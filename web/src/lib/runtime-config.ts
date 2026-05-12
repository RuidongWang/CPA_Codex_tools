import { decryptStringValue, encryptStringValue, isEncryptedValue, VAULT_SECRET_STORAGE_KEY } from "./crypto-vault";
import { normalizeHotmailHelperUrl, normalizeOAuthSettings } from "./oauth";
import { createOAuthJobStore } from "./oauth-job-store";
import { normalizePriorityPlanOrder, normalizePriorityPlanRanges, PRIORITY_PLAN_KEYS } from "./priority";
import { clearWebPayloadCache, clearWebQuotaSnapshots } from "./web-cache";
import type { AppLanguage, HotmailAccount, KeeperSettings, PayloadEnvelope, RuntimeConfig, ThemeMode, UiSettings } from "../types";

type StoredHotmailAccount = Partial<Omit<HotmailAccount, "password" | "refreshToken" | "lastCode">> & {
  password?: unknown;
  refreshToken?: unknown;
  lastCode?: unknown;
};

type StoredOAuthSettings = Partial<Omit<RuntimeConfig["oauthSettings"], "hotmailAccounts">> & {
  hotmailAccounts?: StoredHotmailAccount[];
};

type StoredRuntimeConfig = Partial<Omit<RuntimeConfig, "managementKey" | "oauthSettings">> & {
  managementKey?: unknown;
  oauthSettings?: StoredOAuthSettings;
};

export interface SaveRuntimeConfigOptions {
  rememberManagementKey?: boolean;
  rememberHotmailTokens?: boolean;
}

export interface SensitiveConfigExport {
  schema_version: 1;
  exported_at: string;
  cpaBaseUrl: string;
  managementKey: string;
  oauthSettings: {
    hotmailAccounts: Array<{
      email: string;
      password: string;
      clientId: string;
      refreshToken: string;
    }>;
  };
}

// 开源版不内置开发期地址，这里只保留示例占位，避免把本地端口写死到产物和文档里。
export const DEFAULT_CPA_BASE_URL = "https://cpa.example/";
export const DEFAULT_QUERY_CONCURRENCY = 6;
export const DEFAULT_KEEPER_SETTINGS: KeeperSettings = {
  quotaThreshold: 100,
  expiryThresholdDays: 3,
  enableRefresh: true,
  workerThreads: 6,
};
export const DEFAULT_UI_SETTINGS: UiSettings = {
  themeMode: "system",
  language: "zh",
};

const WEB_CACHE_NAMESPACE = "cpa_codex_quota_cache";
const WEB_RUNTIME_CONFIG_KEY = `${WEB_CACHE_NAMESPACE}.runtime-config`;
export const WEB_PAYLOAD_CACHE_KEY = `${WEB_CACHE_NAMESPACE}.payload-cache`;
const LEGACY_WEB_RUNTIME_CONFIG_KEY = "cpa-quota-desk.runtime-config";
export const LEGACY_WEB_PAYLOAD_CACHE_KEY = "cpa-quota-desk.payload-cache";

function readRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function cleanStorageRecord<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function readWebStorage<T>(primaryKey: string, legacyKeys: string[] = []): T | null {
  try {
    const raw = window.localStorage.getItem(primaryKey);
    if (raw) {
      return JSON.parse(raw) as T;
    }
    for (const legacyKey of legacyKeys) {
      const legacyRaw = window.localStorage.getItem(legacyKey);
      if (!legacyRaw) {
        continue;
      }
      const parsed = JSON.parse(legacyRaw) as T;
      // 浏览器端拿不到固定文件目录，就统一迁到可清理的命名空间里，后续只保留新 key。
      writeWebStorage(primaryKey, parsed, legacyKeys);
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function removeWebStorage(primaryKey: string, legacyKeys: string[] = []): void {
  try {
    window.localStorage.removeItem(primaryKey);
    legacyKeys.forEach((legacyKey) => window.localStorage.removeItem(legacyKey));
  } catch {
    // 清理缓存只是辅助动作，浏览器禁用 storage 时直接忽略即可。
  }
}

function writeWebStorage(key: string, value: unknown, legacyKeys: string[] = []): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    legacyKeys.forEach((legacyKey) => window.localStorage.removeItem(legacyKey));
  } catch {
    // 浏览器隐私模式或禁用 storage 时不影响主流程。
  }
}

async function decryptStringValueOrEmpty(value: unknown): Promise<string> {
  try {
    return await decryptStringValue(value);
  } catch {
    return "";
  }
}

async function decryptStoredHotmailAccount(input: unknown): Promise<StoredHotmailAccount> {
  const account = readRecord(input) as StoredHotmailAccount;
  return cleanStorageRecord({
    ...account,
    password: await decryptStringValueOrEmpty(account.password),
    refreshToken: await decryptStringValueOrEmpty(account.refreshToken),
    // 验证码是短期凭据，不作为 Hotmail 账号资料长期落盘。
    lastCode: undefined,
  });
}

async function decryptStoredRuntimeConfig(input: StoredRuntimeConfig | null): Promise<Partial<RuntimeConfig> | null> {
  if (!input) {
    return null;
  }
  const oauthSettings = readRecord(input.oauthSettings) as StoredOAuthSettings;
  const hotmailAccounts = Array.isArray(oauthSettings.hotmailAccounts)
    ? await Promise.all(oauthSettings.hotmailAccounts.map((account) => decryptStoredHotmailAccount(account)))
    : [];
  return {
    ...input,
    managementKey: await decryptStringValueOrEmpty(input.managementKey),
    oauthSettings: {
      ...oauthSettings,
      hotmailAccounts,
    },
  } as Partial<RuntimeConfig>;
}

function storedRuntimeConfigNeedsRewrite(input: StoredRuntimeConfig | null): boolean {
  if (!input) {
    return false;
  }
  if (typeof input.managementKey === "string" && input.managementKey) {
    return true;
  }
  const accounts = Array.isArray(input.oauthSettings?.hotmailAccounts) ? input.oauthSettings.hotmailAccounts : [];
  return accounts.some((account) => {
    return (
      isEncryptedValue(account.password) ||
      isEncryptedValue(account.refreshToken) ||
      isEncryptedValue(account.lastCode) ||
      (typeof account.lastCode === "string" && account.lastCode.length > 0)
    );
  });
}

export function readLegacyWebPayloadStorage(): PayloadEnvelope | null {
  for (const key of [WEB_PAYLOAD_CACHE_KEY, LEGACY_WEB_PAYLOAD_CACHE_KEY]) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        continue;
      }
      return JSON.parse(raw) as PayloadEnvelope;
    } catch {
      // 单个旧缓存损坏不能阻止继续尝试其他 fallback key。
    }
  }
  return null;
}

export function normalizeKeeperSettings(input: Partial<KeeperSettings> | null | undefined): KeeperSettings {
  const raw = input ?? {};
  const quotaThreshold =
    typeof raw.quotaThreshold === "number" && Number.isFinite(raw.quotaThreshold)
      ? Math.max(0, Math.min(100, Math.trunc(raw.quotaThreshold)))
      : DEFAULT_KEEPER_SETTINGS.quotaThreshold;
  const expiryThresholdDays =
    typeof raw.expiryThresholdDays === "number" && Number.isFinite(raw.expiryThresholdDays)
      ? Math.max(0, Math.trunc(raw.expiryThresholdDays))
      : DEFAULT_KEEPER_SETTINGS.expiryThresholdDays;
  const workerThreads =
    typeof raw.workerThreads === "number" && Number.isFinite(raw.workerThreads)
      ? Math.max(1, Math.trunc(raw.workerThreads))
      : DEFAULT_KEEPER_SETTINGS.workerThreads;
  return {
    quotaThreshold,
    expiryThresholdDays,
    enableRefresh: typeof raw.enableRefresh === "boolean" ? raw.enableRefresh : DEFAULT_KEEPER_SETTINGS.enableRefresh,
    workerThreads,
  };
}

function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : DEFAULT_UI_SETTINGS.themeMode;
}

function normalizeLanguage(value: unknown): AppLanguage {
  return value === "en" || value === "zh"
    ? value
    : DEFAULT_UI_SETTINGS.language;
}

export function normalizeUiSettings(input: Partial<UiSettings> | null | undefined): UiSettings {
  const raw = input ?? {};
  return {
    themeMode: normalizeThemeMode(raw.themeMode),
    language: normalizeLanguage(raw.language),
  };
}

