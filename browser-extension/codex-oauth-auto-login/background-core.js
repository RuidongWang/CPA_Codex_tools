(function attachCpaCodexOAuthBackgroundCore(root, factory) {
  const api = factory();
  root.CpaCodexOAuthBackgroundCore = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createBackgroundCore() {
  const LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1']);
  const LOCAL_HOST_SET = new Set(LOCAL_HOSTS);
  const OPENAI_AUTH_HOSTS = Object.freeze([
    'auth.openai.com',
    'auth0.openai.com',
    'accounts.openai.com',
  ]);
  const OPENAI_AUTH_HOST_SET = new Set(OPENAI_AUTH_HOSTS);
  const OPENAI_CLEAR_ORIGINS = Object.freeze([
    'https://auth.openai.com',
    'https://auth0.openai.com',
    'https://accounts.openai.com',
    'https://chatgpt.com',
    'https://chat.openai.com',
    'https://platform.openai.com',
    'https://openai.com',
  ]);
  const OPENAI_RELATED_HOSTS = Object.freeze(OPENAI_CLEAR_ORIGINS.map((origin) => new URL(origin).hostname));
  const OPENAI_RELATED_HOST_SET = new Set(OPENAI_RELATED_HOSTS);
  const CALLBACK_PATHS = Object.freeze(['/auth/callback', '/codex/callback']);
  const CALLBACK_PATH_SET = new Set(CALLBACK_PATHS);
  const SECRET_KEY_PATTERN = /(code|token|secret|password|refresh|authorization|cookie)/i;
  const OTP_CODE_FETCH_EXTRA_WAIT_MS = 5000;
  const DEFAULT_AUTOMATION_SETTINGS = Object.freeze({
    stepWaitMs: 5000,
    clickProgressTimeoutMs: 3000,
    blockedSkipDelayMs: 30000,
    betweenJobsDelayMs: 30000,
    jobTimeoutMs: 5 * 60 * 1000,
  });
  const AUTOMATION_SETTING_LIMITS = Object.freeze({
    stepWaitMs: Object.freeze({ min: 1000, max: 60000 }),
    clickProgressTimeoutMs: Object.freeze({ min: 1000, max: 60000 }),
    blockedSkipDelayMs: Object.freeze({ min: 0, max: 10 * 60 * 1000 }),
    betweenJobsDelayMs: Object.freeze({ min: 0, max: 10 * 60 * 1000 }),
    jobTimeoutMs: Object.freeze({ min: 30000, max: 30 * 60 * 1000 }),
  });

  function asString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function parseUrl(value) {
    try {
      return new URL(String(value || ''));
    } catch {
      return null;
    }
  }

  function isLocalAppUrl(value) {
    const parsed = parseUrl(value);
    return Boolean(parsed && parsed.protocol === 'http:' && LOCAL_HOST_SET.has(parsed.hostname));
  }

  function isOpenAIAuthUrl(value) {
    const parsed = parseUrl(value);
    return Boolean(parsed && parsed.protocol === 'https:' && OPENAI_AUTH_HOST_SET.has(parsed.hostname));
  }

  function isOpenAIRelatedUrl(value) {
    const parsed = parseUrl(value);
    return Boolean(parsed && parsed.protocol === 'https:' && OPENAI_RELATED_HOST_SET.has(parsed.hostname));
  }

  function buildOpenAISessionRemovalOptions() {
    return {
      options: {
        origins: [...OPENAI_CLEAR_ORIGINS],
      },
      dataToRemove: {
        cacheStorage: true,
        cookies: true,
        fileSystems: true,
        indexedDB: true,
        localStorage: true,
        serviceWorkers: true,
        webSQL: true,
      },
    };
  }

  function parseCallbackUrl(value) {
    const parsed = parseUrl(value);
    if (!parsed) {
      return { ok: false, reason: 'invalid_url', url: String(value || '') };
    }
    if (!isLocalAppUrl(parsed.href)) {
      return { ok: false, reason: 'not_local_app', url: parsed.href };
    }
    if (!CALLBACK_PATH_SET.has(parsed.pathname)) {
      return { ok: false, reason: 'unsupported_callback_path', url: parsed.href };
    }

    const state = parsed.searchParams.get('state') || '';
    const code = parsed.searchParams.get('code') || '';
    const error = parsed.searchParams.get('error') || '';
    if (!state) {
      return { ok: false, reason: 'missing_state', url: parsed.href };
    }
    if (!code && !error) {
      return { ok: false, reason: 'missing_code_or_error', url: parsed.href };
    }

    return {
      ok: true,
      url: parsed.href,
      state,
      code,
      error,
      pathname: parsed.pathname,
      host: parsed.host,
    };
  }

  function isCallbackUrl(value) {
    return parseCallbackUrl(value).ok;
  }

  function redactCallbackUrl(value) {
    const parsed = parseUrl(value);
    if (!parsed || !isCallbackUrl(parsed.href)) {
      return value;
    }
    for (const key of ['code']) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, '[redacted]');
      }
    }
    return parsed.href;
  }

  function redactSecrets(value, key = '') {
    if (value == null) {
      return value;
    }
    if (SECRET_KEY_PATTERN.test(key)) {
      return '[redacted]';
    }
    if (typeof value === 'string') {
      return redactCallbackUrl(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => redactSecrets(item));
    }
    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          redactSecrets(entryValue, entryKey),
        ])
      );
    }
    return value;
  }

  function createSafeStatus(input = {}) {
    const safe = redactSecrets(input);
    return {
      phase: String(safe.phase || 'idle'),
      message: String(safe.message || ''),
      running: Boolean(safe.running),
      ...safe,
      updatedAt: Date.now(),
    };
  }

  function normalizeMillisecondsSetting(value, fallback, limits) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(limits.max, Math.max(limits.min, Math.trunc(number)));
  }

  function normalizeAutomationSettings(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    return {
      stepWaitMs: normalizeMillisecondsSetting(
        source.stepWaitMs,
        DEFAULT_AUTOMATION_SETTINGS.stepWaitMs,
        AUTOMATION_SETTING_LIMITS.stepWaitMs
      ),
      clickProgressTimeoutMs: normalizeMillisecondsSetting(
        source.clickProgressTimeoutMs,
        DEFAULT_AUTOMATION_SETTINGS.clickProgressTimeoutMs,
        AUTOMATION_SETTING_LIMITS.clickProgressTimeoutMs
      ),
      blockedSkipDelayMs: normalizeMillisecondsSetting(
        source.blockedSkipDelayMs,
        DEFAULT_AUTOMATION_SETTINGS.blockedSkipDelayMs,
        AUTOMATION_SETTING_LIMITS.blockedSkipDelayMs
      ),
      betweenJobsDelayMs: normalizeMillisecondsSetting(
        source.betweenJobsDelayMs,
        DEFAULT_AUTOMATION_SETTINGS.betweenJobsDelayMs,
        AUTOMATION_SETTING_LIMITS.betweenJobsDelayMs
      ),
      jobTimeoutMs: normalizeMillisecondsSetting(
        source.jobTimeoutMs,
        DEFAULT_AUTOMATION_SETTINGS.jobTimeoutMs,
        AUTOMATION_SETTING_LIMITS.jobTimeoutMs
      ),
    };
  }

  function pickPreferredLocalAppTab(tabs = []) {
    const localTabs = tabs.filter((tab) => isLocalAppUrl(tab?.url));
    return localTabs.find((tab) => tab.active) || localTabs[0] || null;
  }

  function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function buildTrustedClickMouseEvents(rect = {}) {
    const x = toFiniteNumber(rect.centerX);
    const y = toFiniteNumber(rect.centerY);
    return [
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseMoved', x, y, button: 'none' },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
      },
    ];
  }

  function normalizeOpenAIActionFailure(action, response = {}) {
    const rawError = response?.error;
    const actionError = rawError && typeof rawError === 'object' ? rawError : {};
    const stringError = typeof rawError === 'string' ? asString(rawError) : '';
    const code = asString(actionError.code) || asString(response?.code) || stringError || asString(response?.errorType) || 'openai_action_failed';
    const errorType = asString(actionError.errorType) || asString(response?.errorType) || '';
    const message = asString(actionError.message)
      || stringError
      || asString(response?.message)
      || `OpenAI helper action failed: ${action}`;
    return {
      action: asString(action),
      message,
      code,
      errorType,
    };
  }

  function computeOtpCodeFetchDelayMs(shouldWait, extraWaitMs = OTP_CODE_FETCH_EXTRA_WAIT_MS) {
    const extraWait = Number(extraWaitMs);
    if (!shouldWait || !Number.isFinite(extraWait) || extraWait <= 0) {
      return 0;
    }
    return Math.trunc(extraWait);
  }

  return {
    AUTOMATION_SETTING_LIMITS,
    CALLBACK_PATHS,
    DEFAULT_AUTOMATION_SETTINGS,
    LOCAL_HOSTS,
    OTP_CODE_FETCH_EXTRA_WAIT_MS,
    OPENAI_AUTH_HOSTS,
    OPENAI_CLEAR_ORIGINS,
    OPENAI_RELATED_HOSTS,
    buildOpenAISessionRemovalOptions,
    buildTrustedClickMouseEvents,
    computeOtpCodeFetchDelayMs,
    createSafeStatus,
    isCallbackUrl,
    isLocalAppUrl,
    isOpenAIAuthUrl,
    isOpenAIRelatedUrl,
    normalizeAutomationSettings,
    normalizeOpenAIActionFailure,
    parseCallbackUrl,
    parseUrl,
    pickPreferredLocalAppTab,
    redactSecrets,
  };
});
