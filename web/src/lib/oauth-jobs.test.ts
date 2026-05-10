import { describe, expect, it } from "vitest";
import type { AccountItem, HotmailAccount, OAuthJob, OAuthJobErrorType, OAuthJobStatus } from "../types";
import {
  buildOAuthJobs,
  claimNextOAuthJob,
  heartbeatOAuthJob,
  markOAuthJobCallbackSubmitted,
  markOAuthJobError,
  OAUTH_JOB_LEASE_MS,
  recoverExpiredOAuthJobLeases,
  releaseOAuthJob,
  summarizeOAuthJobs,
} from "./oauth-jobs";

const NOW = "2026-05-09T01:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function makeAccount(overrides: Partial<AccountItem> = {}): AccountItem {
  return {
    name: "codex-a.json",
    email: "A@Hotmail.com",
    plan_type: "free",
    account_id: "acct-a",
    auth_index: "idx-a",
    priority: null,
    status: "error",
    windows: [],
    additional_windows: [],
    error: "quota query failed",
    has_refresh_token: true,
    last_query_at: "2026-05-09T00:00:00.000Z",
    quota_updated_at: null,
    ...overrides,
  };
}

function makeHotmail(overrides: Partial<HotmailAccount> = {}): HotmailAccount {
  return {
    id: "hotmail-a",
    email: "a@hotmail.com",
    password: "pass",
    clientId: "client-a",
    refreshToken: "refresh-a",
    status: "authorized",
    ...overrides,
  };
}

function makeJob(overrides: Partial<OAuthJob> = {}): OAuthJob {
  return {
    jobId: "oauth-job:idx-a",
    authIndex: "idx-a",
    accountEmail: "a@hotmail.com",
    accountName: "codex-a.json",
    planType: "free",
    hotmailId: "hotmail-a",
    hotmailEmail: "a@hotmail.com",
    status: "queued",
    attempt: 0,
    retryCount: 0,
    startedAt: null,
    updatedAt: NOW,
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
    ...overrides,
  };
}

describe("OAuthJob contract", () => {
  it("contains the complete status contract", () => {
    const statuses: OAuthJobStatus[] = [
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
    ];

    expect(statuses).toHaveLength(10);
  });

  it("contains only the three error type categories", () => {
    const errorTypes: OAuthJobErrorType[] = ["retryable", "manual", "fatal"];

    expect(errorTypes).toEqual(["retryable", "manual", "fatal"]);
  });

  it("uses the planned job fields without the old id field", () => {
    expect(makeJob()).toEqual({
      jobId: "oauth-job:idx-a",
      authIndex: "idx-a",
      accountEmail: "a@hotmail.com",
      accountName: "codex-a.json",
      planType: "free",
      hotmailId: "hotmail-a",
      hotmailEmail: "a@hotmail.com",
      status: "queued",
      attempt: 0,
      retryCount: 0,
      startedAt: null,
      updatedAt: NOW,
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
    });
    expect(makeJob()).not.toHaveProperty("id");
  });
});

describe("buildOAuthJobs", () => {
  it("builds scoped jobs for OAuth relogin candidates and links Hotmail by email case-insensitively", () => {
    const jobs = buildOAuthJobs({
      accounts: [
        makeAccount({ auth_index: "idx-a", email: "A@Hotmail.com", plan_type: "plus" }),
        makeAccount({ auth_index: "idx-b", email: "missing@hotmail.com" }),
        makeAccount({ auth_index: "idx-c", email: "healthy@hotmail.com", status: "healthy", last_query_at: null }),
      ],
      hotmailAccounts: [makeHotmail({ id: "hotmail-a", email: "a@hotmail.com" })],
      keeperRefreshFailureAuthIndexes: ["idx-b"],
      scope: { kind: "selected", authIndexes: ["idx-a", "idx-b", "idx-c"] },
      now: NOW,
    });

    expect(jobs).toEqual([
      expect.objectContaining({
        jobId: "oauth-job:idx-a",
        authIndex: "idx-a",
        planType: "plus",
        hotmailId: "hotmail-a",
        hotmailEmail: "a@hotmail.com",
        state: "",
        callbackUrl: "",
        lastErrorType: "",
      }),
      expect.objectContaining({ jobId: "oauth-job:idx-b", authIndex: "idx-b", hotmailId: "", hotmailEmail: "" }),
    ]);
  });

  it("supports filtered scope by auth index", () => {
    const jobs = buildOAuthJobs({
      accounts: [makeAccount({ auth_index: "idx-a" }), makeAccount({ auth_index: "idx-b" })],
      hotmailAccounts: [],
      keeperRefreshFailureAuthIndexes: [],
      scope: { kind: "filtered", authIndexes: ["idx-b"] },
      now: NOW,
    });

    expect(jobs.map((job) => job.authIndex)).toEqual(["idx-b"]);
  });

  it("builds jobs for imported invalid account emails even when quota status is healthy", () => {
    const jobs = buildOAuthJobs({
      accounts: [
        makeAccount({ auth_index: "idx-healthy", email: "Healthy@Outlook.com", status: "healthy", error: "", last_query_at: null }),
        makeAccount({ auth_index: "idx-other", email: "other@outlook.com", status: "healthy", error: "", last_query_at: null }),
      ],
      hotmailAccounts: [makeHotmail({ id: "hotmail-healthy", email: "healthy@outlook.com" })],
      keeperRefreshFailureAuthIndexes: [],
      importedInvalidAccountEmails: ["healthy@outlook.com", "missing@outlook.com"],
      scope: { kind: "all" },
      now: NOW,
    });

    expect(jobs).toEqual([
      expect.objectContaining({
        authIndex: "idx-healthy",
        accountEmail: "Healthy@Outlook.com",
        hotmailId: "hotmail-healthy",
        hotmailEmail: "healthy@outlook.com",
      }),
    ]);
  });

  it("leaves state empty until START_JOB_OAUTH writes the real OAuth state", () => {
    const [job] = buildOAuthJobs({
      accounts: [makeAccount()],
      hotmailAccounts: [],
      keeperRefreshFailureAuthIndexes: [],
      scope: { kind: "all" },
      now: NOW,
    });

    expect(job.state).toBe("");
  });
});

