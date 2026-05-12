# Codex OAuth Batch Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a batch Codex OAuth recovery flow where the Web app owns the Job queue and the Chrome/Edge extension serially executes each invalid account until callback submission.

**Architecture:** The Web app becomes the Job Controller: it builds, persists, locks, updates, and displays OAuth Jobs through a global versioned bridge. The extension becomes the Browser Executor: it claims one Job at a time, clears OpenAI session state, automates the OpenAI OAuth tab, submits the callback, and continues to the next Job without storing Hotmail secrets.

**Tech Stack:** React, TypeScript, Vitest, localStorage/IndexedDB-style browser persistence, Chrome Manifest V3, vanilla JavaScript service worker/content scripts, Node built-in test runner.

---

## Source Documents

- Spec: `docs/superpowers/specs/2026-05-09-codex-oauth-batch-extension-design.md`
- Existing single-account plan: `docs/superpowers/plans/2026-05-08-codex-oauth-extension.md`

## Implementation Order

Tasks 1 and 5 can run in parallel because they touch separate Web/extension pure layers. Task 2 depends on Task 1. Task 3 depends on Tasks 1 and 2. Task 4 depends on Task 3 because it uses the queue props and bridge wiring introduced there. Task 6 depends on Tasks 3 and 5. Task 7 depends on Task 6. Task 8 is final verification.

## File Structure

- `web/src/types.ts`: Add shared OAuth Job, Queue, bridge request/response, and queue summary types.
- `web/src/lib/oauth-jobs.ts`: Pure queue builder, state machine, lease handling, callback idempotency, and summary helpers.
- `web/src/lib/oauth-jobs.test.ts`: Vitest coverage for queue building, claim/update/release, retries, lease expiry, callback idempotency, and fatal/manual behavior.
- `web/src/lib/oauth-job-store.ts`: Browser persistence wrapper for the queue; store no Hotmail passwords, refresh tokens, or verification codes.
- `web/src/lib/oauth-job-store.test.ts`: Storage tests using injected fake storage.
- `web/src/lib/oauth-bridge.ts`: Bridge constants, capability metadata, request/response helpers, and error normalization.
- `web/src/lib/oauth-bridge.test.ts`: Bridge constants and error normalization tests.
- `web/src/components/CodexOAuthBridge.tsx`: Global bridge controller rendered by `App` regardless of the active page.
- `web/src/components/CodexOAuthBridge.test.tsx`: Bridge action tests.
- `web/src/components/CodexOAuthPanel.tsx`: UI for queue creation, queue status, Job list, diagnostics, and existing Hotmail import controls.
- `web/src/components/CodexOAuthPanel.test.tsx`: UI and legacy compatibility tests.
- `web/src/App.tsx`: Own OAuth queue state, load/persist it, render `CodexOAuthBridge`, and pass queue data/actions to `CodexOAuthPanel`.
- `browser-extension/codex-oauth-auto-login/background-core.js`: Extend pure helpers with OpenAI clear domains, callback safety, and status sanitization.
- `browser-extension/codex-oauth-auto-login/background-batch-core.js`: New pure batch executor decision helpers.
- `browser-extension/codex-oauth-auto-login/background.js`: Batch runner, Job claim loop, heartbeat, pause/resume/stop, session clearing, retry rules.
- `browser-extension/codex-oauth-auto-login/content-openai.js`: Add account-email read/compare helpers if needed before consent click.
- `browser-extension/codex-oauth-auto-login/manifest.json`: Add exact OpenAI-related host permissions and `cookies`/`browsingData`.
- `browser-extension/codex-oauth-auto-login/sidepanel.html`: Batch controls and progress containers.
- `browser-extension/codex-oauth-auto-login/sidepanel.js`: Render queue stats/current Job/recent errors and dispatch batch actions.
- `browser-extension/codex-oauth-auto-login/sidepanel.css`: Batch side panel layout.
- `browser-extension/codex-oauth-auto-login/tests/*.test.js`: Add batch core, manifest permission, session clearing, content helper, and runner decision tests.
- `README.md` and `browser-extension/codex-oauth-auto-login/README.md`: Document batch OAuth recovery and extension permissions.

---

### Task 1: Web OAuth Job State Machine

**Files:**
- Modify: `web/src/types.ts`
- Create: `web/src/lib/oauth-jobs.ts`
- Create: `web/src/lib/oauth-jobs.test.ts`

- [ ] **Step 1: Write failing tests for queue building**

