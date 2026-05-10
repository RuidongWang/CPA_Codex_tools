import { normalizePriorityPlanKey, normalizePriorityPlanOrder, normalizePriorityPlanRanges, PRIORITY_PLAN_KEYS } from "./priority";
import { normalizeHotmailHelperUrl, normalizeOAuthSettings } from "./oauth";
import {
  clearWebPayloadCache,
  clearWebQuotaSnapshots,
  loadWebPayloadCache,
  loadWebQuotaSnapshots,
  saveWebPayloadCache,
  saveWebQuotaSnapshot,
  type QuotaSnapshotRecord,
} from "./web-cache";
import type {
  AccountItem,
  DownloadedAccountConfig,
  HotmailAccount,
  KeeperDirectAction,
  KeeperItemReport,
  KeeperRunResult,
  KeeperSettings,
  PayloadEnvelope,
  QueryProgressEvent,
  RuntimeConfig,
} from "../types";

export interface CodexOAuthStartResult {
  authUrl: string;
  state: string;
  raw: Record<string, unknown>;
}

export interface CodexOAuthStatusResult {
  state: string;
  status: "pending" | "success" | "error";
  message: string;
  email: string;
  raw: Record<string, unknown>;
}

export interface CodexOAuthCallbackResult {
  state: string;
  status: "pending" | "success" | "error";
  message: string;
  raw: Record<string, unknown>;
}

export interface HotmailVerificationCodeResult {
  code: string;
  nextRefreshToken: string;
  transport: string;
  raw: Record<string, unknown>;
}

export interface HotmailVerificationCodeInput {
  config?: RuntimeConfig;
  helperUrl: string;
  account: HotmailAccount;
  authIndex?: string;
  top?: number;
  mailboxes?: string[];
  senderFilters?: string[];
  subjectFilters?: string[];
  excludeCodes?: string[];
  filterAfterTimestamp?: number;
}

export interface ManagementBaseUrlInspection {
  valid: boolean;
  error: string;
  warning: string;
  normalizedUrl: string;
}

export interface SaveRuntimeConfigOptions {
  rememberManagementKey?: boolean;
  rememberHotmailTokens?: boolean;
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
const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_USER_AGENT = "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal";
const MICROSOFT_GRAPH_SCOPES = "offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read";
const MICROSOFT_GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";
const MICROSOFT_GRAPH_API_BASE = "https://graph.microsoft.com/v1.0/me/mailFolders";
const MICROSOFT_OUTLOOK_API_BASE = "https://outlook.office.com/api/v2.0/me/mailfolders";
const WINDOW_5H_SECONDS = 5 * 60 * 60;
const WINDOW_7D_SECONDS = 7 * 24 * 60 * 60;
const LOW_5H_THRESHOLD = 20;
const LOW_7D_THRESHOLD = 10;
const WEB_CACHE_NAMESPACE = "cpa_codex_quota_cache";
const WEB_RUNTIME_CONFIG_KEY = `${WEB_CACHE_NAMESPACE}.runtime-config`;
const WEB_PAYLOAD_CACHE_KEY = `${WEB_CACHE_NAMESPACE}.payload-cache`;
const LEGACY_WEB_RUNTIME_CONFIG_KEY = "cpa-quota-desk.runtime-config";
const LEGACY_WEB_PAYLOAD_CACHE_KEY = "cpa-quota-desk.payload-cache";
const WEB_MANAGEMENT_FETCH_TIMEOUT_MS = 30_000;

interface WebAuthRecord {
  name: string;
  email: string;
  plan_type: string;
  account_id: string;
  auth_index: string;
  priority: number | null;
  disabled: boolean | undefined;
  expired: string;
  has_refresh_token: boolean;
  raw: Record<string, unknown>;
}

interface WebQuotaReport extends WebAuthRecord {
  status: AccountItem["status"];
  windows: AccountItem["windows"];
  additional_windows: AccountItem["additional_windows"];
  error: string;
  timings_ms: Record<string, number>;
  last_query_at: string | null;
  quota_reset_at: string | null;
  quota_reset_label: string | null;
  quota_updated_at: string | null;
}

interface MicrosoftTokenStrategy {
  name: string;
  url: string;
  extraData?: Record<string, string>;
}

interface MicrosoftTransportPlan {
  transport: "graph" | "outlook";
  strategyNames: string[];
}

interface MicrosoftAccessTokenResult {
  accessToken: string;
  nextRefreshToken: string;
  tokenStrategy: string;
}

interface MicrosoftMailMessage {
  id: string;
  mailbox: string;
  subject: string;
  from: {
    emailAddress: {
      address: string;
      name: string;
    };
  };
  bodyPreview: string;
  body: {
    content: string;
  };
  receivedDateTime: string;
  receivedTimestamp: number;
}

const MICROSOFT_TOKEN_STRATEGIES: MicrosoftTokenStrategy[] = [
  {
    name: "entra-common-delegated",
    url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    extraData: { scope: MICROSOFT_GRAPH_SCOPES },
  },
  {
    name: "entra-consumers-delegated",
    url: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
    extraData: { scope: MICROSOFT_GRAPH_SCOPES },
  },
  {
    name: "entra-common-default",
    url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    extraData: { scope: MICROSOFT_GRAPH_DEFAULT_SCOPE },
  },
  {
    name: "entra-common-outlook",
    url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    extraData: {},
  },
];

const MICROSOFT_TRANSPORT_PLANS: MicrosoftTransportPlan[] = [
  {
    transport: "graph",
    strategyNames: ["entra-common-delegated", "entra-consumers-delegated", "entra-common-default"],
  },
  {
    transport: "outlook",
    strategyNames: ["entra-common-outlook", "entra-common-delegated", "entra-consumers-delegated"],
  },
];

export async function openExternalUrl(url: string): Promise<void> {
  window.open(url, "_blank", "noopener,noreferrer");
}

function emptyPayload(): PayloadEnvelope {
  return {
    meta: {
      generated_at: "",
      total: 0,
      success: 0,
      failed: 0,
    },
    groups: {
      by_plan: {},
      by_status: {},
    },
    items: [],
    error: "",
  };
}

function normalizeItem(input: Partial<AccountItem>): AccountItem {
  const remotePriority = typeof input.remote_priority === "number" ? input.remote_priority : input.priority;
  const windows = Array.isArray(input.windows) ? input.windows : [];
  const quotaReset = readPrimaryQuotaReset(windows);
  const legacyQuotaLabel = typeof input.quota_updated_at === "string" ? input.quota_updated_at : null;
  return {
    name: input.name ?? "",
    email: input.email ?? "",
    // 入口层统一把 CPA plan_type 别名归一化，避免视图层到处判断 pro/pro-lite 变体。
    plan_type: normalizePriorityPlanKey(input.plan_type),
    account_id: input.account_id ?? "",
    auth_index: input.auth_index ?? "",
    priority: typeof input.priority === "number" ? input.priority : null,
    remote_priority: typeof remotePriority === "number" ? remotePriority : null,
    draft_priority: typeof input.draft_priority === "number" ? input.draft_priority : undefined,
    dirty_priority: Boolean(input.dirty_priority),
    disabled: typeof input.disabled === "boolean" ? input.disabled : undefined,
    expired: typeof input.expired === "string" ? input.expired : undefined,
    has_refresh_token: typeof input.has_refresh_token === "boolean" ? input.has_refresh_token : undefined,
    status: input.status ?? "unknown",
    windows,
    additional_windows: Array.isArray(input.additional_windows) ? input.additional_windows : [],
    error: input.error ?? "",
    timings_ms: input.timings_ms ?? {},
    last_query_at: input.last_query_at ?? null,
    quota_reset_at: quotaReset.resetAt ?? input.quota_reset_at ?? null,
    quota_reset_label: quotaReset.label ?? input.quota_reset_label ?? legacyQuotaLabel,
    quota_updated_at: quotaReset.label ?? legacyQuotaLabel,
  };
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
  };
}

function isLocalManagementHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function inspectManagementBaseUrl(input: unknown): ManagementBaseUrlInspection {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) {
    return { valid: false, error: "请先填写 CPA 地址", warning: "请先填写 CPA 地址", normalizedUrl: "" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { valid: false, error: "CPA 地址格式无效", warning: "CPA 地址格式无效", normalizedUrl: "" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, error: "CPA 地址仅支持 HTTP 或 HTTPS", warning: "CPA 地址仅支持 HTTP 或 HTTPS", normalizedUrl: "" };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, error: "CPA 地址不能包含用户名或密码", warning: "CPA 地址不能包含用户名或密码", normalizedUrl: "" };
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "/");
  parsed.search = "";
  parsed.hash = "";
  const normalizedUrl = parsed.toString().replace(/\/$/, "");
  const warning =
    parsed.protocol === "http:" && !isLocalManagementHost(parsed.hostname)
      ? "当前 CPA 地址使用非 HTTPS，管理密钥可能会通过明文传输"
      : "";
  return { valid: true, error: "", warning, normalizedUrl };
}

