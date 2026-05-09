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

  function pickPreferredLocalAppTab(tabs = []) {
    const localTabs = tabs.filter((tab) => isLocalAppUrl(tab?.url));
    return localTabs.find((tab) => tab.active) || localTabs[0] || null;
  }

  return {
    CALLBACK_PATHS,
    LOCAL_HOSTS,
    OPENAI_AUTH_HOSTS,
    OPENAI_CLEAR_ORIGINS,
    OPENAI_RELATED_HOSTS,
    buildOpenAISessionRemovalOptions,
    createSafeStatus,
    isCallbackUrl,
    isLocalAppUrl,
    isOpenAIAuthUrl,
    isOpenAIRelatedUrl,
    parseCallbackUrl,
    parseUrl,
    pickPreferredLocalAppTab,
    redactSecrets,
  };
});
