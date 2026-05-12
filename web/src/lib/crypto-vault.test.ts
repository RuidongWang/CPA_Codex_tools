import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decryptText,
  encryptText,
  getVaultSecret,
  isEncryptedValue,
  resetVaultSecretCacheForTests,
  VAULT_SECRET_STORAGE_KEY,
} from "./crypto-vault";

function createFakeLocalStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? (values.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } as Storage;
}

describe("crypto-vault", () => {
  beforeEach(() => {
    resetVaultSecretCacheForTests();
    vi.unstubAllGlobals();
    Object.defineProperty(window, "localStorage", { configurable: true, value: createFakeLocalStorage() });
    window.localStorage.clear();
    delete (window as typeof window & { __CPA_CODEX_VAULT_SECRET__?: string }).__CPA_CODEX_VAULT_SECRET__;
  });

  it("encrypts text without storing plaintext and decrypts with the same secret", async () => {
    const encrypted = await encryptText("hotmail-password", "deployment-secret-a");
    const serialized = JSON.stringify(encrypted);

    expect(isEncryptedValue(encrypted)).toBe(true);
    expect(serialized).not.toContain("hotmail-password");
    await expect(decryptText(encrypted, "deployment-secret-a")).resolves.toBe("hotmail-password");
  });

  it("uses a random iv so repeated encryption produces different ciphertext", async () => {
    const first = await encryptText("refresh-token", "deployment-secret-a");
    const second = await encryptText("refresh-token", "deployment-secret-a");

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("rejects decryption with a different secret", async () => {
    const encrypted = await encryptText("management-key", "deployment-secret-a");

    await expect(decryptText(encrypted, "deployment-secret-b")).rejects.toThrow("加密数据无法解密");
  });

  it("uses the deployment secret when present and falls back to a stable local secret", async () => {
    (window as typeof window & { __CPA_CODEX_VAULT_SECRET__?: string }).__CPA_CODEX_VAULT_SECRET__ = "runtime-secret";
    await expect(getVaultSecret()).resolves.toBe("runtime-secret");

    resetVaultSecretCacheForTests();
    delete (window as typeof window & { __CPA_CODEX_VAULT_SECRET__?: string }).__CPA_CODEX_VAULT_SECRET__;
    const generated = await getVaultSecret();
    expect(generated).toHaveLength(43);
    expect(window.localStorage.getItem(VAULT_SECRET_STORAGE_KEY)).toBe(generated);
    await expect(getVaultSecret()).resolves.toBe(generated);
  });
});