describe("summarizeOAuthJobs", () => {
  it("counts running jobs with the planned summary fields", () => {
    expect(
      summarizeOAuthJobs([
        makeJob({ status: "queued" }),
        makeJob({ jobId: "oauth-job:idx-b", authIndex: "idx-b", status: "session_clearing" }),
        makeJob({ jobId: "oauth-job:idx-c", authIndex: "idx-c", status: "oauth_started" }),
        makeJob({ jobId: "oauth-job:idx-d", authIndex: "idx-d", status: "email_submitting" }),
        makeJob({ jobId: "oauth-job:idx-e", authIndex: "idx-e", status: "code_polling" }),
        makeJob({ jobId: "oauth-job:idx-f", authIndex: "idx-f", status: "code_submitting" }),
        makeJob({ jobId: "oauth-job:idx-g", authIndex: "idx-g", status: "consent_submitting" }),
        makeJob({ jobId: "oauth-job:idx-h", authIndex: "idx-h", status: "callback_submitted" }),
        makeJob({ jobId: "oauth-job:idx-i", authIndex: "idx-i", status: "manual_required" }),
        makeJob({ jobId: "oauth-job:idx-j", authIndex: "idx-j", status: "failed" }),
      ]),
    ).toEqual({
      total: 10,
      queued: 1,
      running: 6,
      callbackSubmitted: 1,
      manualRequired: 1,
      failed: 1,
    });
  });
});

