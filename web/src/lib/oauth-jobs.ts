import type { AccountItem, HotmailAccount, OAuthJob, OAuthJobErrorType, OAuthJobStatus, OAuthQueueSummary } from "../types";
import { isOAuthReloginCandidate } from "./oauth";

export const OAUTH_JOB_LEASE_MS = 2 * 60 * 1000;
export const OAUTH_JOB_ATTEMPT_TIMEOUT_MS = 5 * 60 * 1000;

const RUNNING_STATUSES = new Set<OAuthJobStatus>([
  "session_clearing",
  "oauth_started",
  "email_submitting",
  "code_polling",
  "code_submitting",
  "consent_submitting",
]);

const ACCEPTED_CALLBACK_PREFIX = "accepted-callback:";
const REJECTED_CODE_PREFIX = "rejected-code:";
const FNV_64_PRIME = 0x100000001b3n;
const FNV_64_MASK = 0xffffffffffffffffn;
const FNV_64_OFFSET_A = 0xcbf29ce484222325n;
const FNV_64_OFFSET_B = 0x6c62272e07bb0142n;

type ParsedCallbackUrl =
  | { ok: true; redacted: string; state: string; code: string; error: string }
  | { ok: false };

export type OAuthQueueScope =
  | { kind: "all" }
  | { kind: "selected"; authIndexes: readonly string[] }
  | { kind: "filtered"; authIndexes: readonly string[] };

export interface BuildOAuthJobsInput {
  accounts: readonly AccountItem[];
  hotmailAccounts: readonly HotmailAccount[];
  keeperRefreshFailureAuthIndexes: readonly string[] | ReadonlySet<string>;
  scope: OAuthQueueScope;
  now: string;
}

export interface OAuthJobErrorInput {
  errorType: OAuthJobErrorType;
  code: string;
  message?: string;
}

export interface OAuthJobArrayUpdateResult {
  jobs: OAuthJob[];
  job: OAuthJob | null;
}

export interface OAuthJobClaimResult {
  jobs: OAuthJob[];
  claimed: OAuthJob | null;
}

function normalizeEmailKey(value: string): string {
  return value.trim().toLowerCase();
}

function toIsoString(now: string | number): string {
  return typeof now === "number" ? new Date(now).toISOString() : now;
}

function fnv1a64(value: string, offset: bigint): string {
  let hash = offset;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_64_PRIME) & FNV_64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

function fingerprint(value: string): string {
  const canonical = `oauth-job-fingerprint:v1:${value}`;
  const first = fnv1a64(canonical, FNV_64_OFFSET_A);
  const second = fnv1a64(`${canonical}:secondary`, FNV_64_OFFSET_B);
  return `fp:${first}${second}`;
}

function scopeIncludes(scope: OAuthQueueScope, authIndex: string): boolean {
  if (scope.kind === "all") {
    return true;
  }
  return new Set(scope.authIndexes).has(authIndex);
}

function clearLease(job: OAuthJob): OAuthJob {
  return {
    ...job,
    lockedByExtension: "",
    leaseExpiresAt: null,
  };
}

function findJobIndex(jobs: readonly OAuthJob[], jobId: string): number {
  return jobs.findIndex((job) => job.jobId === jobId);
}

function replaceJob(jobs: readonly OAuthJob[], index: number, job: OAuthJob): OAuthJob[] {
  return jobs.map((candidate, candidateIndex) => (candidateIndex === index ? job : candidate));
}

function parseCallbackUrl(callbackUrl: string): ParsedCallbackUrl {
  try {
    const parsed = new URL(callbackUrl);
    const state = parsed.searchParams.get("state") ?? "";
    const code = parsed.searchParams.get("code") ?? "";
    const error = parsed.searchParams.get("error") ?? "";
    if (parsed.searchParams.has("code")) {
      parsed.searchParams.set("code", "REDACTED");
    }
    return { ok: true, redacted: parsed.toString(), state, code, error };
  } catch {
    return { ok: false };
  }
}

