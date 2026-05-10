importScripts('background-core.js', 'background-batch-core.js');

const core = self.CpaCodexOAuthBackgroundCore;
const batchCore = self.CpaCodexOAuthBackgroundBatchCore;
const STATUS_KEY = 'cpaCodexOAuthAutoLoginStatus';
const SETTINGS_KEY = 'cpaCodexOAuthAutoLoginSettings';
const BRIDGE_TIMEOUT_MS = 25000;
const EMAIL_CONTINUE_RETRIES = 4;
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_OPERATION_LOG = 80;
const EMAIL_CONTINUE_WORDS = Object.freeze(['continue', 'next', 'sign in', 'log in', '继续', '下一步', '登录', '登入']);
const OTP_LOGIN_WORDS = Object.freeze([
  'log in with a one-time code',
  'login with a one-time code',
  'sign in with a one-time code',
  'use a one-time code',
  'use one-time code',
  'email me a code',
  'send code by email',
  'send a code',
  '使用一次性验证码登录',
  '使用验证码登录',
  '使用一次性代码登录',
  '通过电子邮件发送代码',
  '通过邮箱发送验证码',
]);
const REQUIRED_BRIDGE_ACTIONS = Object.freeze([
  'GET_CAPABILITIES',
  'GET_ACCOUNT_POOLS',
  'BUILD_QUEUE',
  'GET_QUEUE',
  'CLAIM_JOB',
  'UPDATE_JOB',
  'START_JOB_OAUTH',
  'FETCH_CODE',
  'SUBMIT_CALLBACK',
  'CHECK_OAUTH_STATUS',
  'RELEASE_JOB',
]);

let activeRun = null;
let operationLog = [];
let automationSettings = core.normalizeAutomationSettings();
let lastStatus = core.createSafeStatus({
  phase: 'idle',
  message: 'Ready.',
  running: false,
  automationSettings,
  queueSummary: null,
  currentJob: null,
  operationLog,
});

function getAutomationSettings() {
  return automationSettings;
}

function getStepWaitMs() {
  return getAutomationSettings().stepWaitMs;
}

function buildOpenAIActionOptions() {
  const stepWaitMs = getStepWaitMs();
  return {
    actionSettleMs: stepWaitMs,
    actionTimeoutMs: stepWaitMs,
  };
}

function publicJob(job) {
  if (!job) {
    return null;
  }
  return {
    jobId: job.jobId || '',
    authIndex: job.authIndex || '',
    accountEmail: job.accountEmail || '',
    hotmailEmail: job.hotmailEmail || '',
    status: job.status || '',
    attempt: Number(job.attempt || 0),
    leaseExpiresAt: job.leaseExpiresAt || null,
  };
}

function persistStatus(status) {
  try {
    chrome.storage?.session?.set?.({ [STATUS_KEY]: status });
  } catch {
    // Status persistence is best-effort and never required for the flow.
  }
}

