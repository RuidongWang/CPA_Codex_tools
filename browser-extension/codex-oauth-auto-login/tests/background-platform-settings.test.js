const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const test = require('node:test');

globalThis.CpaCodexOAuthBackgroundCore = require('../background-core.js');
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}
if (!globalThis.btoa) {
  globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
}
if (!globalThis.atob) {
  globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');
}

const storage = new Map();
globalThis.chrome = {
  runtime: {
    lastError: null,
  },
  storage: {
    local: {
      get(key, done) {
        done({ [key]: storage.get(key) });
      },
      set(value, done) {
        for (const [key, storedValue] of Object.entries(value)) {
          storage.set(key, storedValue);
        }
        done();
      },
      remove(key, done) {
        storage.delete(key);
        done();
      },
    },
  },
};

const platformSettings = require('../background-platform-settings.js');

test.beforeEach(() => {
  storage.clear();
  globalThis.chrome.runtime.lastError = null;
});

test('saves platform password encrypted and loads it only when requested', async () => {
  const saved = await platformSettings.savePlatformSettings({
    platformBaseUrl: 'http://cpa.example/app/',
    platformPassword: 'panel-secret',
    savePlatformPassword: true,
  });

  assert.deepEqual(saved, {
    platformBaseUrl: 'http://cpa.example/app',
    platformPasswordSaved: true,
  });

  const raw = storage.get(platformSettings.PLATFORM_SETTINGS_KEY);
  assert.equal(JSON.stringify(raw).includes('panel-secret'), false);
  assert.equal(platformSettings.isEncryptedPlatformPassword(raw.encryptedPlatformPassword), true);

  const publicSettings = await platformSettings.loadPlatformSettings();
  assert.equal('platformPassword' in publicSettings, false);
  assert.equal(publicSettings.platformPasswordSaved, true);

  const withPassword = await platformSettings.loadPlatformSettings({ includePassword: true });
  assert.equal(withPassword.platformPassword, 'panel-secret');
  assert.equal(withPassword.platformPasswordSaved, true);
});

test('keeps the saved password when save is checked and password input is blank', async () => {
  await platformSettings.savePlatformSettings({
    platformBaseUrl: 'http://cpa.example/app',
    platformPassword: 'panel-secret',
    savePlatformPassword: true,
  });
  const firstEncryptedPassword = storage.get(platformSettings.PLATFORM_SETTINGS_KEY).encryptedPlatformPassword;

  await platformSettings.savePlatformSettings({
    platformBaseUrl: 'http://cpa.example/next',
    platformPassword: '',
    savePlatformPassword: true,
  });

  const raw = storage.get(platformSettings.PLATFORM_SETTINGS_KEY);
  assert.strictEqual(raw.encryptedPlatformPassword, firstEncryptedPassword);
  assert.equal(raw.platformBaseUrl, 'http://cpa.example/next');

  const withPassword = await platformSettings.loadPlatformSettings({ includePassword: true });
  assert.equal(withPassword.platformPassword, 'panel-secret');
});

test('removes the saved password when save is unchecked', async () => {
  await platformSettings.savePlatformSettings({
    platformBaseUrl: 'http://cpa.example/app',
    platformPassword: 'panel-secret',
    savePlatformPassword: true,
  });

  const saved = await platformSettings.savePlatformSettings({
    platformBaseUrl: 'http://cpa.example/app',
    platformPassword: '',
    savePlatformPassword: false,
  });

  const raw = storage.get(platformSettings.PLATFORM_SETTINGS_KEY);
  assert.equal(raw.encryptedPlatformPassword, undefined);
  assert.equal(saved.platformPasswordSaved, false);

  const withPassword = await platformSettings.loadPlatformSettings({ includePassword: true });
  assert.equal(withPassword.platformPassword, '');
  assert.equal(withPassword.platformPasswordSaved, false);
});

test('reset clears platform settings without failing when a vault secret exists', async () => {
  await platformSettings.savePlatformSettings({
    platformBaseUrl: 'http://cpa.example/app',
    platformPassword: 'panel-secret',
    savePlatformPassword: true,
  });
  assert.equal(storage.has(platformSettings.PLATFORM_VAULT_SECRET_KEY), true);

  const reset = await platformSettings.resetPlatformSettings();

  assert.deepEqual(reset, {
    platformBaseUrl: '',
    platformPasswordSaved: false,
  });
  assert.equal(storage.has(platformSettings.PLATFORM_SETTINGS_KEY), false);
  assert.equal(storage.has(platformSettings.PLATFORM_VAULT_SECRET_KEY), true);
});
