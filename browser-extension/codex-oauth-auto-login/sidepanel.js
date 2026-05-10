(function initSidePanel() {
  const POLL_INTERVAL_MS = 1500;
  const MAX_RECENT_ERRORS = 6;
  const MAX_OPERATION_LOG = 12;
  const QUEUE_STATS = [
    ['total', '全部'],
    ['queued', '排队'],
    ['running', '运行中'],
    ['callbackSubmitted', '已回调'],
    ['manualRequired', '需人工'],
    ['failed', '失败'],
  ];
  const DEFAULT_SETTINGS = Object.freeze({
    stepWaitMs: 5000,
    clickProgressTimeoutMs: 3000,
    blockedSkipDelayMs: 30000,
    betweenJobsDelayMs: 30000,
    jobTimeoutMs: 300000,
  });
  const SETTING_FIELDS = Object.freeze([
    ['stepWaitMs', 'setting-step-wait', DEFAULT_SETTINGS.stepWaitMs, 1000, 60000],
    ['clickProgressTimeoutMs', 'setting-click-timeout', DEFAULT_SETTINGS.clickProgressTimeoutMs, 1000, 60000],
    ['jobTimeoutMs', 'setting-job-timeout', DEFAULT_SETTINGS.jobTimeoutMs, 30000, 1800000],
    ['blockedSkipDelayMs', 'setting-skip-delay', DEFAULT_SETTINGS.blockedSkipDelayMs, 0, 600000],
    ['betweenJobsDelayMs', 'setting-between-jobs-delay', DEFAULT_SETTINGS.betweenJobsDelayMs, 0, 600000],
  ]);

  /**
   * Public batch status rendered by this side panel:
   * {
   *   phase,
   *   running,
   *   currentJob: { jobId, accountEmail, status, attempt, lastError },
   *   queueSummary,
   *   recentErrors,
   *   operationLog: [{ timestamp, phase, message, accountEmail }]
   * }
   */

  const startButton = document.getElementById('start-batch');
  const stopButton = document.getElementById('stop-batch');
  const pauseButton = document.getElementById('pause-batch');
  const resumeButton = document.getElementById('resume-batch');
  const buildQueueButton = document.getElementById('build-queue');
  const readPoolsButton = document.getElementById('read-pools');
  const saveSettingsButton = document.getElementById('save-settings');
  const resetSettingsButton = document.getElementById('reset-settings');
  const settingsState = document.getElementById('settings-state');
  const phase = document.getElementById('phase');
  const message = document.getElementById('message');
  const updated = document.getElementById('updated');
  const dot = document.getElementById('state-dot');
  const queueTotal = document.getElementById('queue-total');
  const queueStats = document.getElementById('queue-stats');
  const currentJob = document.getElementById('current-job');
  const recentErrors = document.getElementById('recent-errors');
  const operationLog = document.getElementById('operation-log');
  const invalidCount = document.getElementById('invalid-count');
  const hotmailCount = document.getElementById('hotmail-count');
  const invalidList = document.getElementById('invalid-list');
  const hotmailList = document.getElementById('hotmail-list');
  const settingInputs = Object.fromEntries(SETTING_FIELDS.map(([, elementId]) => [
    elementId,
    document.getElementById(elementId),
  ]));

  let latestStatus = normalizeStatus();
  let queueRecentErrors = [];
  let panelRecentErrors = [];
  let latestSettings = { ...DEFAULT_SETTINGS };

  function send(action, payload = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'CPA_OAUTH_PANEL', action, payload }, (response) => {
        const runtimeError = chrome.runtime?.lastError?.message || '';
        if (runtimeError) {
          resolve({ ok: false, error: runtimeError });
          return;
        }
        resolve(response || { ok: false, error: 'No response.' });
      });
    });
  }

  function asText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function asCount(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
  }

  function clampMs(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.trunc(number)));
  }

  function normalizeSettings(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    return Object.fromEntries(SETTING_FIELDS.map(([key, , fallback, min, max]) => [
      key,
      clampMs(source[key], fallback, min, max),
    ]));
  }

  function secondsToMs(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return clampMs(number * 1000, fallback, min, max);
  }

  function formatSeconds(ms) {
    const seconds = Number(ms) / 1000;
    if (!Number.isFinite(seconds)) {
      return '';
    }
    return Number.isInteger(seconds) ? String(seconds) : String(Math.round(seconds * 10) / 10);
  }

  function redactForDisplay(value) {
    return asText(value)
      .replace(/([?&](?:code|token)=)[^&\s]+/gi, '$1[redacted]')
      .replace(/\b((?:code|token|secret|pass(?:word)?|authorization|cookie|refresh[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
      .replace(/\b\d{6,8}\b/g, '[redacted]');
  }

  function normalizeCurrentJob(job) {
    if (!job || typeof job !== 'object') {
      return null;
    }
    return {
      jobId: asText(job.jobId),
      accountEmail: asText(job.accountEmail),
      status: asText(job.status),
      attempt: asCount(job.attempt),
      lastError: redactForDisplay(job.lastError || job.oauthError || job.error),
    };
  }

  function normalizeQueueSummary(summary) {
    if (!summary || typeof summary !== 'object') {
      return null;
    }
    return QUEUE_STATS.reduce((normalized, [key]) => ({
      ...normalized,
      [key]: asCount(summary[key]),
    }), {});
  }

  function normalizeError(error) {
    if (!error) {
      return null;
    }
    if (typeof error === 'string') {
      return { message: redactForDisplay(error) };
    }
    if (typeof error !== 'object') {
      return { message: redactForDisplay(String(error)) };
    }
    const message = redactForDisplay(error.message || error.lastError || error.error || error.code || error.phase);
    if (!message) {
      return null;
    }
    return {
      jobId: asText(error.jobId),
      accountEmail: asText(error.accountEmail),
      status: asText(error.status || error.phase),
      message,
    };
  }

  function normalizeRecentErrors(errors) {
    if (!Array.isArray(errors)) {
      return [];
    }
    return errors.map(normalizeError).filter(Boolean).slice(0, MAX_RECENT_ERRORS);
  }

  function normalizeOperationLog(log) {
    if (!Array.isArray(log)) {
      return [];
    }
    return log
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        const message = redactForDisplay(entry.message);
        if (!message) {
          return null;
        }
        const timestamp = Number(entry.timestamp);
        return {
          timestamp: Number.isFinite(timestamp) ? timestamp : 0,
          phase: asText(entry.phase),
          message,
          accountEmail: asText(entry.accountEmail),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_OPERATION_LOG);
  }

  function normalizeStatus(input = {}) {
    const status = input && typeof input === 'object' ? input : {};
    return {
      phase: asText(status.phase) || 'idle',
      message: redactForDisplay(status.message),
      running: Boolean(status.running),
      updatedAt: status.updatedAt || null,
      currentJob: normalizeCurrentJob(status.currentJob),
      queueSummary: normalizeQueueSummary(status.queueSummary),
      recentErrors: normalizeRecentErrors(status.recentErrors),
      operationLog: normalizeOperationLog(status.operationLog),
    };
  }

  function statusClass(status) {
    if (!status) return 'idle';
    if (status.phase === 'done') return 'done';
    if (status.phase === 'error') return 'error';
    if (status.phase === 'manual_required') return 'manual_required';
    if (status.running) return 'running';
    return 'idle';
  }

  function setButtonState(status) {
    const current = normalizeStatus(status);
    const phaseName = current.phase;
    const paused = phaseName === 'paused' || phaseName === 'pausing';
    const active = current.running || paused || phaseName === 'starting' || phaseName === 'resuming';

    startButton.disabled = current.running || paused || phaseName === 'starting' || phaseName === 'resuming';
    pauseButton.disabled = !current.running || paused;
    resumeButton.disabled = !paused;
    stopButton.disabled = !active;
  }

  function renderStatus(status, fallbackError = '') {
    const current = normalizeStatus(status);
    latestStatus = current;
    const phaseLabel = current.phase || 'idle';
    phase.textContent = phaseLabel.replace(/_/g, ' ');
    message.textContent = current.message || redactForDisplay(fallbackError) || 'Ready.';
    updated.textContent = current.updatedAt
      ? new Date(current.updatedAt).toLocaleTimeString()
      : '';
    dot.className = `dot ${statusClass(current)}`;
    setButtonState(current);
    renderQueueSummary(current.queueSummary);
    renderCurrentJob(current.currentJob);
    renderRecentErrors(current);
    renderOperationLog(current.operationLog);
  }

  function setSettingsBusy(busy) {
    saveSettingsButton.disabled = Boolean(busy);
    resetSettingsButton.disabled = Boolean(busy);
  }

  function renderSettings(settings, stateText = '已读取') {
    latestSettings = normalizeSettings(settings);
    for (const [key, elementId] of SETTING_FIELDS) {
      const input = settingInputs[elementId];
      if (input) {
        input.value = formatSeconds(latestSettings[key]);
      }
    }
    settingsState.textContent = stateText;
  }

  function readSettingsForm() {
    return Object.fromEntries(SETTING_FIELDS.map(([key, elementId, fallback, min, max]) => [
      key,
      secondsToMs(settingInputs[elementId]?.value, fallback, min, max),
    ]));
  }

  async function loadSettings() {
    settingsState.textContent = '读取中';
    setSettingsBusy(true);
    const response = await send('GET_SETTINGS');
    setSettingsBusy(false);
    if (!response.ok) {
      rememberPanelError(response.error, 'GET_SETTINGS');
      renderSettings(latestSettings, '默认值');
      renderStatus(response.status, response.error);
      return;
    }
    renderSettings(response.result?.settings, '已读取');
    renderStatus(response.status, response.error);
  }

  async function saveSettings() {
    settingsState.textContent = '保存中';
    setSettingsBusy(true);
    const response = await send('SAVE_SETTINGS', readSettingsForm());
    setSettingsBusy(false);
    if (!response.ok) {
      rememberPanelError(response.error, 'SAVE_SETTINGS');
      settingsState.textContent = '保存失败';
      renderStatus(response.status, response.error);
      return;
    }
    renderSettings(response.result?.settings, '已保存');
    renderStatus(response.status, response.error);
  }

  async function resetSettings() {
    settingsState.textContent = '重置中';
    setSettingsBusy(true);
    const response = await send('RESET_SETTINGS');
    setSettingsBusy(false);
    if (!response.ok) {
      rememberPanelError(response.error, 'RESET_SETTINGS');
      settingsState.textContent = '重置失败';
      renderStatus(response.status, response.error);
      return;
    }
    renderSettings(response.result?.settings, '已重置');
    renderStatus(response.status, response.error);
  }

  function clearList(container, emptyText) {
    container.replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyText;
    container.appendChild(empty);
  }

  function appendMeta(parent, text, className = 'meta') {
    const meta = document.createElement('span');
    meta.className = className;
    meta.textContent = text;
    parent.appendChild(meta);
  }

  function renderQueueSummary(summary) {
    queueStats.replaceChildren();
    const safeSummary = summary || normalizeQueueSummary({});
    queueTotal.textContent = `${safeSummary.total || 0} total`;

    for (const [key, label] of QUEUE_STATS) {
      const row = document.createElement('div');
      row.className = 'queue-stat';
      const name = document.createElement('span');
      name.textContent = label;
      const value = document.createElement('strong');
      value.textContent = String(safeSummary[key] || 0);
      row.append(name, value);
      queueStats.appendChild(row);
    }
  }

  function renderCurrentJob(job) {
    currentJob.replaceChildren();
    const fields = job
      ? [
          ['账号', job.accountEmail || '-'],
          ['Job ID', job.jobId || '-'],
          ['状态', job.status || '-'],
          ['尝试', String(job.attempt || 0)],
          ['错误', job.lastError || '-'],
        ]
      : [
          ['账号', '-'],
          ['Job ID', '-'],
          ['状态', '暂无运行任务'],
          ['尝试', '0'],
          ['错误', '-'],
        ];

    for (const [label, value] of fields) {
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      detail.textContent = value;
      currentJob.append(term, detail);
    }
  }

  function collectQueueErrors(jobs) {
    if (!Array.isArray(jobs)) {
      queueRecentErrors = [];
      return;
    }
    queueRecentErrors = jobs
      .filter((job) => job && (job.lastError || job.oauthError || job.manualReason))
      .slice(-MAX_RECENT_ERRORS)
      .reverse()
      .map((job) => normalizeError({
        jobId: job.jobId,
        accountEmail: job.accountEmail,
        status: job.status,
        message: job.lastError || job.oauthError || job.manualReason,
      }))
      .filter(Boolean);
  }

  function rememberPanelError(error, action) {
    const item = normalizeError({
      status: action,
      message: error || 'Unknown error.',
    });
    if (!item) {
      return;
    }
    panelRecentErrors = [item, ...panelRecentErrors].slice(0, MAX_RECENT_ERRORS);
  }

  function renderRecentErrors(status) {
    const combined = [
      ...(status?.recentErrors || []),
      ...queueRecentErrors,
      ...panelRecentErrors,
    ].slice(0, MAX_RECENT_ERRORS);

    recentErrors.replaceChildren();
    if (!combined.length) {
      clearList(recentErrors, '暂无错误');
      return;
    }

    for (const error of combined) {
      const row = document.createElement('article');
      row.className = 'error-row';
      const title = document.createElement('strong');
      title.textContent = error.accountEmail || error.jobId || error.status || '错误';
      row.appendChild(title);
      appendMeta(row, error.message || '-');
      if (error.status || error.jobId) {
        appendMeta(row, [error.status, error.jobId].filter(Boolean).join(' · '));
      }
      recentErrors.appendChild(row);
    }
  }

  function renderOperationLog(log) {
    operationLog.replaceChildren();
    if (!log.length) {
      clearList(operationLog, '暂无操作日志');
      return;
    }

    for (const entry of log) {
      const row = document.createElement('div');
      row.className = 'operation-log-row';
      const time = document.createElement('time');
      time.dateTime = entry.timestamp ? new Date(entry.timestamp).toISOString() : '';
      time.textContent = entry.timestamp
        ? new Date(entry.timestamp).toLocaleTimeString()
        : '--:--:--';
      const text = document.createElement('span');
      text.textContent = entry.message;
      row.append(time, text);
      operationLog.appendChild(row);
    }
  }

  function renderInvalidAccounts(accounts) {
    invalidList.replaceChildren();
    if (!accounts.length) {
      clearList(invalidList, '暂无失效账号');
      return;
    }
    for (const account of accounts) {
      const row = document.createElement('article');
      row.className = 'row';
      const title = document.createElement('strong');
      title.textContent = account.email || account.name || account.authIndex || '-';
      row.appendChild(title);
      appendMeta(row, `${account.reason || account.status || 'unknown'} · ${account.planType || 'unknown'} · ${account.authIndex || '-'}`);
      invalidList.appendChild(row);
    }
  }

  function renderHotmailAccounts(accounts) {
    hotmailList.replaceChildren();
    if (!accounts.length) {
      clearList(hotmailList, '暂无 Hotmail 账号');
      return;
    }
    for (const account of accounts) {
      const row = document.createElement('article');
      row.className = 'row';
      const title = document.createElement('strong');
      title.textContent = account.email || '-';
      row.appendChild(title);
      appendMeta(row, `状态：${account.status || 'pending'}`);
      if (account.clientId) {
        appendMeta(row, `Client ID：${account.clientId}`);
      }
      if (account.lastError) {
        appendMeta(row, `错误：${redactForDisplay(account.lastError)}`);
      }
      hotmailList.appendChild(row);
    }
  }

  function renderPools(result) {
    const pools = result?.pools || {};
    const invalidAccounts = Array.isArray(pools.invalidAccounts) ? pools.invalidAccounts : [];
    const hotmailAccounts = Array.isArray(pools.hotmailAccounts) ? pools.hotmailAccounts : [];
    invalidCount.textContent = String(pools.counts?.invalidAccounts ?? invalidAccounts.length);
    hotmailCount.textContent = String(pools.counts?.hotmailAccounts ?? hotmailAccounts.length);
    renderInvalidAccounts(invalidAccounts);
    renderHotmailAccounts(hotmailAccounts);
  }

  function renderQueueResult(result) {
    if (result?.summary) {
      renderQueueSummary(normalizeQueueSummary(result.summary));
    }
    collectQueueErrors(result?.jobs);
    renderRecentErrors(latestStatus);
  }

  async function refreshStatus() {
    const response = await send('GET_STATUS');
    if (!response.ok) {
      rememberPanelError(response.error, 'GET_STATUS');
    }
    renderStatus(response.status, response.error);
  }

  async function readPools() {
    readPoolsButton.disabled = true;
    const response = await send('READ_ACCOUNT_POOLS');
    readPoolsButton.disabled = false;
    if (!response.ok) {
      rememberPanelError(response.error, 'READ_ACCOUNT_POOLS');
    }
    renderStatus(response.status, response.error);
    if (!response.ok) {
      return;
    }
    renderPools(response.result);
  }

  async function buildQueue() {
    buildQueueButton.disabled = true;
    renderStatus({
      ...latestStatus,
      phase: 'building_queue',
      message: '正在生成 OAuth 队列...',
    });
    const response = await send('BUILD_QUEUE');
    buildQueueButton.disabled = false;
    if (!response.ok) {
      rememberPanelError(response.error, 'BUILD_QUEUE');
    }
    renderStatus(response.status, response.error);
    if (response.ok) {
      renderQueueResult(response.result);
    }
  }

  async function runBatchAction(action, optimisticStatus) {
    renderStatus({
      ...latestStatus,
      ...optimisticStatus,
      updatedAt: Date.now(),
    });
    const response = await send(action);
    if (!response.ok) {
      rememberPanelError(response.error, action);
    }
    renderStatus(response.status, response.error);
  }

  startButton.addEventListener('click', async () => {
    await runBatchAction('START_BATCH_LOGIN', {
      phase: 'starting',
      message: '正在启动批量登录...',
      running: true,
    });
  });

  stopButton.addEventListener('click', async () => {
    await runBatchAction('STOP_BATCH', {
      phase: 'stopping',
      message: '正在停止批量登录...',
    });
  });

  pauseButton.addEventListener('click', async () => {
    await runBatchAction('PAUSE_BATCH', {
      phase: 'pausing',
      message: '正在请求暂停...',
    });
  });

  resumeButton.addEventListener('click', async () => {
    await runBatchAction('RESUME_BATCH', {
      phase: 'resuming',
      message: '正在继续批量登录...',
      running: true,
    });
  });

  readPoolsButton.addEventListener('click', readPools);
  buildQueueButton.addEventListener('click', buildQueue);
  saveSettingsButton.addEventListener('click', saveSettings);
  resetSettingsButton.addEventListener('click', resetSettings);

  renderSettings(DEFAULT_SETTINGS, '默认值');
  loadSettings();
  refreshStatus();
  renderQueueSummary(null);
  renderCurrentJob(null);
  setInterval(refreshStatus, POLL_INTERVAL_MS);
})();
