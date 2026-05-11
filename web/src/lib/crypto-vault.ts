export interface EncryptedValue {
  __encrypted: true;
  v: 1;
  alg: "AES-GCM";
  iv: string;
  ciphertext: string;
}

export const VAULT_SECRET_STORAGE_KEY = "cpa_codex_quota_cache.vault-secret";

const ENCRYPTION_ALGORITHM = "AES-GCM";
const ENCRYPTED_VALUE_VERSION = 1;
let cachedVaultSecret: string | null = null;

declare global {
  interface Window {
    __CPA_CODEX_VAULT_SECRET__?: string;
  }
}

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error("当前运行环境不支持 Web Crypto 加密");
  }
  return globalThis.crypto;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

function generateVaultSecret(): string {
  return bytesToBase64Url(randomBytes(32));
}

function readRuntimeVaultSecret(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return typeof window.__CPA_CODEX_VAULT_SECRET__ === "string" ? window.__CPA_CODEX_VAULT_SECRET__.trim() : "";
}

export async function getVaultSecret(): Promise<string> {
  if (cachedVaultSecret) {
    return cachedVaultSecret;
  }

  const runtimeSecret = readRuntimeVaultSecret();
  if (runtimeSecret) {
    cachedVaultSecret = runtimeSecret;
    return runtimeSecret;
  }

  const storage = getStorage();
  const storedSecret = storage?.getItem(VAULT_SECRET_STORAGE_KEY)?.trim() ?? "";
  if (storedSecret) {
    cachedVaultSecret = storedSecret;
    return storedSecret;
  }

  const generated = generateVaultSecret();
  try {
    storage?.setItem(VAULT_SECRET_STORAGE_KEY, generated);
  } catch {
    // 加密仍可在当前会话工作；只是刷新后无法解密旧数据。
  }
  cachedVaultSecret = generated;
  return generated;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await getCrypto().subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return getCrypto().subtle.importKey("raw", digest, ENCRYPTION_ALGORITHM, false, ["encrypt", "decrypt"]);
}

export function isEncryptedValue(value: unknown): value is EncryptedValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<EncryptedValue>;
  return (
    candidate.__encrypted === true &&
    candidate.v === ENCRYPTED_VALUE_VERSION &&
    candidate.alg === ENCRYPTION_ALGORITHM &&
    typeof candidate.iv === "string" &&
    candidate.iv.length > 0 &&
    typeof candidate.ciphertext === "string" &&
    candidate.ciphertext.length > 0
  );
}

export async function encryptText(plaintext: string, secret?: string): Promise<EncryptedValue> {
  const iv = randomBytes(12);
  const key = await deriveKey(secret ?? (await getVaultSecret()));
  const ciphertext = await getCrypto().subtle.encrypt(
    { name: ENCRYPTION_ALGORITHM, iv: bytesToArrayBuffer(iv) },
    key,
    bytesToArrayBuffer(new TextEncoder().encode(plaintext)),
  );
  return {
    __encrypted: true,
    v: ENCRYPTED_VALUE_VERSION,
    alg: ENCRYPTION_ALGORITHM,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptText(value: EncryptedValue, secret?: string): Promise<string> {
  try {
    const key = await deriveKey(secret ?? (await getVaultSecret()));
    const plaintext = await getCrypto().subtle.decrypt(
      { name: ENCRYPTION_ALGORITHM, iv: bytesToArrayBuffer(base64ToBytes(value.iv)) },
      key,
      bytesToArrayBuffer(base64ToBytes(value.ciphertext)),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("加密数据无法解密");
  }
}

export async function encryptStringValue(value: unknown): Promise<unknown> {
  return typeof value === "string" && value ? encryptText(value) : value;
}

export async function decryptStringValue(value: unknown): Promise<string> {
  if (isEncryptedValue(value)) {
    return decryptText(value);
  }
  return typeof value === "string" ? value : "";
}

export function resetVaultSecretCacheForTests(): void {
  cachedVaultSecret = null;
}