Add `web/src/lib/oauth-jobs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildOAuthJobs, summarizeOAuthJobs } from "./oauth-jobs";
import type { AccountItem, HotmailAccount } from "../types";

const now = "2026-05-09T01:00:00.000Z";

function account(overrides: Partial<AccountItem>): AccountItem {
  return {
    auth_index: overrides.auth_index ?? "auth-1",
    account_id: overrides.account_id ?? "",
    name: overrides.name ?? "",
    email: overrides.email ?? "a@example.com",
    plan_type: overrides.plan_type ?? "free",
    status: overrides.status ?? "healthy",
    error: overrides.error ?? "",
    expired: overrides.expired ?? null,
    windows: overrides.windows ?? [],
    additional_windows: overrides.additional_windows ?? [],
    priority: overrides.priority ?? null,
    timings_ms: overrides.timings_ms ?? {},
    last_query_at: overrides.last_query_at ?? null,
    quota_reset_at: overrides.quota_reset_at ?? null,
    quota_reset_label: overrides.quota_reset_label ?? null,
    quota_updated_at: overrides.quota_updated_at ?? null,
    updated_at: overrides.updated_at ?? null,
  };
}

function hotmail(overrides: Partial<HotmailAccount>): HotmailAccount {
  return {
    id: overrides.id ?? `${overrides.email ?? "a@example.com"}::client`,
    email: overrides.email ?? "a@example.com",
    password: overrides.password ?? "password",
    clientId: overrides.clientId ?? "client",
    refreshToken: overrides.refreshToken ?? "refresh",
    status: overrides.status ?? "authorized",
    lastCode: overrides.lastCode,
    lastCodeAt: overrides.lastCodeAt,
    lastError: overrides.lastError,
    updatedAt: overrides.updatedAt,
  };
}

describe("buildOAuthJobs", () => {
  it("builds jobs only for invalid candidates and links matching Hotmail accounts", () => {
    const jobs = buildOAuthJobs({
      accounts: [
        account({ auth_index: "normal", email: "normal@example.com", status: "healthy" }),
        account({ auth_index: "quota-error", email: "quota@example.com", status: "error", last_query_at: now }),
        account({ auth_index: "keeper-error", email: "keeper@example.com", status: "healthy" }),
      ],
      hotmailAccounts: [hotmail({ id: "h1", email: "quota@example.com" })],
      keeperRefreshFailureAuthIndexes: new Set(["keeper-error"]),
      scope: { kind: "all" },
      now,
    });

    expect(jobs.map((job) => [job.authIndex, job.status, job.hotmailEmail])).toEqual([
      ["quota-error", "queued", "quota@example.com"],
      ["keeper-error", "queued", ""],
    ]);
    expect(summarizeOAuthJobs(jobs)).toMatchObject({ total: 2, queued: 2 });
  });

  it("respects selected auth indexes and current filtered auth indexes", () => {
    const accounts = [
      account({ auth_index: "a", email: "a@example.com", status: "error", last_query_at: now }),
      account({ auth_index: "b", email: "b@example.com", status: "error", last_query_at: now }),
    ];

    expect(buildOAuthJobs({ accounts, hotmailAccounts: [], keeperRefreshFailureAuthIndexes: new Set(), scope: { kind: "selected", authIndexes: ["b"] }, now })).toHaveLength(1);
    expect(buildOAuthJobs({ accounts, hotmailAccounts: [], keeperRefreshFailureAuthIndexes: new Set(), scope: { kind: "filtered", authIndexes: ["a"] }, now })[0].authIndex).toBe("a");
  });
});
```

- [ ] **Step 2: Run targeted test and verify failure**

Run:

```bash
cd web && npm run test:run -- src/lib/oauth-jobs.test.ts
```

Expected: FAIL because `web/src/lib/oauth-jobs.ts` does not exist.

- [ ] **Step 3: Add Job and bridge types**

Modify `web/src/types.ts` with these exported types:

```ts
export type OAuthJobStatus =
  | "queued"
  | "session_clearing"
  | "oauth_started"
  | "email_submitting"
  | "code_polling"
  | "code_submitting"
  | "consent_submitting"
  | "callback_submitted"
  | "manual_required"
  | "failed";

export type OAuthJobErrorType = "retryable" | "manual" | "fatal";

export interface OAuthJob {
  jobId: string;
  authIndex: string;
  accountEmail: string;
  accountName: string;
  planType: string;
  hotmailId: string;
  hotmailEmail: string;
  status: OAuthJobStatus;
  attempt: 0 | 1;
  retryCount: number;
  startedAt: string | null;
  updatedAt: string;
  lockedByExtension: string;
  leaseExpiresAt: string | null;
  state: string;
  authUrl: string;
  callbackUrl: string;
  callbackSubmittedAt: string | null;
  oauthStatus: "pending" | "success" | "error" | "";
  oauthCheckedAt: string | null;
  oauthError: string;
  lastError: string;
  lastErrorType: OAuthJobErrorType | "";
  manualReason: string;
  lastPageSnapshot: Record<string, unknown> | null;
  lastCodeAt: string | null;
  rejectedCodeFingerprints: string[];
}

export interface OAuthQueueSummary {
  total: number;
  queued: number;
  running: number;
  callbackSubmitted: number;
  manualRequired: number;
  failed: number;
}
```

- [ ] **Step 4: Implement queue building and summary**

Create `web/src/lib/oauth-jobs.ts` with:

```ts
import { isOAuthReloginCandidate } from "./oauth";
import type { AccountItem, HotmailAccount, OAuthJob, OAuthQueueSummary } from "../types";

export const OAUTH_JOB_LEASE_MS = 2 * 60 * 1000;
export const OAUTH_JOB_ATTEMPT_TIMEOUT_MS = 5 * 60 * 1000;

export type OAuthQueueScope =
  | { kind: "all" }
  | { kind: "selected"; authIndexes: string[] }
  | { kind: "filtered"; authIndexes: string[] };

export function buildOAuthJobId(authIndex: string): string {
  return `oauth-job:${String(authIndex || "").trim()}`;
}

export function buildOAuthJobs(input: {
  accounts: AccountItem[];
  hotmailAccounts: HotmailAccount[];
  keeperRefreshFailureAuthIndexes: ReadonlySet<string>;
  scope: OAuthQueueScope;
  now: string;
}): OAuthJob[] {
  const scoped = new Set("authIndexes" in input.scope ? input.scope.authIndexes : []);
  const hotmailByEmail = new Map(input.hotmailAccounts.map((account) => [account.email.trim().toLowerCase(), account]));
  return input.accounts
    .filter((account) => isOAuthReloginCandidate(account, input.keeperRefreshFailureAuthIndexes))
    .filter((account) => input.scope.kind === "all" || scoped.has(account.auth_index))
    .map((account) => {
      const hotmail = hotmailByEmail.get(account.email.trim().toLowerCase());
      return {
        jobId: buildOAuthJobId(account.auth_index),
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
      } satisfies OAuthJob;
    });
}

export function summarizeOAuthJobs(jobs: OAuthJob[]): OAuthQueueSummary {
  return jobs.reduce<OAuthQueueSummary>(
    (summary, job) => {
      summary.total += 1;
      if (job.status === "queued") summary.queued += 1;
      if (!["queued", "callback_submitted", "manual_required", "failed"].includes(job.status)) summary.running += 1;
      if (job.status === "callback_submitted") summary.callbackSubmitted += 1;
      if (job.status === "manual_required") summary.manualRequired += 1;
      if (job.status === "failed") summary.failed += 1;
      return summary;
    },
    { total: 0, queued: 0, running: 0, callbackSubmitted: 0, manualRequired: 0, failed: 0 },
  );
}
```

