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

test('rejects non-local, wrong path, and incomplete callbacks', () => {
  assert.equal(core.parseCallbackUrl('https://localhost/auth/callback?code=a&state=b').ok, false);
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
    code: 'secret-code',
    nested: {
      accessToken: 'token-value',
      email: 'person@example.com',
    },
  });

  assert.equal(status.phase, 'callback');
  assert.equal(status.message, 'done');
  assert.equal(status.callbackUrl, 'http://localhost:1455/auth/callback?code=%5Bredacted%5D&state=keep&error=bad');
  assert.equal(status.code, '[redacted]');
  assert.equal(status.nested.accessToken, '[redacted]');
  assert.equal(status.nested.email, 'person@example.com');
  assert.equal(typeof status.updatedAt, 'number');
});