function createRequestId(command: string): string {
  // 单次查询只需要局部唯一，时间戳加随机串足够过滤掉并发事件串台。
  return `${command}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// 前端不信任原始 CPA 或缓存结果，这里统一做一遍结构归一化。
export function normalizePayload(input: unknown): PayloadEnvelope {
  if (!input || typeof input !== "object") {
    return emptyPayload();
  }
  const raw = input as Partial<PayloadEnvelope>;
  return {
    meta: {
      generated_at: raw.meta?.generated_at ?? "",
      total: raw.meta?.total ?? 0,
      success: raw.meta?.success ?? 0,
      failed: raw.meta?.failed ?? 0,
    },
    groups: {
      by_plan: raw.groups?.by_plan ?? {},
      by_status: raw.groups?.by_status ?? {},
    },
    items: Array.isArray(raw.items) ? raw.items.map((item) => normalizeItem(item)) : [],
    error: raw.error ?? "",
  };
}

function cleanString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = cleanString(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function firstPresent<T>(...values: T[]): T | undefined {
  return values.find((value) => value !== null && value !== undefined);
}

function normalizePlan(value: unknown): string {
  return cleanString(value).toLowerCase();
}

function normalizePriority(value: unknown): number | null {
  if (typeof value === "boolean") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const text = cleanString(value);
  if (!text) {
    return null;
  }
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBoolOrNull(value: unknown): boolean | null {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function readRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function nestedGet(input: Record<string, unknown>, ...keys: string[]): unknown {
  let current: unknown = input;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) {
    return {};
  }
  let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const remainder = payload.length % 4;
  if (remainder === 2) {
    payload += "==";
  } else if (remainder === 3) {
    payload += "=";
  } else if (remainder === 1) {
    return {};
  }
  try {
    return readRecord(JSON.parse(window.atob(payload)));
  } catch {
    return {};
  }
}

function extractCodexClaims(value: unknown): { email: string; account_id: string; plan_type: string } {
  const payload = typeof value === "string" ? decodeJwtPayload(value) : readRecord(value);
  const authInfo = readRecord(nestedGet(payload, "https://api.openai.com/auth"));
  return {
    email: firstNonEmpty(payload.email),
    account_id: firstNonEmpty(payload.chatgpt_account_id, payload.account_id, authInfo.chatgpt_account_id),
    plan_type: normalizePlan(firstNonEmpty(payload.plan_type, payload.chatgpt_plan_type, authInfo.chatgpt_plan_type)),
  };
}

function inferPlanFromName(name: string): string {
  const raw = cleanString(name).toLowerCase();
  for (const suffix of ["-free.json", "-plus.json", "-team.json"]) {
    if (raw.endsWith(suffix)) {
      return suffix.replace(/^-/, "").replace(/\.json$/, "");
    }
  }
  return "";
}

function sortWebAuthRecords(records: WebAuthRecord[]): WebAuthRecord[] {
  return [...records].sort((left, right) => {
    const leftPriority = left.priority ?? Number.MIN_SAFE_INTEGER;
    const rightPriority = right.priority ?? Number.MIN_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return rightPriority - leftPriority;
    }
    return left.email.localeCompare(right.email, "zh-CN");
  });
}

function buildAuthRecordsFromAuthFiles(rawFiles: unknown[]): WebAuthRecord[] {
  const records: WebAuthRecord[] = [];
  for (const rawItem of rawFiles) {
    const item = readRecord(rawItem);
    const provider = normalizePlan(firstNonEmpty(item.provider, item.type));
    if (provider !== "codex") {
      continue;
    }
    const claims = extractCodexClaims(firstPresent(item.id_token, nestedGet(item, "metadata", "id_token")));
    const name = firstNonEmpty(item.name, item.id, claims.email, "unknown");
    records.push({
      name,
      email: firstNonEmpty(item.email, claims.email),
      plan_type: firstNonEmpty(item.plan_type, claims.plan_type, inferPlanFromName(name), "unknown"),
      account_id: firstNonEmpty(item.chatgpt_account_id, claims.account_id),
      auth_index: firstNonEmpty(item.auth_index, item.authIndex),
      priority: normalizePriority(item.priority),
      disabled: normalizeBoolOrNull(item.disabled) ?? undefined,
      expired: firstNonEmpty(item.expired, item.expires_at, item.expiresAt),
      has_refresh_token: Boolean(firstNonEmpty(item.refresh_token, item.refreshToken)),
      raw: item,
    });
  }
  return sortWebAuthRecords(records);
}

function authRecordToItem(record: WebAuthRecord): Partial<AccountItem> {
  return {
    name: record.name,
    email: record.email,
    plan_type: record.plan_type || "unknown",
    account_id: record.account_id,
    auth_index: record.auth_index,
    priority: record.priority,
    remote_priority: record.priority,
    disabled: record.disabled ?? undefined,
    expired: record.expired || undefined,
    has_refresh_token: record.has_refresh_token,
    status: "unknown",
    windows: [],
    additional_windows: [],
    error: "",
    last_query_at: null,
    quota_reset_at: null,
    quota_reset_label: null,
    quota_updated_at: null,
  };
}

function buildGroupCounts(items: Partial<AccountItem>[]): PayloadEnvelope["groups"] {
  const byPlan: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const item of items) {
    const plan = normalizePriorityPlanKey(item.plan_type);
    const status = item.status ?? "unknown";
    byPlan[plan] = (byPlan[plan] ?? 0) + 1;
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  return {
    by_plan: Object.fromEntries(Object.entries(byPlan).sort(([left], [right]) => left.localeCompare(right))),
    by_status: Object.fromEntries(Object.entries(byStatus).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function buildListPayload(records: WebAuthRecord[]): PayloadEnvelope {
  const items = records.map(authRecordToItem);
  return normalizePayload({
    meta: { generated_at: new Date().toISOString(), total: items.length, success: 0, failed: 0 },
    groups: buildGroupCounts(items),
    items,
    error: "",
  });
}

function buildQueryPayload(reports: WebQuotaReport[]): PayloadEnvelope {
  const failed = reports.filter((item) => item.status === "error").length;
  return normalizePayload({
    meta: { generated_at: new Date().toISOString(), total: reports.length, success: reports.length - failed, failed },
    groups: buildGroupCounts(reports),
    items: reports,
    error: "",
  });
}

function hasFreshQuota(report: WebQuotaReport): boolean {
  return !report.error && report.windows.length > 0;
}

function readPrimaryQuotaReset(windows: AccountItem["windows"]): { resetAt: string | null; label: string | null } {
  const primaryWindow = windows.find((window) => window.id === "code-5h");
  const resetAt = primaryWindow?.reset_at ?? null;
  const resetLabel = primaryWindow?.reset_label ?? null;
  return {
    resetAt,
    label: resetLabel && resetLabel !== "-" ? resetLabel : null,
  };
}

function mergeQuotaSnapshotIntoItem(item: AccountItem, snapshot: QuotaSnapshotRecord | undefined): AccountItem {
  if (!snapshot) {
    return item;
  }
  return normalizeItem({
    ...item,
    name: item.name || snapshot.name,
    email: item.email || snapshot.email,
    expired: item.expired || snapshot.expired || undefined,
    status: snapshot.status,
    windows: snapshot.windows,
    additional_windows: snapshot.additional_windows,
    error: snapshot.error,
    timings_ms: snapshot.timings_ms,
    last_query_at: snapshot.last_query_at,
    quota_reset_at: snapshot.quota_reset_at,
    quota_reset_label: snapshot.quota_reset_label,
    quota_updated_at: snapshot.quota_updated_at,
  });
}

async function mergeQuotaSnapshotsIntoListPayload(payload: PayloadEnvelope): Promise<PayloadEnvelope> {
  const snapshots = await loadWebQuotaSnapshots(payload.items.map((item) => item.auth_index));
  if (!snapshots.size) {
    return payload;
  }
  const items = payload.items.map((item) => mergeQuotaSnapshotIntoItem(item, snapshots.get(item.auth_index)));
  return normalizePayload({
    ...payload,
    groups: buildGroupCounts(items),
    items,
  });
}

async function buildWebListPayload(records: WebAuthRecord[]): Promise<PayloadEnvelope> {
  return mergeQuotaSnapshotsIntoListPayload(buildListPayload(records));
}

function buildQuotaSnapshotFromReport(report: WebQuotaReport, previous: QuotaSnapshotRecord | undefined): QuotaSnapshotRecord | null {
  if (!report.auth_index) {
    return null;
  }
  const freshQuota = hasFreshQuota(report);
  return {
    auth_index: report.auth_index,
    name: report.name,
    email: report.email,
    expired: report.expired || previous?.expired || null,
    status: report.status,
    windows: freshQuota ? report.windows : (previous?.windows ?? report.windows),
    additional_windows: freshQuota ? report.additional_windows : (previous?.additional_windows ?? report.additional_windows),
    error: report.error,
    timings_ms: report.timings_ms,
    last_query_at: report.last_query_at,
    quota_reset_at: freshQuota ? report.quota_reset_at : (previous?.quota_reset_at ?? null),
    quota_reset_label: freshQuota ? report.quota_reset_label : (previous?.quota_reset_label ?? previous?.quota_updated_at ?? null),
    quota_updated_at: freshQuota ? report.quota_updated_at : (previous?.quota_updated_at ?? null),
  };
}

function mergeQuotaSnapshotIntoReport(report: WebQuotaReport, snapshot: QuotaSnapshotRecord): WebQuotaReport {
  return {
    ...report,
    status: snapshot.status,
    expired: snapshot.expired || report.expired,
    windows: snapshot.windows,
    additional_windows: snapshot.additional_windows,
    error: snapshot.error,
    timings_ms: snapshot.timings_ms,
    last_query_at: snapshot.last_query_at,
    quota_reset_at: snapshot.quota_reset_at,
    quota_reset_label: snapshot.quota_reset_label,
    quota_updated_at: snapshot.quota_updated_at,
  };
}

async function persistWebQuotaReports(reports: WebQuotaReport[]): Promise<WebQuotaReport[]> {
  const previousSnapshots = await loadWebQuotaSnapshots(reports.map((report) => report.auth_index));
  return Promise.all(
    reports.map(async (report) => {
      const snapshot = buildQuotaSnapshotFromReport(report, previousSnapshots.get(report.auth_index));
      if (!snapshot) {
        return report;
      }
      await saveWebQuotaSnapshot(snapshot);
      return mergeQuotaSnapshotIntoReport(report, snapshot);
    }),
  );
}

function buildManagementUrl(config: RuntimeConfig, path: string, query?: Record<string, string>): string {
  const safety = inspectManagementBaseUrl(config.cpaBaseUrl);
  if (!safety.valid) {
    throw new Error(safety.warning);
  }
  const base = new URL(`${safety.normalizedUrl}/`);
  base.pathname = path;
  base.search = "";
  for (const [key, value] of Object.entries(query ?? {})) {
    base.searchParams.set(key, value);
  }
  return base.toString();
}

function buildManagementHeaders(config: RuntimeConfig, contentType?: string): Headers {
  const headers = new Headers();
  const managementKey = config.managementKey.trim();
  if (managementKey) {
    // CPA 的管理接口历史上同时接受 Bearer 和 X-Management-Key，这里两个头都带上以兼容不同部署。
    headers.set("Authorization", `Bearer ${managementKey}`);
    headers.set("X-Management-Key", managementKey);
  }
  if (contentType) {
    headers.set("Content-Type", contentType);
  }
  return headers;
}

async function fetchManagementText(config: RuntimeConfig, path: string, init: RequestInit = {}, query?: Record<string, string>): Promise<string> {
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  let didTimeout = false;
  const timeoutId = controller
    ? setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, WEB_MANAGEMENT_FETCH_TIMEOUT_MS)
    : null;
  try {
    const response = await fetch(buildManagementUrl(config, path, query), {
      ...init,
      headers: init.headers ?? buildManagementHeaders(config),
      signal: init.signal ?? controller?.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text.trim() || `CPA 管理接口调用失败，HTTP ${response.status}`);
    }
    return text;
  } catch (error) {
    if (didTimeout || (error instanceof DOMException && error.name === "AbortError")) {
      throw new Error(`CPA 管理接口请求超时（${Math.round(WEB_MANAGEMENT_FETCH_TIMEOUT_MS / 1000)} 秒）`);
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function fetchManagementJson(config: RuntimeConfig, path: string, init: RequestInit = {}, query?: Record<string, string>): Promise<Record<string, unknown>> {
  const text = await fetchManagementText(config, path, init, query);
  if (!text.trim()) {
    return {};
  }
  try {
    return readRecord(JSON.parse(text));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知解析错误";
    throw new Error(`CPA 管理接口没有返回合法 JSON: ${detail}`);
  }
}

function extractStateFromUrl(input: string): string {
  try {
    return new URL(input).searchParams.get("state") ?? "";
  } catch {
    return "";
  }
}

export async function startCodexOAuth(config: RuntimeConfig): Promise<CodexOAuthStartResult> {
  const raw = await fetchManagementJson(config, "/v0/management/codex-auth-url", { method: "GET" }, { is_webui: "true" });
  const data = readRecord(raw.data);
  const authUrl = firstNonEmpty(raw.url, raw.auth_url, raw.authUrl, data.url, data.auth_url, data.authUrl);
  const state = firstNonEmpty(raw.state, raw.auth_state, raw.authState, data.state, data.auth_state, data.authState, extractStateFromUrl(authUrl));
  if (!authUrl || !authUrl.startsWith("http")) {
    throw new Error("CPA 管理接口未返回有效的 Codex OAuth 登录链接");
  }
  if (!state) {
    throw new Error("Codex OAuth 登录链接缺少 state");
  }
  return {
    authUrl,
    state,
    raw,
  };
}

function normalizeOAuthStatus(raw: Record<string, unknown>): "pending" | "success" | "error" {
  const status = firstNonEmpty(raw.status, raw.state, raw.phase, raw.result).toLowerCase();
  const ok = raw.ok === true || raw.success === true || raw.authenticated === true || raw.done === true;
  const failed = raw.ok === false || raw.success === false || raw.error || raw.reason;
  if (ok || /success|authenticated|complete|done|ok/.test(status)) {
    return "success";
  }
  if (failed || /error|fail|failed|expired|invalid|timeout/.test(status)) {
    return "error";
  }
  return "pending";
}

export async function pollCodexOAuthStatus(config: RuntimeConfig, state: string): Promise<CodexOAuthStatusResult> {
  const trimmedState = state.trim();
  if (!trimmedState) {
    throw new Error("缺少 Codex OAuth state");
  }
  const raw = await fetchManagementJson(config, "/v0/management/get-auth-status", { method: "GET" }, { state: trimmedState });
  const data = readRecord(raw.data);
  const merged = { ...raw, ...data };
  return {
    state: trimmedState,
    status: normalizeOAuthStatus(merged),
    message: firstNonEmpty(merged.message, merged.detail, merged.reason, merged.error, merged.status),
    email: firstNonEmpty(merged.email, merged.account_email, merged.accountEmail),
    raw,
  };
}

export async function submitCodexOAuthCallback(config: RuntimeConfig, state: string, redirectUrl: string): Promise<CodexOAuthCallbackResult> {
  const trimmedState = state.trim();
  const trimmedRedirectUrl = redirectUrl.trim();
  if (!trimmedState) {
    throw new Error("缺少 Codex OAuth state");
  }
  if (!trimmedRedirectUrl) {
    throw new Error("请粘贴 OAuth 回调 URL");
  }
  let parsedRedirectUrl: URL;
  try {
    parsedRedirectUrl = new URL(trimmedRedirectUrl);
  } catch {
    throw new Error("OAuth 回调 URL 格式无效");
  }
  if (parsedRedirectUrl.protocol !== "http:" && parsedRedirectUrl.protocol !== "https:") {
    throw new Error("OAuth 回调 URL 仅支持 HTTP 或 HTTPS");
  }
  const callbackState = parsedRedirectUrl.searchParams.get("state")?.trim() ?? "";
  if (!callbackState) {
    throw new Error("OAuth 回调 URL 缺少 state");
  }
  if (callbackState !== trimmedState) {
    throw new Error("OAuth 回调 URL state 不匹配");
  }
  if (!firstNonEmpty(parsedRedirectUrl.searchParams.get("code"), parsedRedirectUrl.searchParams.get("error"))) {
    throw new Error("OAuth 回调 URL 缺少 code 或 error");
  }
  const raw = await fetchManagementJson(config, "/v0/management/oauth-callback", {
    method: "POST",
    headers: buildManagementHeaders(config, "application/json"),
    body: JSON.stringify({
      provider: "codex",
      redirect_url: trimmedRedirectUrl,
      state: trimmedState,
    }),
  });
  const data = readRecord(raw.data);
  const merged = { ...raw, ...data };
  return {
    state: trimmedState,
    status: normalizeOAuthStatus(merged),
    message: firstNonEmpty(merged.message, merged.detail, merged.reason, merged.error) || "回调 URL 已提交",
    raw,
  };
}

function resolveMicrosoftTokenStrategy(name: string): MicrosoftTokenStrategy {
  return MICROSOFT_TOKEN_STRATEGIES.find((strategy) => strategy.name === name) ?? MICROSOFT_TOKEN_STRATEGIES[0];
}

function normalizeMicrosoftMailboxLabel(mailbox?: string): string {
  return /^junk(?:\s*e-?mail|\s*email)?$/i.test(String(mailbox || "").trim()) ? "Junk" : "INBOX";
}

function normalizeMicrosoftMailboxId(mailbox?: string): string {
  return normalizeMicrosoftMailboxLabel(mailbox) === "Junk" ? "junkemail" : "inbox";
}

function normalizeMicrosoftMailboxList(mailboxes?: string[]): string[] {
  const list = Array.isArray(mailboxes) && mailboxes.length ? mailboxes : ["INBOX"];
  return [...new Set(list.map((mailbox) => normalizeMicrosoftMailboxLabel(mailbox)))];
}

function readMicrosoftApiCallBody(response: Record<string, unknown>, label: string): Record<string, unknown> {
  const upstreamStatus = Number(firstPresent(response.status_code, response.statusCode, response.status) ?? 0);
  const bodyValue = firstPresent(response.body, response.data, response.payload);
  const bodyText = typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue ?? {});
  if (upstreamStatus && (upstreamStatus < 200 || upstreamStatus >= 300)) {
    throw new Error(`${label} 返回 HTTP ${upstreamStatus}: ${bodyText.trim()}`);
  }
  try {
    return bodyText.trim() ? readRecord(JSON.parse(bodyText)) : {};
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} 没有返回合法 JSON: ${detail}`);
  }
}

