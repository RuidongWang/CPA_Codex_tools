import type { OAuthJob, OAuthJobErrorType, OAuthJobStatus } from "../types";

export const OAUTH_JOB_STORE_KEY = "cpa_codex_quota_cache.oauth-jobs";

export interface OAuthJobStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const OAUTH_JOB_STATUSES = new Set<OAuthJobStatus>([
  "queued",
  "session_clearing",
  "oauth_started",
  "email_submitting",
  "code_polling",
  "code_submitting",
  "consent_submitting",
  "callback_submitted",
  "manual_required",
  "failed",
]);

const OAUTH_JOB_ERROR_TYPES = new Set<OAuthJobErrorType | "">(["retryable", "manual", "fatal", ""]);
const OAUTH_STATUSES = new Set<OAuthJob["oauthStatus"]>(["pending", "success", "error", ""]);
const FINGERPRINT_PATTERN = /^(?:accepted-callback|rejected-code):fp:[0-9a-f]{32}$/;
const REDACTED_VALUE = "[redacted]";
const REDACTED_CODE_VALUE = "[redacted-code]";
const EMBEDDED_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const AUTHORIZATION_TEXT_PATTERN = /\b(authorization\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi;
const COOKIE_TEXT_PATTERN = /\b((?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gi;
const BEARER_TEXT_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const SIX_DIGIT_CODE_PATTERN = /\b\d{6}\b/g;
const SENSITIVE_KEY_PATTERN_SOURCE = String.raw`(?:[A-Za-z0-9_-]*(?:password|pass|token|refresh|secret|authorization|cookie|code)[A-Za-z0-9_-]*|(?:[A-Za-z0-9_-]+[\s_-]+)*(?:password|pass|token|refresh|secret|authorization|cookie|code|key)(?:[\s_-]+[A-Za-z0-9_-]+)*|management[\s_-]*key|cpa[\s_-]*key|api[\s_-]*key|refresh[\s_-]*token|verification[\s_-]*code|callback[\s_-]*code)`;
const SENSITIVE_VALUE_PATTERN_SOURCE = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[[^\r\n]*?\]|\{[^\r\n]*?\}|[^\s,;}&\]\[]+)`;
const QUOTED_SENSITIVE_KEY_VALUE_PATTERN = new RegExp(
  String.raw`((["'])${SENSITIVE_KEY_PATTERN_SOURCE}\2\s*[:=]\s*)${SENSITIVE_VALUE_PATTERN_SOURCE}`,
  "gi",
);
const SENSITIVE_KEY_VALUE_PATTERN = new RegExp(String.raw`\b(${SENSITIVE_KEY_PATTERN_SOURCE}\s*[:=]\s*)${SENSITIVE_VALUE_PATTERN_SOURCE}`, "gi");
const SENSITIVE_KEY_TOKENS = new Set(["authorization", "code", "cookie", "key", "pass", "password", "refresh", "secret", "token"]);

export interface OAuthJobStore {
  load(): OAuthJob[];
  save(jobs: OAuthJob[]): boolean;
  clear(): boolean;
}

function getDefaultStorage(): OAuthJobStorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isOAuthJobStatus(value: unknown): value is OAuthJobStatus {
  return isString(value) && OAUTH_JOB_STATUSES.has(value as OAuthJobStatus);
}

function isOAuthErrorType(value: unknown): value is OAuthJobErrorType | "" {
  return isString(value) && OAUTH_JOB_ERROR_TYPES.has(value as OAuthJobErrorType | "");
}

function isOAuthStatus(value: unknown): value is OAuthJob["oauthStatus"] {
  return isString(value) && OAUTH_STATUSES.has(value as OAuthJob["oauthStatus"]);
}

function isAttempt(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function normalizeSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokenizeKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeSensitiveKey(key);
  const tokens = tokenizeKey(key);
  return (
    normalized === "code" ||
    normalized === "pass" ||
    normalized.endsWith("pass") ||
    tokens.some((token) => SENSITIVE_KEY_TOKENS.has(token)) ||
    normalized.includes("password") ||
    normalized.includes("token") ||
    normalized.includes("refresh") ||
    normalized.includes("secret") ||
    normalized.includes("authorization") ||
    normalized.includes("cookie") ||
    normalized.includes("managementkey") ||
    normalized.includes("cpakey") ||
    normalized.includes("apikey") ||
    normalized.includes("verificationcode") ||
    normalized.includes("callbackcode") ||
    normalized.endsWith("code")
  );
}

function sanitizeJsonText(value: string): string | null {
  const trimmed = value.trim();
  if (
    !((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))
  ) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    const sanitized = sanitizeSnapshotValue(parsed);
    return sanitized === undefined ? null : JSON.stringify(sanitized);
  } catch {
    return null;
  }
}

function sanitizePlainText(value: string): string {
  return value
    .replace(AUTHORIZATION_TEXT_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(COOKIE_TEXT_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(BEARER_TEXT_PATTERN, `$1 ${REDACTED_VALUE}`)
    .replace(QUOTED_SENSITIVE_KEY_VALUE_PATTERN, (match: string, prefix: string) => {
      const valueStart = match.slice(prefix.length).trimStart();
      const valueQuote = valueStart[0] === "'" || valueStart[0] === '"' ? valueStart[0] : "";
      return valueQuote ? `${prefix}${valueQuote}${REDACTED_VALUE}${valueQuote}` : `${prefix}${REDACTED_VALUE}`;
    })
    .replace(SENSITIVE_KEY_VALUE_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(SIX_DIGIT_CODE_PATTERN, REDACTED_CODE_VALUE);
}

function sanitizeUrlParameters(parameters: URLSearchParams): void {
  for (const [key, parameterValue] of Array.from(parameters.entries())) {
    parameters.set(key, isSensitiveKey(key) ? REDACTED_VALUE : sanitizePlainText(parameterValue));
  }
}

function sanitizeUrlHash(hash: string): string {
  if (!hash) {
    return "";
  }

  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryPrefix = fragment.startsWith("?") ? "?" : "";
  const queryLikeFragment = queryPrefix ? fragment.slice(1) : fragment;
  if (queryLikeFragment.includes("=")) {
    const parameters = new URLSearchParams(queryLikeFragment);
    sanitizeUrlParameters(parameters);
    return `#${queryPrefix}${parameters.toString()}`;
  }

  return `#${sanitizePlainText(fragment)}`;
}

function sanitizeUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = REDACTED_VALUE;
      parsed.password = REDACTED_VALUE;
    }

    sanitizeUrlParameters(parsed.searchParams);
    parsed.hash = sanitizeUrlHash(parsed.hash);

    return parsed.toString();
  } catch {
    return null;
  }
}

function sanitizeText(value: string): string {
  const sanitizedJson = sanitizeJsonText(value);
  if (sanitizedJson !== null) {
    return sanitizedJson;
  }

  const withSanitizedUrls = value.replace(EMBEDDED_URL_PATTERN, (url) => sanitizeUrl(url) ?? sanitizePlainText(url));
  return sanitizePlainText(withSanitizedUrls);
}

function sanitizeNullableText(value: string | null): string | null {
  return value === null ? null : sanitizeText(value);
}

function sanitizeCallbackUrl(callbackUrl: string): string {
  if (!callbackUrl) {
    return "";
  }

  return sanitizeUrl(callbackUrl) ?? "";
}

function sanitizeFingerprintList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((candidate): candidate is string => isString(candidate) && FINGERPRINT_PATTERN.test(candidate));
}

function sanitizeSnapshotValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeText(value);
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeSnapshotValue).filter((candidate) => candidate !== undefined);
  }

  if (!isPlainRecord(value)) {
    return undefined;
  }

  return sanitizeSnapshotRecord(value);
}