- [ ] **Step 5: Add failing tests for claim, lease, callback, and errors**

Extend `oauth-jobs.test.ts`:

```ts
import {
  claimNextOAuthJob,
  recoverExpiredOAuthJobLeases,
  releaseOAuthJob,
  markOAuthJobCallbackSubmitted,
  markOAuthJobError,
} from "./oauth-jobs";

it("claims the next queued job with lease metadata", () => {
  const [job] = buildOAuthJobs({ accounts: [account({ status: "error", last_query_at: now })], hotmailAccounts: [], keeperRefreshFailureAuthIndexes: new Set(), scope: { kind: "all" }, now });
  const result = claimNextOAuthJob([job], "extension-1", Date.parse(now));
  expect(result.claimed?.lockedByExtension).toBe("extension-1");
  expect(result.claimed?.leaseExpiresAt).toBe("2026-05-09T01:02:00.000Z");
});

it("recovers expired leases deterministically", () => {
  const [job] = buildOAuthJobs({ accounts: [account({ status: "error", last_query_at: now })], hotmailAccounts: [], keeperRefreshFailureAuthIndexes: new Set(), scope: { kind: "all" }, now });
  const firstClaim = claimNextOAuthJob([job], "extension-1", Date.parse(now)).jobs[0];
  const recovered = recoverExpiredOAuthJobLeases([firstClaim], Date.parse("2026-05-09T01:03:00.000Z"))[0];
  expect(recovered).toMatchObject({ status: "queued", attempt: 1, retryCount: 1, lockedByExtension: "" });
});

it("marks callback submitted idempotently for the same callback url", () => {
  const [job] = buildOAuthJobs({ accounts: [account({ status: "error", last_query_at: now })], hotmailAccounts: [], keeperRefreshFailureAuthIndexes: new Set(), scope: { kind: "all" }, now });
  const first = markOAuthJobCallbackSubmitted({ ...job, state: "state-a" }, "http://localhost:1455/auth/callback?code=abc&state=state-a", now);
  const second = markOAuthJobCallbackSubmitted(first, "http://localhost:1455/auth/callback?code=abc&state=state-a", now);
  expect(second.status).toBe("callback_submitted");
  expect(second.callbackSubmittedAt).toBe(first.callbackSubmittedAt);
});

it("does not retry fatal errors", () => {
  const [job] = buildOAuthJobs({ accounts: [account({ status: "error", last_query_at: now })], hotmailAccounts: [], keeperRefreshFailureAuthIndexes: new Set(), scope: { kind: "all" }, now });
  expect(markOAuthJobError(job, { errorType: "fatal", code: "state_mismatch", message: "state mismatch" }, now)).toMatchObject({
    status: "failed",
    attempt: 0,
    lastError: "state_mismatch",
  });
});
```

- [ ] **Step 6: Implement state transitions**

Add these exports to `web/src/lib/oauth-jobs.ts`:

```ts
export function claimNextOAuthJob(jobs: OAuthJob[], extensionId: string, nowMs: number): { jobs: OAuthJob[]; claimed: OAuthJob | null } {
  const now = new Date(nowMs).toISOString();
  const leaseExpiresAt = new Date(nowMs + OAUTH_JOB_LEASE_MS).toISOString();
  let claimed: OAuthJob | null = null;
  const nextJobs = jobs.map((job) => {
    if (!claimed && job.status === "queued") {
      claimed = { ...job, status: "session_clearing", lockedByExtension: extensionId, leaseExpiresAt, startedAt: job.startedAt ?? now, updatedAt: now };
      return claimed;
    }
    return job;
  });
  return { jobs: nextJobs, claimed };
}
```

Also implement:

- `heartbeatOAuthJob(jobs, jobId, extensionId, nowMs)`
- `updateOAuthJob(jobs, jobId, patch, now)`
- `releaseOAuthJob(jobs, jobId, options, now)`
- `recoverExpiredOAuthJobLeases(jobs, nowMs)`
- `markOAuthJobCallbackSubmitted(job, callbackUrl, now)`; this helper stores only a redacted callback URL or stable fingerprint, never the raw OAuth `code`.
- `markOAuthJobError(job, error, now)`