function redactLogMessage(value) {
  return String(value || '')
    .replace(/([?&](?:code|token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b((?:code|token|secret|pass(?:word)?|authorization|cookie|refresh[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b\d{6,8}\b/g, '[redacted]')
    .trim();
}

function appendOperationLog(input, currentJob) {
  const message = redactLogMessage(input?.message);
  if (!message) {
    return operationLog;
  }

  const entry = {
    timestamp: Date.now(),
    phase: String(input?.phase || lastStatus.phase || 'idle'),
    message,
    accountEmail: currentJob?.accountEmail || input?.accountEmail || '',
  };
  const lastEntry = operationLog[0];
  if (
    lastEntry
    && lastEntry.phase === entry.phase
    && lastEntry.message === entry.message
    && lastEntry.accountEmail === entry.accountEmail
  ) {
    return operationLog;
  }

  operationLog = [entry, ...operationLog].slice(0, MAX_OPERATION_LOG);
  return operationLog;
}

function setStatus(input) {
  const nextInput = input || {};
  const phase = String(nextInput.phase || lastStatus.phase || 'idle');
  const terminal = ['done', 'error', 'manual_required', 'stopped'].includes(phase);
  const defaultRunning = Boolean(activeRun && !activeRun.stopRequested && !activeRun.pauseRequested && !terminal);
  const running = 'running' in nextInput ? Boolean(nextInput.running) : defaultRunning;
  const queueSummary = 'queueSummary' in nextInput
    ? nextInput.queueSummary
    : (activeRun?.queueSummary || null);
  const currentJob = 'currentJob' in nextInput
    ? nextInput.currentJob
    : publicJob(activeRun?.currentJob);
  const nextAutomationSettings = 'automationSettings' in nextInput
    ? core.normalizeAutomationSettings(nextInput.automationSettings)
    : automationSettings;
  const nextOperationLog = appendOperationLog({ ...nextInput, phase }, currentJob);

  lastStatus = core.createSafeStatus({
    phase,
    message: String(nextInput.message || ''),
    queueSummary,
    currentJob,
    ...nextInput,
    automationSettings: nextAutomationSettings,
    operationLog: nextOperationLog,
    running,
  });
  persistStatus(lastStatus);
  return lastStatus;
}

function makeErrorMessage(error) {
  if (!error) return 'Unknown error.';
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  if (error.error?.message) return error.error.message;
  if (typeof error.error === 'string') return error.error;
  return String(error);
}

function createFlowError(errorType, code, message, extra = {}) {
  const error = new Error(message || code || errorType || 'flow_error');
  error.errorType = errorType;
  error.code = code || errorType || 'flow_error';
  Object.assign(error, extra);
  return error;
}

function createBridgeActionError(action, response) {
  const rawError = response?.error;
  const bridgeError = rawError && typeof rawError === 'object' ? rawError : {};
  const message = bridgeError.message
    || (typeof rawError === 'string' ? rawError : '')
    || `CPA bridge action failed: ${action}`;
  const error = new Error(message);
  error.name = 'BridgeActionError';
  error.action = action;
  error.errorType = bridgeError.errorType;
  error.code = bridgeError.code || response?.code || '';
  error.bridgeError = rawError;
  error.bridgeResult = response?.result;
  return error;
}

function assertRunning(run) {
  if (!run || run.stopRequested) {
    const error = new Error('Auto-login stopped.');
    error.name = 'AbortError';
    throw error;
  }
}

function wait(ms, run) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(0, Number(ms) || 0);
    const startedAt = Date.now();
    const tick = () => {
      if (run?.stopRequested) {
        reject(createFlowError('fatal', 'stopped', 'Auto-login stopped.'));
        return;
      }
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(250, remaining));
    };
    tick();
  });
}

function chromeCallback(call) {
  return new Promise((resolve, reject) => {
    try {
      call((result) => {
        const lastError = chrome.runtime?.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function loadAutomationSettings() {
  if (!chrome.storage?.local?.get) {
    automationSettings = core.normalizeAutomationSettings();
    return automationSettings;
  }
  const stored = await chromeCallback((done) => chrome.storage.local.get(SETTINGS_KEY, done)).catch(() => ({}));
  automationSettings = core.normalizeAutomationSettings(stored?.[SETTINGS_KEY]);
  return automationSettings;
}

async function saveAutomationSettings(input) {
  const settings = core.normalizeAutomationSettings(input);
  if (chrome.storage?.local?.set) {
    await chromeCallback((done) => chrome.storage.local.set({ [SETTINGS_KEY]: settings }, done));
  }
  automationSettings = settings;
  setStatus({
    phase: lastStatus.phase || 'idle',
    message: lastStatus.message || 'Ready.',
    automationSettings: settings,
  });
  return settings;
}

function queryTabs(queryInfo) {
  return chromeCallback((done) => chrome.tabs.query(queryInfo, done));
}

function getTab(tabId) {
  return chromeCallback((done) => chrome.tabs.get(tabId, done));
}

function createTab(createProperties) {
  return chromeCallback((done) => chrome.tabs.create(createProperties, done));
}

function removeTab(tabId) {
  if (!tabId) {
    return Promise.resolve();
  }
  return chromeCallback((done) => chrome.tabs.remove(tabId, done)).catch(() => null);
}

function sendTabMessage(tabId, message, options = {}) {
  return chromeCallback((done) => chrome.tabs.sendMessage(tabId, message, options, done));
}

function getAllFrames(tabId) {
  return chromeCallback((done) => chrome.webNavigation.getAllFrames({ tabId }, done));
}

async function ensureScript(tabId, file, frameId = 0) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: [file] });
  } catch {
    // The script may already be injected or the page may be temporarily unavailable.
  }
}

async function sendMessageWithInjectedScript(tabId, file, message, options = {}) {
  const frameId = Number.isInteger(options.frameId) ? options.frameId : 0;
  try {
    return await sendTabMessage(tabId, message, { frameId });
  } catch {
    await ensureScript(tabId, file, frameId);
    return sendTabMessage(tabId, message, { frameId });
  }
}

function createOpenAIActionError(action, response) {
  const failure = core.normalizeOpenAIActionFailure(action, response);
  const error = new Error(failure.message);
  error.name = 'OpenAIActionError';
  error.action = failure.action;
  error.code = failure.code;
  error.errorType = failure.errorType;
  error.openAIResponse = response;
  return error;
}

async function getPreferredLocalAppTab(errorMessage = 'Open the local CPA Codex app tab before starting auto-login.') {
  const activeTabs = await queryTabs({ active: true, currentWindow: true });
  const activeLocalTab = core.pickPreferredLocalAppTab(activeTabs);
  if (activeLocalTab) {
    return activeLocalTab;
  }

  const tabs = await queryTabs({ currentWindow: true });
  const localTab = core.pickPreferredLocalAppTab(tabs);
  if (localTab) {
    return localTab;
  }

  const allTabs = await queryTabs({});
  const anyLocalTab = core.pickPreferredLocalAppTab(allTabs);
  if (anyLocalTab) {
    return anyLocalTab;
  }

  throw new Error(errorMessage);
}

async function callCpaBridge(tabId, action, payload = {}) {
  const response = await sendMessageWithInjectedScript(tabId, 'content-cpa.js', {
    type: 'CPA_OAUTH_BRIDGE',
    action,
    payload,
    timeoutMs: BRIDGE_TIMEOUT_MS,
  });
  if (!response?.ok) {
    throw createBridgeActionError(action, response);
  }
  return response.result || {};
}

async function callOpenAI(tabId, action, payload = {}, frameId = 0) {
  const response = await sendMessageWithInjectedScript(tabId, 'content-openai.js', {
    type: 'CPA_OPENAI_AUTH',
    action,
    ...payload,
  }, { frameId });
  if (response && response.ok === false) {
    throw createOpenAIActionError(action, response);
  }
  return response?.result || response || {};
}

function getDebuggerTarget(tabId) {
  return { tabId };
}

function attachDebugger(tabId) {
  if (!chrome.debugger?.attach) {
    throw createFlowError('retryable', 'debugger_unavailable', 'Chrome debugger API is not available for trusted OpenAI clicks.');
  }
  const target = getDebuggerTarget(tabId);
  return chromeCallback((done) => chrome.debugger.attach(target, '1.3', done));
}

function detachDebugger(tabId) {
  if (!chrome.debugger?.detach) {
    return Promise.resolve();
  }
  return chromeCallback((done) => chrome.debugger.detach(getDebuggerTarget(tabId), done));
}

function sendDebuggerCommand(tabId, method, params = {}) {
  if (!chrome.debugger?.sendCommand) {
    throw createFlowError('retryable', 'debugger_unavailable', 'Chrome debugger API is not available for trusted OpenAI clicks.');
  }
  return chromeCallback((done) => chrome.debugger.sendCommand(getDebuggerTarget(tabId), method, params, done));
}

async function dispatchTrustedClick(tabId, rect) {
  await attachDebugger(tabId);
  try {
    for (const event of core.buildTrustedClickMouseEvents(rect)) {
      await sendDebuggerCommand(tabId, event.method, event.params);
    }
  } finally {
    await detachDebugger(tabId).catch(() => null);
  }
}

async function getOpenAIFrameIds(tab, options = {}) {
  const fallback = options.includeFallback === false ? [] : [0];
  let frames = [];
  try {
    frames = await getAllFrames(tab.id);
  } catch {
    return fallback;
  }

  const frameIds = frames
    .filter((frame) => core.isOpenAIAuthUrl(frame?.url))
    .map((frame) => frame.frameId)
    .filter((frameId) => Number.isInteger(frameId));

  if (core.isOpenAIAuthUrl(tab?.url) && !frameIds.includes(0)) {
    frameIds.unshift(0);
  }

  return [...new Set(frameIds.length ? frameIds : fallback)];
}

async function tabHasOpenAIAuthContext(tab) {
  if (core.isOpenAIAuthUrl(tab?.url)) {
    return true;
  }
  const frameIds = await getOpenAIFrameIds(tab, { includeFallback: false });
  return frameIds.length > 0;
}

function scoreOpenAIState(state) {
  switch (state?.state) {
    case 'manual_required':
      return 50;
    case 'verification':
      return 40;
    case 'email':
      return 35;
    case 'account':
      return 32;
    case 'consent':
      return 30;
    default:
      return 0;
  }
}

async function classifyOpenAI(tab) {
  const frameIds = await getOpenAIFrameIds(tab);
  const states = [];

  for (const frameId of frameIds) {
    try {
      const state = await callOpenAI(tab.id, 'CLASSIFY', {}, frameId);
      states.push({ ...state, frameId });
    } catch (error) {
      states.push({
        state: 'unknown',
        reason: 'frame_classify_failed',
        error: error?.message || String(error),
        frameId,
      });
    }
  }

  const selected = [...states].sort((left, right) => scoreOpenAIState(right) - scoreOpenAIState(left))[0] || {
    state: 'unknown',
    reason: 'no_openai_frames',
    frameId: 0,
  };

  return {
    ...selected,
    frameCount: frameIds.length,
    frameStates: states.map((state) => ({
      frameId: state.frameId,
      state: state.state,
      reason: state.reason || '',
      inputCount: state.inputCount || 0,
      visibleInputCount: state.visibleInputCount || 0,
      emailPageHint: Boolean(state.emailPageHint),
    })),
  };
}

function readPath(source, path) {
  return path.split('.').reduce((current, key) => {
    if (current && typeof current === 'object' && key in current) {
      return current[key];
    }
    return undefined;
  }, source);
}

function pickString(source, paths) {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function extractAuthUrl(payload) {
  return pickString(payload, [
    'authUrl',
    'authorizationUrl',
    'oauthUrl',
    'url',
    'startResult.authUrl',
    'startResult.authorizationUrl',
    'job.authUrl',
    'session.authUrl',
    'session.url',
    'oauth.authUrl',
    'oauth.url',
  ]);
}

function extractState(payload) {
  return pickString(payload, [
    'state',
    'authState',
    'oauthState',
    'startResult.state',
    'job.state',
    'session.state',
    'oauth.state',
  ]);
}

function extractEmail(payload) {
  return pickString(payload, [
    'accountEmail',
    'account.email',
    'selectedAccount.email',
    'hotmailEmail',
    'selectedHotmail.email',
    'hotmail.email',
    'email',
    'oauth.email',
  ]);
}

function extractCode(payload) {
  return pickString(payload, [
    'code',
    'verificationCode',
    'latestCode',
    'hotmailCode.code',
    'hotmailCode',
    'result.code',
  ]);
}

function getTabDiagnostics(tab, state = {}, context = {}) {
  return {
    url: tab?.url || '',
    title: tab?.title || '',
    pageState: state?.state || 'unknown',
    reason: state?.reason || '',
    email: extractEmail(state) || context?.accountEmail || context?.email || '',
    tabStatus: tab?.status || '',
    frameId: Number.isInteger(state?.frameId) ? state.frameId : 0,
    frameCount: Number(state?.frameCount || 0),
    inputCount: Number(state?.inputCount || 0),
    visibleInputCount: Number(state?.visibleInputCount || 0),
    genericInputCount: Number(state?.genericInputCount || 0),
    activeTag: state?.activeTag || '',
    activeInput: state?.activeInput || '',
    emailPageHint: Boolean(state?.emailPageHint),
  };
}

function formatDiagnosticsMessage(prefix, diagnostics) {
  const details = [
    diagnostics.pageState ? `state=${diagnostics.pageState}` : '',
    diagnostics.reason ? `reason=${diagnostics.reason}` : '',
    diagnostics.email ? `email=${diagnostics.email}` : '',
    diagnostics.tabStatus ? `tab=${diagnostics.tabStatus}` : '',
    diagnostics.frameCount ? `frame=${diagnostics.frameId}/${diagnostics.frameCount}` : '',
    diagnostics.inputCount ? `inputs=${diagnostics.visibleInputCount}/${diagnostics.inputCount}` : '',
    diagnostics.genericInputCount ? `generic=${diagnostics.genericInputCount}` : '',
    diagnostics.activeTag ? `active=${diagnostics.activeTag}${diagnostics.activeInput ? `(${diagnostics.activeInput})` : ''}` : '',
    diagnostics.emailPageHint ? 'emailHint=true' : '',
    diagnostics.title ? `title="${diagnostics.title}"` : '',
  ].filter(Boolean);

  return details.length ? `${prefix} (${details.join(', ')}).` : prefix;
}

async function readOpenAIEmail(tabId, frameId = 0) {
  const result = await callOpenAI(tabId, 'READ_EMAIL', {}, frameId).catch(() => ({}));
  return extractEmail(result);
}

async function clickEmailContinue(tabId, run, frameId = 0) {
  for (let attempt = 0; attempt < EMAIL_CONTINUE_RETRIES; attempt += 1) {
    assertRunning(run);
    if (attempt > 0) {
      await wait(getStepWaitMs(), run);
    }
    const result = await callOpenAI(tabId, 'CLICK_ACTION', {
      words: EMAIL_CONTINUE_WORDS,
      ...buildOpenAIActionOptions(),
    }, frameId).catch(() => null);
    if (result?.ok || result?.text) {
      return result;
    }
  }
  return { ok: false, error: 'email_continue_not_clickable' };
}

async function waitForOpenAIProgress(tabId, previousState, previousUrl, run, timeoutMs = getAutomationSettings().clickProgressTimeoutMs) {
  const startedAt = Date.now();
  let lastTab = null;
  let lastState = null;

  while (Date.now() - startedAt < timeoutMs) {
    assertRunning(run);
    await wait(250, run);
    lastTab = await getTab(tabId).catch(() => null);
    if (!lastTab) {
      return { changed: true, tab: null, state: null, reason: 'tab_closed' };
    }

    const currentUrl = lastTab.url || '';
    if (previousUrl && currentUrl && currentUrl !== previousUrl) {
      return { changed: true, tab: lastTab, state: null, reason: 'url_changed' };
    }

    if (!(await tabHasOpenAIAuthContext(lastTab).catch(() => false))) {
      if (currentUrl) {
        return { changed: true, tab: lastTab, state: null, reason: 'left_openai_auth' };
      }
      continue;
    }

    lastState = await classifyOpenAI(lastTab).catch(() => null);
    const nextState = lastState?.state || '';
    if (nextState && nextState !== previousState && nextState !== 'unknown') {
      return { changed: true, tab: lastTab, state: lastState, reason: 'state_changed' };
    }
  }

  return { changed: false, tab: lastTab, state: lastState, reason: 'timeout' };
}

async function trustedClickLikelyAction(tabId, words, frameId = 0, options = {}) {
  const rectResult = await callOpenAI(tabId, 'GET_ACTION_RECT', {
    words,
    ...options,
  }, frameId);
  if (!rectResult?.ok || !rectResult.rect) {
    return {
      ok: false,
      error: rectResult?.error || 'action_rect_unavailable',
      code: rectResult?.error || 'action_rect_unavailable',
      text: rectResult?.text || '',
    };
  }

  await dispatchTrustedClick(tabId, rectResult.rect);
  return {
    ok: true,
    mode: 'trustedClick',
    text: rectResult.text || '',
    rect: rectResult.rect,
  };
}

async function verifyOpenAIActionProgressOrTrustedFallback(tab, run, {
  frameId = 0,
  words = [],
  previousState = '',
  previousUrl = '',
  actionLabel = 'OpenAI action',
  allowSubmitFallback = false,
  clickResult = {},
  clickedAt = Date.now(),
} = {}) {
  const progress = await waitForOpenAIProgress(tab.id, previousState, previousUrl, run);
  if (progress.changed) {
    return { ...clickResult, clickedAt, progress };
  }

  setStatus({
    phase: 'trusted_click',
    message: `${actionLabel} did not advance after DOM click; trying trusted browser click.`,
  });

  let trustedResult;
  try {
    trustedResult = await trustedClickLikelyAction(tab.id, words, frameId, {
      allowSubmitFallback,
      actionSettleMs: 0,
      actionTimeoutMs: getStepWaitMs(),
    });
  } catch (error) {
    const snapshot = createPageSnapshot(progress.tab || tab, progress.state || {});
    throw createFlowError(
      error.errorType || 'retryable',
      error.code || 'trusted_click_failed',
      `${actionLabel} did not advance after DOM click, and trusted browser click failed: ${makeErrorMessage(error)}`,
      { pageSnapshot: snapshot }
    );
  }

  if (!trustedResult?.ok) {
    const snapshot = createPageSnapshot(progress.tab || tab, progress.state || {});
    throw createFlowError(
      'retryable',
      trustedResult?.code || 'trusted_click_failed',
      `${actionLabel} did not advance after DOM click, and trusted browser click could not locate the action.`,
      { pageSnapshot: snapshot }
    );
  }

  const trustedProgress = await waitForOpenAIProgress(tab.id, previousState, previousUrl, run);
  if (!trustedProgress.changed) {
    const snapshot = createPageSnapshot(trustedProgress.tab || tab, trustedProgress.state || {});
    throw createFlowError(
      'retryable',
      'openai_click_no_transition',
      `${actionLabel} trusted browser click did not advance the OpenAI page.`,
      { pageSnapshot: snapshot }
    );
  }

  return { ...trustedResult, clickedAt, progress: trustedProgress };
}

async function clickOpenAIActionWithTrustedFallback(tab, run, {
  frameId = 0,
  words = [],
  previousState = '',
  previousUrl = '',
  actionLabel = 'OpenAI action',
  allowSubmitFallback = false,
} = {}) {
  const clickOptions = {
    words,
    allowSubmitFallback,
    ...buildOpenAIActionOptions(),
  };
  const clickedAt = Date.now();
  const clickResult = await callOpenAI(tab.id, 'CLICK_ACTION', clickOptions, frameId);
  const clicked = Boolean(clickResult?.ok || clickResult?.text);
  if (!clicked) {
    return { ...clickResult, clickedAt };
  }

  return verifyOpenAIActionProgressOrTrustedFallback(tab, run, {
    frameId,
    words,
    previousState,
    previousUrl,
    actionLabel,
    allowSubmitFallback,
    clickResult,
    clickedAt,
  });
}

function throwPageEmailVerificationFailure(verification) {
  throw createFlowError(
    verification.errorType || 'manual',
    verification.code || 'account_email_unverified',
    verification.message || 'OpenAI page account email could not be verified.',
    {
      observedEmail: verification.observedEmail || '',
      expectedEmail: verification.expectedEmail || '',
    }
  );
}

function assertExpectedPageEmail(observedEmail, expectedEmail, context = 'OpenAI page') {
  const verification = batchCore.verifyPageEmail({
    observedEmail,
    expectedEmail,
    context,
  });
  if (verification.ok) {
    return;
  }
  throwPageEmailVerificationFailure(verification);
}

function assertStrictExpectedPageEmail(observedEmail, expectedEmail, context) {
  const verification = batchCore.verifyPageEmail({
    observedEmail,
    expectedEmail,
    context,
    requireObserved: true,
  });
  if (verification.ok) {
    return;
  }
  throwPageEmailVerificationFailure(verification);
}

function createPageSnapshot(tab, state = {}) {
  return {
    url: tab?.url || '',
    title: tab?.title || '',
    state: state.state || 'unknown',
    reason: state.reason || '',
    email: extractEmail(state) || '',
    frameId: Number.isInteger(state.frameId) ? state.frameId : 0,
    frameCount: Number(state.frameCount || 0),
    inputCount: Number(state.inputCount || 0),
    visibleInputCount: Number(state.visibleInputCount || 0),
    updatedAt: new Date().toISOString(),
  };
}

async function clearOpenAICookiesFallback() {
  if (!chrome.cookies?.getAll || !chrome.cookies?.remove) {
    return { removed: 0 };
  }

  let removed = 0;
  for (const origin of core.OPENAI_CLEAR_ORIGINS) {
    const cookies = await chromeCallback((done) => chrome.cookies.getAll({ url: origin }, done)).catch(() => []);
    for (const cookie of cookies || []) {
      const path = String(cookie.path || '/').startsWith('/') ? cookie.path : `/${cookie.path}`;
      const details = {
        url: `${origin}${path}`,
        name: cookie.name,
      };
      if (cookie.storeId) {
        details.storeId = cookie.storeId;
      }
      await chromeCallback((done) => chrome.cookies.remove(details, done)).catch(() => null);
      removed += 1;
    }
  }
  return { removed };
}

async function clearOpenAISession() {
  const removalOptions = core.buildOpenAISessionRemovalOptions();
  if (chrome.browsingData?.remove) {
    await chromeCallback((done) => chrome.browsingData.remove(
      removalOptions.options,
      removalOptions.dataToRemove,
      done
    ));
    return { mode: 'browsingData' };
  }

  const fallback = await clearOpenAICookiesFallback();
  return { mode: 'cookies', ...fallback };
}

function bridgeJobPayload(run, job, extra = {}) {
  return {
    extensionId: run.id,
    jobId: job?.jobId || '',
    authIndex: job?.authIndex || '',
    accountEmail: job?.accountEmail || '',
    hotmailId: job?.hotmailId || '',
    hotmailEmail: job?.hotmailEmail || '',
    state: job?.state || '',
    ...extra,
  };
}

function updateRunFromBridgeResult(run, result = {}) {
  if (result.summary) {
    run.queueSummary = result.summary;
  }
  if (result.job) {
    run.currentJob = result.job;
  }
}

async function updateJob(run, job, patch = {}) {
  const result = await callCpaBridge(run.localTabId, 'UPDATE_JOB', bridgeJobPayload(run, job, {
    patch,
    state: patch.state || job.state || '',
  }));
  updateRunFromBridgeResult(run, result);
  return result;
}

async function releaseJob(run, job, payload = {}) {
  const result = await callCpaBridge(run.localTabId, 'RELEASE_JOB', bridgeJobPayload(run, job, payload));
  updateRunFromBridgeResult(run, result);
  return result;
}

async function claimJob(run) {
  const result = await callCpaBridge(run.localTabId, 'CLAIM_JOB', { extensionId: run.id });
  updateRunFromBridgeResult(run, result);
  const job = result.claimed || result.job || null;
  run.currentJob = job;
  return job;
}

async function requireBridgeV2(localTabId) {
  const capabilities = await callCpaBridge(localTabId, 'GET_CAPABILITIES');
  const version = Number(capabilities.version || 0);
  if (version < 2) {
    throw createFlowError(
      'fatal',
      'bridge_version_unsupported',
      `CPA OAuth bridge v2 is required; got version ${version || 'unknown'}.`
    );
  }

  const actions = new Set(Array.isArray(capabilities.actions) ? capabilities.actions : []);
  const missing = REQUIRED_BRIDGE_ACTIONS.filter((action) => !actions.has(action));
  if (missing.length) {
    throw createFlowError(
      'fatal',
      'bridge_actions_missing',
      `CPA OAuth bridge is missing actions: ${missing.join(', ')}.`
    );
  }

  return capabilities;
}

async function heartbeatIfNeeded(run, job, patch = {}) {
  if (Date.now() < run.nextHeartbeatAt) {
    return;
  }
  run.nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MS;
  await updateJob(run, run.currentJob || job, patch);
}

function getEffectiveJobAttempt(run, job) {
  return batchCore.getEffectiveJobAttempt(job, run?.retryAttemptsByJobId);
}

function clearRememberedRetryAttempt(run, job) {
  batchCore.forgetRetryAttempt(run?.retryAttemptsByJobId, job);
}

function describeJob(job) {
  return job?.accountEmail || job?.authIndex || job?.jobId || 'job';
}

async function waitBeforeSkippingBlockedJob(run, job, classified = {}) {
  const delayMs = getAutomationSettings().blockedSkipDelayMs;
  const seconds = Math.ceil(delayMs / 1000);
  const reason = classified.message || classified.code || 'OAuth automation could not continue.';
  setStatus({
    phase: 'job_skip_wait',
    message: `${describeJob(job)} cannot continue: ${reason}. Waiting ${seconds}s before skipping.`,
  });
  await wait(delayMs, run);
  run.postJobDelayMs = Math.max(Number(run.postJobDelayMs || 0), delayMs);
}

function hasQueuedOAuthJobs(summary) {
  if (!summary || typeof summary !== 'object') {
    return true;
  }
  const queued = Number(summary.queued);
  return !Number.isFinite(queued) || queued > 0;
}

async function refreshQueueSummary(run) {
  try {
    const result = await callCpaBridge(run.localTabId, 'GET_QUEUE');
    updateRunFromBridgeResult(run, result);
    return result.summary || null;
  } catch {
    return null;
  }
}

async function waitBetweenJobsIfNeeded(run) {
  const configuredDelayMs = getAutomationSettings().betweenJobsDelayMs;
  const alreadyWaitedMs = Math.max(0, Number(run.postJobDelayMs || 0));
  run.postJobDelayMs = 0;
  if (!configuredDelayMs || run.stopRequested) {
    return;
  }

  const summary = await refreshQueueSummary(run);
  if (!hasQueuedOAuthJobs(summary)) {
    return;
  }

  const delayMs = Math.max(0, configuredDelayMs - alreadyWaitedMs);
  if (!delayMs) {
    return;
  }

  const seconds = Math.ceil(delayMs / 1000);
  setStatus({
    phase: 'between_jobs_wait',
    message: `Waiting ${seconds}s before the next OAuth job.`,
    currentJob: null,
  });
  await wait(delayMs, run);
}

function classifyFailureForAction(error) {
  if (error?.code === 'account_email_mismatch' || error?.errorType === 'account_email_mismatch') {
    return {
      classified: {
        errorType: 'retryable',
        code: 'account_email_mismatch',
        message: makeErrorMessage(error),
      },
      actionErrorType: 'account_email_mismatch',
    };
  }

  const classified = batchCore.classifyBridgeError(error);
  return {
    classified,
    actionErrorType: classified.errorType,
  };
}

async function closeAuthTab(run) {
  const tabId = run.authTabId;
  run.authTabId = 0;
  run.callbackUrl = '';
  await removeTab(tabId);
}

async function submitJobCallback(run, job, context, callbackUrl) {
  const parsed = core.parseCallbackUrl(callbackUrl);
  if (!parsed.ok) {
    throw createFlowError('fatal', parsed.reason || 'invalid_callback_url', `Ignoring invalid callback URL: ${parsed.reason}`);
  }

  setStatus({
    phase: 'callback',
    message: `Submitting OAuth callback for ${context.accountEmail}.`,
    callbackUrl,
  });

  const result = await callCpaBridge(run.localTabId, 'SUBMIT_CALLBACK', bridgeJobPayload(run, job, {
    callbackUrl,
    redirectUrl: callbackUrl,
    state: parsed.state || context.state,
    authIndex: context.authIndex,
    accountEmail: context.accountEmail,
  }));
  updateRunFromBridgeResult(run, result);
  await closeAuthTab(run);
  return result;
}

async function fetchVerificationCode(run, job, context) {
  return callCpaBridge(run.localTabId, 'FETCH_CODE', bridgeJobPayload(run, job, {
    expectedEmail: context.accountEmail,
    email: context.hotmailEmail || context.accountEmail,
    state: context.state,
    filterAfterTimestamp: context.filterAfterTimestamp || Date.now() - 15000,
    excludeCodes: [...context.excludeCodes],
  }));
}

async function handleOpenAIJobState(run, job, tab, context) {
  const state = await classifyOpenAI(tab);
  const frameId = Number.isInteger(state.frameId) ? state.frameId : 0;
  context.openAIFrameId = frameId;
  const snapshot = createPageSnapshot(tab, state);

  if (state.state === 'manual_required') {
    const diagnostics = getTabDiagnostics(tab, state, context);
    const accountDeactivated = state.reason === 'account_deactivated';
    throw createFlowError(
      accountDeactivated ? 'fatal' : 'manual',
      accountDeactivated ? 'openai_account_deactivated' : 'openai_manual_required',
      formatDiagnosticsMessage(accountDeactivated ? 'OpenAI account is deactivated' : 'Manual OpenAI verification required', diagnostics),
      { pageSnapshot: snapshot }
    );
  }

  if (state.state === 'email') {
    if (!context.accountEmail) {
      throw createFlowError('manual', 'missing_account_email', 'OpenAI email page detected, but the job did not provide an account email.');
    }
    const previousUrl = state.url || tab.url || '';
    setStatus({ phase: 'email_submitting', message: `Filling OpenAI email: ${context.accountEmail}.` });
    await updateJob(run, job, { status: 'email_submitting', lastPageSnapshot: snapshot });
    const clickedAt = Date.now();
    const fillResult = await callOpenAI(tab.id, 'FILL_EMAIL_AND_CONTINUE', {
      email: context.accountEmail,
      ...buildOpenAIActionOptions(),
    }, frameId);
    const filledEmail = extractEmail(fillResult) || context.accountEmail;
    assertExpectedPageEmail(filledEmail, context.accountEmail);
    setStatus({ phase: 'email_submitting', message: 'Email filled. Clicking continue.' });
    const clickResult = fillResult?.continueClicked
      ? await verifyOpenAIActionProgressOrTrustedFallback(tab, run, {
        frameId,
        words: EMAIL_CONTINUE_WORDS,
        previousState: 'email',
        previousUrl,
        actionLabel: 'OpenAI email continue',
        allowSubmitFallback: true,
        clickResult: fillResult.continueResult || { ok: true },
        clickedAt,
      })
      : await clickOpenAIActionWithTrustedFallback(tab, run, {
        frameId,
        words: EMAIL_CONTINUE_WORDS,
        previousState: 'email',
        previousUrl,
        actionLabel: 'OpenAI email continue',
        allowSubmitFallback: true,
      });
    if (clickResult?.ok) {
      context.filterAfterTimestamp = clickResult.clickedAt || Date.now();
    } else {
      setStatus({ phase: 'email_submitting', message: 'Email filled. Waiting for the continue button to become clickable.' });
    }
    return;
  }

  if (state.state === 'otp_choice') {
    const previousUrl = state.url || tab.url || '';
    const pageEmail = extractEmail(state) || await readOpenAIEmail(tab.id, frameId);
    assertExpectedPageEmail(pageEmail, context.accountEmail, 'OpenAI password page');
    setStatus({ phase: 'otp_choice_submitting', message: `Requesting one-time code login for ${context.accountEmail}.` });
    await updateJob(run, job, { status: 'otp_choice_submitting', lastPageSnapshot: snapshot });
    const clickResult = await clickOpenAIActionWithTrustedFallback(tab, run, {
      frameId,
      words: OTP_LOGIN_WORDS,
      previousState: 'otp_choice',
      previousUrl,
      actionLabel: 'OpenAI one-time-code login',
    });
    context.otpRequestedAt = clickResult.clickedAt || Date.now();
    context.otpCodeFetchDelayPending = true;
    context.filterAfterTimestamp = context.otpRequestedAt;
    return;
  }

  if (state.state === 'verification') {
    const previousUrl = state.url || tab.url || '';
    const pageEmail = extractEmail(state) || await readOpenAIEmail(tab.id, frameId);
    assertExpectedPageEmail(pageEmail, context.accountEmail);
    context.filterAfterTimestamp = context.filterAfterTimestamp || Date.now() - 15000;
    const codeFetchDelayMs = core.computeOtpCodeFetchDelayMs(context.otpCodeFetchDelayPending);
    if (codeFetchDelayMs > 0) {
      context.otpCodeFetchDelayPending = false;
      setStatus({
        phase: 'code_polling_wait',
        message: `Waiting ${Math.ceil(codeFetchDelayMs / 1000)}s before reading verification code for ${context.accountEmail}.`,
      });
      await wait(codeFetchDelayMs, run);
    }
    setStatus({ phase: 'code_polling', message: `Reading verification code for ${context.accountEmail}.` });
    await updateJob(run, job, { status: 'code_polling', lastPageSnapshot: snapshot });
    const codeResult = await fetchVerificationCode(run, job, context);
    const code = extractCode(codeResult || {});
    if (!code) {
      return;
    }
    setStatus({ phase: 'code_submitting', message: `Filling OpenAI verification code for ${context.accountEmail}.` });
    await updateJob(run, job, { status: 'code_submitting', lastPageSnapshot: snapshot });
    await callOpenAI(tab.id, 'FILL_CODE', {
      code,
    }, frameId);
    const autoProgress = await waitForOpenAIProgress(tab.id, 'verification', previousUrl, run, 1000);
    if (!autoProgress.changed) {
      await clickOpenAIActionWithTrustedFallback(tab, run, {
        frameId,
        words: ['continue', 'submit', 'verify', 'next', '继续', '提交', '验证', '下一步'],
        previousState: 'verification',
        previousUrl,
        actionLabel: 'OpenAI verification code submit',
        allowSubmitFallback: true,
      });
    }
    return;
  }

  if (state.state === 'consent') {
    const previousUrl = state.url || tab.url || '';
    const pageEmail = extractEmail(state) || await readOpenAIEmail(tab.id, frameId);
    assertStrictExpectedPageEmail(pageEmail, context.accountEmail, 'OpenAI consent page');
    setStatus({ phase: 'consent_submitting', message: `Authorizing Codex for ${context.accountEmail}.` });
    await updateJob(run, job, { status: 'consent_submitting', lastPageSnapshot: snapshot });
    await clickOpenAIActionWithTrustedFallback(tab, run, {
      frameId,
      words: ['authorize', 'authorise', 'allow', 'continue', 'confirm', '授权', '允许', '同意', '继续', '确认'],
      previousState: 'consent',
      previousUrl,
      actionLabel: 'OpenAI consent authorize',
    });
    return;
  }

  if (state.state === 'account') {
    const previousUrl = state.url || tab.url || '';
    const pageEmail = extractEmail(state) || await readOpenAIEmail(tab.id, frameId);
    assertStrictExpectedPageEmail(pageEmail, context.accountEmail, 'OpenAI account page');
    setStatus({ phase: 'account_submitting', message: `Continuing OpenAI account page for ${context.accountEmail}.` });
    await updateJob(run, job, { status: 'account_submitting', lastPageSnapshot: snapshot });
    await clickOpenAIActionWithTrustedFallback(tab, run, {
      frameId,
      words: ['continue as', 'continue with', 'sign in as', '继续使用', '继续以', 'continue', '继续'],
      previousState: 'account',
      previousUrl,
      actionLabel: 'OpenAI account continue',
    });
    return;
  }

  const diagnostics = getTabDiagnostics(tab, state, context);
  setStatus({
    phase: 'waiting',
    message: formatDiagnosticsMessage('Waiting for OpenAI page to reach a recognizable OAuth step', diagnostics),
    ...diagnostics,
    openAIState: state,
  });
}

async function runSingleJobAttempt(run, job) {
  const context = {
    jobId: job.jobId || '',
    authIndex: job.authIndex || '',
    accountEmail: job.accountEmail || '',
    hotmailId: job.hotmailId || '',
    hotmailEmail: job.hotmailEmail || '',
    state: job.state || '',
    filterAfterTimestamp: 0,
    excludeCodes: [],
    openAIFrameId: 0,
    otpRequestedAt: 0,
    otpCodeFetchDelayPending: false,
  };

  setStatus({ phase: 'session_clearing', message: `Clearing OpenAI session for ${context.accountEmail}.` });
  await updateJob(run, job, { status: 'session_clearing' });
  await clearOpenAISession();
  assertRunning(run);

  setStatus({ phase: 'oauth_started', message: `Requesting OAuth URL for ${context.accountEmail}.` });
  const started = await callCpaBridge(run.localTabId, 'START_JOB_OAUTH', bridgeJobPayload(run, job));
  updateRunFromBridgeResult(run, started);

  const activeJob = run.currentJob || job;
  const authUrl = extractAuthUrl(started) || activeJob.authUrl || '';
  context.state = extractState(started) || activeJob.state || context.state;
  if (!authUrl || !core.isOpenAIAuthUrl(authUrl)) {
    throw createFlowError('fatal', 'invalid_auth_url', 'The CPA app did not return a supported OpenAI OAuth URL.');
  }

  setStatus({ phase: 'auth_tab', message: `Opening OpenAI OAuth tab for ${context.accountEmail}.` });
  const authTab = await createTab({ url: authUrl, active: true });
  run.authTabId = authTab.id;
  run.callbackUrl = '';
  run.nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MS;

  const startedAt = Date.now();
  while (Date.now() - startedAt < getAutomationSettings().jobTimeoutMs) {
    assertRunning(run);

    if (run.callbackUrl) {
      await submitJobCallback(run, activeJob, context, run.callbackUrl);
      return { ok: true };
    }

    const tab = await getTab(run.authTabId);
    if (core.isCallbackUrl(tab.url)) {
      await submitJobCallback(run, activeJob, context, tab.url);
      return { ok: true };
    }

    if (await tabHasOpenAIAuthContext(tab)) {
      await handleOpenAIJobState(run, activeJob, tab, context);
    } else {
      setStatus({ phase: 'navigation', message: 'Waiting for OpenAI OAuth navigation.', url: tab.url || '' });
    }

    await heartbeatIfNeeded(run, activeJob, {});
    await wait(getStepWaitMs(), run);
  }

  const timeoutCode = getEffectiveJobAttempt(run, activeJob) === 0 ? 'job_timeout' : 'job_timeout_after_retry';
  throw createFlowError('retryable', timeoutCode, 'OAuth job timed out before a local callback was captured.');
}

async function handleJobFailure(run, job, error) {
  const { classified, actionErrorType } = classifyFailureForAction(error);
  const terminalBridgeJob = batchCore.getTerminalBridgeErrorJob(error);

  await waitBeforeSkippingBlockedJob(run, terminalBridgeJob || job, classified);
  await closeAuthTab(run);

  if (terminalBridgeJob) {
    setStatus({
      phase: 'job_skipped',
      message: `Skipping ${describeJob(terminalBridgeJob)}; bridge already marked the job ${terminalBridgeJob.status}.`,
      currentJob: null,
    });
    clearRememberedRetryAttempt(run, job);
    return;
  }

  const failureAction = batchCore.nextBlockedFailureAction({
    errorType: actionErrorType,
  });

  if (actionErrorType === 'account_email_mismatch') {
    await clearOpenAISession().catch(() => null);
  }

  if (failureAction.action === 'mark_manual_required') {
    setStatus({
      phase: 'job_manual_required',
      message: `Manual action required for ${job.accountEmail || job.authIndex}: ${classified.message}.`,
    });
    await updateJob(run, job, {
      status: 'manual_required',
      lastError: classified.code,
      lastErrorType: 'manual',
      manualReason: classified.message,
      lastPageSnapshot: error.pageSnapshot || null,
    });
    clearRememberedRetryAttempt(run, job);
    return;
  }

  const lastError = failureAction.lastError || classified.code || 'job_failed';
  setStatus({
    phase: 'job_failed',
    message: `Marking ${job.accountEmail || job.authIndex} failed: ${lastError}.`,
  });
  await releaseJob(run, job, {
    failed: true,
    status: 'failed',
    code: lastError,
    error: lastError,
    message: classified.message,
    errorType: classified.errorType,
  });
  clearRememberedRetryAttempt(run, job);
}

async function waitWhilePaused(run) {
  while (run.pauseRequested && !run.stopRequested) {
    setStatus({
      phase: 'paused',
      message: 'Batch paused. Current job is finished; no new job will be claimed.',
      running: false,
    });
    await wait(1000, run);
  }
}

async function runBatch(run) {
  try {
    await loadAutomationSettings();
    const localTab = await getPreferredLocalAppTab('Open the local CPA Codex app tab before starting batch auto-login.');
    run.localTabId = localTab.id;
    setStatus({ phase: 'bridge_capabilities', message: 'Checking CPA OAuth bridge capabilities.' });
    await requireBridgeV2(localTab.id);

    while (!run.stopRequested) {
      await waitWhilePaused(run);
      assertRunning(run);

      setStatus({ phase: 'claiming_job', message: 'Claiming next OAuth job.' });
      const job = await claimJob(run);
      if (!job) {
        setStatus({
          phase: 'done',
          message: 'No queued OAuth jobs remain.',
          running: false,
          currentJob: null,
        });
        return;
      }

      let shouldWaitBetweenJobs = false;
      try {
        setStatus({ phase: 'job_started', message: `Running OAuth job for ${job.accountEmail || job.authIndex}.` });
        await runSingleJobAttempt(run, job);
        setStatus({ phase: 'job_done', message: `OAuth callback submitted for ${job.accountEmail || job.authIndex}.` });
        clearRememberedRetryAttempt(run, job);
        shouldWaitBetweenJobs = true;
      } catch (error) {
        if (error?.name === 'AbortError' || run.stopRequested) {
          throw error;
        }
        await handleJobFailure(run, job, error);
        shouldWaitBetweenJobs = true;
      } finally {
        run.currentJob = null;
        run.authTabId = 0;
        run.callbackUrl = '';
      }

      if (shouldWaitBetweenJobs && !run.stopRequested) {
        await waitBetweenJobsIfNeeded(run);
      }
    }

    setStatus({ phase: 'stopped', message: 'Batch stopped.', running: false, currentJob: null });
  } catch (error) {
    if (error?.name === 'AbortError' || run.stopRequested) {
      setStatus({ phase: 'stopped', message: 'Batch stopped.', running: false, currentJob: null });
      return;
    }
    setStatus({ phase: 'error', message: makeErrorMessage(error), running: false });
  } finally {
    if (activeRun === run) {
      activeRun = null;
    }
  }
}

function startBatch() {
  if (activeRun && !activeRun.stopRequested) {
    return lastStatus;
  }

  activeRun = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    localTabId: 0,
    authTabId: 0,
    callbackUrl: '',
    currentJob: null,
    queueSummary: null,
    stopRequested: false,
    pauseRequested: false,
    nextHeartbeatAt: 0,
    postJobDelayMs: 0,
    retryAttemptsByJobId: Object.create(null),
  };
  setStatus({ phase: 'starting', message: 'Starting Codex OAuth batch auto-login.', running: true });
  runBatch(activeRun);
  return lastStatus;
}

async function stopBatch() {
  const run = activeRun;
  if (!run) {
    return setStatus({ phase: 'stopped', message: 'No active batch is running.', running: false, currentJob: null });
  }

  run.stopRequested = true;
  await closeAuthTab(run);
  if (run.localTabId && run.currentJob) {
    await releaseJob(run, run.currentJob, {
      code: 'stopped',
      error: 'stopped',
      message: 'Stop requested.',
    }).catch(() => null);
  }
  run.currentJob = null;
  return setStatus({ phase: 'stopped', message: 'Stop requested.', running: false, currentJob: null });
}

function pauseBatch() {
  if (activeRun) {
    activeRun.pauseRequested = true;
  }
  return setStatus({
    phase: activeRun?.currentJob ? 'pausing' : 'paused',
    message: activeRun?.currentJob
      ? 'Pause requested. The current job will finish before claiming stops.'
      : 'Batch paused.',
    running: Boolean(activeRun?.currentJob),
  });
}

function resumeBatch() {
  if (!activeRun) {
    return startBatch();
  }
  activeRun.pauseRequested = false;
  return setStatus({ phase: 'resuming', message: 'Resuming Codex OAuth batch.', running: true });
}

async function readAccountPools() {
  const localTab = await getPreferredLocalAppTab('Open the local CPA Codex app tab before reading account pools.');
  const result = await callCpaBridge(localTab.id, 'GET_ACCOUNT_POOLS');
  if (!result.pools && (Array.isArray(result.invalidAccounts) || Array.isArray(result.hotmailAccounts))) {
    return {
      pools: {
        invalidAccounts: result.invalidAccounts || [],
        hotmailAccounts: result.hotmailAccounts || [],
        counts: result.counts || {
          invalidAccounts: (result.invalidAccounts || []).length,
          hotmailAccounts: (result.hotmailAccounts || []).length,
        },
      },
    };
  }
  return result;
}

async function buildQueue(payload = {}) {
  const localTab = await getPreferredLocalAppTab('Open the local CPA Codex app tab before building the OAuth queue.');
  await requireBridgeV2(localTab.id);
  const result = await callCpaBridge(localTab.id, 'BUILD_QUEUE', payload);
  setStatus({
    phase: 'queue_built',
    message: 'OAuth queue built.',
    queueSummary: result.summary || null,
    running: false,
  });
  return result;
}

function handleNavigation(details) {
  if (!activeRun || details.tabId !== activeRun.authTabId || !details.url) {
    return;
  }
  if (core.isCallbackUrl(details.url)) {
    activeRun.callbackUrl = details.url;
  }
}

loadAutomationSettings()
  .then((settings) => {
    lastStatus = core.createSafeStatus({
      ...lastStatus,
      automationSettings: settings,
    });
    persistStatus(lastStatus);
  })
  .catch(() => null);

chrome.webNavigation?.onBeforeNavigate?.addListener(handleNavigation);
chrome.webNavigation?.onCommitted?.addListener(handleNavigation);
chrome.webNavigation?.onHistoryStateUpdated?.addListener(handleNavigation);
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  handleNavigation({ tabId, url: changeInfo?.url });
});

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch?.(() => null);
chrome.action?.onClicked?.addListener((tab) => {
  chrome.sidePanel?.open?.({ windowId: tab.windowId })?.catch?.(() => null);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'CPA_OAUTH_PANEL') {
    return false;
  }

  if (message.action === 'START_AUTO_LOGIN' || message.action === 'START_BATCH' || message.action === 'START_BATCH_LOGIN') {
    sendResponse({ ok: true, status: startBatch() });
    return false;
  }
  if (message.action === 'STOP_AUTO_LOGIN' || message.action === 'STOP_BATCH') {
    stopBatch()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => sendResponse({ ok: false, error: makeErrorMessage(error), status: lastStatus }));
    return true;
  }
  if (message.action === 'PAUSE_BATCH') {
    sendResponse({ ok: true, status: pauseBatch() });
    return false;
  }
  if (message.action === 'RESUME_BATCH') {
    sendResponse({ ok: true, status: resumeBatch() });
    return false;
  }
  if (message.action === 'GET_STATUS') {
    sendResponse({ ok: true, status: lastStatus });
    return false;
  }
  if (message.action === 'GET_SETTINGS') {
    loadAutomationSettings()
      .then((settings) => sendResponse({ ok: true, result: { settings }, status: lastStatus }))
      .catch((error) => sendResponse({ ok: false, error: makeErrorMessage(error), status: lastStatus }));
    return true;
  }
  if (message.action === 'SAVE_SETTINGS') {
    saveAutomationSettings(message.payload || {})
      .then((settings) => sendResponse({ ok: true, result: { settings }, status: lastStatus }))
      .catch((error) => sendResponse({ ok: false, error: makeErrorMessage(error), status: lastStatus }));
    return true;
  }
  if (message.action === 'RESET_SETTINGS') {
    saveAutomationSettings(core.DEFAULT_AUTOMATION_SETTINGS)
      .then((settings) => sendResponse({ ok: true, result: { settings }, status: lastStatus }))
      .catch((error) => sendResponse({ ok: false, error: makeErrorMessage(error), status: lastStatus }));
    return true;
  }
  if (message.action === 'BUILD_QUEUE') {
    buildQueue(message.payload || {})
      .then((result) => sendResponse({ ok: true, result, status: lastStatus }))
      .catch((error) => sendResponse({ ok: false, error: makeErrorMessage(error), status: lastStatus }));
    return true;
  }
  if (message.action === 'READ_ACCOUNT_POOLS') {
    readAccountPools()
      .then((result) => {
        sendResponse({ ok: true, result, status: lastStatus });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: makeErrorMessage(error), status: lastStatus });
      });
    return true;
  }

  sendResponse({ ok: false, error: 'unknown_action', status: lastStatus });
  return false;
});