describe("job claiming and leases", () => {
  it("claims the first queued job, heartbeats the owner, and releases back to queued by default without mutation", () => {
    const jobs = [makeJob(), makeJob({ jobId: "oauth-job:idx-b", authIndex: "idx-b" })];
    const original = structuredClone(jobs);

    const claimResult = claimNextOAuthJob(jobs, "ext-a", NOW_MS);
    expect(claimResult.claimed).toEqual(
      expect.objectContaining({
        jobId: "oauth-job:idx-a",
        status: "session_clearing",
        lockedByExtension: "ext-a",
        leaseExpiresAt: new Date(NOW_MS + OAUTH_JOB_LEASE_MS).toISOString(),
        startedAt: NOW,
        updatedAt: NOW,
      }),
    );
    expect(jobs).toEqual(original);
    expect(claimResult.jobs).not.toBe(jobs);
    expect(claimResult.jobs[0]).not.toBe(jobs[0]);

    const heartbeat = heartbeatOAuthJob(claimResult.jobs, "oauth-job:idx-a", "ext-a", NOW_MS + 1_000);
    expect(heartbeat.job?.leaseExpiresAt).toBe(new Date(NOW_MS + 1_000 + OAUTH_JOB_LEASE_MS).toISOString());
    expect(heartbeatOAuthJob(claimResult.jobs, "oauth-job:idx-a", "ext-b", NOW_MS + 2_000).job).toBeNull();

    const releaseTime = new Date(NOW_MS + 3_000).toISOString();
    const released = releaseOAuthJob(heartbeat.jobs, "oauth-job:idx-a", {}, releaseTime);
    expect(released.job).toEqual(expect.objectContaining({ status: "queued", lockedByExtension: "", leaseExpiresAt: null }));
    expect(released.jobs).not.toBe(heartbeat.jobs);
  });

  it("can release a job as failed", () => {
    const jobs = [
      makeJob({
        status: "session_clearing",
        lockedByExtension: "ext-a",
        leaseExpiresAt: new Date(NOW_MS + 1_000).toISOString(),
      }),
    ];

    const released = releaseOAuthJob(jobs, "oauth-job:idx-a", { status: "failed", lastError: "fatal_client", lastErrorType: "fatal" }, NOW);
    expect(released.job).toEqual(
      expect.objectContaining({ status: "failed", lastError: "fatal_client", lastErrorType: "fatal", lockedByExtension: "", leaseExpiresAt: null }),
    );
    expect(jobs[0].lockedByExtension).toBe("ext-a");
  });

  it("recovers expired leases immutably, retrying once and failing after retry lease expires", () => {
    const original = [
      makeJob({ status: "session_clearing", lockedByExtension: "ext-a", leaseExpiresAt: new Date(NOW_MS - 1).toISOString() }),
    ];
    const first = recoverExpiredOAuthJobLeases(original, NOW_MS);
    expect(first[0]).toEqual(expect.objectContaining({ status: "queued", attempt: 1, retryCount: 1, lockedByExtension: "", leaseExpiresAt: null }));
    expect(original[0].lockedByExtension).toBe("ext-a");

    const second = recoverExpiredOAuthJobLeases(
      [
        makeJob({
          status: "session_clearing",
          attempt: 1,
          retryCount: 1,
          lockedByExtension: "ext-a",
          leaseExpiresAt: new Date(NOW_MS - 1).toISOString(),
        }),
      ],
      NOW_MS,
    );
    expect(second[0]).toEqual(expect.objectContaining({ status: "failed", lastError: "lease_expired_after_retry", lastErrorType: "fatal" }));
  });

  it("does not requeue or fail queued and terminal jobs that have stale lease fields", () => {
    const staleLease = new Date(NOW_MS - 1).toISOString();
    const jobs = [
      makeJob({ status: "queued", lockedByExtension: "ext-a", leaseExpiresAt: staleLease }),
      makeJob({ jobId: "oauth-job:idx-b", authIndex: "idx-b", status: "callback_submitted", lockedByExtension: "ext-a", leaseExpiresAt: staleLease }),
      makeJob({ jobId: "oauth-job:idx-c", authIndex: "idx-c", status: "manual_required", lockedByExtension: "ext-a", leaseExpiresAt: staleLease }),
      makeJob({ jobId: "oauth-job:idx-d", authIndex: "idx-d", status: "failed", lockedByExtension: "ext-a", leaseExpiresAt: staleLease }),
    ];

    const recovered = recoverExpiredOAuthJobLeases(jobs, NOW_MS);

    expect(recovered.map((job) => job.status)).toEqual(["queued", "callback_submitted", "manual_required", "failed"]);
    expect(recovered.map((job) => job.attempt)).toEqual([0, 0, 0, 0]);
    expect(recovered.map((job) => job.retryCount)).toEqual([0, 0, 0, 0]);
  });
});

