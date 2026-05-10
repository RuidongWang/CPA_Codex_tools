import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodexOAuthBridge } from "./CodexOAuthBridge";
import {
  OAUTH_BRIDGE_REQUEST_SOURCE,
  OAUTH_BRIDGE_REQUEST_TYPE,
  OAUTH_BRIDGE_RESPONSE_SOURCE,
  OAUTH_BRIDGE_RESPONSE_TYPE,
  type OAuthBridgeAction,
} from "../lib/oauth-bridge";
import type { OAuthJobStore } from "../lib/oauth-job-store";
import type { AccountItem, HotmailAccount, OAuthJob, OAuthSettings } from "../types";

const NOW = "2026-05-09T01:00:00.000Z";

function makeAccount(overrides: Partial<AccountItem> = {}): AccountItem {
  return {
    name: "codex-a.json",
    email: "alice@hotmail.com",
    plan_type: "free",
    account_id: "acct-a",
    auth_index: "idx-a",
    priority: null,
    status: "error",
    windows: [],
    additional_windows: [],
    error: "Token 失效",
    has_refresh_token: false,
    last_query_at: "2026-05-09T00:00:00.000Z",
    quota_updated_at: null,
    ...overrides,
  };
}

function makeHotmail(overrides: Partial<HotmailAccount> = {}): HotmailAccount {
  return {
    id: "hotmail-a",
    email: "alice@hotmail.com",
    password: "mail-password",
    clientId: "client-a",
    refreshToken: "refresh-token-a",
    status: "authorized",
    ...overrides,
  };
}