async function fetchMicrosoftApiCallJson(config: RuntimeConfig, payload: Record<string, unknown>, label: string): Promise<Record<string, unknown>> {
  try {
    const response = await fetchManagementJson(config, "/v0/management/api-call", {
      method: "POST",
      headers: buildManagementHeaders(config, "application/json"),
      body: JSON.stringify(payload),
    });
    return readMicrosoftApiCallBody(response, label);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/^CPA 代理 Microsoft API 请求失败/.test(detail)) {
      throw error;
    }
    throw new Error(`CPA 代理 Microsoft API 请求失败：${detail}`);
  }
}

async function exchangeMicrosoftRefreshTokenViaManagementApi(
  config: RuntimeConfig,
  clientId: string,
  refreshToken: string,
  strategyName: string,
  authIndex = "",
): Promise<MicrosoftAccessTokenResult> {
  const strategy = resolveMicrosoftTokenStrategy(strategyName);
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    ...(strategy.extraData ?? {}),
  });
  const payload = await fetchMicrosoftApiCallJson(
    config,
    {
      ...(authIndex ? { auth_index: authIndex } : {}),
      method: "POST",
      url: strategy.url,
      header: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      data: body.toString(),
    },
    `Microsoft token ${strategy.name}`,
  );
  const accessToken = firstNonEmpty(payload.access_token, payload.accessToken);
  if (!accessToken) {
    throw new Error(`${strategy.name}: token response missing access_token`);
  }
  return {
    accessToken,
    nextRefreshToken: firstNonEmpty(payload.refresh_token, payload.refreshToken),
    tokenStrategy: strategy.name,
  };
}

function buildMicrosoftMessagesUrl(transport: MicrosoftTransportPlan["transport"], mailbox: string, top: number): string {
  const mailboxId = normalizeMicrosoftMailboxId(mailbox);
  const params = new URLSearchParams({
    $top: String(Math.max(1, Math.min(Math.trunc(top || 5), 30))),
    $orderby: transport === "graph" ? "receivedDateTime desc" : "ReceivedDateTime desc",
    $select: transport === "graph"
      ? "id,internetMessageId,subject,from,bodyPreview,receivedDateTime"
      : "Id,Subject,From,BodyPreview,Body,ReceivedDateTime",
  });
  const base = transport === "graph" ? MICROSOFT_GRAPH_API_BASE : MICROSOFT_OUTLOOK_API_BASE;
  return `${base}/${mailboxId}/messages?${params.toString()}`;
}

function readNestedRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function normalizeMicrosoftMessage(input: unknown, mailbox: string): MicrosoftMailMessage {
  const raw = readNestedRecord(input);
  const sender = readNestedRecord(firstPresent(raw.From, raw.from));
  const emailAddress = readNestedRecord(firstPresent(sender.EmailAddress, sender.emailAddress));
  const body = readNestedRecord(firstPresent(raw.Body, raw.body));
  const receivedDateTime = firstNonEmpty(raw.ReceivedDateTime, raw.receivedDateTime);
  const receivedTimestamp = Date.parse(receivedDateTime);
  return {
    id: firstNonEmpty(raw.Id, raw.id, raw.internetMessageId),
    mailbox: normalizeMicrosoftMailboxLabel(firstNonEmpty(raw.mailbox, mailbox)),
    subject: firstNonEmpty(raw.Subject, raw.subject),
    from: {
      emailAddress: {
        address: firstNonEmpty(emailAddress.Address, emailAddress.address),
        name: firstNonEmpty(emailAddress.Name, emailAddress.name),
      },
    },
    bodyPreview: firstNonEmpty(raw.BodyPreview, raw.bodyPreview),
    body: {
      content: firstNonEmpty(body.Content, body.content),
    },
    receivedDateTime,
    receivedTimestamp: Number.isFinite(receivedTimestamp) ? receivedTimestamp : 0,
  };
}