export function normalizeRuntimeConfig(input: Partial<RuntimeConfig> | null | undefined): RuntimeConfig {
  const raw = input ?? {};
  const queryConcurrency =
    typeof raw.queryConcurrency === "number" && Number.isFinite(raw.queryConcurrency)
      ? Math.max(1, Math.trunc(raw.queryConcurrency))
      : DEFAULT_QUERY_CONCURRENCY;
  return {
    cpaBaseUrl: raw.cpaBaseUrl ?? "",
    managementKey: raw.managementKey ?? "",
    queryConcurrency,
    keeperSettings: normalizeKeeperSettings(raw.keeperSettings),
    priorityPlanOrder: normalizePriorityPlanOrder(raw.priorityPlanOrder ?? PRIORITY_PLAN_KEYS),
    priorityPlanRanges: normalizePriorityPlanRanges(raw.priorityPlanRanges),
    oauthSettings: normalizeOAuthSettings(raw.oauthSettings),
    uiSettings: normalizeUiSettings(raw.uiSettings),
  };
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const rawConfig = readWebStorage<StoredRuntimeConfig>(WEB_RUNTIME_CONFIG_KEY, [LEGACY_WEB_RUNTIME_CONFIG_KEY]);
  const decryptedConfig = await decryptStoredRuntimeConfig(rawConfig);
  const normalized = normalizeRuntimeConfig(decryptedConfig);
  if (storedRuntimeConfigNeedsRewrite(rawConfig)) {
    const nextConfig = normalized;
    writeWebStorage(
      WEB_RUNTIME_CONFIG_KEY,
      await sanitizeRuntimeConfigForStorage(nextConfig, {
        rememberManagementKey: Boolean(nextConfig.managementKey),
        rememberHotmailTokens: nextConfig.oauthSettings.rememberHotmailTokens,
      }),
      [LEGACY_WEB_RUNTIME_CONFIG_KEY],
    );
    return nextConfig;
  }
  return normalized;
}

async function sanitizeHotmailAccountForStorage(account: HotmailAccount): Promise<Record<string, unknown>> {
  return cleanStorageRecord({
    id: account.id,
    email: account.email,
    password: account.password ?? "",
    clientId: account.clientId,
    refreshToken: account.refreshToken ?? "",
    status: account.status,
    lastCodeAt: account.lastCodeAt,
    lastError: account.lastError,
    updatedAt: account.updatedAt,
  });
}

async function sanitizeRuntimeConfigForStorage(config: RuntimeConfig, options: SaveRuntimeConfigOptions = {}): Promise<Record<string, unknown>> {
  const normalized = normalizeRuntimeConfig(config);
  const rememberHotmailTokens = true;
  const hotmailAccounts = await Promise.all(
    normalized.oauthSettings.hotmailAccounts.map((account) => sanitizeHotmailAccountForStorage(account)),
  );
  return {
    ...normalized,
    managementKey: options.rememberManagementKey === false || !normalized.managementKey ? "" : await encryptStringValue(normalized.managementKey),
    oauthSettings: {
      ...normalized.oauthSettings,
      rememberHotmailTokens,
      hotmailAccounts,
    },
  };
}

export async function saveRuntimeConfig(config: RuntimeConfig, options: SaveRuntimeConfigOptions = {}): Promise<void> {
  writeWebStorage(WEB_RUNTIME_CONFIG_KEY, await sanitizeRuntimeConfigForStorage(config, options), [LEGACY_WEB_RUNTIME_CONFIG_KEY]);
}

export async function clearLocalCache(): Promise<void> {
  // 把新旧命名空间都清掉，确保手工迁移前后的残留配置不会回流。
  removeWebStorage(WEB_RUNTIME_CONFIG_KEY, [LEGACY_WEB_RUNTIME_CONFIG_KEY]);
  removeWebStorage(WEB_PAYLOAD_CACHE_KEY, [LEGACY_WEB_PAYLOAD_CACHE_KEY]);
  removeWebStorage(VAULT_SECRET_STORAGE_KEY);
  createOAuthJobStore().clear();
  await clearWebPayloadCache();
  await clearWebQuotaSnapshots();
}

export function triggerBrowserDownload(name: string, content: string): void {
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function formatExportTimestamp(value: string): string {
  const parsed = Date.parse(value);
  const date = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

export function buildSensitiveConfigExport(config: RuntimeConfig, exportedAt = new Date().toISOString()): SensitiveConfigExport {
  const normalized = normalizeRuntimeConfig(config);
  return {
    schema_version: 1,
    exported_at: exportedAt,
    cpaBaseUrl: normalized.cpaBaseUrl,
    managementKey: normalized.managementKey,
    oauthSettings: {
      hotmailAccounts: normalized.oauthSettings.hotmailAccounts.map((account) => ({
        email: account.email,
        password: account.password ?? "",
        clientId: account.clientId,
        refreshToken: account.refreshToken,
      })),
    },
  };
}

export async function exportSensitiveConfig(config: RuntimeConfig): Promise<void> {
  const exportedAt = new Date().toISOString();
  triggerBrowserDownload(
    `cpa-codex-sensitive-export-${formatExportTimestamp(exportedAt)}.json`,
    `${JSON.stringify(buildSensitiveConfigExport(config, exportedAt), null, 2)}\n`,
  );
}
