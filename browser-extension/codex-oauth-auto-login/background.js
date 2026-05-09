importScripts('background-core.js');

const core = self.CpaCodexOAuthBackgroundCore;
const STATUS_KEY = 'cpaCodexOAuthAutoLoginStatus';
const LOOP_INTERVAL_MS = 1200;
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const BRIDGE_TIMEOUT_MS = 25000;
const CODE_RETRY_INTERVAL_MS = 3500;
const EMAIL_CONTINUE_RETRY_MS = 450;
const EMAIL_CONTINUE_RETRIES = 4;

let activeRun = null;
let lastStatus = core.createSafeStatus({
  phase: 'idle',
  message: 'Ready.',
  running: false,
});

function persistStatus(status) {
  try {
    chrome.storage?.session?.set?.({ [STATUS_KEY]: status });
  } catch {
    // Status persistence is best-effort and never required for the flow.
  }
}

function setStatus(input) {
  lastStatus = core.createSafeStatus({
    running: Boolean(activeRun && !activeRun.stopRequested && input.phase !== 'done' && input.phase !== 'error' && input.phase !== 'manual_required'),
    ...input,
  });
  persistStatus(lastStatus);
  return lastStatus;
}

function makeErrorMessage(error) {
  if (!error) return 'Unknown error.';
  return error.message || String(error);
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
    const timer = setTimeout(resolve, ms);
    if (run?.stopRequested) {
      clearTimeout(timer);
      reject(new Error('Auto-login stopped.'));
    }
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

function queryTabs(queryInfo) {
  return chromeCallback((done) => chrome.tabs.query(queryInfo, done));
}

function getTab(tabId) {
  return chromeCallback((done) => chrome.tabs.get(tabId, done));
}

function createTab(createProperties) {
  return chromeCallback((done) => chrome.tabs.create(createProperties, done));
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
    throw new Error(response?.error || `CPA bridge action failed: ${action}`);
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
    throw new Error(response.error || `OpenAI helper action failed: ${action}`);
  }
  return response?.result || response || {};
}

async function getOpenAIFrameIds(tab) {
  const fallback = [0];
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

function scoreOpenAIState(state) {
  switch (state?.state) {
    case 'manual_required':
      return 50;
    case 'verification':
      return 40;
    case 'email':
      return 35;
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
    'session.state',
    'oauth.state',
  ]);
}

function extractEmail(payload) {
  return pickString(payload, [
    'hotmailEmail',
    'selectedHotmail.email',
    'hotmail.email',
    'email',
    'accountEmail',
    'account.email',
    'selectedAccount.email',
    'oauth.email',
  ]);
}