async function fetchMicrosoftMailboxMessagesViaManagementApi(
  config: RuntimeConfig,
  accessToken: string,
  mailbox: string,
  top: number,
  transport: MicrosoftTransportPlan["transport"],
  authIndex = "",
): Promise<MicrosoftMailMessage[]> {
  const payload = await fetchMicrosoftApiCallJson(
    config,
    {
      ...(authIndex ? { auth_index: authIndex } : {}),
      method: "GET",
      url: buildMicrosoftMessagesUrl(transport, mailbox, top),
      header: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    },
    `Microsoft ${transport} mailbox ${normalizeMicrosoftMailboxLabel(mailbox)}`,
  );
  const messages = Array.isArray(payload.value) ? payload.value : [];
  return messages.map((message) => normalizeMicrosoftMessage(message, mailbox));
}

async function fetchMicrosoftMailboxViaManagementApi(
  config: RuntimeConfig,
  clientId: string,
  refreshToken: string,
  mailbox: string,
  top: number,
  authIndex = "",
): Promise<{
  messages: MicrosoftMailMessage[];
  nextRefreshToken: string;
  transport: string;
  tokenStrategy: string;
}> {
  const errors: string[] = [];
  for (const plan of MICROSOFT_TRANSPORT_PLANS) {
    for (const strategyName of plan.strategyNames) {
      try {
        const token = await exchangeMicrosoftRefreshTokenViaManagementApi(config, clientId, refreshToken, strategyName, authIndex);
        const messages = await fetchMicrosoftMailboxMessagesViaManagementApi(config, token.accessToken, mailbox, top, plan.transport, authIndex);
        return {
          messages,
          nextRefreshToken: token.nextRefreshToken,
          transport: plan.transport,
          tokenStrategy: token.tokenStrategy,
        };
      } catch (error) {
        errors.push(`${plan.transport}/${strategyName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  throw new Error(`Hotmail API 对接请求失败：${errors.join(" | ")}`);
}

function getMicrosoftMessageSender(message: MicrosoftMailMessage): string {
  return firstNonEmpty(message.from?.emailAddress?.address).trim();
}

function getMicrosoftMessageSearchText(message: MicrosoftMailMessage): string {
  return [
    message.subject,
    message.bodyPreview,
    message.body?.content,
    getMicrosoftMessageSender(message),
  ].join("\n");
}

function normalizeFilterText(value: unknown): string {
  return firstNonEmpty(value).toLowerCase();
}

function isOpenAiMicrosoftMessage(message: MicrosoftMailMessage): boolean {
  return /openai\.com|auth0\.openai\.com/i.test(`${getMicrosoftMessageSender(message)}\n${getMicrosoftMessageSearchText(message)}`);
}

function selectMicrosoftVerificationCode(
  messages: MicrosoftMailMessage[],
  options: {
    filterAfterTimestamp?: number;
    senderFilters?: string[];
    subjectFilters?: string[];
    excludeCodes?: string[];
  },
): { code: string; message: MicrosoftMailMessage | null; usedTimeFallback: boolean } {
  const senderFilters = (options.senderFilters ?? []).map(normalizeFilterText).filter(Boolean);
  const subjectFilters = (options.subjectFilters ?? []).map(normalizeFilterText).filter(Boolean);
  const excludedCodes = new Set((options.excludeCodes ?? []).map((value) => String(value || "").trim()).filter(Boolean));
  const hasExplicitFilters = senderFilters.length > 0 || subjectFilters.length > 0;
  const orderedMessages = [...messages].sort((left, right) => right.receivedTimestamp - left.receivedTimestamp);

  for (const usedTimeFallback of [false, true]) {
    for (const message of orderedMessages) {
      if (!usedTimeFallback && options.filterAfterTimestamp && message.receivedTimestamp && message.receivedTimestamp < options.filterAfterTimestamp) {
        continue;
      }
      const searchText = getMicrosoftMessageSearchText(message);
      const code = searchText.match(/\b(\d{6})\b/)?.[1] || "";
      if (!code || excludedCodes.has(code)) {
        continue;
      }
      if (!hasExplicitFilters && !isOpenAiMicrosoftMessage(message)) {
        continue;
      }
      const sender = normalizeFilterText(getMicrosoftMessageSender(message));
      const subject = normalizeFilterText(message.subject);
      const preview = normalizeFilterText(message.bodyPreview);
      const normalizedSearchText = normalizeFilterText(searchText);
      const senderMatched = senderFilters.length === 0
        ? true
        : senderFilters.some((filter) => sender.includes(filter) || preview.includes(filter) || normalizedSearchText.includes(filter));
      const subjectMatched = subjectFilters.length === 0
        ? true
        : subjectFilters.some((filter) => subject.includes(filter) || preview.includes(filter) || normalizedSearchText.includes(filter));
      if (!senderMatched && !subjectMatched) {
        continue;
      }
      return { code, message, usedTimeFallback };
    }
  }
  return { code: "", message: null, usedTimeFallback: false };
}

async function fetchHotmailVerificationCodeViaMicrosoftApi(input: HotmailVerificationCodeInput): Promise<HotmailVerificationCodeResult> {
  if (!input.config) {
    throw new Error("缺少 CPA 配置，无法通过 API 对接读取 Hotmail 验证码");
  }
  const clientId = firstNonEmpty(input.account.clientId);
  const initialRefreshToken = firstNonEmpty(input.account.refreshToken);
  if (!clientId) {
    throw new Error(`Hotmail 账号 ${input.account.email || input.account.id} 缺少客户端 ID。`);
  }
  if (!initialRefreshToken) {
    throw new Error(`Hotmail 账号 ${input.account.email || input.account.id} 缺少刷新令牌（refresh token）。`);
  }

  let workingRefreshToken = initialRefreshToken;
  let latestRefreshToken = "";
  let latestTransport = "";
  let latestTokenStrategy = "";
  const messages: MicrosoftMailMessage[] = [];
  for (const mailbox of normalizeMicrosoftMailboxList(input.mailboxes?.length ? input.mailboxes : ["INBOX", "Junk"])) {
    const result = await fetchMicrosoftMailboxViaManagementApi(input.config, clientId, workingRefreshToken, mailbox, input.top ?? 10, input.authIndex);
    if (result.nextRefreshToken) {
      workingRefreshToken = result.nextRefreshToken;
      latestRefreshToken = result.nextRefreshToken;
    }
    latestTransport = result.transport;
    latestTokenStrategy = result.tokenStrategy;
    messages.push(...result.messages);
  }

  const selected = selectMicrosoftVerificationCode(messages, {
    filterAfterTimestamp: Math.max(0, Math.trunc(input.filterAfterTimestamp ?? 0)),
    senderFilters: input.senderFilters ?? [],
    subjectFilters: input.subjectFilters ?? [],
    excludeCodes: input.excludeCodes ?? [],
  });
  if (!selected.code) {
    throw new Error("未在 Hotmail 中找到验证码");
  }
  return {
    code: selected.code,
    nextRefreshToken: latestRefreshToken,
    transport: latestTransport,
    raw: {
      source: "microsoft-api",
      tokenStrategy: latestTokenStrategy,
      usedTimeFallback: selected.usedTimeFallback,
      message: selected.message,
    },
  };
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs = WEB_MANAGEMENT_FETCH_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  let didTimeout = false;
  const timeoutId = controller
    ? setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, timeoutMs)
    : null;
  try {
    const response = await fetch(url, {
      ...init,
      signal: init.signal ?? controller?.signal,
    });
    const text = await response.text();
    const payload = text.trim() ? readRecord(JSON.parse(text)) : {};
    if (!response.ok) {
      throw new Error(firstNonEmpty(payload.message, payload.error, payload.detail, text) || `HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (didTimeout || (error instanceof DOMException && error.name === "AbortError")) {
      throw new Error(`Hotmail 验证码接口请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    if (error instanceof TypeError && /failed to fetch|load failed|network/i.test(error.message)) {
      throw new Error("无法连接 Hotmail helper，请确认本地 helper 已启动且地址可访问");
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Hotmail 验证码接口没有返回合法 JSON: ${error.message}`);
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function fetchHotmailVerificationCode(input: HotmailVerificationCodeInput): Promise<HotmailVerificationCodeResult> {
  if (input.config) {
    return fetchHotmailVerificationCodeViaMicrosoftApi(input);
  }
  const helperUrl = normalizeHotmailHelperUrl(input.helperUrl);
  const endpoint = `${helperUrl}/code`;
  const raw = await fetchJsonWithTimeout(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.account.email,
      clientId: input.account.clientId,
      refreshToken: input.account.refreshToken,
      top: Math.max(1, Math.min(Math.trunc(input.top ?? 10), 30)),
      mailboxes: input.mailboxes?.length ? input.mailboxes : ["INBOX", "Junk"],
      senderFilters: input.senderFilters ?? [],
      subjectFilters: input.subjectFilters ?? [],
      excludeCodes: input.excludeCodes ?? [],
      filterAfterTimestamp: Math.max(0, Math.trunc(input.filterAfterTimestamp ?? 0)),
    }),
  });
  const code = firstNonEmpty(raw.code, raw.otp, raw.verificationCode, raw.verification_code);
  if (!code) {
    throw new Error(firstNonEmpty(raw.message, raw.error) || "未在 Hotmail 中找到验证码");
  }
  return {
    code,
    nextRefreshToken: firstNonEmpty(raw.nextRefreshToken, raw.next_refresh_token),
    transport: firstNonEmpty(raw.transport),
    raw,
  };
}

async function downloadAuthFile(config: RuntimeConfig, name: string): Promise<Record<string, unknown>> {
  const text = await fetchManagementText(config, "/v0/management/auth-files/download", { method: "GET" }, { name });
  try {
    return readRecord(JSON.parse(text));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知解析错误";
    throw new Error(`下载的账号文件不是合法 JSON: ${detail}`);
  }
}

async function uploadAuthFile(config: RuntimeConfig, name: string, payload: Record<string, unknown>): Promise<void> {
  await fetchManagementText(
    config,
    "/v0/management/auth-files",
    {
      method: "POST",
      headers: buildManagementHeaders(config, "application/json"),
      body: JSON.stringify(payload),
    },
    { name },
  );
}

function applyDownloadedAuthPayload(record: WebAuthRecord, payload: Record<string, unknown>): void {
  const claims = extractCodexClaims(firstNonEmpty(payload.id_token));
  const currentPlan = normalizePlan(record.plan_type) === "unknown" ? "" : record.plan_type;
  record.email = firstNonEmpty(record.email, payload.email, claims.email);
  record.plan_type = firstNonEmpty(currentPlan, claims.plan_type, inferPlanFromName(record.name), "unknown");
  record.account_id = firstNonEmpty(record.account_id, payload.account_id, claims.account_id);
  record.priority = normalizePriority(firstPresent(record.priority, payload.priority));
  record.disabled = normalizeBoolOrNull(firstPresent(payload.disabled, record.disabled)) ?? undefined;
  record.expired = firstNonEmpty(payload.expired, payload.expires_at, payload.expiresAt, record.expired);
  record.has_refresh_token = Boolean(firstNonEmpty(payload.refresh_token, payload.refreshToken)) || record.has_refresh_token;
  record.raw = { ...record.raw, ...payload };
}

function copyAuthRecordIntoReport(report: WebQuotaReport, record: WebAuthRecord): void {
  report.email = record.email;
  report.plan_type = record.plan_type;
  report.account_id = record.account_id;
  report.priority = record.priority;
  report.disabled = record.disabled;
  report.expired = record.expired;
  report.has_refresh_token = record.has_refresh_token;
}

async function preloadMissingAuthDetails(config: RuntimeConfig, records: WebAuthRecord[]): Promise<WebAuthRecord[]> {
  for (const record of records) {
    if (record.account_id) {
      continue;
    }
    try {
      applyDownloadedAuthPayload(record, await downloadAuthFile(config, record.name));
    } catch (error) {
      // 列表加载阶段的预补全失败不应阻断整个 Web 页面，查询阶段会再给单账号错误。
      record.raw.prefetch_error = error instanceof Error ? error.message : String(error);
    }
  }
  return records;
}

async function loadWebAuthSummaryRecords(config: RuntimeConfig): Promise<WebAuthRecord[]> {
  const payload = await fetchManagementJson(config, "/v0/management/auth-files");
  const rawFiles = Array.isArray(payload.files) ? payload.files : [];
  return buildAuthRecordsFromAuthFiles(rawFiles);
}

async function loadWebAuthRecords(config: RuntimeConfig): Promise<WebAuthRecord[]> {
  return preloadMissingAuthDetails(config, await loadWebAuthSummaryRecords(config));
}

function buildWhamApiCallPayload(record: WebAuthRecord): Record<string, unknown> {
  return {
    auth_index: record.auth_index,
    method: "GET",
    url: WHAM_USAGE_URL,
    header: {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": CODEX_USER_AGENT,
      "Chatgpt-Account-Id": record.account_id,
    },
  };
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = cleanString(value).replace(/%$/, "");
  if (!text) {
    return null;
  }
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampFloat(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

function boolFromAny(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
}

function readQuotaResetTarget(windowValue: Record<string, unknown>): Date | null {
  const resetAt = numberOrNull(firstPresent(windowValue.reset_at, windowValue.resetAt));
  const resetAfterSeconds = numberOrNull(firstPresent(windowValue.reset_after_seconds, windowValue.resetAfterSeconds));
  return resetAt && resetAt > 0 ? new Date(resetAt * 1000) : resetAfterSeconds && resetAfterSeconds > 0 ? new Date(Date.now() + resetAfterSeconds * 1000) : null;
}

function formatResetLabel(target: Date | null): string {
  if (!target) {
    return "-";
  }
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const day = String(target.getDate()).padStart(2, "0");
  const hour = String(target.getHours()).padStart(2, "0");
  const minute = String(target.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

function buildWindow(windowId: string, label: string, rawWindow: unknown, limitReached: unknown, allowed: unknown): AccountItem["windows"][number] | null {
  const windowValue = readRecord(rawWindow);
  if (!Object.keys(windowValue).length) {
    return null;
  }
  const directUsed = numberOrNull(firstPresent(windowValue.used_percent, windowValue.usedPercent));
  const resetTarget = readQuotaResetTarget(windowValue);
  const resetLabel = formatResetLabel(resetTarget);
  const exhaustedHint = boolFromAny(limitReached) || allowed === false;
  const usedPercent = directUsed !== null ? clampFloat(directUsed, 0, 100) : exhaustedHint && resetLabel !== "-" ? 100 : null;
  const remainingPercent = usedPercent === null ? null : clampFloat(100 - usedPercent, 0, 100);
  return {
    id: windowId,
    label,
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    reset_at: resetTarget ? resetTarget.toISOString() : null,
    reset_label: resetLabel,
    exhausted: usedPercent !== null && usedPercent >= 100,
  };
}

function findQuotaWindows(rateLimit: Record<string, unknown>): [Record<string, unknown>, Record<string, unknown>] {
  const primary = readRecord(firstPresent(rateLimit.primary_window, rateLimit.primaryWindow));
  const secondary = readRecord(firstPresent(rateLimit.secondary_window, rateLimit.secondaryWindow));
  let fiveHour: Record<string, unknown> = {};
  let weekly: Record<string, unknown> = {};
  for (const candidate of [primary, secondary]) {
    const seconds = numberOrNull(firstPresent(candidate.limit_window_seconds, candidate.limitWindowSeconds));
    if (seconds === WINDOW_5H_SECONDS && !Object.keys(fiveHour).length) {
      fiveHour = candidate;
    }
    if (seconds === WINDOW_7D_SECONDS && !Object.keys(weekly).length) {
      weekly = candidate;
    }
  }
  return [Object.keys(fiveHour).length ? fiveHour : primary, Object.keys(weekly).length ? weekly : secondary];
}

function parseCodexWindows(payload: Record<string, unknown>): AccountItem["windows"] {
  const rateLimit = readRecord(firstPresent(payload.rate_limit, payload.rateLimit));
  if (!Object.keys(rateLimit).length) {
    return [];
  }
  const [fiveHour, weekly] = findQuotaWindows(rateLimit);
  return [
    buildWindow("code-5h", "5h", fiveHour, rateLimit.limit_reached, rateLimit.allowed),
    buildWindow("code-7d", "7d", weekly, rateLimit.limit_reached, rateLimit.allowed),
  ].filter((item): item is AccountItem["windows"][number] => item !== null);
}

function parseAdditionalWindows(payload: Record<string, unknown>): AccountItem["additional_windows"] {
  const rawWindows = firstPresent(payload.additional_rate_limits, payload.additionalRateLimits);
  if (!Array.isArray(rawWindows)) {
    return [];
  }
  const results: AccountItem["additional_windows"] = [];
  rawWindows.forEach((rawItem, index) => {
    const item = readRecord(rawItem);
    const rateLimit = readRecord(firstPresent(item.rate_limit, item.rateLimit));
    if (!Object.keys(rateLimit).length) {
      return;
    }
    const name = firstNonEmpty(item.limit_name, item.limitName, item.metered_feature, item.meteredFeature, `additional-${index + 1}`);
    const primary = firstPresent(rateLimit.primary_window, rateLimit.primaryWindow);
    const secondary = firstPresent(rateLimit.secondary_window, rateLimit.secondaryWindow);
    const primaryWindow = buildWindow(`${name}-primary`, `${name} 5h`, primary, rateLimit.limit_reached, rateLimit.allowed);
    const secondaryWindow = buildWindow(`${name}-secondary`, `${name} 7d`, secondary, rateLimit.limit_reached, rateLimit.allowed);
    if (primaryWindow) {
      results.push(primaryWindow);
    }
    if (secondaryWindow) {
      results.push(secondaryWindow);
    }
  });
  return results;
}

function deriveWebStatus(report: WebQuotaReport): AccountItem["status"] {
  if (report.error || !report.account_id) {
    return "error";
  }
  const fiveHour = report.windows.find((item) => item.id === "code-5h");
  const weekly = report.windows.find((item) => item.id === "code-7d");
  if ((fiveHour?.remaining_percent ?? null) === null && (weekly?.remaining_percent ?? null) === null) {
    return "unknown";
  }
  if (report.windows.some((item) => item.exhausted)) {
    return "exhausted";
  }
  if (typeof fiveHour?.remaining_percent === "number" && fiveHour.remaining_percent <= LOW_5H_THRESHOLD) {
    return "low";
  }
  if (typeof weekly?.remaining_percent === "number" && weekly.remaining_percent <= LOW_7D_THRESHOLD) {
    return "low";
  }
  return "healthy";
}

async function queryWebRecord(config: RuntimeConfig, input: WebAuthRecord): Promise<WebQuotaReport> {
  const record = { ...input, raw: { ...input.raw } };
  const startedAt = performance.now();
  const report: WebQuotaReport = {
    ...record,
    status: "unknown",
    windows: [],
    additional_windows: [],
    error: "",
    timings_ms: {},
    last_query_at: null,
    quota_reset_at: null,
    quota_reset_label: null,
    quota_updated_at: null,
  };
  const finalize = () => {
    const queriedAt = new Date().toISOString();
    report.timings_ms.query_total_ms = Math.round((performance.now() - startedAt) * 10) / 10;
    report.status = deriveWebStatus(report);
    report.last_query_at = queriedAt;
    const quotaReset = readPrimaryQuotaReset(report.windows);
    if (!report.error && quotaReset.label) {
      report.quota_reset_at = quotaReset.resetAt;
      report.quota_reset_label = quotaReset.label;
      report.quota_updated_at = quotaReset.label;
    }
    return report;
  };

  try {
    if (record.name) {
      const downloadStartedAt = performance.now();
      try {
        applyDownloadedAuthPayload(record, await downloadAuthFile(config, record.name));
        copyAuthRecordIntoReport(report, record);
      } catch (error) {
        if (!record.account_id) {
          report.error = error instanceof Error ? error.message : String(error);
          return finalize();
        }
      } finally {
        report.timings_ms.download_auth_file_ms = Math.round((performance.now() - downloadStartedAt) * 10) / 10;
      }
    }
    if (!record.auth_index) {
      report.error = "缺少 auth_index";
      return finalize();
    }
    if (!record.account_id) {
      report.error = "缺少 chatgpt_account_id";
      return finalize();
    }
    const apiCallStartedAt = performance.now();
    const response = await fetchManagementJson(config, "/v0/management/api-call", {
      method: "POST",
      headers: buildManagementHeaders(config, "application/json"),
      body: JSON.stringify(buildWhamApiCallPayload(record)),
    });
    report.timings_ms.api_call_ms = Math.round((performance.now() - apiCallStartedAt) * 10) / 10;
    const upstreamStatus = Number(response.status_code ?? 0);
    const bodyText = typeof response.body === "string" ? response.body : "";
    const body = bodyText.trim() ? readRecord(JSON.parse(bodyText)) : {};
    if (upstreamStatus < 200 || upstreamStatus >= 300) {
      report.error = bodyText.trim() || `OpenAI 返回 HTTP ${upstreamStatus}`;
      return finalize();
    }
    report.plan_type = firstNonEmpty(body.plan_type, body.planType, report.plan_type);
    report.priority = normalizePriority(firstPresent(report.priority, body.priority));
    report.windows = parseCodexWindows(body);
    report.additional_windows = parseAdditionalWindows(body);
    return finalize();
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    return finalize();
  }
}

async function runWebQueries(
  config: RuntimeConfig,
  records: WebAuthRecord[],
  onProgress?: (event: QueryProgressEvent) => void,
): Promise<WebQuotaReport[]> {
  const total = records.length;
  const results: WebQuotaReport[] = new Array(total);
  const workerCount = Math.max(1, Math.min(Math.trunc(config.queryConcurrency || DEFAULT_QUERY_CONCURRENCY), total || 1));
  let nextIndex = 0;
  let completed = 0;
  const requestId = createRequestId("web-query");

  async function runWorker() {
    while (nextIndex < total) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const report = await queryWebRecord(config, records[currentIndex]);
      results[currentIndex] = report;
      completed += 1;
      onProgress?.({
        requestId,
        completed,
        total,
        currentLabel: report.email || report.name,
        authIndex: report.auth_index,
        status: report.status,
        timingsMs: report.timings_ms,
      });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function buildAuthRecordsFromCachedItems(items: AccountItem[]): WebAuthRecord[] {
  return sortWebAuthRecords(
    items.map((item) => ({
      name: item.name || item.email || "unknown",
      email: item.email,
      plan_type: item.plan_type || "unknown",
      account_id: item.account_id,
      auth_index: item.auth_index,
      priority: typeof item.priority === "number" ? item.priority : null,
      disabled: typeof item.disabled === "boolean" ? item.disabled : undefined,
      expired: item.expired ?? "",
      has_refresh_token: Boolean(item.has_refresh_token),
      raw: item as unknown as Record<string, unknown>,
    })),
  );
}

function mergeFreshAuthRecord(record: WebAuthRecord, freshRecord: WebAuthRecord | null): WebAuthRecord {
  if (!freshRecord) {
    return record;
  }
  return {
    name: freshRecord.name || record.name,
    email: freshRecord.email || record.email,
    plan_type: freshRecord.plan_type || record.plan_type,
    account_id: freshRecord.account_id || record.account_id,
    auth_index: freshRecord.auth_index || record.auth_index,
    priority: freshRecord.priority ?? record.priority,
    disabled: freshRecord.disabled ?? record.disabled,
    expired: freshRecord.expired || record.expired,
    has_refresh_token: freshRecord.has_refresh_token || record.has_refresh_token,
    raw: { ...record.raw, ...freshRecord.raw },
  };
}

async function refreshCachedAuthRecords(config: RuntimeConfig, records: WebAuthRecord[]): Promise<WebAuthRecord[]> {
  if (!records.length) {
    return records;
  }
  try {
    const freshRecords = await loadWebAuthSummaryRecords(config);
    const byAuthIndex = new Map(freshRecords.filter((record) => record.auth_index).map((record) => [record.auth_index, record]));
    const byName = new Map(freshRecords.filter((record) => record.name).map((record) => [record.name, record]));
    return records.map((record) => mergeFreshAuthRecord(record, byAuthIndex.get(record.auth_index) ?? byName.get(record.name) ?? null));
  } catch {
    return records;
  }
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

function readLegacyWebPayloadStorage(): PayloadEnvelope | null {
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

function writeWebStorage(key: string, value: unknown, legacyKeys: string[] = []): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    legacyKeys.forEach((legacyKey) => window.localStorage.removeItem(legacyKey));
  } catch {
    // 浏览器隐私模式或禁用 storage 时不影响主流程。
  }
}

function removeWebStorage(primaryKey: string, legacyKeys: string[] = []): void {
  try {
    window.localStorage.removeItem(primaryKey);
    legacyKeys.forEach((legacyKey) => window.localStorage.removeItem(legacyKey));
  } catch {
    // 清理缓存只是辅助动作，浏览器禁用 storage 时直接忽略即可。
  }
}

function triggerBrowserDownload(name: string, content: string): void {
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

async function webDownloadSelectedAccounts(
  config: RuntimeConfig,
  items: AccountItem[],
  onProgress?: (event: QueryProgressEvent) => void,
): Promise<DownloadedAccountConfig[]> {
  const names = items.map((item) => item.name.trim()).filter(Boolean);
  const requestId = createRequestId("web-download-selected-accounts");
  const downloaded: DownloadedAccountConfig[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const content = await fetchManagementText(config, "/v0/management/auth-files/download", { method: "GET" }, { name });
    triggerBrowserDownload(name, content);
    downloaded.push({ name, destinationPath: `browser-download:${name}` });
    onProgress?.({
      requestId,
      completed: index + 1,
      total: names.length,
      currentLabel: name,
      authIndex: "",
      status: "",
      timingsMs: {},
    });
  }
  return downloaded;
}

async function webSyncAccountPriorities(
  config: RuntimeConfig,
  changes: Array<{ name: string; priority: number }>,
  onProgress?: (event: QueryProgressEvent) => void,
): Promise<void> {
  const requestId = createRequestId("web-sync-account-priorities");
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    await fetchManagementText(config, "/v0/management/auth-files/fields", {
      method: "PATCH",
      headers: buildManagementHeaders(config, "application/json"),
      body: JSON.stringify(change),
    });
    onProgress?.({
      requestId,
      completed: index + 1,
      total: changes.length,
      currentLabel: change.name,
      authIndex: "",
      status: "",
      timingsMs: {},
    });
  }
}

function formatKeeperWindowLabel(seconds: number | null, fallback: string): string {
  if (seconds === WINDOW_5H_SECONDS) {
    return "5h";
  }
  if (seconds === WINDOW_7D_SECONDS) {
    return "Week";
  }
  return fallback;
}

function formatKeeperRemaining(seconds: number | null): string {
  if (seconds === null) {
    return "未知";
  }
  if (seconds <= 0) {
    return "已过期";
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) {
    return `${days}天${hours}小时`;
  }
  if (hours > 0) {
    return `${hours}小时${minutes}分钟`;
  }
  return `${minutes}分钟`;
}

function readExpirationSeconds(expired: string, accessToken: string): number | null {
  if (expired) {
    const normalized = expired.endsWith("Z") ? expired : expired;
    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed)) {
      return (parsed - Date.now()) / 1000;
    }
  }
  const jwtExp = numberOrNull(decodeJwtPayload(accessToken).exp);
  if (jwtExp !== null && jwtExp > 0) {
    return jwtExp - Date.now() / 1000;
  }
  return null;
}

function readKeeperQuotaInfo(body: Record<string, unknown>): Pick<
  KeeperItemReport,
  "primary_label" | "primary_used_percent" | "secondary_label" | "secondary_used_percent"
> {
  const rateLimit = readRecord(firstPresent(body.rate_limit, body.rateLimit));
  const primary = readRecord(firstPresent(rateLimit.primary_window, rateLimit.primaryWindow));
  const secondary = readRecord(firstPresent(rateLimit.secondary_window, rateLimit.secondaryWindow));
  const primarySeconds = numberOrNull(firstPresent(primary.limit_window_seconds, primary.limitWindowSeconds));
  const secondarySeconds = numberOrNull(firstPresent(secondary.limit_window_seconds, secondary.limitWindowSeconds));
  return {
    primary_label: formatKeeperWindowLabel(primarySeconds, "primary_window"),
    primary_used_percent: numberOrNull(firstPresent(primary.used_percent, primary.usedPercent)),
    secondary_label: Object.keys(secondary).length ? formatKeeperWindowLabel(secondarySeconds, "secondary_window") : "",
    secondary_used_percent: Object.keys(secondary).length ? numberOrNull(firstPresent(secondary.used_percent, secondary.usedPercent)) : null,
  };
}

function buildKeeperBaseReport(item: AccountItem): KeeperItemReport {
  return {
    name: item.name,
    email: item.email,
    auth_index: item.auth_index,
    plan_type: item.plan_type,
    disabled: typeof item.disabled === "boolean" ? item.disabled : null,
    expired: item.expired ?? "",
    remaining_label: "未知",
    has_refresh_token: Boolean(item.has_refresh_token),
    primary_label: "",
    primary_used_percent: null,
    secondary_label: "",
    secondary_used_percent: null,
    action: "skip",
    outcome: "skipped",
    applied: false,
    refresh_candidate: false,
    refreshed: false,
    reason: "尚未检查",
  };
}

async function deleteManagementAuthFile(config: RuntimeConfig, name: string): Promise<void> {
  await fetchManagementText(config, "/v0/management/auth-files", { method: "DELETE" }, { name });
}

async function setManagementAuthFileDisabled(config: RuntimeConfig, name: string, disabled: boolean): Promise<void> {
  await fetchManagementText(config, "/v0/management/auth-files/status", {
    method: "PATCH",
    headers: buildManagementHeaders(config, "application/json"),
    body: JSON.stringify({ name, disabled }),
  });
}

function buildOpenAIRefreshPayload(refreshToken: string): Record<string, unknown> {
  return {
    redirect_uri: OPENAI_CODEX_REDIRECT_URI,
    grant_type: "refresh_token",
    client_id: OPENAI_CODEX_CLIENT_ID,
    refresh_token: refreshToken,
  };
}

function buildOpenAIRefreshApiCallPayload(authIndex: string, refreshToken: string): Record<string, unknown> {
  return {
    auth_index: authIndex,
    method: "POST",
    url: OPENAI_OAUTH_TOKEN_URL,
    header: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    data: JSON.stringify(buildOpenAIRefreshPayload(refreshToken)),
  };
}

async function refreshOpenAITokenViaManagementApi(config: RuntimeConfig, authIndex: string, refreshToken: string): Promise<Record<string, unknown>> {
  const response = await fetchManagementJson(config, "/v0/management/api-call", {
    method: "POST",
    headers: buildManagementHeaders(config, "application/json"),
    body: JSON.stringify(buildOpenAIRefreshApiCallPayload(authIndex, refreshToken)),
  });
  const upstreamStatus = Number(response.status_code ?? 0);
  const bodyText = typeof response.body === "string" ? response.body : "";
  if (upstreamStatus < 200 || upstreamStatus >= 300) {
    throw new Error(bodyText.trim() || `OpenAI refresh 返回 HTTP ${upstreamStatus}`);
  }
  try {
    const body = bodyText.trim() ? readRecord(JSON.parse(bodyText)) : {};
    if (!firstNonEmpty(body.access_token, body.accessToken)) {
      throw new Error("OpenAI refresh 没有返回 access_token");
    }
    return body;
  } catch (error) {
    if (error instanceof Error && error.message === "OpenAI refresh 没有返回 access_token") {
      throw error;
    }
    const detail = error instanceof Error ? error.message : "未知解析错误";
    throw new Error(`OpenAI refresh 没有返回合法 JSON: ${detail}`);
  }
}

function buildRefreshedAuthPayload(detail: Record<string, unknown>, refreshBody: Record<string, unknown>): Record<string, unknown> {
  const now = new Date();
  const expiresIn = numberOrNull(firstPresent(refreshBody.expires_in, refreshBody.expiresIn)) ?? 864_000;
  return {
    ...detail,
    access_token: firstNonEmpty(refreshBody.access_token, refreshBody.accessToken),
    refresh_token: firstNonEmpty(refreshBody.refresh_token, refreshBody.refreshToken, detail.refresh_token, detail.refreshToken),
    id_token: firstNonEmpty(refreshBody.id_token, refreshBody.idToken, detail.id_token, detail.idToken),
    last_refresh: now.toISOString(),
    expired: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    type: firstNonEmpty(detail.type, detail.provider, "codex"),
  };
}

async function refreshKeeperAuthFile(
  config: RuntimeConfig,
  item: AccountItem,
  detail: Record<string, unknown>,
  keepDisabled: boolean,
): Promise<Record<string, unknown>> {
  const authIndex = firstNonEmpty(item.auth_index, detail.auth_index, detail.authIndex);
  const refreshToken = firstNonEmpty(detail.refresh_token, detail.refreshToken);
  if (!authIndex) {
    throw new Error("缺少 auth_index，无法通过 CPA 代理刷新 token");
  }
  if (!refreshToken) {
    throw new Error("缺少 Refresh Token");
  }
  const refreshBody = await refreshOpenAITokenViaManagementApi(config, authIndex, refreshToken);
  const refreshedAuth = buildRefreshedAuthPayload(detail, refreshBody);
  await uploadAuthFile(config, item.name, refreshedAuth);
  if (keepDisabled) {
    await setManagementAuthFileDisabled(config, item.name, true);
  }
  return refreshedAuth;
}

async function applyKeeperAction(config: RuntimeConfig, report: KeeperItemReport, dryRun: boolean): Promise<boolean> {
  if (dryRun || report.action === "none" || report.action === "skip" || report.action === "refresh" || report.action === "refresh-candidate") {
    return false;
  }
  if (report.action === "delete") {
    await deleteManagementAuthFile(config, report.name);
    return true;
  }
  if (report.action === "disable") {
    await setManagementAuthFileDisabled(config, report.name, true);
    return true;
  }
  if (report.action === "enable") {
    await setManagementAuthFileDisabled(config, report.name, false);
    return true;
  }
  return false;
}

async function processKeeperDirectActionItem(
  config: RuntimeConfig,
  item: AccountItem,
  action: KeeperDirectAction,
): Promise<KeeperItemReport> {
  const report = buildKeeperBaseReport(item);
  try {
    if (action === "disable") {
      await setManagementAuthFileDisabled(config, item.name, true);
      report.action = "disable";
      report.outcome = "alive";
      report.applied = true;
      report.disabled = true;
      report.reason = "已手动禁用证书";
      return report;
    }

    if (action === "delete") {
      await deleteManagementAuthFile(config, item.name);
      report.action = "delete";
      report.outcome = "dead";
      report.applied = true;
      report.reason = "已手动删除证书";
      return report;
    }

    const detail = await downloadAuthFile(config, item.name);
    const claims = extractCodexClaims(firstNonEmpty(detail.id_token));
    report.email = firstNonEmpty(item.email, detail.email, claims.email);
    report.plan_type = firstNonEmpty(item.plan_type, detail.plan_type, claims.plan_type, "unknown");
    report.disabled = normalizeBoolOrNull(firstPresent(detail.disabled, item.disabled)) ?? false;
    report.expired = firstNonEmpty(detail.expired, detail.expires_at, detail.expiresAt, item.expired);
    report.has_refresh_token = Boolean(firstNonEmpty(detail.refresh_token, detail.refreshToken));

    const refreshedAuth = await refreshKeeperAuthFile(config, item, detail, Boolean(report.disabled));
    report.action = "refresh";
    report.outcome = "alive";
    report.applied = true;
    report.refreshed = true;
    report.expired = firstNonEmpty(refreshedAuth.expired, refreshedAuth.expires_at, refreshedAuth.expiresAt, report.expired);
    report.remaining_label = formatKeeperRemaining(readExpirationSeconds(report.expired, firstNonEmpty(refreshedAuth.access_token, refreshedAuth.accessToken)));
    report.reason = "已手动刷新证书";
    return report;
  } catch (error) {
    report.action = "error";
    report.outcome = "error";
    report.reason = error instanceof Error ? error.message : String(error);
    return report;
  }
}

async function queryKeeperUsage(config: RuntimeConfig, item: AccountItem, detail: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown>; rawBody: string }> {
  const accountId = firstNonEmpty(detail.account_id, detail.chatgpt_account_id, item.account_id);
  const authIndex = firstNonEmpty(item.auth_index, detail.auth_index, detail.authIndex);
  if (!authIndex) {
    throw new Error("缺少 auth_index，无法通过 CPA 代理检查 usage");
  }
  if (!accountId) {
    throw new Error("缺少 chatgpt_account_id");
  }
  const response = await fetchManagementJson(config, "/v0/management/api-call", {
    method: "POST",
    headers: buildManagementHeaders(config, "application/json"),
    body: JSON.stringify(
      buildWhamApiCallPayload({
        name: item.name,
        email: item.email,
        plan_type: item.plan_type,
        account_id: accountId,
        auth_index: authIndex,
        priority: typeof item.priority === "number" ? item.priority : null,
        disabled: typeof item.disabled === "boolean" ? item.disabled : undefined,
        expired: item.expired ?? "",
        has_refresh_token: Boolean(item.has_refresh_token),
        raw: detail,
      }),
    ),
  });
  const status = Number(response.status_code ?? 0);
  const rawBody = typeof response.body === "string" ? response.body : "";
  return {
    status,
    rawBody,
    body: rawBody.trim() ? readRecord(JSON.parse(rawBody)) : {},
  };
}

async function processKeeperItem(config: RuntimeConfig, item: AccountItem, dryRun: boolean): Promise<KeeperItemReport> {
  const settings = normalizeKeeperSettings(config.keeperSettings);
  const report = buildKeeperBaseReport(item);
  try {
    const detail = await downloadAuthFile(config, item.name);
    const claims = extractCodexClaims(firstNonEmpty(detail.id_token));
    report.email = firstNonEmpty(item.email, detail.email, claims.email);
    report.plan_type = firstNonEmpty(item.plan_type, detail.plan_type, claims.plan_type, "unknown");
    report.disabled = normalizeBoolOrNull(firstPresent(detail.disabled, item.disabled)) ?? false;
    report.expired = firstNonEmpty(detail.expired, detail.expires_at, detail.expiresAt, item.expired);
    report.has_refresh_token = Boolean(firstNonEmpty(detail.refresh_token, detail.refreshToken));
    const accessToken = firstNonEmpty(detail.access_token, detail.accessToken);
    const remainingSeconds = readExpirationSeconds(report.expired, accessToken);
    report.remaining_label = formatKeeperRemaining(remainingSeconds);

    if (!report.has_refresh_token && remainingSeconds !== null && remainingSeconds <= 0) {
      report.action = "delete";
      report.outcome = "dead";
      report.reason = "Token 已过期且无 Refresh Token";
      report.applied = await applyKeeperAction(config, report, dryRun);
      return report;
    }
    if (!accessToken) {
      report.action = "skip";
      report.outcome = "skipped";
      report.reason = "缺少 access_token";
      return report;
    }

    const usage = await queryKeeperUsage(config, item, detail);
    if (usage.status === 401 || usage.status === 402) {
      report.action = "delete";
      report.outcome = "dead";
      report.reason = usage.status === 401 ? "Usage 返回 401，Token 无效" : "Usage 返回 402，workspace 不可用";
      report.applied = await applyKeeperAction(config, report, dryRun);
      return report;
    }
    if (usage.status !== 200) {
      report.action = "skip";
      report.outcome = "skipped";
      report.reason = usage.rawBody.trim() || `Usage 返回 HTTP ${usage.status}`;
      return report;
    }

    Object.assign(report, readKeeperQuotaInfo(usage.body));
    const primaryPct = report.primary_used_percent ?? 0;
    const secondaryPct = report.secondary_used_percent;
    const primaryReached = primaryPct >= settings.quotaThreshold;
    const secondaryReached = secondaryPct !== null && secondaryPct >= settings.quotaThreshold;
    const belowThreshold = secondaryPct === null
      ? primaryPct < settings.quotaThreshold
      : primaryPct < settings.quotaThreshold && secondaryPct < settings.quotaThreshold;
    const reachedSummary = [
      primaryReached ? `${report.primary_label}额度 ${primaryPct}%` : "",
      secondaryReached ? `${report.secondary_label}额度 ${secondaryPct}%` : "",
    ].filter(Boolean).join("、") || `${report.primary_label || "quota"}额度 ${primaryPct}%`;

    let effectiveDisabled = Boolean(report.disabled);
    if (!report.has_refresh_token && (primaryReached || secondaryReached)) {
      report.action = "delete";
      report.outcome = "dead";
      report.reason = `无 Refresh Token，且${reachedSummary} >= ${settings.quotaThreshold}%`;
    } else if (effectiveDisabled && belowThreshold) {
      report.action = "enable";
      report.outcome = "alive";
      report.reason = "已禁用账号额度恢复，符合重新启用条件";
      effectiveDisabled = false;
    } else if (!effectiveDisabled && (primaryReached || secondaryReached)) {
      report.action = "disable";
      report.outcome = "alive";
      report.reason = `${reachedSummary} >= ${settings.quotaThreshold}%`;
      effectiveDisabled = true;
    } else if (effectiveDisabled) {
      report.action = "none";
      report.outcome = "alive";
      report.reason = `${reachedSummary} >= ${settings.quotaThreshold}%，保持禁用`;
    } else {
      report.action = "none";
      report.outcome = "alive";
      report.reason = "额度未达到维护阈值";
    }

    report.refresh_candidate = Boolean(
      settings.enableRefresh &&
        report.has_refresh_token &&
        effectiveDisabled &&
        remainingSeconds !== null &&
        remainingSeconds > 0 &&
        remainingSeconds < settings.expiryThresholdDays * 86_400,
    );
    if (report.refresh_candidate) {
      if (dryRun) {
        if (report.action === "none") {
          report.action = "refresh";
          report.reason = "已禁用且临近过期，执行时将刷新 token";
        } else {
          report.reason += "；同时临近过期，执行时将刷新 token";
        }
        return report;
      }
      const refreshedAuth = await refreshKeeperAuthFile(config, item, detail, effectiveDisabled);
      report.action = "refresh";
      report.outcome = "alive";
      report.applied = true;
      report.refreshed = true;
      report.expired = firstNonEmpty(refreshedAuth.expired, refreshedAuth.expires_at, refreshedAuth.expiresAt, report.expired);
      report.remaining_label = formatKeeperRemaining(readExpirationSeconds(report.expired, firstNonEmpty(refreshedAuth.access_token, refreshedAuth.accessToken)));
      report.reason = report.reason === "额度未达到维护阈值" || report.reason.includes("保持禁用")
        ? "已禁用且临近过期，已刷新 token"
        : `${report.reason}；已刷新 token`;
      return report;
    }

    report.applied = await applyKeeperAction(config, report, dryRun);
    return report;
  } catch (error) {
    report.action = "error";
    report.outcome = "error";
    report.reason = error instanceof Error ? error.message : String(error);
    return report;
  }
}

function buildKeeperRunResult(items: KeeperItemReport[], dryRun: boolean): KeeperRunResult {
  return {
    summary: {
      generated_at: new Date().toISOString(),
      dry_run: dryRun,
      total: items.length,
      alive: items.filter((item) => item.outcome === "alive").length,
      dead: items.filter((item) => item.action === "delete").length,
      disabled: items.filter((item) => item.action === "disable").length,
      enabled: items.filter((item) => item.action === "enable").length,
      refreshed: items.filter((item) => item.refreshed || item.action === "refresh").length,
      refresh_candidates: items.filter((item) => item.refresh_candidate).length,
      skipped: items.filter((item) => item.outcome === "skipped").length,
      network_error: items.filter((item) => item.outcome === "network_error").length,
      errors: items.filter((item) => item.outcome === "error").length,
    },
    items,
  };
}

export async function runKeeperMaintenance(
  config: RuntimeConfig,
  items: AccountItem[],
  options: { dryRun: boolean },
  onProgress?: (event: QueryProgressEvent) => void,
): Promise<KeeperRunResult> {
  const normalizedConfig = normalizeRuntimeConfig(config);
  const targets = items.filter((item) => item.name.trim());
  const workerCount = Math.max(1, Math.min(normalizedConfig.keeperSettings.workerThreads, targets.length || 1));
  const reports: KeeperItemReport[] = new Array(targets.length);
  const requestId = createRequestId(options.dryRun ? "keeper-dry-run" : "keeper-apply");
  let nextIndex = 0;
  let completed = 0;

  async function runWorker() {
    while (nextIndex < targets.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const report = await processKeeperItem(normalizedConfig, targets[currentIndex], options.dryRun);
      reports[currentIndex] = report;
      completed += 1;
      onProgress?.({
        requestId,
        completed,
        total: targets.length,
        currentLabel: report.email || report.name,
        authIndex: report.auth_index,
        status: report.action,
        timingsMs: {},
      });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return buildKeeperRunResult(reports, options.dryRun);
}

export async function runKeeperDirectAction(
  config: RuntimeConfig,
  items: AccountItem[],
  action: KeeperDirectAction,
  onProgress?: (event: QueryProgressEvent) => void,
): Promise<KeeperRunResult> {
  const normalizedConfig = normalizeRuntimeConfig(config);
  const targets = items.filter((item) => item.name.trim());
  const workerCount = Math.max(1, Math.min(normalizedConfig.keeperSettings.workerThreads, targets.length || 1));
  const reports: KeeperItemReport[] = new Array(targets.length);
  const requestId = createRequestId(`keeper-direct-${action}`);
  let nextIndex = 0;
  let completed = 0;

  async function runWorker() {
    while (nextIndex < targets.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const target = targets[currentIndex];
      const report = await processKeeperDirectActionItem(normalizedConfig, target, action);
      reports[currentIndex] = report;
      completed += 1;
      onProgress?.({
        requestId,
        completed,
        total: targets.length,
        currentLabel: target.email || target.name,
        authIndex: target.auth_index,
        status: report.action,
        timingsMs: {},
      });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return buildKeeperRunResult(reports, false);
}

export async function fetchAccountList(config: RuntimeConfig): Promise<PayloadEnvelope> {
  return buildWebListPayload(await loadWebAuthRecords(normalizeRuntimeConfig(config)));
}

export async function queryCachedAccounts(
  config: RuntimeConfig,
  items: AccountItem[],
  onProgress?: (event: QueryProgressEvent) => void,
): Promise<PayloadEnvelope> {
  const normalizedConfig = normalizeRuntimeConfig(config);
  const records = await refreshCachedAuthRecords(normalizedConfig, buildAuthRecordsFromCachedItems(items));
  const reports = await runWebQueries(normalizedConfig, records, onProgress);
  return buildQueryPayload(await persistWebQuotaReports(reports));
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const rawConfig = readWebStorage<Partial<RuntimeConfig>>(WEB_RUNTIME_CONFIG_KEY, [LEGACY_WEB_RUNTIME_CONFIG_KEY]);
  const normalized = normalizeRuntimeConfig(rawConfig);
  const shouldStripHistoricalHotmailTokens =
    rawConfig?.oauthSettings &&
    normalizeOAuthSettings(rawConfig.oauthSettings).rememberHotmailTokens !== true &&
    normalized.oauthSettings.hotmailAccounts.length > 0;
  if (shouldStripHistoricalHotmailTokens) {
    const sanitized = sanitizeRuntimeConfigForStorage(normalized, { rememberHotmailTokens: false });
    writeWebStorage(WEB_RUNTIME_CONFIG_KEY, sanitized, [LEGACY_WEB_RUNTIME_CONFIG_KEY]);
    return sanitized;
  }
  return normalized;
}

function sanitizeRuntimeConfigForStorage(config: RuntimeConfig, options: SaveRuntimeConfigOptions = {}): RuntimeConfig {
  const normalized = normalizeRuntimeConfig(config);
  const rememberHotmailTokens = options.rememberHotmailTokens ?? normalized.oauthSettings.rememberHotmailTokens;
  return {
    ...normalized,
    managementKey: options.rememberManagementKey === false ? "" : normalized.managementKey,
    oauthSettings: {
      ...normalized.oauthSettings,
      rememberHotmailTokens,
      hotmailAccounts: rememberHotmailTokens ? normalized.oauthSettings.hotmailAccounts : [],
    },
  };
}

export async function saveRuntimeConfig(config: RuntimeConfig, options: SaveRuntimeConfigOptions = {}): Promise<void> {
  writeWebStorage(WEB_RUNTIME_CONFIG_KEY, sanitizeRuntimeConfigForStorage(config, options), [LEGACY_WEB_RUNTIME_CONFIG_KEY]);
}

export async function loadPayloadCache(): Promise<PayloadEnvelope | null> {
  const indexedDbPayload = await loadWebPayloadCache();
  if (indexedDbPayload) {
    return normalizePayload(indexedDbPayload);
  }
  const legacyPayload = readLegacyWebPayloadStorage();
  if (!legacyPayload) {
    return null;
  }
  const normalizedPayload = normalizePayload(legacyPayload);
  if (await saveWebPayloadCache(normalizedPayload)) {
    removeWebStorage(WEB_PAYLOAD_CACHE_KEY, [LEGACY_WEB_PAYLOAD_CACHE_KEY]);
  }
  return normalizedPayload;
}

export async function savePayloadCache(payload: PayloadEnvelope): Promise<void> {
  if (await saveWebPayloadCache(normalizePayload(payload))) {
    removeWebStorage(WEB_PAYLOAD_CACHE_KEY, [LEGACY_WEB_PAYLOAD_CACHE_KEY]);
  }
}

export async function clearLocalCache(): Promise<void> {
  // 把新旧命名空间都清掉，确保手工迁移前后的残留配置不会回流。
  removeWebStorage(WEB_RUNTIME_CONFIG_KEY, [LEGACY_WEB_RUNTIME_CONFIG_KEY]);
  removeWebStorage(WEB_PAYLOAD_CACHE_KEY, [LEGACY_WEB_PAYLOAD_CACHE_KEY]);
  await clearWebPayloadCache();
  await clearWebQuotaSnapshots();
}

export async function downloadSelectedAccounts(
  config: RuntimeConfig,
  items: AccountItem[],
  onProgress?: (event: QueryProgressEvent) => void,
): Promise<DownloadedAccountConfig[]> {
  return webDownloadSelectedAccounts(normalizeRuntimeConfig(config), items, onProgress);
}

export async function syncAccountPriorities(
  config: RuntimeConfig,
  changes: Array<{ name: string; priority: number }>,
  onProgress?: (event: QueryProgressEvent) => void,
): Promise<void> {
  await webSyncAccountPriorities(normalizeRuntimeConfig(config), changes, onProgress);
}
