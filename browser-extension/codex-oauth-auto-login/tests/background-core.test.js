const assert = require('node:assert/strict');
const test = require('node:test');

const core = require('../background-core.js');

test('detects local app URLs only on localhost and 127.0.0.1 over http', () => {
  assert.equal(core.isLocalAppUrl('http://localhost:5173/oauth'), true);
  assert.equal(core.isLocalAppUrl('http://127.0.0.1:5173/oauth'), true);
  assert.equal(core.isLocalAppUrl('https://localhost/oauth'), false);
  assert.equal(core.isLocalAppUrl('http://example.com/oauth'), false);
});

test('detects supported OpenAI auth hosts only', () => {
  assert.equal(core.isOpenAIAuthUrl('https://auth.openai.com/authorize'), true);
  assert.equal(core.isOpenAIAuthUrl('https://auth0.openai.com/u/login'), true);
  assert.equal(core.isOpenAIAuthUrl('https://accounts.openai.com/consent'), true);
  assert.equal(core.isOpenAIAuthUrl('https://chat.openai.com/'), false);
});

test('lists OpenAI session clearing origins in stable order', () => {
  assert.deepEqual(core.OPENAI_CLEAR_ORIGINS, [
    'https://auth.openai.com',
    'https://auth0.openai.com',
    'https://accounts.openai.com',
    'https://chatgpt.com',
    'https://chat.openai.com',
    'https://platform.openai.com',
    'https://openai.com',
  ]);
});

test('detects OpenAI related URLs only on allowed https hosts', () => {
  assert.equal(core.isOpenAIRelatedUrl('https://auth.openai.com/authorize'), true);
  assert.equal(core.isOpenAIRelatedUrl('https://auth0.openai.com/u/login'), true);
  assert.equal(core.isOpenAIRelatedUrl('https://accounts.openai.com/consent'), true);
  assert.equal(core.isOpenAIRelatedUrl('https://chatgpt.com/'), true);
  assert.equal(core.isOpenAIRelatedUrl('https://chat.openai.com/'), true);
  assert.equal(core.isOpenAIRelatedUrl('https://platform.openai.com/account'), true);
  assert.equal(core.isOpenAIRelatedUrl('https://openai.com/'), true);
  assert.equal(core.isOpenAIRelatedUrl('http://auth.openai.com/authorize'), false);
  assert.equal(core.isOpenAIRelatedUrl('https://api.openai.com/'), false);
  assert.equal(core.isOpenAIRelatedUrl('https://evilopenai.com/'), false);
  assert.equal(core.isOpenAIRelatedUrl('not a url'), false);
});