function sanitizeSnapshotRecord(snapshot: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(snapshot)
      .map(([key, value]) => [key, isSensitiveKey(key) ? REDACTED_VALUE : sanitizeSnapshotValue(value)])
      .filter(([, value]) => value !== undefined),
  );
}

function toOAuthJob(value: unknown): OAuthJob | null {
  if (!isPlainRecord(value)) {
    return null;
  }

  if (!Array.isArray(value.rejectedCodeFingerprints)) {
    return null;
  }

  const rejectedCodeFingerprints = sanitizeFingerprintList(value.rejectedCodeFingerprints);
  if (rejectedCodeFingerprints.length !== value.rejectedCodeFingerprints.length) {
    return null;
  }

  if (
    !isString(value.jobId) ||
    value.jobId.length === 0 ||
    !isString(value.authIndex) ||
    value.authIndex.length === 0 ||
    !isString(value.accountEmail) ||
    !isString(value.accountName) ||
    !isString(value.planType) ||
    !isString(value.hotmailId) ||
    !isString(value.hotmailEmail) ||
    !isOAuthJobStatus(value.status) ||
    !isAttempt(value.attempt) ||
    !isNonNegativeInteger(value.retryCount) ||
    !isNullableString(value.startedAt) ||
    !isString(value.updatedAt) ||
    !isString(value.lockedByExtension) ||
    !isNullableString(value.leaseExpiresAt) ||
    !isString(value.state) ||
    !isString(value.authUrl) ||
    !isString(value.callbackUrl) ||
    !isNullableString(value.callbackSubmittedAt) ||
    !isOAuthStatus(value.oauthStatus) ||
    !isNullableString(value.oauthCheckedAt) ||
    !isString(value.oauthError) ||
    !isString(value.lastError) ||
    !isOAuthErrorType(value.lastErrorType) ||
    !isString(value.manualReason) ||
    !(value.lastPageSnapshot === null || isPlainRecord(value.lastPageSnapshot)) ||
    !isNullableString(value.lastCodeAt)
  ) {
    return null;
  }

  return {
    jobId: sanitizeText(value.jobId),
    authIndex: sanitizeText(value.authIndex),
    accountEmail: sanitizeText(value.accountEmail),
    accountName: sanitizeText(value.accountName),
    planType: sanitizeText(value.planType),
    hotmailId: sanitizeText(value.hotmailId),
    hotmailEmail: sanitizeText(value.hotmailEmail),
    status: sanitizeText(value.status) as OAuthJobStatus,
    attempt: value.attempt,
    retryCount: value.retryCount,
    startedAt: sanitizeNullableText(value.startedAt),
    updatedAt: sanitizeText(value.updatedAt),
    lockedByExtension: sanitizeText(value.lockedByExtension),
    leaseExpiresAt: sanitizeNullableText(value.leaseExpiresAt),
    state: sanitizeText(value.state),
    authUrl: sanitizeText(value.authUrl),
    callbackUrl: sanitizeCallbackUrl(value.callbackUrl),
    callbackSubmittedAt: sanitizeNullableText(value.callbackSubmittedAt),
    oauthStatus: sanitizeText(value.oauthStatus) as OAuthJob["oauthStatus"],
    oauthCheckedAt: sanitizeNullableText(value.oauthCheckedAt),
    oauthError: sanitizeText(value.oauthError),
    lastError: sanitizeText(value.lastError),
    lastErrorType: sanitizeText(value.lastErrorType) as OAuthJobErrorType | "",
    manualReason: sanitizeText(value.manualReason),
    lastPageSnapshot: value.lastPageSnapshot === null ? null : sanitizeSnapshotRecord(value.lastPageSnapshot),
    lastCodeAt: sanitizeNullableText(value.lastCodeAt),
    rejectedCodeFingerprints,
  };
}