function extractCode(payload) {
  return pickString(payload, [
    'code',
    'verificationCode',
    'latestCode',
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
    email: extractEmail(state) || context?.email || '',
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
  const words = ['continue', 'next', 'sign in', 'log in', '继续', '下一步', '登录', '登入'];
  for (let attempt = 0; attempt < EMAIL_CONTINUE_RETRIES; attempt += 1) {
    assertRunning(run);
    if (attempt > 0) {
      await wait(EMAIL_CONTINUE_RETRY_MS, run);
    }
    const result = await callOpenAI(tabId, 'CLICK_ACTION', { words }, frameId).catch(() => null);
    if (result?.ok || result?.text) {
      return result;
    }
  }
  return { ok: false, error: 'email_continue_not_clickable' };
}

async function startOAuthFromApp(localTabId) {
  setStatus({ phase: 'app_state', message: 'Reading selected account from local app.' });
  const currentState = await callCpaBridge(localTabId, 'GET_STATE');
  let started = currentState;

  if (!extractAuthUrl(currentState)) {
    setStatus({ phase: 'start_oauth', message: 'Requesting a Codex OAuth URL from the local app.' });
    started = await callCpaBridge(localTabId, 'START_OAUTH');
  }

  const authUrl = extractAuthUrl(started) || extractAuthUrl(currentState);
  if (!authUrl || !core.isOpenAIAuthUrl(authUrl)) {
    throw new Error('The local app did not return a supported OpenAI OAuth URL.');
  }

  return {
    authUrl,
    email: extractEmail(started) || extractEmail(currentState),
    state: extractState(started) || extractState(currentState),
  };
}

async function submitCallback(run, callbackUrl) {
  const parsed = core.parseCallbackUrl(callbackUrl);
  if (!parsed.ok) {
    throw new Error(`Ignoring invalid callback URL: ${parsed.reason}`);
  }

  setStatus({
    phase: 'callback',
    message: 'Submitting OAuth callback to the local app.',
    callbackUrl,
  });
  await callCpaBridge(run.localTabId, 'SUBMIT_CALLBACK', { redirectUrl: callbackUrl });

  setStatus({ phase: 'status_check', message: 'Checking Codex OAuth status.' });
  const statusResult = await callCpaBridge(run.localTabId, 'CHECK_STATUS');
  setStatus({
    phase: 'done',
    message: 'OAuth callback submitted. Status check completed.',
    result: statusResult,
    running: false,
  });
}

async function handleOpenAIState(run, tab, context) {
  const state = await classifyOpenAI(tab);
  const frameId = Number.isInteger(state.frameId) ? state.frameId : 0;
  context.openAIFrameId = frameId;

  if (state.state === 'manual_required') {
    const diagnostics = getTabDiagnostics(tab, state, context);
    setStatus({
      phase: 'manual_required',
      message: formatDiagnosticsMessage('Manual OpenAI verification required', diagnostics),
      running: false,
      ...diagnostics,
      openAIState: state,
    });
    run.stopRequested = true;
    return;
  }

  if (state.state === 'email') {
    if (!context.email) {
      setStatus({
        phase: 'manual_required',
        message: 'OpenAI email page detected, but the local app did not provide an email.',
        running: false,
      });
      run.stopRequested = true;
      return;
    }
    setStatus({ phase: 'email', message: `Filling OpenAI email: ${context.email}.` });
    const fillResult = await callOpenAI(tab.id, 'FILL_EMAIL', { email: context.email }, frameId);
    context.email = extractEmail(fillResult) || context.email;
    setStatus({ phase: 'email', message: 'Email filled. Clicking continue.' });
    const clickResult = await clickEmailContinue(tab.id, run, frameId);
    if (!clickResult?.ok) {
      setStatus({ phase: 'email', message: 'Email filled. Waiting for the continue button to become clickable.' });
    }
    return;
  }

  if (state.state === 'verification') {
    const pageEmail = extractEmail(state) || await readOpenAIEmail(tab.id, frameId);
    const codeEmail = pageEmail || context.email;
    if (!codeEmail) {
      setStatus({
        phase: 'manual_required',
        message: 'Verification page detected, but no filled email could be read.',
        running: false,
      });
      run.stopRequested = true;
      return;
    }
    context.email = codeEmail;
    setStatus({ phase: 'verification', message: `Reading verification code for ${codeEmail}.` });
    const codeResult = await callCpaBridge(run.localTabId, 'FETCH_CODE', {
      email: codeEmail,
      state: context.state,
    });
    const code = extractCode(codeResult);
    if (!code) {
      await wait(CODE_RETRY_INTERVAL_MS, run);
      return;
    }
    setStatus({ phase: 'verification', message: `Filling OpenAI verification code for ${codeEmail}.` });
    await callOpenAI(tab.id, 'FILL_CODE', { code }, frameId);
    await callOpenAI(tab.id, 'CLICK_ACTION', { words: ['continue', 'submit', 'verify', 'next', '继续', '提交', '验证', '下一步'] }, frameId).catch(() => null);
    return;
  }

  if (state.state === 'consent') {
    setStatus({ phase: 'consent', message: 'Clicking OpenAI consent/authorize control.' });
    await callOpenAI(tab.id, 'CLICK_ACTION', { words: ['authorize', 'authorise', 'allow', 'continue', 'confirm', '授权', '允许', '同意', '继续', '确认'] }, frameId);
    return;
  }

  const diagnostics = getTabDiagnostics(tab, state, context);
  setStatus({
    phase: 'waiting',
    message: formatDiagnosticsMessage('Waiting for OpenAI page to reach a recognizable OAuth step', diagnostics),
    ...diagnostics,
    openAIState: state,
  });
  await callOpenAI(tab.id, 'CLICK_ACTION', { words: ['continue', 'next', '继续', '下一步'] }, frameId).catch(() => null);
}

async function runAutoLogin(run) {
  try {
    const localTab = await getPreferredLocalAppTab('Open the local CPA Codex app tab before starting auto-login.');
    run.localTabId = localTab.id;
    const context = await startOAuthFromApp(localTab.id);

    assertRunning(run);
    setStatus({ phase: 'auth_tab', message: 'Opening OpenAI OAuth tab.' });
    const authTab = await createTab({ url: context.authUrl, active: true });
    run.authTabId = authTab.id;

    const startedAt = Date.now();
    while (Date.now() - startedAt < FLOW_TIMEOUT_MS) {
      assertRunning(run);

      if (run.callbackUrl) {
        await submitCallback(run, run.callbackUrl);
        return;
      }

      const tab = await getTab(run.authTabId);
      if (core.isCallbackUrl(tab.url)) {
        await submitCallback(run, tab.url);
        return;
      }

      if (core.isOpenAIAuthUrl(tab.url)) {
        await handleOpenAIState(run, tab, context);
        if (run.stopRequested) {
          return;
        }
      } else {
        setStatus({ phase: 'navigation', message: 'Waiting for OpenAI OAuth navigation.', url: tab.url || '' });
      }

      await wait(LOOP_INTERVAL_MS, run);
    }

    throw new Error('OAuth auto-login timed out before a local callback was captured.');
  } catch (error) {
    if (error?.name === 'AbortError' || activeRun?.stopRequested) {
      setStatus({ phase: 'stopped', message: 'Auto-login stopped.', running: false });
      return;
    }
    setStatus({ phase: 'error', message: makeErrorMessage(error), running: false });
  } finally {
    if (activeRun === run) {
      activeRun = null;
    }
  }
}

function startAutoLogin() {
  if (activeRun && !activeRun.stopRequested) {
    return lastStatus;
  }

  activeRun = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    localTabId: 0,
    authTabId: 0,
    callbackUrl: '',
    stopRequested: false,
  };
  setStatus({ phase: 'starting', message: 'Starting Codex OAuth auto-login.', running: true });
  runAutoLogin(activeRun);
  return lastStatus;
}

function stopAutoLogin() {
  if (activeRun) {
    activeRun.stopRequested = true;
  }
  return setStatus({ phase: 'stopped', message: 'Stop requested.', running: false });
}

async function readAccountPools() {
  const localTab = await getPreferredLocalAppTab('Open the local CPA Codex app tab before reading account pools.');
  return callCpaBridge(localTab.id, 'GET_ACCOUNT_POOLS');
}

function handleNavigation(details) {
  if (!activeRun || details.tabId !== activeRun.authTabId || !details.url) {
    return;
  }
  if (core.isCallbackUrl(details.url)) {
    activeRun.callbackUrl = details.url;
  }
}

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

  if (message.action === 'START_AUTO_LOGIN') {
    sendResponse({ ok: true, status: startAutoLogin() });
    return false;
  }
  if (message.action === 'STOP_AUTO_LOGIN') {
    sendResponse({ ok: true, status: stopAutoLogin() });
    return false;
  }
  if (message.action === 'GET_STATUS') {
    sendResponse({ ok: true, status: lastStatus });
    return false;
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