test('builds Chrome browsingData removal options for OpenAI sessions', () => {
  const options = core.buildOpenAISessionRemovalOptions();

  assert.deepEqual(options, {
    options: {
      origins: [
        'https://auth.openai.com',
        'https://auth0.openai.com',
        'https://accounts.openai.com',
        'https://chatgpt.com',
        'https://chat.openai.com',
        'https://platform.openai.com',
        'https://openai.com',
      ],
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
  });
  assert.notEqual(options.options.origins, core.OPENAI_CLEAR_ORIGINS);
});

test('exports immutable host/path lists instead of mutable sets', () => {
  assert.equal(Object.isFrozen(core.LOCAL_HOSTS), true);
  assert.equal(Object.isFrozen(core.OPENAI_AUTH_HOSTS), true);
  assert.equal(Object.isFrozen(core.CALLBACK_PATHS), true);
  assert.equal(Object.isFrozen(core.OPENAI_CLEAR_ORIGINS), true);
  assert.equal(Object.isFrozen(core.OPENAI_RELATED_HOSTS), true);
  assert.equal(Object.isFrozen(core.DEFAULT_PLATFORM_SETTINGS), true);
});

test('normalizes configured platform URL without credentials, query, or trailing slash', () => {
  assert.equal(core.normalizePlatformBaseUrl('http://192.168.1.10:5173/app/?x=1#hash'), 'http://192.168.1.10:5173/app');
  assert.equal(core.normalizePlatformBaseUrl('https://cpa.example.local/'), 'https://cpa.example.local');
  assert.equal(core.normalizePlatformBaseUrl('ftp://cpa.example.local'), '');
  assert.equal(core.normalizePlatformBaseUrl('http://user:pass@cpa.example.local'), '');
  assert.deepEqual(core.normalizePlatformSettings({
    platformBaseUrl: 'http://192.168.1.10:5173/app/',
    platformPasswordSaved: true,
  }), {
    platformBaseUrl: 'http://192.168.1.10:5173/app',
    platformPasswordSaved: true,
  });
});

test('picks a local CPA tab even when it is not the active browser tab', () => {
  const picked = core.pickPreferredLocalAppTab([
    { id: 1, active: true, url: 'https://auth.openai.com/oauth' },
    { id: 2, active: false, url: 'http://127.0.0.1:5173/' },
  ]);

  assert.equal(picked.id, 2);
});

test('prefers the active local CPA tab when multiple local tabs exist', () => {
  const picked = core.pickPreferredLocalAppTab([
    { id: 1, active: false, url: 'http://localhost:5174/' },
    { id: 2, active: true, url: 'http://127.0.0.1:5173/' },
  ]);

  assert.equal(picked.id, 2);
});

test('picks a configured remote CPA tab by origin and base path', () => {
  const settings = core.normalizePlatformSettings({ platformBaseUrl: 'http://192.168.1.10:5173/app/' });
  const picked = core.pickPreferredAppTab([
    { id: 1, active: true, url: 'http://192.168.1.10:5173/other' },
    { id: 2, active: false, url: 'http://127.0.0.1:5173/' },
    { id: 3, active: false, url: 'http://192.168.1.10:5173/app/oauth' },
  ], settings);

  assert.equal(picked.id, 3);
  assert.equal(core.isConfiguredPlatformUrl('http://192.168.1.10:5173/app/settings', settings), true);
  assert.equal(core.isConfiguredPlatformUrl('http://192.168.1.10:5173/other', settings), false);
  assert.equal(core.buildPlatformHostPermissionPattern(settings), 'http://192.168.1.10:5173/*');
});

test('parses valid localhost auth callback with code and state', () => {
  const parsed = core.parseCallbackUrl('http://localhost:1455/auth/callback?code=abc123&state=xyz');

  assert.equal(parsed.ok, true);
  assert.equal(parsed.code, 'abc123');
  assert.equal(parsed.state, 'xyz');
  assert.equal(parsed.error, '');
  assert.equal(core.isCallbackUrl(parsed.url), true);
});

test('parses valid 127.0.0.1 codex callback with error and state', () => {
  const parsed = core.parseCallbackUrl('http://127.0.0.1:8317/codex/callback?error=access_denied&state=xyz');

  assert.equal(parsed.ok, true);
  assert.equal(parsed.code, '');
  assert.equal(parsed.error, 'access_denied');
  assert.equal(parsed.state, 'xyz');
});

test('parses configured remote auth callback with code and state', () => {
  const settings = core.normalizePlatformSettings({ platformBaseUrl: 'http://192.168.1.10:5173/app' });
  const parsed = core.parseCallbackUrl('http://192.168.1.10:5173/app/auth/callback?code=abc123&state=xyz', settings);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.code, 'abc123');
  assert.equal(parsed.state, 'xyz');
  assert.equal(core.isCallbackUrl(parsed.url, settings), true);
  assert.equal(core.parseCallbackUrl('http://localhost:1455/auth/callback?code=a&state=b', settings).ok, true);
  assert.equal(core.parseCallbackUrl('http://192.168.1.11:5173/app/auth/callback?code=a&state=b', settings).ok, false);
});

test('rejects non-local, wrong path, and incomplete callbacks', () => {
  assert.equal(core.parseCallbackUrl('https://localhost/auth/callback?code=a&state=b').ok, false);
  assert.equal(core.parseCallbackUrl('http://192.168.1.10/auth/callback?code=a&state=b').ok, false);
  assert.equal(core.parseCallbackUrl('http://localhost/other/callback?code=a&state=b').ok, false);
  assert.equal(core.parseCallbackUrl('http://localhost/auth/callback?code=a').ok, false);
  assert.equal(core.parseCallbackUrl('http://localhost/auth/callback?state=b').ok, false);
  assert.equal(core.parseCallbackUrl('not a url').ok, false);
});

