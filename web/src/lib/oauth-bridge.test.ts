import { describe, expect, it, vi } from "vitest";
import type { HotmailAccount } from "../types";
import {
  createOAuthBridgeError,
  isOAuthBridgeAction,
  isOAuthBridgeRequest,
  OAUTH_BRIDGE_ACTIONS,
  OAUTH_BRIDGE_REQUEST_SOURCE,
  OAUTH_BRIDGE_REQUEST_TYPE,
  OAUTH_BRIDGE_RESPONSE_SOURCE,
  OAUTH_BRIDGE_RESPONSE_TYPE,
  OAUTH_BRIDGE_VERSION,
  postOAuthBridgeResponse,
  toOAuthBridgeHotmailAccount,
} from "./oauth-bridge";

function makeHotmailAccount(overrides: Partial<HotmailAccount> = {}): HotmailAccount {
  return {
    id: "hotmail-a",
    email: "alice@hotmail.com",
    password: "mail-password",
    clientId: "client-a",
    refreshToken: "refresh-token",
    status: "authorized",
    lastCode: "123456",
    lastCodeAt: "2026-05-09T01:00:00.000Z",
    lastError: "older failure",
    updatedAt: "2026-05-09T01:01:00.000Z",
    ...overrides,
  };
}

describe("oauth bridge protocol helpers", () => {
  it("exports the v2 protocol constants and action contract", () => {
    expect(OAUTH_BRIDGE_REQUEST_SOURCE).toBe("cpa-codex-oauth-extension");
    expect(OAUTH_BRIDGE_RESPONSE_SOURCE).toBe("cpa-codex-oauth-page");
    expect(OAUTH_BRIDGE_REQUEST_TYPE).toBe("CPA_OAUTH_BRIDGE_REQUEST");
    expect(OAUTH_BRIDGE_RESPONSE_TYPE).toBe("CPA_OAUTH_BRIDGE_RESPONSE");
    expect(OAUTH_BRIDGE_VERSION).toBe(2);
    expect([...OAUTH_BRIDGE_ACTIONS]).toEqual([
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
    ]);
    expect(isOAuthBridgeAction("FETCH_CODE")).toBe(true);
    expect(isOAuthBridgeAction("START_OAUTH")).toBe(false);
  });

  it("recognizes bridge requests and rejects the legacy panel protocol shape", () => {
    expect(
      isOAuthBridgeRequest({
        source: OAUTH_BRIDGE_REQUEST_SOURCE,
        type: OAUTH_BRIDGE_REQUEST_TYPE,
        requestId: "req-a",
        action: "GET_QUEUE",
      }),
    ).toBe(true);

    expect(
      isOAuthBridgeRequest({
        source: OAUTH_BRIDGE_REQUEST_SOURCE,
        type: OAUTH_BRIDGE_REQUEST_TYPE,
        requestId: "legacy-req",
        action: "GET_STATE",
      }),
    ).toBe(false);
    expect(isOAuthBridgeRequest({ source: OAUTH_BRIDGE_REQUEST_SOURCE })).toBe(false);
  });

  it("builds structured errors with optional metadata", () => {
    expect(createOAuthBridgeError("retryable", "code_not_found", "No code yet", { retryAfterMs: 1000 })).toEqual({
      errorType: "retryable",
      code: "code_not_found",
      message: "No code yet",
      retryAfterMs: 1000,
    });
  });

  it("posts versioned bridge responses with the request id", () => {
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);

    postOAuthBridgeResponse(
      {
        source: OAUTH_BRIDGE_REQUEST_SOURCE,
        type: OAUTH_BRIDGE_REQUEST_TYPE,
        requestId: "req-a",
        action: "GET_CAPABILITIES",
      },
      { ok: true, result: { version: OAUTH_BRIDGE_VERSION } },
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: OAUTH_BRIDGE_RESPONSE_SOURCE,
        type: OAUTH_BRIDGE_RESPONSE_TYPE,
        requestId: "req-a",
        version: OAUTH_BRIDGE_VERSION,
        ok: true,
      }),
      expect.any(String),
    );
  });

  it("maps Hotmail accounts to the extension-safe field set", () => {
    const safe = toOAuthBridgeHotmailAccount(makeHotmailAccount());

    expect(safe).toEqual({
      id: "hotmail-a",
      email: "alice@hotmail.com",
      clientId: "client-a",
      status: "authorized",
      lastCodeAt: "2026-05-09T01:00:00.000Z",
      lastError: "older failure",
      hasRefreshToken: true,
    });
    expect(JSON.stringify(safe)).not.toContain("mail-password");
    expect(JSON.stringify(safe)).not.toContain("refresh-token");
    expect(JSON.stringify(safe)).not.toContain("123456");
    expect(safe).not.toHaveProperty("updatedAt");
  });
});