function makeJob(overrides: Partial<OAuthJob> = {}): OAuthJob {
  return {
    jobId: "oauth-job:idx-a",
    authIndex: "idx-a",
    accountEmail: "alice@hotmail.com",
    accountName: "codex-a.json",
    planType: "free",
    hotmailId: "hotmail-a",
    hotmailEmail: "alice@hotmail.com",
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

function makeStore(): OAuthJobStore {
  return {
    load: vi.fn(() => []),
    save: vi.fn(() => true),
    clear: vi.fn(() => true),
  };
}

function makeSettings(overrides: Partial<OAuthSettings> = {}): OAuthSettings {
  return {
    hotmailHelperUrl: "http://127.0.0.1:17373",
    hotmailAccounts: [makeHotmail()],
    rememberHotmailTokens: false,
    ...overrides,
  };
}

function requestOAuthBridge(action: OAuthBridgeAction, payload: Record<string, unknown> = {}) {
  const requestId = `test-${action}-${Math.random().toString(36).slice(2)}`;
  return new Promise<Record<string, unknown>>((resolve) => {
    const handler = (event: MessageEvent) => {
      if (
        event.data?.source === OAUTH_BRIDGE_RESPONSE_SOURCE &&
        event.data?.type === OAUTH_BRIDGE_RESPONSE_TYPE &&
        event.data?.requestId === requestId
      ) {
        window.removeEventListener("message", handler);
        resolve(event.data as Record<string, unknown>);
      }
    };
    window.addEventListener("message", handler);
    window.postMessage(
      {
        source: OAUTH_BRIDGE_REQUEST_SOURCE,
        type: OAUTH_BRIDGE_REQUEST_TYPE,
        requestId,
        action,
        payload,
      },
      window.location.origin,
    );
  });
}

function jobIdentity(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "oauth-job:idx-a",
    authIndex: "idx-a",
    accountEmail: "alice@hotmail.com",
    ...overrides,
  };
}

function renderBridge(overrides: Partial<React.ComponentProps<typeof CodexOAuthBridge>> = {}) {
  const queueStore = overrides.queueStore ?? makeStore();
  const onQueueJobsChange = overrides.onQueueJobsChange ?? vi.fn();
  const onSettingsChange = overrides.onSettingsChange ?? vi.fn();
  const props: React.ComponentProps<typeof CodexOAuthBridge> = {
    items: [makeAccount()],
    settings: makeSettings(),
    ready: true,
    queueJobs: [],
    queueStore,
    selectedAuthIndexes: [],
    filteredAuthIndexes: [],
    keeperRefreshFailureAuthIndexes: [],
    onQueueJobsChange,
    onSettingsChange,
    onStartOAuth: vi.fn().mockResolvedValue({
      authUrl: "https://auth.openai.com/oauth?state=state-a",
      state: "state-a",
      raw: {},
    }),
    onSubmitOAuthCallback: vi.fn().mockResolvedValue({
      state: "state-a",
      status: "pending",
      message: "callback accepted",
      raw: {},
    }),
    onPollOAuthStatus: vi.fn().mockResolvedValue({
      state: "state-a",
      status: "success",
      email: "alice@hotmail.com",
      message: "认证成功",
      raw: {},
    }),
    onFetchHotmailCode: vi.fn().mockResolvedValue({
      code: "654321",
      nextRefreshToken: "next-refresh-token",
      transport: "graph",
      raw: {},
    }),
    ...overrides,
  };

  render(<CodexOAuthBridge {...props} />);
  return props;
}

describe("CodexOAuthBridge", () => {
  it("responds globally with capabilities and safe account pools", async () => {
    renderBridge({
      items: [
        makeAccount({ email: "alice@hotmail.com", auth_index: "idx-a" }),
        makeAccount({ email: "healthy@hotmail.com", auth_index: "idx-healthy", status: "healthy", error: "", last_query_at: null }),
        makeAccount({ email: "keeper@hotmail.com", auth_index: "idx-keeper", status: "healthy", error: "", last_query_at: null }),
      ],
      keeperRefreshFailureAuthIndexes: ["idx-keeper"],
      settings: makeSettings({
        hotmailAccounts: [
          makeHotmail({
            email: "alice@hotmail.com",
            password: "pool-password",
            refreshToken: "pool-refresh-token",
            lastCode: "111222",
          }),
        ],
      }),
    });

    const capabilities = await requestOAuthBridge("GET_CAPABILITIES");
    expect(capabilities.ok).toBe(true);
    expect(capabilities.result).toEqual(
      expect.objectContaining({
        version: 2,
        actions: expect.arrayContaining(["BUILD_QUEUE", "START_JOB_OAUTH", "RELEASE_JOB"]),
      }),
    );

    const pools = await requestOAuthBridge("GET_ACCOUNT_POOLS");
    const serialized = JSON.stringify(pools);
    expect(pools.ok).toBe(true);
    expect(pools.result).toEqual(
      expect.objectContaining({
        counts: { invalidAccounts: 2, hotmailAccounts: 1 },
        invalidAccounts: [
          expect.objectContaining({ email: "alice@hotmail.com", authIndex: "idx-a", reason: "Token 失效" }),
          expect.objectContaining({ email: "keeper@hotmail.com", authIndex: "idx-keeper", reason: "Keeper 刷新失败" }),
        ],
        hotmailAccounts: [
          {
            id: "hotmail-a",
            email: "alice@hotmail.com",
            clientId: "client-a",
            status: "authorized",
            lastCodeAt: undefined,
            lastError: undefined,
            hasRefreshToken: true,
          },
        ],
      }),
    );
    expect(serialized).not.toContain("pool-password");
    expect(serialized).not.toContain("pool-refresh-token");
    expect(serialized).not.toContain("111222");
  });

  it("builds, persists, claims, and starts OAuth jobs using the queue state machine", async () => {
    const queueStore = makeStore();
    const onQueueJobsChange = vi.fn();
    const onStartOAuth = vi.fn().mockResolvedValue({
      authUrl: "https://auth.openai.com/oauth?state=claimed-state",
      state: "claimed-state",
      raw: {},
    });

    renderBridge({
      queueStore,
      onQueueJobsChange,
      onStartOAuth,
      items: [
        makeAccount({ email: "alice@hotmail.com", auth_index: "idx-a" }),
        makeAccount({ email: "healthy@hotmail.com", auth_index: "idx-healthy", status: "healthy", error: "", last_query_at: null }),
      ],
      selectedAuthIndexes: ["idx-a", "idx-healthy"],
    });

    const built = await requestOAuthBridge("BUILD_QUEUE", { scope: "selected" });
    expect(built.ok).toBe(true);
    expect(built.result).toEqual(
      expect.objectContaining({
        summary: expect.objectContaining({ total: 1, queued: 1 }),
        jobs: [expect.objectContaining({ jobId: "oauth-job:idx-a", status: "queued", hotmailId: "hotmail-a" })],
      }),
    );
    expect(queueStore.save).toHaveBeenLastCalledWith([expect.objectContaining({ jobId: "oauth-job:idx-a" })]);

    const claimed = await requestOAuthBridge("CLAIM_JOB", { extensionId: "extension-a" });
    expect(claimed.ok).toBe(true);
    expect(claimed.result).toEqual(
      expect.objectContaining({
        claimed: expect.objectContaining({
          jobId: "oauth-job:idx-a",
          status: "session_clearing",
          lockedByExtension: "extension-a",
          leaseExpiresAt: expect.any(String),
        }),
      }),
    );

    const started = await requestOAuthBridge("START_JOB_OAUTH", jobIdentity({ extensionId: "extension-a" }));
    expect(started.ok).toBe(true);
    expect(onStartOAuth).toHaveBeenCalledTimes(1);
    expect(started.result).toEqual(
      expect.objectContaining({
        job: expect.objectContaining({
          jobId: "oauth-job:idx-a",
          status: "oauth_started",
          authUrl: "https://auth.openai.com/oauth?state=claimed-state",
          state: "claimed-state",
        }),
      }),
    );
    expect(onQueueJobsChange).toHaveBeenCalledWith([expect.objectContaining({ state: "claimed-state" })]);
  });

  it.each([
    "UPDATE_JOB",
    "START_JOB_OAUTH",
    "FETCH_CODE",
    "SUBMIT_CALLBACK",
    "CHECK_OAUTH_STATUS",
    "RELEASE_JOB",
  ] as const)("rejects %s when the payload omits jobId even if state matches a job", async (action) => {
    const onStartOAuth = vi.fn().mockResolvedValue({
      authUrl: "https://auth.openai.com/oauth?state=claimed-state",
      state: "claimed-state",
      raw: {},
    });
    const onSubmitOAuthCallback = vi.fn().mockResolvedValue({
      state: "state-a",
      status: "pending",
      message: "callback accepted",
      raw: {},
    });
    const onPollOAuthStatus = vi.fn().mockResolvedValue({
      state: "state-a",
      status: "success",
      email: "alice@hotmail.com",
      message: "认证成功",
      raw: {},
    });
    const onFetchHotmailCode = vi.fn().mockResolvedValue({
      code: "654321",
      transport: "graph",
      raw: {},
    });

    renderBridge({
      queueJobs: [
        makeJob({
          status: "oauth_started",
          lockedByExtension: "extension-a",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          state: "state-a",
        }),
      ],
      onStartOAuth,
      onSubmitOAuthCallback,
      onPollOAuthStatus,
      onFetchHotmailCode,
    });

    const response = await requestOAuthBridge(action, {
      state: "state-a",
      extensionId: "extension-a",
      authIndex: "idx-a",
      accountEmail: "alice@hotmail.com",
      expectedEmail: "alice@hotmail.com",
      hotmailId: "hotmail-a",
      callbackUrl: "http://localhost:1455/auth/callback?code=oauth-code&state=state-a",
    });

    expect(response.ok).toBe(false);
    expect(response.error).toEqual(
      expect.objectContaining({
        errorType: "fatal",
        code: "missing_job_id",
      }),
    );
    expect(onStartOAuth).not.toHaveBeenCalled();
    expect(onSubmitOAuthCallback).not.toHaveBeenCalled();
    expect(onPollOAuthStatus).not.toHaveBeenCalled();
    expect(onFetchHotmailCode).not.toHaveBeenCalled();
  });

  it("rejects START_JOB_OAUTH when required auth identity is missing or mismatched", async () => {
    const onStartOAuth = vi.fn().mockResolvedValue({
      authUrl: "https://auth.openai.com/oauth?state=claimed-state",
      state: "claimed-state",
      raw: {},
    });

    renderBridge({
      queueJobs: [
        makeJob({
          status: "session_clearing",
          lockedByExtension: "extension-a",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ],
      onStartOAuth,
    });

    const missingAuthIndex = await requestOAuthBridge("START_JOB_OAUTH", {
      jobId: "oauth-job:idx-a",
      extensionId: "extension-a",
      accountEmail: "alice@hotmail.com",
    });
    expect(missingAuthIndex.ok).toBe(false);
    expect(missingAuthIndex.error).toEqual(
      expect.objectContaining({
        errorType: "fatal",
        code: "missing_job_identity",
        field: "authIndex",
      }),
    );

    const missingEmail = await requestOAuthBridge("START_JOB_OAUTH", {
      jobId: "oauth-job:idx-a",
      extensionId: "extension-a",
      authIndex: "idx-a",
    });
    expect(missingEmail.ok).toBe(false);
    expect(missingEmail.error).toEqual(
      expect.objectContaining({
        errorType: "fatal",
        code: "missing_job_identity",
        field: "accountEmail",
      }),
    );

    const wrongEmail = await requestOAuthBridge("START_JOB_OAUTH", jobIdentity({
      extensionId: "extension-a",
      accountEmail: "mallory@hotmail.com",
    }));
    expect(wrongEmail.ok).toBe(false);
    expect(wrongEmail.error).toEqual(
      expect.objectContaining({
        errorType: "fatal",
        code: "job_identity_mismatch",
      }),
    );

    const wrongAuthIndex = await requestOAuthBridge("START_JOB_OAUTH", jobIdentity({
      extensionId: "extension-a",
      authIndex: "idx-other",
    }));
    expect(wrongAuthIndex.ok).toBe(false);
    expect(wrongAuthIndex.error).toEqual(
      expect.objectContaining({
        errorType: "fatal",
        code: "job_identity_mismatch",
      }),
    );
    expect(onStartOAuth).not.toHaveBeenCalled();
  });

  it("updates locked jobs, renews their lease, persists the queue, and rejects the wrong extension", async () => {
    const queueStore = makeStore();
    const initialLease = new Date(Date.now() + 10_000).toISOString();

    renderBridge({
      queueStore,
      queueJobs: [
        makeJob({
          status: "oauth_started",
          lockedByExtension: "extension-a",
          leaseExpiresAt: initialLease,
          state: "state-a",
        }),
      ],
    });

    const updated = await requestOAuthBridge("UPDATE_JOB", jobIdentity({
      extensionId: "extension-a",
      patch: {
        status: "code_polling",
        attempt: 1,
        retryCount: 1,
        lastError: "waiting_for_code",
        lastErrorType: "retryable",
      },
    }));
    expect(updated.ok).toBe(true);
    expect(updated.result).toEqual(
      expect.objectContaining({
        leaseExpiresAt: expect.any(String),
        job: expect.objectContaining({
          jobId: "oauth-job:idx-a",
          status: "code_polling",
          attempt: 1,
          retryCount: 1,
          lastError: "waiting_for_code",
          lastErrorType: "retryable",
          lockedByExtension: "extension-a",
          leaseExpiresAt: expect.any(String),
        }),
      }),
    );
    expect((updated.result as { leaseExpiresAt: string }).leaseExpiresAt).not.toBe(initialLease);
    expect(queueStore.save).toHaveBeenLastCalledWith([
      expect.objectContaining({
        jobId: "oauth-job:idx-a",
        status: "code_polling",
        attempt: 1,
        retryCount: 1,
        lastError: "waiting_for_code",
        lastErrorType: "retryable",
        leaseExpiresAt: (updated.result as { leaseExpiresAt: string }).leaseExpiresAt,
      }),
    ]);

    const rejected = await requestOAuthBridge("UPDATE_JOB", jobIdentity({
      extensionId: "extension-b",
      patch: {
        status: "manual_required",
      },
    }));
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toEqual(
      expect.objectContaining({
        errorType: "fatal",
        code: "job_not_locked_by_extension",
      }),
    );
  });

  it("releases locked jobs back to queued or marks them failed with lastError", async () => {
    const queueStore = makeStore();

    renderBridge({
      queueStore,
      queueJobs: [
        makeJob({
          status: "oauth_started",
          lockedByExtension: "extension-a",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          state: "state-a",
        }),
        makeJob({
          jobId: "oauth-job:idx-b",
          authIndex: "idx-b",
          accountEmail: "bob@hotmail.com",
          hotmailId: "hotmail-b",
          hotmailEmail: "bob@hotmail.com",
          status: "code_polling",
          lockedByExtension: "extension-a",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          state: "state-b",
        }),
      ],
    });

    const released = await requestOAuthBridge("RELEASE_JOB", jobIdentity({ extensionId: "extension-a" }));
    expect(released.ok).toBe(true);
    expect(released.result).toEqual(
      expect.objectContaining({
        job: expect.objectContaining({
          jobId: "oauth-job:idx-a",
          status: "queued",
          lockedByExtension: "",
          leaseExpiresAt: null,
        }),
      }),
    );

    const failed = await requestOAuthBridge("RELEASE_JOB", {
      jobId: "oauth-job:idx-b",
      authIndex: "idx-b",
      accountEmail: "bob@hotmail.com",
      extensionId: "extension-a",
      failed: true,
      error: "extension_failed",
    });
    expect(failed.ok).toBe(true);
    expect(failed.result).toEqual(
      expect.objectContaining({
        job: expect.objectContaining({
          jobId: "oauth-job:idx-b",
          status: "failed",
          lockedByExtension: "",
          leaseExpiresAt: null,
          lastError: "extension_failed",
          lastErrorType: "fatal",
        }),
      }),
    );
    expect(queueStore.save).toHaveBeenLastCalledWith([
      expect.objectContaining({ jobId: "oauth-job:idx-a", status: "queued", lockedByExtension: "" }),
      expect.objectContaining({ jobId: "oauth-job:idx-b", status: "failed", lastError: "extension_failed", lockedByExtension: "" }),
    ]);
  });

  it("fetches codes for the matching Hotmail account and persists refresh-token rotation without returning secrets", async () => {
    const queueStore = makeStore();
    const onSettingsChange = vi.fn();
    const onFetchHotmailCode = vi.fn().mockResolvedValue({
      code: "246810",
      nextRefreshToken: "rotated-refresh-token",
      transport: "graph",
      raw: {},
    });

    renderBridge({
      queueStore,
      queueJobs: [
        makeJob({
          status: "oauth_started",
          lockedByExtension: "extension-a",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          state: "state-a",
        }),
      ],
      onSettingsChange,
      onFetchHotmailCode,
    });

    const response = await requestOAuthBridge("FETCH_CODE", jobIdentity({
      extensionId: "extension-a",
      expectedEmail: "alice@hotmail.com",
      hotmailId: "hotmail-a",
    }));

    expect(response.ok).toBe(true);
    expect(response.result).toEqual(
      expect.objectContaining({
        code: "246810",
        hotmailCode: expect.objectContaining({ code: "246810", email: "alice@hotmail.com", transport: "graph" }),
        job: expect.objectContaining({ lastCodeAt: expect.any(String), status: "code_submitting" }),
      }),
    );
    expect(onFetchHotmailCode).toHaveBeenCalledWith(
      expect.objectContaining({ email: "alice@hotmail.com", refreshToken: "refresh-token-a" }),
      expect.objectContaining({ authIndex: "idx-a", excludeCodes: [], filterAfterTimestamp: expect.any(Number) }),
    );
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        hotmailAccounts: [
          expect.objectContaining({
            email: "alice@hotmail.com",
            refreshToken: "rotated-refresh-token",
            status: "authorized",
            lastCode: "246810",
          }),
        ],
      }),
    );
    expect(JSON.stringify(response)).not.toContain("rotated-refresh-token");
    expect(JSON.stringify(response)).not.toContain("refresh-token-a");
    expect(JSON.stringify(response)).not.toContain("mail-password");
  });

  it("rejects FETCH_CODE when the payload email does not match the job or Hotmail identity", async () => {
    const onFetchHotmailCode = vi.fn().mockResolvedValue({
      code: "246810",
      transport: "graph",
      raw: {},
    });

    renderBridge({
      queueJobs: [
        makeJob({
          status: "oauth_started",
          lockedByExtension: "extension-a",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          state: "state-a",
        }),
      ],
      onFetchHotmailCode,
    });

    const response = await requestOAuthBridge("FETCH_CODE", jobIdentity({
      extensionId: "extension-a",
      expectedEmail: "alice@hotmail.com",
      hotmailId: "hotmail-a",
      email: "mallory@hotmail.com",
    }));

    expect(response.ok).toBe(false);
    expect(response.error).toEqual(
      expect.objectContaining({
        errorType: "fatal",
        code: "job_identity_mismatch",
        field: "email",
      }),
    );
    expect(onFetchHotmailCode).not.toHaveBeenCalled();
  });

  it("marks code_not_found failed without requeueing when the helper has no verification code", async () => {
    const queueStore = makeStore();
    renderBridge({
      queueStore,
      queueJobs: [
        makeJob({
          status: "oauth_started",
          lockedByExtension: "extension-a",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          state: "state-a",
        }),
      ],
      onFetchHotmailCode: vi.fn().mockResolvedValue({
        code: "",
        transport: "graph",
        raw: {},
      }),
    });

    const response = await requestOAuthBridge("FETCH_CODE", jobIdentity({
      extensionId: "extension-a",
      expectedEmail: "alice@hotmail.com",
      hotmailId: "hotmail-a",
    }));

    expect(response.ok).toBe(false);
    expect(response.error).toEqual(
      expect.objectContaining({
        errorType: "retryable",
        code: "code_not_found",
      }),
    );
    await waitFor(() => {
      expect(queueStore.save).toHaveBeenCalledWith([
        expect.objectContaining({
          status: "failed",
          lockedByExtension: "",
          leaseExpiresAt: null,
          attempt: 0,
          retryCount: 0,
          lastError: "code_not_found",
          lastErrorType: "retryable",
        }),
      ]);
    });
  });

  it("submits callbacks idempotently and checks OAuth status without moving callback-submitted jobs", async () => {
    const queueStore = makeStore();
    const onSubmitOAuthCallback = vi.fn().mockResolvedValue({
      state: "state-a",
      status: "pending",
      message: "callback accepted",
      raw: {},
    });
    const onPollOAuthStatus = vi.fn().mockResolvedValue({
      state: "state-a",
      status: "success",
      email: "alice@hotmail.com",
      message: "认证成功",
      raw: {},
    });

    renderBridge({
      queueStore,
      queueJobs: [
        makeJob({
          status: "oauth_started",
          lockedByExtension: "extension-a",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          state: "state-a",
          authUrl: "https://auth.openai.com/oauth?state=state-a",
        }),
      ],
      onSubmitOAuthCallback,
      onPollOAuthStatus,
    });

    const callbackUrl = "http://localhost:1455/auth/callback?code=oauth-code&state=state-a";
    const submitted = await requestOAuthBridge("SUBMIT_CALLBACK", jobIdentity({ extensionId: "extension-a", callbackUrl }));
    expect(submitted.ok).toBe(true);
    expect(onSubmitOAuthCallback).toHaveBeenCalledWith("state-a", callbackUrl);
    expect(submitted.result).toEqual(expect.objectContaining({ job: expect.objectContaining({ status: "callback_submitted" }) }));

    const submittedAgain = await requestOAuthBridge("SUBMIT_CALLBACK", jobIdentity({ callbackUrl }));
    expect(submittedAgain.ok).toBe(true);
    expect(submittedAgain.result).toEqual(expect.objectContaining({ idempotent: true }));
    expect(onSubmitOAuthCallback).toHaveBeenCalledTimes(1);

    const checked = await requestOAuthBridge("CHECK_OAUTH_STATUS", jobIdentity({ state: "state-a" }));
    expect(checked.ok).toBe(true);
    expect(onPollOAuthStatus).toHaveBeenCalledWith("state-a");
    expect(checked.result).toEqual(
      expect.objectContaining({
        job: expect.objectContaining({
          status: "callback_submitted",
          oauthStatus: "success",
          oauthError: "",
          oauthCheckedAt: expect.any(String),
        }),
      }),
    );
  });

  it("rejects CHECK_OAUTH_STATUS when payload state does not match the job state", async () => {
    const onPollOAuthStatus = vi.fn().mockResolvedValue({
      state: "state-a",
      status: "success",
      email: "alice@hotmail.com",
      message: "认证成功",
      raw: {},
    });

    renderBridge({
      queueJobs: [
        makeJob({
          status: "callback_submitted",
          state: "state-a",
          callbackUrl: "http://localhost:1455/auth/callback?code=REDACTED&state=state-a",
        }),
      ],
      onPollOAuthStatus,
    });

    const response = await requestOAuthBridge("CHECK_OAUTH_STATUS", jobIdentity({ state: "state-b" }));

    expect(response.ok).toBe(false);
    expect(response.error).toEqual(
      expect.objectContaining({
        errorType: "fatal",
        code: "state_mismatch",
      }),
    );
    expect(onPollOAuthStatus).not.toHaveBeenCalled();
  });

  it("allows idempotent callback replay but rejects different callback URLs without modifying callback-submitted jobs", async () => {
    const queueStore = makeStore();
    const onSubmitOAuthCallback = vi.fn().mockResolvedValue({
      state: "state-a",
      status: "pending",
      message: "callback accepted",
      raw: {},
    });

    renderBridge({
      queueStore,
      queueJobs: [
        makeJob({
          status: "oauth_started",
          lockedByExtension: "extension-a",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          state: "state-a",
          authUrl: "https://auth.openai.com/oauth?state=state-a",
        }),
      ],
      onSubmitOAuthCallback,
    });

    const callbackUrl = "http://localhost:1455/auth/callback?code=oauth-code&state=state-a";
    const submitted = await requestOAuthBridge("SUBMIT_CALLBACK", jobIdentity({ extensionId: "extension-a", callbackUrl }));
    expect(submitted.ok).toBe(true);
    const saveCountAfterSubmit = vi.mocked(queueStore.save).mock.calls.length;

    const idempotent = await requestOAuthBridge("SUBMIT_CALLBACK", jobIdentity({ callbackUrl }));
    expect(idempotent.ok).toBe(true);
    expect(idempotent.result).toEqual(expect.objectContaining({ idempotent: true }));

    const differentCallbackUrl = "http://localhost:1455/auth/callback?code=second-oauth-code&state=state-a";
    const rejected = await requestOAuthBridge("SUBMIT_CALLBACK", jobIdentity({ callbackUrl: differentCallbackUrl }));

    expect(rejected.ok).toBe(false);
    expect(rejected.error).toEqual(
      expect.objectContaining({
        errorType: "fatal",
        code: "callback_url_mismatch",
      }),
    );
    expect(onSubmitOAuthCallback).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queueStore.save).mock.calls.length).toBe(saveCountAfterSubmit);
  });
});