function serializeJob(job: OAuthJob): OAuthJob {
  return {
    jobId: sanitizeText(job.jobId),
    authIndex: sanitizeText(job.authIndex),
    accountEmail: sanitizeText(job.accountEmail),
    accountName: sanitizeText(job.accountName),
    planType: sanitizeText(job.planType),
    hotmailId: sanitizeText(job.hotmailId),
    hotmailEmail: sanitizeText(job.hotmailEmail),
    status: sanitizeText(job.status) as OAuthJobStatus,
    attempt: job.attempt,
    retryCount: job.retryCount,
    startedAt: sanitizeNullableText(job.startedAt),
    updatedAt: sanitizeText(job.updatedAt),
    lockedByExtension: sanitizeText(job.lockedByExtension),
    leaseExpiresAt: sanitizeNullableText(job.leaseExpiresAt),
    state: sanitizeText(job.state),
    authUrl: sanitizeText(job.authUrl),
    callbackUrl: sanitizeCallbackUrl(job.callbackUrl),
    callbackSubmittedAt: sanitizeNullableText(job.callbackSubmittedAt),
    oauthStatus: sanitizeText(job.oauthStatus) as OAuthJob["oauthStatus"],
    oauthCheckedAt: sanitizeNullableText(job.oauthCheckedAt),
    oauthError: sanitizeText(job.oauthError),
    lastError: sanitizeText(job.lastError),
    lastErrorType: sanitizeText(job.lastErrorType) as OAuthJobErrorType | "",
    manualReason: sanitizeText(job.manualReason),
    lastPageSnapshot: job.lastPageSnapshot === null ? null : sanitizeSnapshotRecord(job.lastPageSnapshot),
    lastCodeAt: sanitizeNullableText(job.lastCodeAt),
    rejectedCodeFingerprints: sanitizeFingerprintList(job.rejectedCodeFingerprints),
  };
}

export function createOAuthJobStore(storage: OAuthJobStorageLike | null | undefined = getDefaultStorage()): OAuthJobStore {
  return {
    load(): OAuthJob[] {
      if (!storage) {
        return [];
      }

      try {
        const raw = storage.getItem(OAUTH_JOB_STORE_KEY);
        if (!raw) {
          return [];
        }

        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          return [];
        }

        return parsed.map(toOAuthJob).filter((job): job is OAuthJob => job !== null);
      } catch {
        return [];
      }
    },

    save(jobs: OAuthJob[]): boolean {
      if (!storage) {
        return false;
      }

      try {
        storage.setItem(OAUTH_JOB_STORE_KEY, JSON.stringify(jobs.map(serializeJob)));
        return true;
      } catch {
        return false;
      }
    },

    clear(): boolean {
      if (!storage) {
        return false;
      }

      try {
        storage.removeItem(OAUTH_JOB_STORE_KEY);
        return true;
      } catch {
        return false;
      }
    },
  };
}
