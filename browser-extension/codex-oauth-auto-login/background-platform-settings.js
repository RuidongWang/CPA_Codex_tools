(function attachCpaCodexOAuthPlatformSettings(root, factory) {
  const api = factory(root);
  root.CpaCodexOAuthPlatformSettings = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createPlatformSettings(root) {
  const core = root.CpaCodexOAuthBackgroundCore;
  const PLATFORM_SETTINGS_KEY = 'cpaCodexOAuthAutoLoginPlatformSettings';
  const PLATFORM_VAULT_SECRET_KEY = 'cpaCodexOAuthAutoLoginPlatformVaultSecret';
  const PASSWORD_ENCRYPTION_ALGORITHM = 'AES-GCM';
  const PASSWORD_ENCRYPTION_VERSION = 1;

  function normalizePlatformSettings(input) {
    return core.normalizePlatformSettings(input);
  }

  function chromeCallback(call) {
    return new Promise((resolve, reject) => {
      try {
        call((result) => {
          const lastError = root.chrome?.runtime?.lastError;
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

  function bytesToBase64(bytes) {
    let binary = '';
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return root.btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = root.atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function bytesToArrayBuffer(bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }

  function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function getExtensionCrypto() {
    if (!root.crypto?.subtle || !root.crypto.getRandomValues) {
      throw new Error('当前浏览器扩展环境不支持密码加密');
    }
    return root.crypto;
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    getExtensionCrypto().getRandomValues(bytes);
    return bytes;
  }

  async function getPlatformVaultSecret() {
    const stored = await chromeCallback((done) => root.chrome.storage.local.get(PLATFORM_VAULT_SECRET_KEY, done)).catch(() => ({}));
    const existing = String(stored?.[PLATFORM_VAULT_SECRET_KEY] || '').trim();
    if (existing) {
      return existing;
    }
    const generated = bytesToBase64Url(randomBytes(32));
    await chromeCallback((done) => root.chrome.storage.local.set({ [PLATFORM_VAULT_SECRET_KEY]: generated }, done));
    return generated;
  }

  async function derivePasswordKey(secret) {
    const digest = await getExtensionCrypto().subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return getExtensionCrypto().subtle.importKey('raw', digest, PASSWORD_ENCRYPTION_ALGORITHM, false, ['encrypt', 'decrypt']);
  }

  function isEncryptedPlatformPassword(value) {
    return Boolean(
      value
      && typeof value === 'object'
      && value.__encrypted === true
      && value.v === PASSWORD_ENCRYPTION_VERSION
      && value.alg === PASSWORD_ENCRYPTION_ALGORITHM
      && typeof value.iv === 'string'
      && typeof value.ciphertext === 'string'
    );
  }

  async function encryptPlatformPassword(password) {
    const iv = randomBytes(12);
    const key = await derivePasswordKey(await getPlatformVaultSecret());
    const ciphertext = await getExtensionCrypto().subtle.encrypt(
      { name: PASSWORD_ENCRYPTION_ALGORITHM, iv: bytesToArrayBuffer(iv) },
      key,
      bytesToArrayBuffer(new TextEncoder().encode(String(password || '')))
    );
    return {
      __encrypted: true,
      v: PASSWORD_ENCRYPTION_VERSION,
      alg: PASSWORD_ENCRYPTION_ALGORITHM,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    };
  }

  async function decryptPlatformPassword(value) {
    if (!isEncryptedPlatformPassword(value)) {
      return typeof value === 'string' ? value : '';
    }
    const key = await derivePasswordKey(await getPlatformVaultSecret());
    const plaintext = await getExtensionCrypto().subtle.decrypt(
      { name: PASSWORD_ENCRYPTION_ALGORITHM, iv: bytesToArrayBuffer(base64ToBytes(value.iv)) },
      key,
      bytesToArrayBuffer(base64ToBytes(value.ciphertext))
    );
    return new TextDecoder().decode(plaintext);
  }

  async function readStoredPlatformSettingsRaw() {
    if (!root.chrome?.storage?.local?.get) {
      return {};
    }
    const stored = await chromeCallback((done) => root.chrome.storage.local.get(PLATFORM_SETTINGS_KEY, done)).catch(() => ({}));
    const raw = stored?.[PLATFORM_SETTINGS_KEY];
    return raw && typeof raw === 'object' ? raw : {};
  }

  function publicPlatformSettings(raw = {}) {
    return normalizePlatformSettings({
      platformBaseUrl: raw.platformBaseUrl,
      platformPasswordSaved: Boolean(raw.encryptedPlatformPassword || raw.platformPasswordSaved),
    });
  }

  async function loadPlatformSettings(options = {}) {
    const raw = await readStoredPlatformSettingsRaw();
    const publicSettings = publicPlatformSettings(raw);
    if (!options.includePassword) {
      return publicSettings;
    }
    const platformPassword = await decryptPlatformPassword(raw.encryptedPlatformPassword).catch(() => '');
    return {
      ...publicSettings,
      platformPassword,
      platformPasswordSaved: Boolean(platformPassword || raw.encryptedPlatformPassword),
    };
  }

  async function savePlatformSettings(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const normalized = normalizePlatformSettings(source);
    if (String(source.platformBaseUrl || '').trim() && !normalized.platformBaseUrl) {
      throw new Error('Web 地址无效');
    }
    const existing = await readStoredPlatformSettingsRaw();
    const next = {
      platformBaseUrl: normalized.platformBaseUrl,
    };
    const password = typeof source.platformPassword === 'string' ? source.platformPassword.trim() : '';
    const savePlatformPassword = Boolean(source.savePlatformPassword);
    if (savePlatformPassword && password) {
      next.encryptedPlatformPassword = await encryptPlatformPassword(password);
    } else if (savePlatformPassword && existing.encryptedPlatformPassword) {
      next.encryptedPlatformPassword = existing.encryptedPlatformPassword;
    }

    if (root.chrome?.storage?.local?.set) {
      await chromeCallback((done) => root.chrome.storage.local.set({ [PLATFORM_SETTINGS_KEY]: next }, done));
    }
    return publicPlatformSettings(next);
  }

  async function resetPlatformSettings() {
    if (root.chrome?.storage?.local?.remove) {
      await chromeCallback((done) => root.chrome.storage.local.remove(PLATFORM_SETTINGS_KEY, done));
    }
    return normalizePlatformSettings();
  }

  return {
    PLATFORM_SETTINGS_KEY,
    PLATFORM_VAULT_SECRET_KEY,
    decryptPlatformPassword,
    encryptPlatformPassword,
    isEncryptedPlatformPassword,
    loadPlatformSettings,
    resetPlatformSettings,
    savePlatformSettings,
  };
});
