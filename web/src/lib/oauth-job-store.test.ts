import { describe, expect, it } from "vitest";
import type { OAuthJob } from "../types";
import { createOAuthJobStore, OAUTH_JOB_STORE_KEY, type OAuthJobStorageLike } from "./oauth-job-store";

const NOW = "2026-05-09T01:00:00.000Z";

class FakeStorage implements OAuthJobStorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
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
    state: "state-a",
    authUrl: "https://app.example/oauth/start?state=state-a",
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

describe("createOAuthJobStore", () => {
  it("saves, loads, and clears jobs with storage", () => {
    const storage = new FakeStorage();
    const store = createOAuthJobStore(storage);
    const jobs = [makeJob()];

    expect(store.save(jobs)).toBe(true);
    expect(store.load()).toEqual(jobs);

    expect(store.clear()).toBe(true);
    expect(storage.getItem(OAUTH_JOB_STORE_KEY)).toBeNull();
    expect(store.load()).toEqual([]);
  });

  it("returns safe results when storage is unavailable", () => {
    const store = createOAuthJobStore(null);

    expect(store.load()).toEqual([]);
    expect(store.save([makeJob()])).toBe(false);
    expect(store.clear()).toBe(false);
  });

  it("returns an empty queue for bad JSON", () => {
    const storage = new FakeStorage();
    storage.setItem(OAUTH_JOB_STORE_KEY, "{not-json");

    expect(createOAuthJobStore(storage).load()).toEqual([]);
  });

  it("redacts raw callback codes before writing JSON", () => {
    const storage = new FakeStorage();
    const store = createOAuthJobStore(storage);
    const rawCode = "raw-callback-code-123";

    expect(
      store.save([
        makeJob({
          callbackUrl: `https://app.example/oauth/callback?code=${rawCode}&state=state-a`,
        }),
      ]),
    ).toBe(true);

    const stored = storage.getItem(OAUTH_JOB_STORE_KEY) ?? "";
    expect(stored).not.toContain(rawCode);
    expect(stored).toContain("code=%5Bredacted%5D");
    expect(stored).toContain("state-a");
    expect(store.load()[0].callbackUrl).toContain("code=%5Bredacted%5D");
  });

  it("redacts raw OAuth callback codes from URL fragments", () => {
    const storage = new FakeStorage();
    const rawCode = "raw-callback-code-123";
    const fragment = `#code=${rawCode}&state=state-a`;
    const store = createOAuthJobStore(storage);

    expect(
      store.save([
        makeJob({
          callbackUrl: `https://app.example/oauth/callback${fragment}`,
          authUrl: `https://app.example/oauth/start${fragment}`,
          oauthError: `redirected to https://app.example/oauth/callback${fragment}`,
        }),
      ]),
    ).toBe(true);

    const stored = storage.getItem(OAUTH_JOB_STORE_KEY) ?? "";
    expect(stored).not.toContain(rawCode);
    expect(decodeURIComponent(stored)).toContain("#code=[redacted]&state=state-a");

    const [storedJob] = store.load();
    expect(decodeURIComponent(storedJob.callbackUrl)).toContain("#code=[redacted]&state=state-a");
    expect(decodeURIComponent(storedJob.authUrl)).toContain("#code=[redacted]&state=state-a");
    expect(decodeURIComponent(storedJob.oauthError)).toContain("#code=[redacted]&state=state-a");
  });

  it("redacts URL username and password userinfo from stored text", () => {
    const storage = new FakeStorage();
    const username = "access-token";
    const password = "secret";
    const urlWithUserinfo = `https://${username}:${password}@example.com/callback?state=s`;

    expect(
      createOAuthJobStore(storage).save([
        makeJob({
          authUrl: urlWithUserinfo,
          oauthError: `redirected to ${urlWithUserinfo}`,
          lastPageSnapshot: {
            body: `snapshot ${urlWithUserinfo}`,
          },
        }),
      ]),
    ).toBe(true);

    const stored = storage.getItem(OAUTH_JOB_STORE_KEY) ?? "";
    expect(stored).not.toContain(username);
    expect(stored).not.toContain(password);

    const [storedJob] = JSON.parse(stored) as OAuthJob[];
    expect(decodeURIComponent(storedJob.authUrl)).toContain("https://[redacted]:[redacted]@example.com/callback?state=s");
    expect(decodeURIComponent(storedJob.oauthError)).toContain("https://[redacted]:[redacted]@example.com/callback?state=s");
    expect(decodeURIComponent(String(storedJob.lastPageSnapshot?.body))).toContain(
      "https://[redacted]:[redacted]@example.com/callback?state=s",
    );
  });

  it("does not persist accidental secret fields mixed into job objects", () => {
    const storage = new FakeStorage();
    const jobWithSecrets = {
      ...makeJob(),
      password: "hotmail-password",
      refreshToken: "hotmail-refresh-token",
      lastCode: "verification-code",
      managementKey: "cpa-management-key",
      cookie: "session-cookie",
    };

    expect(createOAuthJobStore(storage).save([jobWithSecrets])).toBe(true);

    const stored = storage.getItem(OAUTH_JOB_STORE_KEY) ?? "";
    expect(stored).not.toContain("hotmail-password");
    expect(stored).not.toContain("hotmail-refresh-token");
    expect(stored).not.toContain("verification-code");
    expect(stored).not.toContain("cpa-management-key");
    expect(stored).not.toContain("session-cookie");
  });

  it("redacts sensitive values embedded in whitelisted text fields and page snapshots", () => {
    const storage = new FakeStorage();
    const refreshToken = "refresh-token-secret-abc";
    const authorization = "Bearer authorization-secret-abc";
    const cookie = "sid=cookie-secret-abc";
    const callbackCode = "callback-code-secret-abc";
    const cpaKey = "cpa-key-secret-abc";
    const apiKey = "api-key-secret-abc";
    const stateToken = "state-token-secret-abc";
    const nestedToken = "nested-token-secret-abc";
    const verificationCode = "654321";

    const job = makeJob({
      oauthError: `refresh_token=${refreshToken} authorization: ${authorization}`,
      lastError: `apiKey=${apiKey}`,
      manualReason: `Cookie: ${cookie}; callbackCode=${callbackCode}; verification_code=${verificationCode}`,
      authUrl: `https://app.example/oauth/start?state=state-a&refresh_token=${refreshToken}&code=${callbackCode}&cpaKey=${cpaKey}`,
      state: `state-a token=${stateToken}`,
      lastPageSnapshot: {
        refresh_token: refreshToken,
        verification_code: verificationCode,
        cpaKey,
        authorization,
        Cookie: cookie,
        callbackCode,
        nested: {
          api_key: apiKey,
          note: `verification ${verificationCode} token=${nestedToken}`,
        },
        list: [{ secret_token: nestedToken }, `authorization: ${authorization}`],
        safe: "visible note",
      },
    });

    expect(createOAuthJobStore(storage).save([job])).toBe(true);

    const stored = storage.getItem(OAUTH_JOB_STORE_KEY) ?? "";
    for (const secret of [refreshToken, authorization, cookie, callbackCode, cpaKey, apiKey, stateToken, nestedToken, verificationCode]) {
      expect(stored).not.toContain(secret);
    }

    const [storedJob] = JSON.parse(stored) as OAuthJob[];
    expect(decodeURIComponent(storedJob.authUrl)).toContain("code=[redacted]");
    expect(storedJob.state).toBe("state-a token=[redacted]");
    expect(storedJob.oauthError).toBe("refresh_token=[redacted] authorization: [redacted]");
    expect(storedJob.manualReason).toBe("Cookie: [redacted]");
    expect(storedJob.lastPageSnapshot).toEqual({
      refresh_token: "[redacted]",
      verification_code: "[redacted]",
      cpaKey: "[redacted]",
      authorization: "[redacted]",
      Cookie: "[redacted]",
      callbackCode: "[redacted]",
      nested: {
        api_key: "[redacted]",
        note: "verification [redacted-code] token=[redacted]",
      },
      list: [{ secret_token: "[redacted]" }, "authorization: [redacted]"],
      safe: "visible note",
    });
  });

  it("redacts spaced sensitive key-value phrases while keeping safe text readable", () => {
    const storage = new FakeStorage();
    const cpaSecret = "cpa-secret";
    const managementSecret = "mgmt-secret";
    const refreshSecret = "refresh-secret";
    const verificationSecret = "123456";

    const job = makeJob({
      oauthError: `OAuth failed with CPA key: ${cpaSecret}`,
      lastError: `management key = ${managementSecret}`,
      manualReason: `refresh token: ${refreshSecret}`,
      state: `state-a verification code: ${verificationSecret}`,
      lastPageSnapshot: {
        message: `CPA key: ${cpaSecret}; management key = ${managementSecret}; refresh token: ${refreshSecret}; verification code: ${verificationSecret}`,
        safe: "visible safe context",
      },
    });

    expect(createOAuthJobStore(storage).save([job])).toBe(true);

    const stored = storage.getItem(OAUTH_JOB_STORE_KEY) ?? "";
    for (const secret of [cpaSecret, managementSecret, refreshSecret, verificationSecret]) {
      expect(stored).not.toContain(secret);
    }

    const [storedJob] = JSON.parse(stored) as OAuthJob[];
    expect(storedJob.oauthError).toBe("OAuth failed with CPA key: [redacted]");
    expect(storedJob.lastError).toBe("management key = [redacted]");
    expect(storedJob.manualReason).toBe("refresh token: [redacted]");
    expect(storedJob.state).toBe("state-a verification code: [redacted]");
    expect(storedJob.lastPageSnapshot).toEqual({
      message: "CPA key: [redacted]; management key = [redacted]; refresh token: [redacted]; verification code: [redacted]",
      safe: "visible safe context",
    });
  });

  it("redacts JSON-style quoted sensitive keys in free-text fields while keeping safe JSON readable", () => {
    const storage = new FakeStorage();
    const refreshSecret = "json-refresh-secret";
    const passwordSecret = "json-password-secret";
    const verificationSecret = "123456";
    const cpaSecret = "json-cpa-secret";
    const cookieSecret = "json-cookie-secret";
    const singleQuoteSecret = "single-quote-refresh-secret";

    const job = makeJob({
      oauthError: `{"refreshToken":"${refreshSecret}","safe":"visible value"}`,
      lastError: `{"password":"${passwordSecret}","status":"failed"}`,
      manualReason: `{"verificationCode":"${verificationSecret}","safeReason":"manual check"}`,
      state: `{"CPA key":"${cpaSecret}","state":"state-a"}`,
      lastPageSnapshot: {
        body: `{"refresh_token": "${refreshSecret}", "Cookie":"${cookieSecret}", 'refreshToken':'${singleQuoteSecret}', "safe":"visible body"}`,
        safe: "{\"message\":\"visible safe json\"}",
      },
    });

    expect(createOAuthJobStore(storage).save([job])).toBe(true);

    const stored = storage.getItem(OAUTH_JOB_STORE_KEY) ?? "";
    for (const secret of [refreshSecret, passwordSecret, verificationSecret, cpaSecret, cookieSecret, singleQuoteSecret]) {
      expect(stored).not.toContain(secret);
    }

    const [storedJob] = JSON.parse(stored) as OAuthJob[];
    expect(storedJob.oauthError).toBe('{"refreshToken":"[redacted]","safe":"visible value"}');
    expect(storedJob.lastError).toBe('{"password":"[redacted]","status":"failed"}');
    expect(storedJob.manualReason).toBe('{"verificationCode":"[redacted]","safeReason":"manual check"}');
    expect(storedJob.state).toBe('{"CPA key":"[redacted]","state":"state-a"}');
    expect(storedJob.lastPageSnapshot).toEqual({
      body: "{\"refresh_token\": \"[redacted]\", \"Cookie\":\"[redacted]\", 'refreshToken':'[redacted]', \"safe\":\"visible body\"}",
      safe: "{\"message\":\"visible safe json\"}",
    });
  });

  it("redacts complete Cookie and Set-Cookie header text while keeping non-cookie text readable", () => {
    const storage = new FakeStorage();
    const secret = "cookie-secret-one";
    const secret2 = "cookie-secret-two";
    const secret3 = "cookie-secret-three";
    const setCookieSecret = "set-cookie-secret";

    const cookieHeader = `Cookie: sid=${secret}; other_cookie=${secret2}; third=${secret3}`;
    const job = makeJob({
      oauthError: `request failed\n${cookieHeader}\nordinary text remains`,
      manualReason: `Set-Cookie: session=${setCookieSecret}; Path=/; HttpOnly\nmanual note remains`,
      lastPageSnapshot: {
        body: `before body\n${cookieHeader}\nafter body remains`,
        safe: "visible safe context",
      },
    });

    expect(createOAuthJobStore(storage).save([job])).toBe(true);

    const stored = storage.getItem(OAUTH_JOB_STORE_KEY) ?? "";
    for (const leakedValue of [secret, secret2, secret3, setCookieSecret, "other_cookie"]) {
      expect(stored).not.toContain(leakedValue);
    }

    const [storedJob] = JSON.parse(stored) as OAuthJob[];
    expect(storedJob.oauthError).toBe("request failed\nCookie: [redacted]\nordinary text remains");
    expect(storedJob.manualReason).toBe("Set-Cookie: [redacted]\nmanual note remains");
    expect(storedJob.lastPageSnapshot).toEqual({
      body: "before body\nCookie: [redacted]\nafter body remains",
      safe: "visible safe context",
    });
  });

  it("redacts token, secret, password, and JSON cookie dumps in free-text strings", () => {
    const storage = new FakeStorage();
    const accessTokenSecret = "access-token-secret";
    const clientSecret = "client-secret-value";
    const hotmailPassword = "hotmail-password-secret";
    const setCookieSecret = "json-cookie-secret-one";
    const setCookieSecret2 = "json-cookie-secret-two";
    const cookieSecret = "json-cookie-secret-three";
    const cookieSecret2 = "json-cookie-secret-four";

    const job = makeJob({
      oauthError: `{"access token":"${accessTokenSecret}","safe":"visible value"}`,
      lastError: `client secret: ${clientSecret}; ordinary text remains`,
      manualReason: `{"hotmail password":"${hotmailPassword}","safeReason":"manual check"}`,
      state: JSON.stringify({
        "Set-Cookie": [`sid=${setCookieSecret}; Path=/`, `x=${setCookieSecret2}`],
        state: "state-a",
      }),
      lastPageSnapshot: {
        body: JSON.stringify({
          Cookie: `sid=${cookieSecret}; x=${cookieSecret2}`,
          message: "visible body",
        }),
        note: `client secret: ${clientSecret}; ordinary snapshot text`,
      },
    });

    expect(createOAuthJobStore(storage).save([job])).toBe(true);

    const stored = storage.getItem(OAUTH_JOB_STORE_KEY) ?? "";
    for (const leakedValue of [
      accessTokenSecret,
      clientSecret,
      hotmailPassword,
      setCookieSecret,
      setCookieSecret2,
      cookieSecret,
      cookieSecret2,
      "sid=",
      "Path=/",
    ]) {
      expect(stored).not.toContain(leakedValue);
    }

    const [storedJob] = JSON.parse(stored) as OAuthJob[];
    expect(storedJob.oauthError).toBe('{"access token":"[redacted]","safe":"visible value"}');
    expect(storedJob.lastError).toBe("client secret: [redacted]; ordinary text remains");
    expect(storedJob.manualReason).toBe('{"hotmail password":"[redacted]","safeReason":"manual check"}');
    expect(storedJob.state).toBe('{"Set-Cookie":"[redacted]","state":"state-a"}');
    expect(storedJob.lastPageSnapshot).toEqual({
      body: "{\"Cookie\":\"[redacted]\",\"message\":\"visible body\"}",
      note: "client secret: [redacted]; ordinary snapshot text",
    });
  });

  it("loads only basically valid OAuth jobs", () => {
    const storage = new FakeStorage();
    const valid = makeJob({ rejectedCodeFingerprints: ["rejected-code:fp:0123456789abcdef0123456789abcdef"] });
    storage.setItem(
      OAUTH_JOB_STORE_KEY,
      JSON.stringify([
        valid,
        { ...valid, jobId: "" },
        { ...valid, attempt: 2 },
        { ...valid, rejectedCodeFingerprints: ["raw-code-value"] },
        "not-a-job",
      ]),
    );

    expect(createOAuthJobStore(storage).load()).toEqual([valid]);
  });

  it("does not load jobs when rejectedCodeFingerprints is missing or not an array", () => {
    const storage = new FakeStorage();
    const valid = makeJob({ jobId: "oauth-job:idx-valid", authIndex: "idx-valid" });
    storage.setItem(
      OAUTH_JOB_STORE_KEY,
      JSON.stringify([
        valid,
        { ...valid, jobId: "oauth-job:idx-missing", authIndex: "idx-missing", rejectedCodeFingerprints: undefined },
        { ...valid, jobId: "oauth-job:idx-string", authIndex: "idx-string", rejectedCodeFingerprints: "rejected-code:fp:0123456789abcdef0123456789abcdef" },
      ]),
    );

    expect(createOAuthJobStore(storage).load()).toEqual([valid]);
  });
});
