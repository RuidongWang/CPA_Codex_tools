import { useEffect, useRef } from "react";
import type {
  CodexOAuthCallbackResult,
  CodexOAuthStartResult,
  CodexOAuthStatusResult,
  HotmailVerificationCodeResult,
} from "../lib/api";
import {
  createOAuthBridgeError,
  isOAuthBridgeRequest,
  isPlainRecord,
  OAUTH_BRIDGE_ACTIONS,
  OAUTH_BRIDGE_VERSION,
  postOAuthBridgeResponse,
  toOAuthBridgeAccount,
  toOAuthBridgeHotmailAccount,
  toOAuthBridgeQueueJob,
  type OAuthBridgeError,
  type OAuthBridgeRequest,
} from "../lib/oauth-bridge";
import type { OAuthJobStore } from "../lib/oauth-job-store";
import {
  buildOAuthJobs,
  claimNextOAuthJob,
  heartbeatOAuthJob,
  markOAuthJobCallbackSubmitted,
  markOAuthJobError,
  recoverExpiredOAuthJobLeases,
  releaseOAuthJob,
  summarizeOAuthJobs,
  updateOAuthJob,
  type OAuthQueueScope,
} from "../lib/oauth-jobs";
import { buildInvalidAccountEmailSet, isOAuthReloginCandidate, isQuotaQueryError, upsertHotmailAccounts } from "../lib/oauth";
import type { AccountItem, HotmailAccount, OAuthJob, OAuthJobErrorType, OAuthJobStatus, OAuthSettings } from "../types";

interface CodexOAuthBridgeProps {
  items: AccountItem[];
  settings: OAuthSettings;
  ready: boolean;
  queueJobs: OAuthJob[];
  queueStore: OAuthJobStore;
  selectedAuthIndexes?: string[];
  filteredAuthIndexes?: string[];
  keeperRefreshFailureAuthIndexes?: string[];
  importedInvalidAccountEmails?: string[];
  onQueueJobsChange: (jobs: OAuthJob[]) => void | Promise<void>;
  onSettingsChange: (settings: OAuthSettings) => void | Promise<void>;
  onStartOAuth: () => Promise<CodexOAuthStartResult>;
  onSubmitOAuthCallback: (state: string, redirectUrl: string) => Promise<CodexOAuthCallbackResult>;
  onPollOAuthStatus: (state: string) => Promise<CodexOAuthStatusResult>;
  onFetchHotmailCode: (
    account: HotmailAccount,
    options: { authIndex: string; excludeCodes: string[]; filterAfterTimestamp: number },
  ) => Promise<HotmailVerificationCodeResult>;
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

class OAuthBridgeActionFailure extends Error {
  readonly bridgeError: OAuthBridgeError;