function canonicalizeCallbackUrlForFingerprint(callbackUrl: string): string {
  try {
    const parsed = new URL(callbackUrl);
    const searchParams = Array.from(parsed.searchParams.entries()).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey !== rightKey) {
        return leftKey < rightKey ? -1 : 1;
      }
      if (leftValue === rightValue) {
        return 0;
      }
      return leftValue < rightValue ? -1 : 1;
    });
    const search = new URLSearchParams(searchParams).toString();
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname}${search ? `?${search}` : ""}${parsed.hash}`;
  } catch {
    return `invalid-callback-url:${callbackUrl}`;
  }
}

function acceptedCallbackFingerprint(callbackUrl: string): string {
  return `${ACCEPTED_CALLBACK_PREFIX}${fingerprint(canonicalizeCallbackUrlForFingerprint(callbackUrl))}`;
}

function rejectedCodeFingerprint(code: string): string {
  return `${REJECTED_CODE_PREFIX}${fingerprint(code)}`;
}

function appendUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function hasAcceptedCallback(job: OAuthJob, callbackUrl: string): boolean {
  return job.rejectedCodeFingerprints.includes(acceptedCallbackFingerprint(callbackUrl));
}

function failOAuthJobCallback(job: OAuthJob, lastError: string, now: string, rejectedFingerprint = ""): OAuthJob {
  return {
    ...clearLease(job),
    status: "failed",
    lastError,
    lastErrorType: "fatal",
    rejectedCodeFingerprints: rejectedFingerprint ? appendUnique(job.rejectedCodeFingerprints, rejectedFingerprint) : [...job.rejectedCodeFingerprints],
    updatedAt: now,
  };
}

export function buildOAuthJobId(authIndex: string): string {
  return `oauth-job:${authIndex}`;
}

export function buildOAuthJobs(input: BuildOAuthJobsInput): OAuthJob[] {
  const keeperRefreshFailureAuthIndexes =
    input.keeperRefreshFailureAuthIndexes instanceof Set
      ? input.keeperRefreshFailureAuthIndexes
      : new Set(input.keeperRefreshFailureAuthIndexes);
  const hotmailByEmail = new Map(input.hotmailAccounts.map((account) => [normalizeEmailKey(account.email), account]));

  return input.accounts
    .filter((account) => scopeIncludes(input.scope, account.auth_index))
    .filter((account) => isOAuthReloginCandidate(account, keeperRefreshFailureAuthIndexes))
    .map((account) => {
      const hotmail = hotmailByEmail.get(normalizeEmailKey(account.email));
      const jobId = buildOAuthJobId(account.auth_index);
      return {
        jobId,
        authIndex: account.auth_index,
        accountEmail: account.email,
        accountName: account.name,
        planType: account.plan_type,
        hotmailId: hotmail?.id ?? "",
        hotmailEmail: hotmail?.email ?? "",
        status: "queued",
        attempt: 0,
        retryCount: 0,
        startedAt: null,
        updatedAt: input.now,
        lockedByExtension: "",
        leaseExpiresAt: null,
        state: "",
        authUrl: "",
        callbackUrl: "",
        callbackSubmittedAt: null,
        oauthStatus: "",
        oauthCheckedAt: null,
        oauthError: "",
        lastError: "",
        lastErrorType: "",
        manualReason: "",
        lastPageSnapshot: null,
        lastCodeAt: null,
        rejectedCodeFingerprints: [],
      };
    });
}

export function summarizeOAuthJobs(jobs: readonly OAuthJob[]): OAuthQueueSummary {
  return jobs.reduce<OAuthQueueSummary>(
    (summary, job) => ({
      total: summary.total + 1,
      queued: summary.queued + (job.status === "queued" ? 1 : 0),
      running: summary.running + (RUNNING_STATUSES.has(job.status) ? 1 : 0),
      callbackSubmitted: summary.callbackSubmitted + (job.status === "callback_submitted" ? 1 : 0),
      manualRequired: summary.manualRequired + (job.status === "manual_required" ? 1 : 0),
      failed: summary.failed + (job.status === "failed" ? 1 : 0),
    }),
    {
      total: 0,
      queued: 0,
      running: 0,
      callbackSubmitted: 0,
      manualRequired: 0,
      failed: 0,
    },
  );
}

export function claimNextOAuthJob(jobs: readonly OAuthJob[], extensionId: string, nowMs: number): OAuthJobClaimResult {
  const index = jobs.findIndex((job) => job.status === "queued");
  if (index === -1) {
    return { jobs: [...jobs], claimed: null };
  }
  const now = toIsoString(nowMs);
  const job = jobs[index];
  const claimed: OAuthJob = {
    ...job,
    status: "session_clearing",
    lockedByExtension: extensionId,
    leaseExpiresAt: new Date(nowMs + OAUTH_JOB_LEASE_MS).toISOString(),
    startedAt: job.startedAt ?? now,
    updatedAt: now,
  };
  return { jobs: replaceJob(jobs, index, claimed), claimed };
}

export function heartbeatOAuthJob(
  jobs: readonly OAuthJob[],
  jobId: string,
  extensionId: string,
  nowMs: number,
): OAuthJobArrayUpdateResult {
  const index = findJobIndex(jobs, jobId);
  if (index === -1 || jobs[index].lockedByExtension !== extensionId) {
    return { jobs: [...jobs], job: null };
  }
  const job: OAuthJob = {
    ...jobs[index],
    leaseExpiresAt: new Date(nowMs + OAUTH_JOB_LEASE_MS).toISOString(),
    updatedAt: toIsoString(nowMs),
  };
  return { jobs: replaceJob(jobs, index, job), job };
}

export function updateOAuthJob(
  jobs: readonly OAuthJob[],
  jobId: string,
  patch: Partial<OAuthJob>,
  now: string,
): OAuthJobArrayUpdateResult {
  const index = findJobIndex(jobs, jobId);
  if (index === -1) {
    return { jobs: [...jobs], job: null };
  }
  const current = jobs[index];
  const job: OAuthJob = {
    ...current,
    ...patch,
    jobId: current.jobId,
    authIndex: current.authIndex,
    updatedAt: now,
  };
  return { jobs: replaceJob(jobs, index, job), job };
}

export function releaseOAuthJob(
  jobs: readonly OAuthJob[],
  jobId: string,
  options: { status?: Extract<OAuthJobStatus, "queued" | "failed">; lastError?: string; lastErrorType?: OAuthJobErrorType | "" } = {},
  now: string,
): OAuthJobArrayUpdateResult {
  const index = findJobIndex(jobs, jobId);
  if (index === -1) {
    return { jobs: [...jobs], job: null };
  }
  const released = clearLease(jobs[index]);
  const job: OAuthJob = {
    ...released,
    status: options.status ?? "queued",
    lastError: options.lastError ?? released.lastError,
    lastErrorType: options.lastErrorType ?? released.lastErrorType,
    updatedAt: now,
  };
  return { jobs: replaceJob(jobs, index, job), job };
}

export function recoverExpiredOAuthJobLeases(jobs: readonly OAuthJob[], nowMs: number): OAuthJob[] {
  const now = toIsoString(nowMs);
  return jobs.map((job) => {
    if (!RUNNING_STATUSES.has(job.status) || !job.lockedByExtension || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > nowMs) {
      return job;
    }
    const released = clearLease(job);
    if (job.attempt === 0) {
      return {
        ...released,
        status: "queued",
        attempt: 1,
        retryCount: job.retryCount + 1,
        updatedAt: now,
      };
    }
    return {
      ...released,
      status: "failed",
      lastError: "lease_expired_after_retry",
      lastErrorType: "fatal",
      updatedAt: now,
    };
  });
}

export function markOAuthJobCallbackSubmitted(job: OAuthJob, callbackUrl: string, now: string): OAuthJob {
  if (job.status === "callback_submitted" && hasAcceptedCallback(job, callbackUrl)) {
    return { ...job, rejectedCodeFingerprints: [...job.rejectedCodeFingerprints] };
  }

  if (job.status === "callback_submitted") {
    const parsedDifferentCallback = parseCallbackUrl(callbackUrl);
    const rejectedFingerprint = parsedDifferentCallback.ok && parsedDifferentCallback.code ? rejectedCodeFingerprint(parsedDifferentCallback.code) : "";
    return failOAuthJobCallback(job, "callback_url_mismatch", now, rejectedFingerprint);
  }

  const parsed = parseCallbackUrl(callbackUrl);
  if (!parsed.ok) {
    return failOAuthJobCallback(job, "invalid_callback_url", now);
  }

  const rejectedFingerprint = parsed.code ? rejectedCodeFingerprint(parsed.code) : "";

  if (!parsed.state) {
    return failOAuthJobCallback(job, "missing_callback_state", now, rejectedFingerprint);
  }

  if (!job.state) {
    return failOAuthJobCallback(job, "missing_job_state", now, rejectedFingerprint);
  }

  if (parsed.state !== job.state) {
    return failOAuthJobCallback(job, "state_mismatch", now, rejectedFingerprint);
  }

  if (!parsed.code && !parsed.error) {
    return failOAuthJobCallback(job, "missing_callback_result", now);
  }

  return {
    ...clearLease(job),
    status: "callback_submitted",
    callbackSubmittedAt: job.callbackSubmittedAt ?? now,
    callbackUrl: parsed.redacted,
    lastError: "",
    lastErrorType: "",
    rejectedCodeFingerprints: appendUnique(job.rejectedCodeFingerprints, acceptedCallbackFingerprint(callbackUrl)),
    updatedAt: now,
  };
}

export function markOAuthJobError(job: OAuthJob, error: OAuthJobErrorInput, now: string): OAuthJob {
  const base: OAuthJob = {
    ...clearLease(job),
    lastError: error.code,
    lastErrorType: error.errorType,
    manualReason: error.errorType === "manual" ? error.message ?? error.code : job.manualReason,
    oauthError: error.errorType === "retryable" || error.errorType === "fatal" ? error.message ?? error.code : job.oauthError,
    updatedAt: now,
  };

  if (error.errorType === "fatal") {
    return { ...base, status: "failed" };
  }

  if (error.errorType === "manual") {
    if (job.attempt === 0) {
      return { ...base, status: "queued", attempt: 1, retryCount: job.retryCount + 1 };
    }
    return { ...base, status: "manual_required" };
  }

  if (error.errorType === "retryable") {
    if (job.attempt === 0) {
      return { ...base, status: "queued", attempt: 1, retryCount: job.retryCount + 1 };
    }
    return { ...base, status: "failed" };
  }

  throw new Error(`Unsupported OAuth job error type: ${String(error.errorType)}`);
}