Keep all functions pure and return new arrays/objects.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
cd web && npm run test:run -- src/lib/oauth-jobs.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add web/src/types.ts web/src/lib/oauth-jobs.ts web/src/lib/oauth-jobs.test.ts
git commit -m "feat: add oauth job state machine"
```

---

### Task 2: Web Queue Persistence

**Files:**
- Create: `web/src/lib/oauth-job-store.ts`
- Create: `web/src/lib/oauth-job-store.test.ts`

- [ ] **Step 1: Write failing storage tests**

Create `web/src/lib/oauth-job-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createOAuthJobStore } from "./oauth-job-store";
import type { OAuthJob } from "../types";

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("createOAuthJobStore", () => {
  it("saves and loads queue records without secret fields", () => {
    const storage = fakeStorage();
    const store = createOAuthJobStore(storage);
    const job = {
      jobId: "job-1",
      authIndex: "auth-1",
      accountEmail: "a@example.com",
      status: "queued",
      hotmailEmail: "a@example.com",
    } as OAuthJob;

    store.save([job]);
    expect(JSON.stringify(store.load())).toContain("a@example.com");
    expect(JSON.stringify(store.load())).not.toMatch(/refresh|password|123456/i);
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
cd web && npm run test:run -- src/lib/oauth-job-store.test.ts
```

Expected: FAIL because store file does not exist.

- [ ] **Step 3: Implement storage wrapper**

Create `web/src/lib/oauth-job-store.ts`:

```ts
import type { OAuthJob } from "../types";

export const OAUTH_JOB_STORE_KEY = "cpa_codex_quota_cache.oauth-jobs";

export interface OAuthJobStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
  removeItem(key: string): unknown;
}

function defaultStorage(): OAuthJobStorageLike | null {
  return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
}

export function createOAuthJobStore(storage: OAuthJobStorageLike | null = defaultStorage()) {
  return {
    load(): OAuthJob[] {
      if (!storage) return [];
      try {
        const raw = storage.getItem(OAUTH_JOB_STORE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? (parsed as OAuthJob[]) : [];
      } catch {
        return [];
      }
    },
    save(jobs: OAuthJob[]): boolean {
      if (!storage) return false;
      const safeJobs = jobs.map((job) => ({
        ...job,
        callbackUrl: redactOAuthCallbackUrl(job.callbackUrl),
        rejectedCodeFingerprints: job.rejectedCodeFingerprints ?? [],
      }));
      storage.setItem(OAUTH_JOB_STORE_KEY, JSON.stringify(safeJobs));
      return true;
    },
    clear(): boolean {
      if (!storage) return false;
      storage.removeItem(OAUTH_JOB_STORE_KEY);
      return true;
    },
  };
}
```

Add `redactOAuthCallbackUrl(value)` in this file or reuse a shared helper. It must preserve `state` and replace `code` with `[redacted]`.

Do not store Hotmail `password`, `refreshToken`, verification `code`, CPA key, cookies, or raw callback `code`. Keep raw callback URLs and raw verification codes only in memory for the current request. For idempotency, persist a redacted callback URL or callback fingerprint plus `callbackSubmittedAt`; do not persist raw `code`. For rejected verification codes, persist only non-reversible fingerprints if persistence is necessary, otherwise keep raw rejected codes in extension memory for the current attempt.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
cd web && npm run test:run -- src/lib/oauth-job-store.test.ts src/lib/oauth-jobs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add web/src/lib/oauth-job-store.ts web/src/lib/oauth-job-store.test.ts
git commit -m "feat: persist oauth job queue"
```

---

### Task 3: Global Web OAuth Bridge

**Files:**
- Create: `web/src/lib/oauth-bridge.ts`
- Create: `web/src/lib/oauth-bridge.test.ts`
- Create: `web/src/components/CodexOAuthBridge.tsx`
- Create: `web/src/components/CodexOAuthBridge.test.tsx`
- Modify: `web/src/components/CodexOAuthPanel.tsx`
- Modify: `web/src/components/CodexOAuthPanel.test.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Write failing bridge constants tests**

Create `web/src/lib/oauth-bridge.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OAUTH_BRIDGE_ACTIONS, createOAuthBridgeError } from "../lib/oauth-bridge";

it("exposes batch bridge capabilities", () => {
  expect(OAUTH_BRIDGE_ACTIONS).toEqual(expect.arrayContaining([
    "GET_CAPABILITIES",
    "BUILD_QUEUE",
    "GET_QUEUE",
    "CLAIM_JOB",
    "UPDATE_JOB",
    "START_JOB_OAUTH",
    "FETCH_CODE",
    "SUBMIT_CALLBACK",
    "CHECK_OAUTH_STATUS",
    "RELEASE_JOB",
  ]));
});

it("normalizes retryable errors", () => {
  expect(createOAuthBridgeError("retryable", "code_not_found", "未找到验证码")).toMatchObject({
    ok: false,
    errorType: "retryable",
    code: "code_not_found",
  });
});
```

- [ ] **Step 2: Write failing component tests for global bridge**

Create `web/src/components/CodexOAuthBridge.test.tsx` with test helpers that render `CodexOAuthBridge` without rendering `CodexOAuthPanel`, then post bridge requests:

```ts
window.postMessage({
  source: "cpa-codex-oauth-extension",
  type: "CPA_OAUTH_BRIDGE_REQUEST",
  requestId: "req-1",
  action: "GET_CAPABILITIES",
}, window.location.origin);
```

Expect response:

```ts
expect(response).toMatchObject({
  source: "cpa-codex-oauth-page",
  type: "CPA_OAUTH_BRIDGE_RESPONSE",
  requestId: "req-1",
  ok: true,
  result: { version: 2 },
});
```

Also test:

- `BUILD_QUEUE` creates queued Jobs from all invalid accounts.
- `CLAIM_JOB` locks the first queued Job and returns `leaseExpiresAt`.
- `SUBMIT_CALLBACK` marks a Job `callback_submitted` before returning success.
- Repeating `SUBMIT_CALLBACK` with the same URL is idempotent.
- `CHECK_OAUTH_STATUS` updates `oauthStatus` and does not change `status` away from `callback_submitted`.

- [ ] **Step 3: Run targeted tests and verify failure**

Run:

```bash
cd web && npm run test:run -- src/lib/oauth-bridge.test.ts src/components/CodexOAuthBridge.test.tsx src/components/CodexOAuthPanel.test.tsx
```

Expected: FAIL because `CodexOAuthBridge` and new actions do not exist.

- [ ] **Step 4: Implement bridge constants**

Create `web/src/lib/oauth-bridge.ts`:

```ts
export const OAUTH_BRIDGE_REQUEST_SOURCE = "cpa-codex-oauth-extension";
export const OAUTH_BRIDGE_RESPONSE_SOURCE = "cpa-codex-oauth-page";
export const OAUTH_BRIDGE_REQUEST_TYPE = "CPA_OAUTH_BRIDGE_REQUEST";
export const OAUTH_BRIDGE_RESPONSE_TYPE = "CPA_OAUTH_BRIDGE_RESPONSE";
export const OAUTH_BRIDGE_VERSION = 2;

export const OAUTH_BRIDGE_ACTIONS = [
  "GET_CAPABILITIES",
  "GET_ACCOUNT_POOLS",
  "BUILD_QUEUE",
  "GET_QUEUE",
  "CLAIM_JOB",
  "UPDATE_JOB",
  "START_JOB_OAUTH",
  "FETCH_CODE",
  "SUBMIT_CALLBACK",
  "CHECK_OAUTH_STATUS",
  "RELEASE_JOB",
] as const;
```

Include `createOAuthBridgeError(errorType, code, message, extra?)` and `postOAuthBridgeResponse(request, body)`.

- [ ] **Step 5: Implement `CodexOAuthBridge`**

Create `web/src/components/CodexOAuthBridge.tsx` as a headless component. It should:

- Listen for bridge requests globally.
- Use queue helpers from `oauth-jobs.ts`.
- Persist queue after every mutation through `createOAuthJobStore`.
- Use existing API callbacks supplied from `App.tsx`:
  - `onStartOAuth`
  - `onSubmitOAuthCallback`
  - `onPollOAuthStatus`
  - `onFetchHotmailCode`
  - `onSettingsChange`
- Return only safe Hotmail fields to the extension: `id`, `email`, `clientId`, `status`, `lastCodeAt`, `lastError`, `hasRefreshToken`. Do not return `password` or `refreshToken` from batch RPCs.
- Keep legacy `GET_ACCOUNT_POOLS` available for current side panel read-only display, but prefer safe fields there too.

Core action behavior:

- `GET_CAPABILITIES`: return version and actions.
- `BUILD_QUEUE`: build Jobs from `all`, `selected`, or `filtered` scope.
- `GET_QUEUE`: return queue summary and Job list.
- `CLAIM_JOB`: recover expired leases first, then claim first queued Job.
- `UPDATE_JOB`: heartbeat and status patch for a locked Job.
- `START_JOB_OAUTH`: validate Job identity, call `onStartOAuth`, store `authUrl` and `state`.
- `FETCH_CODE`: validate Job and Hotmail match, call `onFetchHotmailCode`, persist updated Hotmail settings through existing callback, return retryable `code_not_found` when no code is found.
- `SUBMIT_CALLBACK`: validate `state`, call `markOAuthJobCallbackSubmitted` before returning success, then call `onSubmitOAuthCallback`; if remote submission fails, mark fatal and return fatal.
- `CHECK_OAUTH_STATUS`: call `onPollOAuthStatus`, update `oauthStatus`, `oauthCheckedAt`, and `oauthError`.
- `RELEASE_JOB`: clear lock; default to `queued`, or `failed` when payload requests failure.

- [ ] **Step 6: Move bridge out of `CodexOAuthPanel`**

Modify `web/src/components/CodexOAuthPanel.tsx`:

- Remove the old `useEffect` bridge listener or gate it behind compatibility only if tests require a transition.
- Keep UI actions (`发起 OAuth登录`, `获取 Hotmail 验证码`, manual callback) functional through existing props.
- Accept queue props from `App`:

```ts
queueJobs: OAuthJob[];
queueSummary: OAuthQueueSummary;
onBuildQueue: (scope: OAuthQueueScope) => void;
onClearQueue: () => void;
```

- [ ] **Step 7: Wire `App.tsx`**

Modify `web/src/App.tsx`:

- Load queue from `createOAuthJobStore()` on startup.
- Store queue in React state.
- Render `CodexOAuthBridge` near the top-level page body, not only under `activePage === "oauth"`.
- Pass allItems, settings, keeper failure set, and API callbacks to the bridge.
- Pass queue props to `CodexOAuthPanel`.

- [ ] **Step 8: Run targeted tests**

Run:

```bash
cd web && npm run test:run -- src/lib/oauth-bridge.test.ts src/components/CodexOAuthBridge.test.tsx src/components/CodexOAuthPanel.test.tsx src/lib/oauth-jobs.test.ts src/lib/oauth-job-store.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add web/src/lib/oauth-bridge.ts web/src/lib/oauth-bridge.test.ts web/src/components/CodexOAuthBridge.tsx web/src/components/CodexOAuthBridge.test.tsx web/src/components/CodexOAuthPanel.tsx web/src/components/CodexOAuthPanel.test.tsx web/src/App.tsx
git commit -m "feat: add global oauth job bridge"
```

---

### Task 4: Web OAuth Queue UI

**Files:**
- Modify: `web/src/components/CodexOAuthPanel.tsx`
- Modify: `web/src/components/CodexOAuthPanel.test.tsx`
- Modify: `web/src/styles.css`
- Modify: `README.md`

- [ ] **Step 1: Write failing UI tests**

Extend `CodexOAuthPanel.test.tsx`:

```ts
it("renders queue controls and separates callback submitted from OAuth success", () => {
  render(<CodexOAuthPanel {...propsWithQueue} />);
  expect(screen.getByRole("button", { name: /全部失效账号生成队列/ })).toBeInTheDocument();
  expect(screen.getByText(/callback 已提交/)).toBeInTheDocument();
  expect(screen.queryByText(/额度已恢复/)).not.toBeInTheDocument();
});
```

Also test selected and filtered queue build buttons call `onBuildQueue` with the expected scope.

- [ ] **Step 2: Run UI tests and verify failure**

Run:

```bash
cd web && npm run test:run -- src/components/CodexOAuthPanel.test.tsx
```

Expected: FAIL until UI is added.

- [ ] **Step 3: Implement queue panel**

In `CodexOAuthPanel.tsx`, add a queue section near the top:

- Buttons:
  - `全部失效账号生成队列`
  - `勾选账号生成队列`
  - `当前筛选结果生成队列`
  - `清空队列`
- Summary counters:
  - 待处理
  - 运行中
  - callback 已提交
  - OAuth success
  - 需人工
  - failed
- Job list columns:
  - 邮箱
  - Hotmail 匹配
  - 状态
  - 尝试
  - 最近错误
  - OAuth 后验状态
  - 更新时间

Do not show Hotmail password, refresh token, or verification code in the Job table.

- [ ] **Step 4: Style the queue panel**

Modify `web/src/styles.css` using existing dark dashboard conventions:

- Reuse existing panel/card tokens.
- Keep controls compact.
- Ensure the queue section is usable at the current 127.0.0.1:5173 desktop viewport.
- Do not add floating hero/marketing sections.

- [ ] **Step 5: Update README**

Modify `README.md`:

- Add "Codex OAuth 批量恢复" usage section.
- Explain invalid-account sources:
  - quota query status is `error` after a query
  - Keeper refresh certificate failure
- Explain callback submitted vs OAuth success.
- Explain extension permissions and local app tab requirement.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
cd web && npm run test:run -- src/components/CodexOAuthPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add web/src/components/CodexOAuthPanel.tsx web/src/components/CodexOAuthPanel.test.tsx web/src/styles.css README.md
git commit -m "feat: add oauth queue management UI"
```

---

### Task 5: Extension Permissions and Session Clearing

**Files:**
- Modify: `browser-extension/codex-oauth-auto-login/manifest.json`
- Modify: `browser-extension/codex-oauth-auto-login/background-core.js`
- Modify: `browser-extension/codex-oauth-auto-login/tests/background-core.test.js`
- Modify: `browser-extension/codex-oauth-auto-login/tests/manifest.test.js`

- [ ] **Step 1: Write failing manifest tests**

Extend `tests/manifest.test.js`:

```js
test('manifest grants exact OpenAI session clearing hosts without all urls', () => {
  const manifest = readManifest();
  assert.equal(manifest.host_permissions.includes('<all_urls>'), false);
  for (const host of [
    'https://auth.openai.com/*',
    'https://auth0.openai.com/*',
    'https://accounts.openai.com/*',
    'https://chatgpt.com/*',
    'https://chat.openai.com/*',
    'https://platform.openai.com/*',
    'https://openai.com/*',
  ]) {
    assert.equal(manifest.host_permissions.includes(host), true);
  }
  assert.equal(manifest.permissions.includes('cookies'), true);
  assert.equal(manifest.permissions.includes('browsingData'), true);
});
```

- [ ] **Step 2: Write failing core tests**

Extend `tests/background-core.test.js`:

```js
test('builds OpenAI session clearing origins', () => {
  assert.deepEqual(core.OPENAI_CLEAR_ORIGINS, [
    'https://auth.openai.com',
    'https://auth0.openai.com',
    'https://accounts.openai.com',
    'https://chatgpt.com',
    'https://chat.openai.com',
    'https://platform.openai.com',
    'https://openai.com',
  ]);
});
```

- [ ] **Step 3: Run extension tests and verify failure**

Run:

```bash
node --test browser-extension/codex-oauth-auto-login/tests/*.test.js
```

Expected: FAIL until permissions/core constants are updated.

- [ ] **Step 4: Update manifest**

Modify `manifest.json`:

- Add permissions: `cookies`, `browsingData`.
- Add exact host permissions from the spec.
- Ensure content scripts still match OpenAI auth domains and local app domains.
- Do not add `<all_urls>`.

- [ ] **Step 5: Implement clearing helpers**

Modify `background-core.js`:

```js
const OPENAI_CLEAR_ORIGINS = [
  'https://auth.openai.com',
  'https://auth0.openai.com',
  'https://accounts.openai.com',
  'https://chatgpt.com',
  'https://chat.openai.com',
  'https://platform.openai.com',
  'https://openai.com',
];
```

Export:

- `OPENAI_CLEAR_ORIGINS`
- `OPENAI_RELATED_HOSTS`
- `isOpenAIRelatedUrl(value)`
- `buildOpenAISessionRemovalOptions()`

- [ ] **Step 6: Run extension tests**

Run:

```bash
node --test browser-extension/codex-oauth-auto-login/tests/*.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add browser-extension/codex-oauth-auto-login/manifest.json browser-extension/codex-oauth-auto-login/background-core.js browser-extension/codex-oauth-auto-login/tests/background-core.test.js browser-extension/codex-oauth-auto-login/tests/manifest.test.js
git commit -m "feat: add openai session clearing permissions"
```

---

### Task 6: Extension Batch Executor

**Files:**
- Create: `browser-extension/codex-oauth-auto-login/background-batch-core.js`
- Create: `browser-extension/codex-oauth-auto-login/tests/background-batch-core.test.js`
- Modify: `browser-extension/codex-oauth-auto-login/background.js`
- Modify: `browser-extension/codex-oauth-auto-login/content-openai.js`
- Modify: `browser-extension/codex-oauth-auto-login/tests/content-openai.test.js`

- [ ] **Step 1: Write failing batch core tests**

Create `tests/background-batch-core.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const batch = require('../background-batch-core.js');

test('classifies bridge errors', () => {
  assert.equal(batch.classifyBridgeError({ errorType: 'retryable', code: 'code_not_found' }).errorType, 'retryable');
  assert.equal(batch.classifyBridgeError({ errorType: 'manual', code: 'captcha' }).errorType, 'manual');
  assert.equal(batch.classifyBridgeError({ errorType: 'fatal', code: 'state_mismatch' }).errorType, 'fatal');
});

test('manual errors retry once then become manual_required', () => {
  assert.deepEqual(batch.nextFailureAction({ attempt: 0, errorType: 'manual' }), { action: 'retry_job' });
  assert.deepEqual(batch.nextFailureAction({ attempt: 1, errorType: 'manual' }), { action: 'mark_manual_required' });
});

test('account email mismatch retries once then fails deterministically', () => {
  assert.deepEqual(batch.nextFailureAction({ attempt: 0, errorType: 'account_email_mismatch' }), { action: 'retry_job' });
  assert.deepEqual(batch.nextFailureAction({ attempt: 1, errorType: 'account_email_mismatch' }), {
    action: 'mark_failed',
    lastError: 'account_email_mismatch',
  });
});

test('fatal errors fail immediately', () => {
  assert.deepEqual(batch.nextFailureAction({ attempt: 0, errorType: 'fatal' }), { action: 'mark_failed' });
});
```

- [ ] **Step 2: Write failing content helper test for account-email verification**

Extend `tests/content-openai.test.js`:

```js
test('reads account email from consent page text', () => {
  const doc = createDocument('<main><p>Authorize Codex for user@example.com</p><button>Authorize</button></main>');
  assert.equal(openai.readEmailValue(doc), 'user@example.com');
});
```

- [ ] **Step 3: Run extension tests and verify failure**

Run:

```bash
node --test browser-extension/codex-oauth-auto-login/tests/*.test.js
```

Expected: FAIL until new core file and helper changes exist.

- [ ] **Step 4: Implement batch core helpers**

Create `background-batch-core.js`:

```js
(function attachCpaCodexOAuthBatchCore(root, factory) {
  const api = factory();
  root.CpaCodexOAuthBatchCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function createBatchCore() {
  function classifyBridgeError(error = {}) {
    const errorType = ['retryable', 'manual', 'fatal'].includes(error.errorType) ? error.errorType : 'fatal';
    return { errorType, code: String(error.code || 'unknown_error'), message: String(error.message || error.error || 'Unknown error') };
  }

  function nextFailureAction({ attempt, errorType }) {
    if (errorType === 'account_email_mismatch') {
      return Number(attempt) === 0 ? { action: 'retry_job' } : { action: 'mark_failed', lastError: 'account_email_mismatch' };
    }
    if (errorType === 'fatal') return { action: 'mark_failed' };
    if (errorType === 'manual') return Number(attempt) === 0 ? { action: 'retry_job' } : { action: 'mark_manual_required' };
    return Number(attempt) === 0 ? { action: 'retry_job' } : { action: 'mark_failed' };
  }

  return { classifyBridgeError, nextFailureAction };
});
```

- [ ] **Step 5: Implement OpenAI session clearing in background**

In `background.js`, add:

```js
async function clearOpenAISessionState() {
  const options = core.buildOpenAISessionRemovalOptions();
  if (chrome.browsingData?.remove) {
    await chromeCallback((done) => chrome.browsingData.remove(options.origins, options.dataToRemove, done));
  }
}
```

Use the real shape expected by Chrome:

```js
chrome.browsingData.remove({ origins: core.OPENAI_CLEAR_ORIGINS }, {
  cacheStorage: true,
  cookies: true,
  fileSystems: true,
  indexedDB: true,
  localStorage: true,
  serviceWorkers: true,
  webSQL: true,
});
```

Fallback to `chrome.cookies.getAll`/`chrome.cookies.remove` per origin when `browsingData` is unavailable.

- [ ] **Step 6: Refactor single-account execution into one Job attempt**

In `background.js`:

- Keep existing helper functions (`callCpaBridge`, `classifyOpenAI`, `handleOpenAIState`) reusable.
- Add `runSingleJobAttempt(run, job)`:
  - `UPDATE_JOB` to `session_clearing`
  - clear OpenAI session
  - `START_JOB_OAUTH`
  - create auth tab
  - loop for 5 minutes
  - fill email from `job.accountEmail`
  - verify consent page email matches `job.accountEmail` before clicking consent
  - fetch code through `FETCH_CODE` with `jobId`, `expectedEmail`, `state`, `filterAfterTimestamp`, `excludeCodes`
  - submit callback through `SUBMIT_CALLBACK`
  - return success immediately after callback submit

Account email mismatch is not a generic fatal error. If the consent page or account page exposes an email that differs from `job.accountEmail`, do not click consent. For `attempt=0`, close the auth tab, clear OpenAI session state, and release/requeue the Job for `attempt=1` with error code `account_email_mismatch`. For `attempt=1`, call `UPDATE_JOB` or `RELEASE_JOB` so the Web Job becomes `failed` with `lastError=account_email_mismatch`.

- [ ] **Step 7: Add batch main loop**

In `background.js`, replace `startAutoLogin` internals or add `START_BATCH_LOGIN`:

- Find local CPA tab.
- `GET_CAPABILITIES`, require version `>= 2`.
- Loop until stopped:
  - `CLAIM_JOB`
  - if no Job, mark done
  - run one Job attempt
  - heartbeat every 30 seconds while running
  - on manual/retryable/fatal, call `UPDATE_JOB` or `RELEASE_JOB` according to `background-batch-core.js`
  - continue next Job
- Preserve existing `START_AUTO_LOGIN` as alias for batch start if no single-account mode is needed.

- [ ] **Step 8: Implement pause/resume/stop behavior**

In `background.js` runtime message handler:

- `PAUSE_BATCH`: set `pauseRequested`, finish current Job, do not claim next.
- `RESUME_BATCH`: continue claiming.
- `STOP_BATCH`: set `stopRequested`, close auth tab, call `RELEASE_JOB` for current Job with default `queued`.
- `GET_STATUS`: include queue summary and current Job if available.

- [ ] **Step 9: Run extension tests**

Run:

```bash
node --test browser-extension/codex-oauth-auto-login/tests/*.test.js
```

Expected: PASS.

- [ ] **Step 10: Commit Task 6**

```bash
git add browser-extension/codex-oauth-auto-login/background-batch-core.js browser-extension/codex-oauth-auto-login/tests/background-batch-core.test.js browser-extension/codex-oauth-auto-login/background.js browser-extension/codex-oauth-auto-login/content-openai.js browser-extension/codex-oauth-auto-login/tests/content-openai.test.js
git commit -m "feat: add oauth batch executor"
```

---

### Task 7: Extension Side Panel Batch UI

**Files:**
- Modify: `browser-extension/codex-oauth-auto-login/sidepanel.html`
- Modify: `browser-extension/codex-oauth-auto-login/sidepanel.js`
- Modify: `browser-extension/codex-oauth-auto-login/sidepanel.css`
- Modify: `browser-extension/codex-oauth-auto-login/README.md`

- [ ] **Step 1: Define side panel status contract**

Document in `sidepanel.js` comments or helper names the expected status shape:

```js
{
  phase: 'idle' | 'running' | 'paused' | 'done' | 'error' | 'manual_required',
  running: boolean,
  currentJob: { jobId, accountEmail, status, attempt, lastError },
  queueSummary: { total, queued, running, callbackSubmitted, manualRequired, failed },
  recentErrors: []
}
```

- [ ] **Step 2: Update controls**

Modify `sidepanel.html`:

- `读取账号池`
- `生成/刷新队列`
- `开始全部`
- `暂停`
- `继续`
- `停止`

Keep the side panel model, not a floating overlay.

- [ ] **Step 3: Render queue progress**

Modify `sidepanel.js`:

- Poll `GET_STATUS`.
- Call background messages:
  - `READ_ACCOUNT_POOLS`
  - `BUILD_QUEUE`
  - `START_BATCH_LOGIN`
  - `PAUSE_BATCH`
  - `RESUME_BATCH`
  - `STOP_BATCH`
- Render queue stats, current Job, and recent errors.
- Never render Hotmail password or refresh token.

- [ ] **Step 4: Style compactly**

Modify `sidepanel.css`:

- Keep readable card sections.
- Use compact rows for queue stats.
- Avoid hidden overflow that prevents seeing current errors.

- [ ] **Step 5: Update extension README**

Document:

- Load unpacked extension.
- Open local CPA Codex app tab first.
- Build queue from Web OAuth page or extension side panel.
- Start batch.
- Expected statuses.
- Permission rationale for OpenAI-related domain clearing.

- [ ] **Step 6: Run extension tests**

Run:

```bash
node --test browser-extension/codex-oauth-auto-login/tests/*.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

```bash
git add browser-extension/codex-oauth-auto-login/sidepanel.html browser-extension/codex-oauth-auto-login/sidepanel.js browser-extension/codex-oauth-auto-login/sidepanel.css browser-extension/codex-oauth-auto-login/README.md
git commit -m "feat: add oauth batch side panel"
```

---

### Task 8: Full Verification and Docs

**Files:**
- Modify: `README.md`
- Modify: `browser-extension/codex-oauth-auto-login/README.md`
- Modify: `docs/superpowers/plans/2026-05-09-codex-oauth-batch-extension.md` only if implementation discovers plan drift.

- [ ] **Step 1: Run Web targeted tests**

Run:

```bash
cd web && npm run test:run -- src/lib/oauth-jobs.test.ts src/lib/oauth-job-store.test.ts src/lib/oauth-bridge.test.ts src/components/CodexOAuthBridge.test.tsx src/components/CodexOAuthPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run full Web tests**

Run:

```bash
cd web && npm run test:run
```

Expected: PASS.

- [ ] **Step 3: Run Web typecheck and build**

Run:

```bash
cd web && npm run typecheck
cd web && npm run build
```

Expected: PASS.

- [ ] **Step 4: Run extension tests**

Run:

```bash
node --test browser-extension/codex-oauth-auto-login/tests/*.test.js
```

Expected: PASS.

- [ ] **Step 5: Manual smoke test**

Run local app:

```bash
cd web && npm run dev -- --host 127.0.0.1
```

Expected:

- App opens at `http://127.0.0.1:5173/` or next available Vite port.
- OAuth page can build a queue.
- Extension side panel can read queue counts.
- Starting batch claims one Job.
- If OpenAI page hits CAPTCHA/MFA/phone verification, the Job retries once and then moves to `manual_required`.
- Callback submission moves the Job to `callback_submitted` and immediately claims next Job.
- `CHECK_OAUTH_STATUS` updates `oauthStatus` without running quota query.

- [ ] **Step 6: Sensitive information check**

Run:

```bash
rg -n "refreshToken|refresh_token|password|client_secret|authorization|cookie|157526|744357|780533" README.md browser-extension web/src docs/superpowers/plans/2026-05-09-codex-oauth-batch-extension.md
```

Expected:

- Only type/property names and documented redaction guidance appear.
- No real Hotmail password, refresh token, OAuth callback `code`, cookie, or CPA key appears.

- [ ] **Step 7: Final commit**

```bash
git status --short
git add README.md browser-extension/codex-oauth-auto-login/README.md
git commit -m "docs: update oauth batch recovery docs"
```

Only commit files changed by the current task. Do not stage unrelated dirty files from other work.

---

## Subagent Assignment Guidance

- Worker A: Task 1 and Task 2. Own only `web/src/types.ts`, `web/src/lib/oauth-jobs.ts`, `web/src/lib/oauth-jobs.test.ts`, `web/src/lib/oauth-job-store.ts`, `web/src/lib/oauth-job-store.test.ts`.
- Worker B: Task 5. Own only `browser-extension/codex-oauth-auto-login/manifest.json`, `background-core.js`, and related tests.
- Worker C: Task 3. Start after Worker A finishes Tasks 1 and 2. Own bridge files, `App.tsx`, and only the bridge extraction/props wiring portions of `CodexOAuthPanel.tsx`.
- Worker D: Task 6. Start after Worker B and Worker C finish. Own `background.js`, `background-batch-core.js`, `content-openai.js`, and related tests.
- Worker E: Task 4 starts only after Worker C lands Task 3. Own OAuth queue UI additions in `CodexOAuthPanel.tsx`, `styles.css`, and docs. Task 7 starts only after Worker D lands Task 6.

Workers are not alone in the codebase. Do not revert edits made by other workers; adapt to existing changes and keep file ownership boundaries tight.

## Risk Controls

- Keep callback submission idempotent. Repeated same callback URL must not duplicate remote submission or queue advancement.
- Treat fatal errors as final immediately; do not retry fatal.
- Clear only the listed OpenAI-related origins; do not use `<all_urls>`.
- Do not store Hotmail passwords, refresh tokens, verification codes, cookies, or CPA keys in extension persistent storage.
- Do not mark quota restored. This flow checks OAuth status only.