  constructor(errorType: OAuthJobErrorType, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.bridgeError = createOAuthBridgeError(errorType, code, message, extra);
  }
}

function bridgeFailure(errorType: OAuthJobErrorType, code: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new OAuthBridgeActionFailure(errorType, code, message, extra);
}

function toBridgeError(error: unknown): OAuthBridgeError {
  if (error instanceof OAuthBridgeActionFailure) {
    return error.bridgeError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return createOAuthBridgeError("fatal", "bridge_action_failed", message || "OAuth bridge action failed");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeEmailKey(value: string): string {
  return value.trim().toLowerCase();
}

function accountReason(
  item: AccountItem,
  keeperRefreshFailureAuthIndexes: ReadonlySet<string>,
  importedInvalidAccountEmailKeys: ReadonlySet<string>,
): string {
  if (isQuotaQueryError(item)) {
    return item.error || "查询异常";
  }
  if (keeperRefreshFailureAuthIndexes.has(item.auth_index)) {
    return "Keeper 刷新失败";
  }
  if (importedInvalidAccountEmailKeys.has(normalizeEmailKey(item.email))) {
    return "失效账号";
  }
  return "正常";
}

function replaceQueueJob(jobs: readonly OAuthJob[], nextJob: OAuthJob): OAuthJob[] {
  return jobs.map((job) => (job.jobId === nextJob.jobId ? nextJob : job));
}

function sanitizeStatusPatch(value: unknown): OAuthJobStatus | undefined {
  return typeof value === "string" && OAUTH_JOB_STATUSES.has(value as OAuthJobStatus) ? (value as OAuthJobStatus) : undefined;
}

function sanitizeAttemptPatch(value: unknown): OAuthJob["attempt"] | undefined {
  return value === 0 || value === 1 ? value : undefined;
}

function sanitizeRetryCountPatch(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function getOAuthStatusMessage(result: CodexOAuthStatusResult | CodexOAuthCallbackResult): string {
  return typeof result.message === "string" ? result.message : "";
}

function getOAuthStatusValue(result: CodexOAuthStatusResult | CodexOAuthCallbackResult): OAuthJob["oauthStatus"] {
  return result.status === "pending" || result.status === "success" || result.status === "error" ? result.status : "";
}

function publicStartResult(result: CodexOAuthStartResult): Record<string, unknown> {
  return {
    authUrl: result.authUrl,
    state: result.state,
  };
}

function publicCallbackResult(result: CodexOAuthCallbackResult): Record<string, unknown> {
  return {
    state: result.state,
    status: result.status,
    message: result.message,
  };
}

function publicStatusResult(result: CodexOAuthStatusResult): Record<string, unknown> {
  return {
    state: result.state,
    status: result.status,
    email: result.email,
    message: result.message,
  };
}

function requirePayloadJobId(payload: Record<string, unknown>): string {
  const jobId = asString(payload.jobId);
  if (!jobId) {
    bridgeFailure("fatal", "missing_job_id", "缺少 jobId");
  }
  return jobId;
}

function findJobIndex(jobs: readonly OAuthJob[], payload: Record<string, unknown>): number {
  const jobId = requirePayloadJobId(payload);
  return jobs.findIndex((job) => job.jobId === jobId);
}

function requireExtensionId(payload: Record<string, unknown>): string {
  const extensionId = asString(payload.extensionId) || asString(payload.workerId);
  if (!extensionId) {
    bridgeFailure("fatal", "missing_extension_id", "缺少 extensionId");
  }
  return extensionId;
}

function requireLockedJob(job: OAuthJob, payload: Record<string, unknown>): string {
  const extensionId = requireExtensionId(payload);
  if (job.lockedByExtension !== extensionId) {
    bridgeFailure("fatal", "job_not_locked_by_extension", "Job 不属于当前 extension lease", {
      jobId: job.jobId,
    });
  }
  return extensionId;
}

function failJobIdentityMismatch(job: OAuthJob, field: string, expected: string | string[], received: string): never {
  bridgeFailure("fatal", "job_identity_mismatch", "Job identity 与 payload 不匹配", {
    jobId: job.jobId,
    field,
    expected,
    received,
  });
}

function failMissingJobIdentity(job: OAuthJob, field: string): never {
  bridgeFailure("fatal", "missing_job_identity", "缺少 job identity 字段", {
    jobId: job.jobId,
    field,
  });
}

function requireExactIdentityField(job: OAuthJob, payload: Record<string, unknown>, field: string, expected: string): void {
  const received = asString(payload[field]);
  if (!received) {
    failMissingJobIdentity(job, field);
  }
  if (received !== expected) {
    failJobIdentityMismatch(job, field, expected, received);
  }
}

function requireEmailIdentityField(
  job: OAuthJob,
  payload: Record<string, unknown>,
  field: string,
  candidates: readonly string[],
  required = false,
): void {
  const received = asString(payload[field]);
  if (!received) {
    if (required) {
      failMissingJobIdentity(job, field);
    }
    return;
  }
  const normalizedCandidates = candidates.filter((candidate) => candidate.trim().length > 0).map(normalizeEmailKey);
  if (!normalizedCandidates.includes(normalizeEmailKey(received))) {
    failJobIdentityMismatch(job, field, candidates.filter((candidate) => candidate.trim().length > 0), received);
  }
}

function requireJobIdentity(
  job: OAuthJob,
  payload: Record<string, unknown>,
  options: { includeHotmailIdentity?: boolean; includeGenericEmailIdentity?: boolean; requireExpectedEmail?: boolean } = {},
): void {
  requireExactIdentityField(job, payload, "jobId", job.jobId);
  requireExactIdentityField(job, payload, "authIndex", job.authIndex);
  requireEmailIdentityField(job, payload, "accountEmail", [job.accountEmail], true);
  requireEmailIdentityField(job, payload, "expectedEmail", [job.accountEmail], options.requireExpectedEmail === true);

  if (options.includeHotmailIdentity) {
    const requestedHotmailId = asString(payload.hotmailId);
    if (requestedHotmailId && job.hotmailId && requestedHotmailId !== job.hotmailId) {
      failJobIdentityMismatch(job, "hotmailId", job.hotmailId, requestedHotmailId);
    }
    requireEmailIdentityField(job, payload, "hotmailEmail", [job.hotmailEmail, job.accountEmail]);
  }

  if (options.includeGenericEmailIdentity) {
    requireEmailIdentityField(job, payload, "email", [job.hotmailEmail, job.accountEmail]);
  }
}

function getInvalidAccounts(
  items: readonly AccountItem[],
  keeperRefreshFailureAuthIndexes: ReadonlySet<string>,
  importedInvalidAccountEmailKeys: ReadonlySet<string>,
): AccountItem[] {
  return items.filter((item) => isOAuthReloginCandidate(item, keeperRefreshFailureAuthIndexes, importedInvalidAccountEmailKeys));
}

function resolveBuildScope(payload: Record<string, unknown>, props: CodexOAuthBridgeProps): OAuthQueueScope {
  const rawScope = payload.scope;
  const payloadAuthIndexes = asStringArray(payload.authIndexes);
  if (isPlainRecord(rawScope)) {
    const kind = asString(rawScope.kind);
    const scopedAuthIndexes = asStringArray(rawScope.authIndexes);
    if (kind === "all") {
      return { kind: "all" };
    }
    if (kind === "selected" || kind === "filtered") {
      return { kind, authIndexes: scopedAuthIndexes };
    }
  }

  if (rawScope === "all" || rawScope === undefined || rawScope === "") {
    return { kind: "all" };
  }
  if (rawScope === "selected") {
    return { kind: "selected", authIndexes: payloadAuthIndexes.length ? payloadAuthIndexes : props.selectedAuthIndexes ?? [] };
  }
  if (rawScope === "filtered") {
    return { kind: "filtered", authIndexes: payloadAuthIndexes.length ? payloadAuthIndexes : props.filteredAuthIndexes ?? [] };
  }
  bridgeFailure("fatal", "invalid_queue_scope", `不支持的队列范围：${String(rawScope)}`);
}

function findHotmailForJob(settings: OAuthSettings, job: OAuthJob, payload: Record<string, unknown>): HotmailAccount {
  const requestedHotmailId = asString(payload.hotmailId);
  const requestedEmail = asString(payload.email);
  const hotmail =
    settings.hotmailAccounts.find((account) => requestedHotmailId && account.id === requestedHotmailId) ??
    settings.hotmailAccounts.find((account) => job.hotmailId && account.id === job.hotmailId) ??
    settings.hotmailAccounts.find((account) => requestedEmail && normalizeEmailKey(account.email) === normalizeEmailKey(requestedEmail)) ??
    settings.hotmailAccounts.find((account) => job.hotmailEmail && normalizeEmailKey(account.email) === normalizeEmailKey(job.hotmailEmail));

  if (!hotmail) {
    bridgeFailure("manual", "hotmail_account_not_found", "未找到匹配的 Hotmail 账号", {
      jobId: job.jobId,
      hotmailId: requestedHotmailId || job.hotmailId,
      email: requestedEmail || job.hotmailEmail || job.accountEmail,
    });
  }

  if (job.hotmailId && hotmail.id !== job.hotmailId) {
    bridgeFailure("fatal", "hotmail_job_mismatch", "Hotmail 账号与 job 不匹配", {
      jobId: job.jobId,
      hotmailId: requestedHotmailId,
    });
  }
  if (job.hotmailEmail && normalizeEmailKey(hotmail.email) !== normalizeEmailKey(job.hotmailEmail)) {
    bridgeFailure("fatal", "hotmail_email_mismatch", "Hotmail 邮箱与 job 不匹配", {
      jobId: job.jobId,
      email: hotmail.email,
    });
  }
  return hotmail;
}

function buildQueueResult(jobs: readonly OAuthJob[]): Record<string, unknown> {
  return {
    summary: summarizeOAuthJobs(jobs),
    jobs: jobs.map(toOAuthBridgeQueueJob),
  };
}

export function CodexOAuthBridge(props: CodexOAuthBridgeProps) {
  const propsRef = useRef(props);
  const queueJobsRef = useRef(props.queueJobs);

  useEffect(() => {
    propsRef.current = props;
    queueJobsRef.current = props.queueJobs;
  });

  useEffect(() => {
    async function persistQueue(nextJobs: OAuthJob[]) {
      queueJobsRef.current = nextJobs;
      propsRef.current.queueStore.save(nextJobs);
      await propsRef.current.onQueueJobsChange(nextJobs);
    }

    async function persistSettings(nextSettings: OAuthSettings) {
      propsRef.current = {
        ...propsRef.current,
        settings: nextSettings,
      };
      await propsRef.current.onSettingsChange(nextSettings);
    }

    function getJobOrFail(payload: Record<string, unknown>): { jobs: OAuthJob[]; job: OAuthJob; index: number } {
      const jobs = queueJobsRef.current;
      const index = findJobIndex(jobs, payload);
      if (index === -1) {
        bridgeFailure("fatal", "job_not_found", "未找到 OAuth queue job");
      }
      return { jobs, job: jobs[index], index };
    }

    async function handleBuildQueue(payload: Record<string, unknown>) {
      const currentProps = propsRef.current;
      const scope = resolveBuildScope(payload, currentProps);
      const now = new Date().toISOString();
      const importedInvalidAccountEmails = currentProps.importedInvalidAccountEmails ?? currentProps.settings.importedInvalidAccountEmails ?? [];
      const jobs = buildOAuthJobs({
        accounts: currentProps.items,
        hotmailAccounts: currentProps.settings.hotmailAccounts,
        keeperRefreshFailureAuthIndexes: currentProps.keeperRefreshFailureAuthIndexes ?? [],
        importedInvalidAccountEmails,
        scope,
        now,
      });
      await persistQueue(jobs);
      return buildQueueResult(jobs);
    }

    async function handleClaimJob(payload: Record<string, unknown>) {
      const extensionId = requireExtensionId(payload);
      const nowMs = Date.now();
      const recovered = recoverExpiredOAuthJobLeases(queueJobsRef.current, nowMs);
      const claimed = claimNextOAuthJob(recovered, extensionId, nowMs);
      await persistQueue(claimed.jobs);
      return {
        ...buildQueueResult(claimed.jobs),
        claimed: claimed.claimed ? toOAuthBridgeQueueJob(claimed.claimed) : null,
        leaseExpiresAt: claimed.claimed?.leaseExpiresAt ?? null,
      };
    }

    async function handleUpdateJob(payload: Record<string, unknown>) {
      const { job } = getJobOrFail(payload);
      requireJobIdentity(job, payload);
      const extensionId = requireLockedJob(job, payload);
      const nowMs = Date.now();
      const heartbeat = heartbeatOAuthJob(queueJobsRef.current, job.jobId, extensionId, nowMs);
      if (!heartbeat.job) {
        bridgeFailure("fatal", "job_heartbeat_failed", "无法续租 OAuth job");
      }

      const patchSource = isPlainRecord(payload.patch) ? payload.patch : payload;
      const patch: Partial<OAuthJob> = {};
      const nextStatus = sanitizeStatusPatch(patchSource.status);
      if (nextStatus) {
        patch.status = nextStatus;
      }
      const nextAttempt = sanitizeAttemptPatch(patchSource.attempt);
      if (nextAttempt !== undefined) {
        patch.attempt = nextAttempt;
      }
      const nextRetryCount = sanitizeRetryCountPatch(patchSource.retryCount);
      if (nextRetryCount !== undefined) {
        patch.retryCount = nextRetryCount;
      }
      if (typeof patchSource.lastError === "string") {
        patch.lastError = patchSource.lastError;
      }
      if (patchSource.lastErrorType === "retryable" || patchSource.lastErrorType === "manual" || patchSource.lastErrorType === "fatal" || patchSource.lastErrorType === "") {
        patch.lastErrorType = patchSource.lastErrorType;
      }
      if (typeof patchSource.manualReason === "string") {
        patch.manualReason = patchSource.manualReason;
      }
      if (typeof patchSource.oauthError === "string") {
        patch.oauthError = patchSource.oauthError;
      }
      if (patchSource.lastPageSnapshot === null || isPlainRecord(patchSource.lastPageSnapshot)) {
        patch.lastPageSnapshot = patchSource.lastPageSnapshot;
      }

      const now = new Date(nowMs).toISOString();
      const updated = updateOAuthJob(heartbeat.jobs, job.jobId, patch, now);
      if (!updated.job) {
        bridgeFailure("fatal", "job_update_failed", "无法更新 OAuth job");
      }
      await persistQueue(updated.jobs);
      return {
        job: toOAuthBridgeQueueJob(updated.job),
        leaseExpiresAt: updated.job.leaseExpiresAt,
      };
    }

    async function handleStartJobOAuth(payload: Record<string, unknown>) {
      const currentProps = propsRef.current;
      if (!currentProps.ready) {
        bridgeFailure("manual", "not_ready", "CPA 管理配置尚未就绪");
      }
      const { jobs, job } = getJobOrFail(payload);
      requireJobIdentity(job, payload, { includeHotmailIdentity: true, includeGenericEmailIdentity: true });
      requireLockedJob(job, payload);
      const started = await currentProps.onStartOAuth();
      const now = new Date().toISOString();
      const updated = updateOAuthJob(
        jobs,
        job.jobId,
        {
          status: "oauth_started",
          authUrl: started.authUrl,
          state: started.state,
          lastError: "",
          lastErrorType: "",
          oauthError: "",
        },
        now,
      );
      if (!updated.job) {
        bridgeFailure("fatal", "job_update_failed", "无法保存 OAuth 启动结果");
      }
      await persistQueue(updated.jobs);
      return {
        startResult: publicStartResult(started),
        job: toOAuthBridgeQueueJob(updated.job),
      };
    }

    async function handleFetchCode(payload: Record<string, unknown>) {
      const currentProps = propsRef.current;
      const { jobs, job } = getJobOrFail(payload);
      requireJobIdentity(job, payload, {
        includeHotmailIdentity: true,
        includeGenericEmailIdentity: true,
        requireExpectedEmail: true,
      });
      requireLockedJob(job, payload);
      const hotmail = findHotmailForJob(currentProps.settings, job, payload);
      const now = new Date().toISOString();
      const polling = updateOAuthJob(jobs, job.jobId, { status: "code_polling" }, now);
      const pollingJobs = polling.job ? polling.jobs : jobs;
      await persistQueue(pollingJobs);

      try {
        const startedAt = Date.parse(job.startedAt ?? job.updatedAt);
        const fallbackTimestamp = Number.isFinite(startedAt) ? Math.max(0, startedAt - 15_000) : 0;
        const result = await currentProps.onFetchHotmailCode(hotmail, {
          authIndex: job.authIndex,
          excludeCodes: asStringArray(payload.excludeCodes),
          filterAfterTimestamp: asNumber(payload.filterAfterTimestamp) ?? fallbackTimestamp,
        });

        if (!result.code) {
          const failedJob = markOAuthJobError(polling.job ?? job, {
            errorType: "retryable",
            code: "code_not_found",
            message: "未找到 Hotmail 验证码",
          }, new Date().toISOString());
          const nextJobs = replaceQueueJob(pollingJobs, failedJob);
          await persistQueue(nextJobs);
          bridgeFailure("retryable", "code_not_found", "未找到 Hotmail 验证码", {
            job: toOAuthBridgeQueueJob(failedJob),
          });
        }

        const codeAt = new Date().toISOString();
        if (result.nextRefreshToken) {
          const nextHotmail: HotmailAccount = {
            ...hotmail,
            refreshToken: result.nextRefreshToken,
            status: "authorized",
            lastCode: result.code,
            lastCodeAt: codeAt,
            lastError: undefined,
            updatedAt: codeAt,
          };
          await persistSettings({
            ...currentProps.settings,
            hotmailAccounts: upsertHotmailAccounts(currentProps.settings.hotmailAccounts, [nextHotmail]),
          });
        }

        const updated = updateOAuthJob(
          queueJobsRef.current,
          job.jobId,
          {
            status: "code_submitting",
            lastCodeAt: codeAt,
            lastError: "",
            lastErrorType: "",
          },
          codeAt,
        );
        if (!updated.job) {
          bridgeFailure("fatal", "job_update_failed", "无法保存验证码状态");
        }
        await persistQueue(updated.jobs);
        return {
          code: result.code,
          hotmailCode: {
            code: result.code,
            email: hotmail.email,
            transport: result.transport,
          },
          job: toOAuthBridgeQueueJob(updated.job),
        };
      } catch (error) {
        if (error instanceof OAuthBridgeActionFailure) {
          throw error;
        }
        const failedAt = new Date().toISOString();
        const failedJob = markOAuthJobError(polling.job ?? job, {
          errorType: "retryable",
          code: "fetch_code_failed",
          message: error instanceof Error ? error.message : String(error),
        }, failedAt);
        const nextJobs = replaceQueueJob(queueJobsRef.current, failedJob);
        await persistQueue(nextJobs);
        bridgeFailure("retryable", "fetch_code_failed", failedJob.oauthError || failedJob.lastError || "获取 Hotmail 验证码失败", {
          job: toOAuthBridgeQueueJob(failedJob),
        });
      }
    }

    async function handleSubmitCallback(payload: Record<string, unknown>) {
      const callbackUrl = asString(payload.callbackUrl) || asString(payload.redirectUrl);
      if (!callbackUrl) {
        bridgeFailure("fatal", "missing_callback_url", "缺少 OAuth 回调 URL");
      }
      const { jobs, job } = getJobOrFail(payload);
      requireJobIdentity(job, payload, { includeHotmailIdentity: true, includeGenericEmailIdentity: true });
      const requestedState = asString(payload.state);
      if (requestedState && requestedState !== job.state) {
        bridgeFailure("fatal", "state_mismatch", "payload state 与 job state 不匹配", {
          jobId: job.jobId,
        });
      }

      const now = new Date().toISOString();
      if (job.status === "callback_submitted") {
        const replayedJob = markOAuthJobCallbackSubmitted(job, callbackUrl, now);
        if (replayedJob.status !== "callback_submitted") {
          bridgeFailure("fatal", replayedJob.lastError || "callback_replay_rejected", replayedJob.oauthError || replayedJob.lastError || "OAuth callback replay rejected", {
            job: toOAuthBridgeQueueJob(replayedJob),
          });
        }
        return {
          idempotent: true,
          job: toOAuthBridgeQueueJob(job),
        };
      }

      requireLockedJob(job, payload);
      const markedJob = markOAuthJobCallbackSubmitted(job, callbackUrl, now);
      const markedJobs = replaceQueueJob(jobs, markedJob);
      await persistQueue(markedJobs);
      if (markedJob.status === "failed") {
        bridgeFailure("fatal", markedJob.lastError || "callback_submit_rejected", markedJob.oauthError || markedJob.lastError || "OAuth callback rejected", {
          job: toOAuthBridgeQueueJob(markedJob),
        });
      }

      try {
        const result = await propsRef.current.onSubmitOAuthCallback(markedJob.state, callbackUrl);
        if (result.status === "error") {
          const failedJob = markOAuthJobError(markedJob, {
            errorType: "fatal",
            code: "callback_submit_failed",
            message: getOAuthStatusMessage(result) || "OAuth callback submit failed",
          }, new Date().toISOString());
          const failedJobs = replaceQueueJob(queueJobsRef.current, failedJob);
          await persistQueue(failedJobs);
          bridgeFailure("fatal", "callback_submit_failed", failedJob.oauthError || failedJob.lastError || "OAuth callback submit failed", {
            callbackResult: publicCallbackResult(result),
            job: toOAuthBridgeQueueJob(failedJob),
          });
        }

        const submittedAt = new Date().toISOString();
        const updated = updateOAuthJob(
          queueJobsRef.current,
          markedJob.jobId,
          {
            status: "callback_submitted",
            oauthStatus: getOAuthStatusValue(result),
            oauthError: "",
          },
          submittedAt,
        );
        if (!updated.job) {
          bridgeFailure("fatal", "job_update_failed", "无法保存回调提交状态");
        }
        await persistQueue(updated.jobs);
        return {
          callbackResult: publicCallbackResult(result),
          job: toOAuthBridgeQueueJob(updated.job),
        };
      } catch (error) {
        if (error instanceof OAuthBridgeActionFailure) {
          throw error;
        }
        const failedJob = markOAuthJobError(markedJob, {
          errorType: "fatal",
          code: "callback_submit_failed",
          message: error instanceof Error ? error.message : String(error),
        }, new Date().toISOString());
        const failedJobs = replaceQueueJob(queueJobsRef.current, failedJob);
        await persistQueue(failedJobs);
        bridgeFailure("fatal", "callback_submit_failed", failedJob.oauthError || failedJob.lastError || "OAuth callback submit failed", {
          job: toOAuthBridgeQueueJob(failedJob),
        });
      }
    }

    async function handleCheckOAuthStatus(payload: Record<string, unknown>) {
      const { jobs, job } = getJobOrFail(payload);
      requireJobIdentity(job, payload, { includeHotmailIdentity: true, includeGenericEmailIdentity: true });
      const requestedState = asString(payload.state);
      if (!job.state) {
        bridgeFailure("fatal", "missing_job_state", "缺少 OAuth state");
      }
      if (requestedState && requestedState !== job.state) {
        bridgeFailure("fatal", "state_mismatch", "payload state 与 job state 不匹配", {
          jobId: job.jobId,
        });
      }

      try {
        const result = await propsRef.current.onPollOAuthStatus(job.state);
        const now = new Date().toISOString();
        const updated = updateOAuthJob(
          jobs,
          job.jobId,
          {
            oauthStatus: getOAuthStatusValue(result),
            oauthCheckedAt: now,
            oauthError: result.status === "error" ? getOAuthStatusMessage(result) || "OAuth status error" : "",
          },
          now,
        );
        if (!updated.job) {
          bridgeFailure("fatal", "job_update_failed", "无法保存 OAuth 状态");
        }
        await persistQueue(updated.jobs);
        return {
          statusResult: publicStatusResult(result),
          job: toOAuthBridgeQueueJob(updated.job),
        };
      } catch (error) {
        if (error instanceof OAuthBridgeActionFailure) {
          throw error;
        }
        const now = new Date().toISOString();
        const message = error instanceof Error ? error.message : String(error);
        const updated = updateOAuthJob(
          queueJobsRef.current,
          job.jobId,
          {
            oauthStatus: "error",
            oauthCheckedAt: now,
            oauthError: message,
          },
          now,
        );
        if (updated.job) {
          await persistQueue(updated.jobs);
        }
        bridgeFailure("retryable", "check_oauth_status_failed", message || "检查 OAuth 状态失败", {
          job: updated.job ? toOAuthBridgeQueueJob(updated.job) : undefined,
        });
      }
    }

    async function handleReleaseJob(payload: Record<string, unknown>) {
      const { jobs, job } = getJobOrFail(payload);
      requireJobIdentity(job, payload);
      requireLockedJob(job, payload);
      const failed = payload.failed === true || payload.status === "failed" || payload.ok === false || payload.success === false;
      const now = new Date().toISOString();
      const released = releaseOAuthJob(
        jobs,
        job.jobId,
        failed
          ? {
              status: "failed",
              lastError: asString(payload.code) || asString(payload.error) || "released_failed",
              lastErrorType: "fatal",
            }
          : {},
        now,
      );
      if (!released.job) {
        bridgeFailure("fatal", "job_release_failed", "无法释放 OAuth job");
      }
      await persistQueue(released.jobs);
      return {
        job: toOAuthBridgeQueueJob(released.job),
      };
    }

    async function handleRequest(request: OAuthBridgeRequest): Promise<Record<string, unknown>> {
      const payload = request.payload ?? {};
      switch (request.action) {
        case "GET_CAPABILITIES":
          return {
            version: OAUTH_BRIDGE_VERSION,
            actions: [...OAUTH_BRIDGE_ACTIONS],
          };
        case "GET_ACCOUNT_POOLS": {
          const currentProps = propsRef.current;
          const keeperFailures = new Set(currentProps.keeperRefreshFailureAuthIndexes ?? []);
          const importedInvalidAccountEmails = currentProps.importedInvalidAccountEmails ?? currentProps.settings.importedInvalidAccountEmails ?? [];
          const importedInvalidAccountEmailKeys = buildInvalidAccountEmailSet(importedInvalidAccountEmails);
          const invalidAccounts = getInvalidAccounts(currentProps.items, keeperFailures, importedInvalidAccountEmailKeys);
          return {
            invalidAccounts: invalidAccounts.map((item) => ({
              ...toOAuthBridgeAccount(item),
              reason: accountReason(item, keeperFailures, importedInvalidAccountEmailKeys),
            })),
            hotmailAccounts: currentProps.settings.hotmailAccounts.map(toOAuthBridgeHotmailAccount),
            counts: {
              invalidAccounts: invalidAccounts.length,
              hotmailAccounts: currentProps.settings.hotmailAccounts.length,
            },
          };
        }
        case "BUILD_QUEUE":
          return handleBuildQueue(payload);
        case "GET_QUEUE":
          return buildQueueResult(queueJobsRef.current);
        case "CLAIM_JOB":
          return handleClaimJob(payload);
        case "UPDATE_JOB":
          return handleUpdateJob(payload);
        case "START_JOB_OAUTH":
          return handleStartJobOAuth(payload);
        case "FETCH_CODE":
          return handleFetchCode(payload);
        case "SUBMIT_CALLBACK":
          return handleSubmitCallback(payload);
        case "CHECK_OAUTH_STATUS":
          return handleCheckOAuthStatus(payload);
        case "RELEASE_JOB":
          return handleReleaseJob(payload);
        default:
          bridgeFailure("fatal", "unsupported_action", `不支持的 OAuth bridge action：${String(request.action)}`);
      }
    }

    function handleBridgeMessage(event: MessageEvent) {
      if (!isOAuthBridgeRequest(event.data)) {
        return;
      }

      const request = event.data;
      void (async () => {
        try {
          const result = await handleRequest(request);
          postOAuthBridgeResponse(request, { ok: true, result });
        } catch (error) {
          postOAuthBridgeResponse(request, { ok: false, error: toBridgeError(error) });
        }
      })();
    }

    window.addEventListener("message", handleBridgeMessage);
    return () => window.removeEventListener("message", handleBridgeMessage);
  }, []);

  return null;
}
