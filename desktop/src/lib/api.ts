import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { normalizePriorityPlanKey, normalizePriorityPlanOrder, PRIORITY_PLAN_KEYS } from "./priority";
import type { AccountItem, DownloadedAccountConfig, PayloadEnvelope, QueryProgressEvent, RuntimeConfig } from "../types";

// 开源版不再内置开发期地址，这里只保留示例占位，避免把本地端口写死到产物和文档里。
export const DEFAULT_CPA_BASE_URL = "https://cpa.example/";
export const DEFAULT_QUERY_CONCURRENCY = 6;
const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USER_AGENT = "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal";
const WINDOW_5H_SECONDS = 5 * 60 * 60;
const WINDOW_7D_SECONDS = 7 * 24 * 60 * 60;
const LOW_5H_THRESHOLD = 20;
const LOW_7D_THRESHOLD = 10;
const WEB_CACHE_NAMESPACE = "cpa_codex_quota_cache";
const WEB_RUNTIME_CONFIG_KEY = `${WEB_CACHE_NAMESPACE}.runtime-config`;
const WEB_PAYLOAD_CACHE_KEY = `${WEB_CACHE_NAMESPACE}.payload-cache`;
const LEGACY_WEB_RUNTIME_CONFIG_KEY = "cpa-quota-desk.runtime-config";
const LEGACY_WEB_PAYLOAD_CACHE_KEY = "cpa-quota-desk.payload-cache";

interface WebAuthRecord {
  name: string;
  email: string;
  plan_type: string;
  account_id: string;
  auth_index: string;
  priority: number | null;
  raw: Record<string, unknown>;
}

interface WebQuotaReport extends WebAuthRecord {
  status: AccountItem["status"];
  windows: AccountItem["windows"];
  additional_windows: AccountItem["additional_windows"];
  error: string;
  timings_ms: Record<string, number>;
  last_query_at: string | null;
}