describe("callback submission", () => {
  it("fails invalid callback URLs even when the job state is still empty", () => {
    const job = makeJob({ status: "session_clearing", state: "" });

    const result = markOAuthJobCallbackSubmitted(job, "not a callback url", NOW);

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        lastError: "invalid_callback_url",
        lastErrorType: "fatal",
        callbackUrl: "",
      }),
    );
  });

  it("fails callback URLs missing state", () => {
    const job = makeJob({ status: "session_clearing", state: "state-a" });

    const result = markOAuthJobCallbackSubmitted(job, "https://app.example/oauth/callback?code=secret-code-123", NOW);

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        lastError: "missing_callback_state",
        lastErrorType: "fatal",
        callbackUrl: "",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("secret-code-123");
  });

  it("fails callback URLs missing both code and error result", () => {
    const job = makeJob({ status: "session_clearing", state: "state-a" });

    const result = markOAuthJobCallbackSubmitted(job, "https://app.example/oauth/callback?state=state-a", NOW);

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        lastError: "missing_callback_result",
        lastErrorType: "fatal",
        callbackUrl: "",
      }),
    );
  });

  it("is idempotent for the same raw callback URL and redacts the raw verification code", () => {
    const job = makeJob({
      status: "session_clearing",
      state: "state-a",
      lockedByExtension: "ext-a",
      leaseExpiresAt: new Date(NOW_MS + 1_000).toISOString(),
    });
    const callbackUrl = `https://app.example/oauth/callback?state=${encodeURIComponent(job.state)}&code=secret-code-123`;

    const first = markOAuthJobCallbackSubmitted(job, callbackUrl, NOW);
    const second = markOAuthJobCallbackSubmitted(first, callbackUrl, "2026-05-09T01:02:00.000Z");

    expect(second.status).toBe("callback_submitted");
    expect(second.callbackSubmittedAt).toBe(NOW);
    expect(second.callbackUrl).toContain("code=REDACTED");
    expect(second.callbackUrl).not.toContain("secret-code-123");
    expect(second.rejectedCodeFingerprints.filter((value) => value.startsWith("accepted-callback:"))).toEqual([
      expect.stringMatching(/^accepted-callback:fp:[0-9a-f]{32}$/),
    ]);
    expect(JSON.stringify(second)).not.toContain("secret-code-123");
    expect(job.status).toBe("session_clearing");
  });

  it("canonicalizes callback URLs before fingerprinting duplicate submissions", () => {
    const job = makeJob({ status: "session_clearing", state: "state-a" });
    const firstCallback = "https://APP.example/oauth/callback?state=state-a&code=secret-code-123";
    const sameCallbackDifferentOrder = "https://app.example/oauth/callback?code=secret-code-123&state=state-a";

    const first = markOAuthJobCallbackSubmitted(job, firstCallback, NOW);
    const second = markOAuthJobCallbackSubmitted(first, sameCallbackDifferentOrder, "2026-05-09T01:02:00.000Z");

    expect(second).toEqual(first);
    expect(second.rejectedCodeFingerprints.filter((value) => value.startsWith("accepted-callback:"))).toHaveLength(1);
    expect(JSON.stringify(second)).not.toContain("secret-code-123");
  });

  it("marks mismatched state as fatal failed without storing the raw code", () => {
    const job = makeJob({ status: "session_clearing", state: "state-a" });
    const result = markOAuthJobCallbackSubmitted(job, "https://app.example/oauth/callback?state=wrong&code=secret-code-456", NOW);

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        lastError: "state_mismatch",
        lastErrorType: "fatal",
        callbackUrl: "",
      }),
    );
    expect(result.rejectedCodeFingerprints).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("secret-code-456");
  });

  it("marks a different callback URL after success as fatal without overwriting the successful redacted URL", () => {
    const job = makeJob({ status: "session_clearing", state: "state-a" });
    const firstCallback = `https://app.example/oauth/callback?state=${encodeURIComponent(job.state)}&code=secret-code-123`;
    const differentCallback = `https://app.example/oauth/callback?state=${encodeURIComponent(job.state)}&code=secret-code-789`;

    const submitted = markOAuthJobCallbackSubmitted(job, firstCallback, NOW);
    const failed = markOAuthJobCallbackSubmitted(submitted, differentCallback, "2026-05-09T01:03:00.000Z");

    expect(failed).toEqual(
      expect.objectContaining({
        status: "failed",
        lastError: "callback_url_mismatch",
        lastErrorType: "fatal",
        callbackSubmittedAt: NOW,
        callbackUrl: submitted.callbackUrl,
      }),
    );
    expect(JSON.stringify(failed)).not.toContain("secret-code-789");
  });
});

describe("markOAuthJobError", () => {
  it("fails fatal errors immediately and separates lastErrorType from the error code", () => {
    expect(
      markOAuthJobError(makeJob({ status: "session_clearing" }), { errorType: "fatal", code: "bad_client", message: "bad client" }, NOW),
    ).toEqual(expect.objectContaining({ status: "failed", attempt: 0, retryCount: 0, lastErrorType: "fatal", lastError: "bad_client" }));
  });

  it("marks manual errors manual_required immediately without requeueing", () => {
    const first = markOAuthJobError(makeJob({ status: "session_clearing" }), { errorType: "manual", code: "captcha", message: "captcha required" }, NOW);
    expect(first).toEqual(expect.objectContaining({ status: "manual_required", attempt: 0, retryCount: 0, lastErrorType: "manual", lastError: "captcha" }));
  });

  it("marks retryable and timeout codes failed immediately without requeueing", () => {
    const first = markOAuthJobError(makeJob({ status: "session_clearing" }), { errorType: "retryable", code: "timeout" }, NOW);
    expect(first).toEqual(expect.objectContaining({ status: "failed", attempt: 0, retryCount: 0, lastErrorType: "retryable", lastError: "timeout" }));
  });

  it("handles account email mismatch as a failed retryable code without requeueing", () => {
    const first = markOAuthJobError(
      makeJob({ status: "session_clearing" }),
      { errorType: "retryable", code: "account_email_mismatch" },
      NOW,
    );
    expect(first).toEqual(
      expect.objectContaining({
        status: "failed",
        attempt: 0,
        retryCount: 0,
        lastErrorType: "retryable",
        lastError: "account_email_mismatch",
      }),
    );
  });
});