test('createSafeStatus strips secret-looking fields and callback query secrets', () => {
  const status = core.createSafeStatus({
    phase: 'callback',
    message: 'done',
    callbackUrl: 'http://localhost:1455/auth/callback?code=secret-code&state=keep&error=bad',
    remoteCallbackUrl: 'http://192.168.1.10:5173/auth/callback?code=remote-code&state=keep',
    code: 'secret-code',
    nested: {
      accessToken: 'token-value',
      email: 'person@example.com',
    },
  });

  assert.equal(status.phase, 'callback');
  assert.equal(status.message, 'done');
  assert.equal(status.callbackUrl, 'http://localhost:1455/auth/callback?code=%5Bredacted%5D&state=keep&error=bad');
  assert.equal(status.remoteCallbackUrl, 'http://192.168.1.10:5173/auth/callback?code=%5Bredacted%5D&state=keep');
  assert.equal(status.code, '[redacted]');
  assert.equal(status.nested.accessToken, '[redacted]');
  assert.equal(status.nested.email, 'person@example.com');
  assert.equal(typeof status.updatedAt, 'number');
});

test('builds trusted click mouse events from action center coordinates', () => {
  assert.deepEqual(core.buildTrustedClickMouseEvents({ centerX: 100, centerY: 96 }), [
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x: 100, y: 96, button: 'none' },
    },
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 100, y: 96, button: 'left', clickCount: 1 },
    },
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseReleased', x: 100, y: 96, button: 'left', clickCount: 1 },
    },
  ]);
});

test('normalizes OpenAI content action failures without losing code and error type', () => {
  assert.deepEqual(core.normalizeOpenAIActionFailure('CLICK_ACTION', {
    ok: false,
    error: 'The continue button did not advance.',
    code: 'openai_click_no_transition',
    errorType: 'retryable',
  }), {
    action: 'CLICK_ACTION',
    message: 'The continue button did not advance.',
    code: 'openai_click_no_transition',
    errorType: 'retryable',
  });
});

test('uses string OpenAI content action errors as fallback codes', () => {
  assert.deepEqual(core.normalizeOpenAIActionFailure('GET_ACTION_RECT', {
    ok: false,
    error: 'action_not_found',
  }), {
    action: 'GET_ACTION_RECT',
    message: 'action_not_found',
    code: 'action_not_found',
    errorType: '',
  });
});

test('normalizes automation timing settings from partial user input', () => {
  assert.equal(Object.isFrozen(core.DEFAULT_AUTOMATION_SETTINGS), true);
  assert.deepEqual(core.normalizeAutomationSettings(), core.DEFAULT_AUTOMATION_SETTINGS);
  assert.deepEqual(core.normalizeAutomationSettings({
    stepWaitMs: '2500.9',
    clickProgressTimeoutMs: 4000,
    blockedSkipDelayMs: 45000,
    betweenJobsDelayMs: 30000,
    jobTimeoutMs: 120000,
    ignored: 1,
  }), {
    stepWaitMs: 2500,
    clickProgressTimeoutMs: 4000,
    blockedSkipDelayMs: 45000,
    betweenJobsDelayMs: 30000,
    jobTimeoutMs: 120000,
  });
});

test('clamps automation timing settings to supported bounds', () => {
  assert.deepEqual(core.normalizeAutomationSettings({
    stepWaitMs: 50,
    clickProgressTimeoutMs: 9999999,
    blockedSkipDelayMs: -1,
    betweenJobsDelayMs: 9999999,
    jobTimeoutMs: 'bad',
  }), {
    stepWaitMs: 1000,
    clickProgressTimeoutMs: 60000,
    blockedSkipDelayMs: 0,
    betweenJobsDelayMs: 600000,
    jobTimeoutMs: 300000,
  });
});

test('computes the extra one-time-code email wait only when pending', () => {
  assert.equal(core.OTP_CODE_FETCH_EXTRA_WAIT_MS, 5000);
  assert.equal(core.computeOtpCodeFetchDelayMs(true), 5000);
  assert.equal(core.computeOtpCodeFetchDelayMs(false), 0);
  assert.equal(core.computeOtpCodeFetchDelayMs(true, 2500), 2500);
  assert.equal(core.computeOtpCodeFetchDelayMs(true, -1), 0);
  assert.equal(core.computeOtpCodeFetchDelayMs(true, 'bad'), 0);
});