export function isTauriRuntime(): boolean {
  // Tauri v2 会注入 __TAURI_INTERNALS__；普通浏览器没有这个对象，必须走 Web HTTP 运行时。
  return typeof window !== "undefined" && Boolean((window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!isTauriRuntime()) {
    // 浏览器端显式新开标签页，避免仓库链接覆盖当前管理界面。
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  // 桌面端不能再依赖 window.open，这里统一转给 Rust 命令层调用系统默认浏览器。
  await invoke("open_external_url", { url });
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
    status: input.status ?? "unknown",
    windows: Array.isArray(input.windows) ? input.windows : [],
    additional_windows: Array.isArray(input.additional_windows) ? input.additional_windows : [],
    error: input.error ?? "",
    timings_ms: input.timings_ms ?? {},
    last_query_at: input.last_query_at ?? null,
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
    backupPath: raw.backupPath ?? "",
    queryConcurrency,
    priorityPlanOrder: normalizePriorityPlanOrder(raw.priorityPlanOrder ?? PRIORITY_PLAN_KEYS),
  };
}

function createRequestId(command: string): string {
  // 单次查询只需要局部唯一，时间戳加随机串足够过滤掉并发事件串台。
  return `${command}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeProgressEvent(input: unknown): QueryProgressEvent | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const raw = input as Record<string, unknown>;
  const requestId =
    typeof raw.requestId === "string"
      ? raw.requestId
      : typeof raw.request_id === "string"
        ? raw.request_id
        : "";
  if (!requestId) {
    return null;
  }
  return {
    requestId,
    completed: typeof raw.completed === "number" ? raw.completed : 0,
    total: typeof raw.total === "number" ? raw.total : 0,
    currentLabel:
      typeof raw.currentLabel === "string"
        ? raw.currentLabel
        : typeof raw.current_label === "string"
          ? raw.current_label
          : "",
    authIndex:
      typeof raw.authIndex === "string"
        ? raw.authIndex
        : typeof raw.auth_index === "string"
          ? raw.auth_index
          : "",
    status: typeof raw.status === "string" ? raw.status : "",
    timingsMs:
      raw.timingsMs && typeof raw.timingsMs === "object"
        ? (raw.timingsMs as Record<string, number>)
        : raw.timings_ms && typeof raw.timings_ms === "object"
          ? (raw.timings_ms as Record<string, number>)
          : {},
  };
}

// 前端不信任原始 invoke 结果，这里统一做一遍结构归一化。
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

export function buildCommonArgs(config: RuntimeConfig): string[] {
  const args = ["--json"];
  const cpaBaseUrl = config.cpaBaseUrl.trim();
  const managementKey = config.managementKey.trim();
  if (cpaBaseUrl) {
    args.push("--cpa-base-url", cpaBaseUrl);
  }
  if (managementKey) {
    args.push("--management-key", managementKey);
  }
  if (Number.isFinite(config.queryConcurrency) && config.queryConcurrency > 0) {
    args.push("--max-workers", String(Math.max(1, Math.trunc(config.queryConcurrency))));
  }
  return args;
}

function buildCachedQueryItems(items: AccountItem[]) {
  return items.map((item) => ({
    name: item.name,
    email: item.email,
    plan_type: item.plan_type,
    account_id: item.account_id,
    auth_index: item.auth_index,
    priority: item.priority,
  }));
}

// Tauri 命令层已经会尽量返回对象，这里仍兼容字符串，避免老构建或异常链路直接把界面打崩。
export function parsePayloadOutput(input: unknown): PayloadEnvelope {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("桌面端没有收到账号数据，请重新加载账号");
    }
    try {
      return normalizePayload(JSON.parse(trimmed));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "未知解析错误";
      throw new Error(`桌面端收到的账号数据不是合法 JSON: ${detail}`);
    }
  }
  return normalizePayload(input);
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
    status: "unknown",
    windows: [],
    additional_windows: [],
    error: "",
    last_query_at: null,
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

function buildManagementUrl(config: RuntimeConfig, path: string, query?: Record<string, string>): string {
  const baseUrl = config.cpaBaseUrl.trim();
  if (!baseUrl) {
    throw new Error("请先填写 CPA 地址");
  }
  const base = new URL(baseUrl.replace(/\/+$/, "/"));
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
    // CPA 的管理接口历史上同时接受 Bearer 和 X-Management-Key，Web 版保持和桌面 Rust 层一致。
    headers.set("Authorization", `Bearer ${managementKey}`);
    headers.set("X-Management-Key", managementKey);
  }
  if (contentType) {
    headers.set("Content-Type", contentType);
  }
  return headers;
}

async function fetchManagementText(config: RuntimeConfig, path: string, init: RequestInit = {}, query?: Record<string, string>): Promise<string> {
  const response = await fetch(buildManagementUrl(config, path, query), {
    ...init,
    headers: init.headers ?? buildManagementHeaders(config),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text.trim() || `CPA 管理接口调用失败，HTTP ${response.status}`);
  }
  return text;
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

async function downloadAuthFile(config: RuntimeConfig, name: string): Promise<Record<string, unknown>> {
  const text = await fetchManagementText(config, "/v0/management/auth-files/download", { method: "GET" }, { name });
  try {
    return readRecord(JSON.parse(text));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知解析错误";
    throw new Error(`下载的账号文件不是合法 JSON: ${detail}`);
  }
}

function applyDownloadedAuthPayload(record: WebAuthRecord, payload: Record<string, unknown>): void {
  const claims = extractCodexClaims(firstNonEmpty(payload.id_token));
  const currentPlan = normalizePlan(record.plan_type) === "unknown" ? "" : record.plan_type;
  record.email = firstNonEmpty(record.email, payload.email, claims.email);
  record.plan_type = firstNonEmpty(currentPlan, claims.plan_type, inferPlanFromName(record.name), "unknown");
  record.account_id = firstNonEmpty(record.account_id, payload.account_id, claims.account_id);
  record.priority = normalizePriority(firstPresent(record.priority, payload.priority));
  record.raw = { ...record.raw, ...payload };
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

async function loadWebAuthRecords(config: RuntimeConfig): Promise<WebAuthRecord[]> {
  const payload = await fetchManagementJson(config, "/v0/management/auth-files");
  const rawFiles = Array.isArray(payload.files) ? payload.files : [];
  return preloadMissingAuthDetails(config, buildAuthRecordsFromAuthFiles(rawFiles));
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

function formatResetLabel(windowValue: Record<string, unknown>): string {
  const resetAt = numberOrNull(firstPresent(windowValue.reset_at, windowValue.resetAt));
  const resetAfterSeconds = numberOrNull(firstPresent(windowValue.reset_after_seconds, windowValue.resetAfterSeconds));
  const target = resetAt && resetAt > 0 ? new Date(resetAt * 1000) : resetAfterSeconds && resetAfterSeconds > 0 ? new Date(Date.now() + resetAfterSeconds * 1000) : null;
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
  const resetLabel = formatResetLabel(windowValue);
  const exhaustedHint = boolFromAny(limitReached) || allowed === false;
  const usedPercent = directUsed !== null ? clampFloat(directUsed, 0, 100) : exhaustedHint && resetLabel !== "-" ? 100 : null;
  const remainingPercent = usedPercent === null ? null : clampFloat(100 - usedPercent, 0, 100);
  return {
    id: windowId,
    label,
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
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

function deriveDesktopStatus(report: WebQuotaReport): AccountItem["status"] {
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
  };
  const finalize = () => {
    report.timings_ms.query_total_ms = Math.round((performance.now() - startedAt) * 10) / 10;
    report.status = deriveDesktopStatus(report);
    report.last_query_at = new Date().toISOString();
    return report;
  };

  try {
    if (!record.account_id) {
      const downloadStartedAt = performance.now();
      applyDownloadedAuthPayload(record, await downloadAuthFile(config, record.name));
      report.email = record.email;
      report.plan_type = record.plan_type;
      report.account_id = record.account_id;
      report.priority = record.priority;
      report.timings_ms.download_auth_file_ms = Math.round((performance.now() - downloadStartedAt) * 10) / 10;
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
      raw: item as unknown as Record<string, unknown>,
    })),
  );
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

async function invokePayload(
  command: string,
  args: string[],
  stdinPayload?: string,
  onProgress?: (event: QueryProgressEvent) => void,
): Promise<PayloadEnvelope> {
  const requestId = onProgress ? createRequestId(command) : undefined;
  const unlisten = await createProgressListener(requestId, onProgress);
  try {
    const output = await invoke<unknown>("run_python_query", {
      command,
      args,
      stdinPayload,
      requestId,
    });
    return parsePayloadOutput(output);
  } finally {
    unlisten?.();
  }
}

async function createProgressListener(
  requestId: string | undefined,
  onProgress?: (event: QueryProgressEvent) => void,
): Promise<(() => void) | null> {
  if (!requestId || !onProgress) {
    return null;
  }
  // 备份、同步和查询共用同一条事件总线，前端只按 requestId 过滤自己关心的那一轮。
  return listen<unknown>("quota-query-progress", (event) => {
    const payload = normalizeProgressEvent(event.payload);
    if (!payload || payload.requestId !== requestId) {
      return;
    }
    onProgress(payload);
  });
}

export async function fetchAccountList(config: RuntimeConfig): Promise<PayloadEnvelope> {
  if (!isTauriRuntime()) {
    return buildListPayload(await loadWebAuthRecords(normalizeRuntimeConfig(config)));
  }
  return invokePayload("list", buildCommonArgs(config));
}

export async function queryCachedAccounts(
  config: RuntimeConfig,
  items: AccountItem[],
  onProgress?: (event: QueryProgressEvent) => void,
): Promise<PayloadEnvelope> {
  if (!isTauriRuntime()) {
    const normalizedConfig = normalizeRuntimeConfig(config);
    return buildQueryPayload(await runWebQueries(normalizedConfig, buildAuthRecordsFromCachedItems(items), onProgress));
  }
  return invokePayload("query-records", buildCommonArgs(config), JSON.stringify(buildCachedQueryItems(items)), onProgress);
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (!isTauriRuntime()) {
    return normalizeRuntimeConfig(readWebStorage<Partial<RuntimeConfig>>(WEB_RUNTIME_CONFIG_KEY, [LEGACY_WEB_RUNTIME_CONFIG_KEY]));
  }
  const config = await invoke<Partial<RuntimeConfig>>("load_runtime_config");
  return normalizeRuntimeConfig(config);
}

export async function saveRuntimeConfig(config: RuntimeConfig): Promise<void> {
  if (!isTauriRuntime()) {
    writeWebStorage(WEB_RUNTIME_CONFIG_KEY, normalizeRuntimeConfig(config), [LEGACY_WEB_RUNTIME_CONFIG_KEY]);
    return;
  }
  await invoke("save_runtime_config", { config: normalizeRuntimeConfig(config) });
}

export async function loadPayloadCache(): Promise<PayloadEnvelope | null> {
  if (!isTauriRuntime()) {
    const payload = readWebStorage<PayloadEnvelope>(WEB_PAYLOAD_CACHE_KEY, [LEGACY_WEB_PAYLOAD_CACHE_KEY]);
    return payload ? normalizePayload(payload) : null;
  }
  const payload = await invoke<unknown | null>("load_payload_cache");
  if (!payload) {
    return null;
  }
  return parsePayloadOutput(payload);
}

export async function savePayloadCache(payload: PayloadEnvelope): Promise<void> {
  if (!isTauriRuntime()) {
    writeWebStorage(WEB_PAYLOAD_CACHE_KEY, normalizePayload(payload), [LEGACY_WEB_PAYLOAD_CACHE_KEY]);
    return;
  }
  await invoke("save_payload_cache", { payload });
}

export async function clearLocalCache(): Promise<void> {
  if (!isTauriRuntime()) {
    // 浏览器端把新旧命名空间都清掉，确保手工迁移前后的残留配置不会回流。
    removeWebStorage(WEB_RUNTIME_CONFIG_KEY, [LEGACY_WEB_RUNTIME_CONFIG_KEY]);
    removeWebStorage(WEB_PAYLOAD_CACHE_KEY, [LEGACY_WEB_PAYLOAD_CACHE_KEY]);
    return;
  }
  await invoke("clear_local_cache");
}

export async function downloadSelectedAccounts(
  config: RuntimeConfig,
  items: AccountItem[],
  onProgress?: (event: QueryProgressEvent) => void,
): Promise<DownloadedAccountConfig[]> {
  if (!isTauriRuntime()) {
    return webDownloadSelectedAccounts(normalizeRuntimeConfig(config), items, onProgress);
  }
  const requestId = onProgress ? createRequestId("download-selected-accounts") : undefined;
  const unlisten = await createProgressListener(requestId, onProgress);
  try {
    return invoke<DownloadedAccountConfig[]>("download_selected_accounts", {
      config: normalizeRuntimeConfig(config),
      authFileNames: items.map((item) => item.name).filter((name) => name.trim()),
      requestId,
    });
  } finally {
    unlisten?.();
  }
}

export async function syncAccountPriorities(
  config: RuntimeConfig,
  changes: Array<{ name: string; priority: number }>,
  onProgress?: (event: QueryProgressEvent) => void,
): Promise<void> {
  if (!isTauriRuntime()) {
    await webSyncAccountPriorities(normalizeRuntimeConfig(config), changes, onProgress);
    return;
  }
  const requestId = onProgress ? createRequestId("sync-account-priorities") : undefined;
  const unlisten = await createProgressListener(requestId, onProgress);
  try {
    await invoke("sync_account_priorities", {
      config: normalizeRuntimeConfig(config),
      changes,
      requestId,
    });
  } finally {
    unlisten?.();
  }
}
