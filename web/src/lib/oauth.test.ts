import { describe, expect, it } from "vitest";
import {
  createHotmailAccount,
  DEFAULT_HOTMAIL_HELPER_URL,
  isOAuthReloginCandidate,
  normalizeHotmailHelperUrl,
  normalizeOAuthSettings,
  parseInvalidAccountEmailImportText,
  parseHotmailImportText,
  upsertHotmailAccounts,
} from "./oauth";
import type { AccountItem } from "../types";

function makeAccount(overrides: Partial<AccountItem> = {}): AccountItem {
  return {
    name: "codex-a.json",
    email: "a@hotmail.com",
    plan_type: "free",
    account_id: "acct-a",
    auth_index: "idx-a",
    priority: null,
    status: "healthy",
    windows: [],
    additional_windows: [],
    error: "",
    has_refresh_token: true,
    last_query_at: null,
    quota_updated_at: null,
    ...overrides,
  };
}

describe("parseHotmailImportText", () => {
  it("parses reference hotmail account format", () => {
    const parsed = parseHotmailImportText(`
账号----密码----ID----Token
example-one@hotmail.com----pass-1----client-1----refresh-token-1
example-two@hotmail.com----pass-2----client-2----refresh-token-2
    `);

    expect(parsed).toEqual([
      {
        email: "example-one@hotmail.com",
        password: "pass-1",
        clientId: "client-1",
        refreshToken: "refresh-token-1",
      },
      {
        email: "example-two@hotmail.com",
        password: "pass-2",
        clientId: "client-2",
        refreshToken: "refresh-token-2",
      },
    ]);
  });
});

describe("parseInvalidAccountEmailImportText", () => {
  it("extracts batch pasted emails, normalizes case, and de-duplicates them", () => {
    expect(parseInvalidAccountEmailImportText(" Alice@Outlook.com\nbob@hotmail.com, alice@outlook.com bad-text bob@hotmail.com ")).toEqual([
      "alice@outlook.com",
      "bob@hotmail.com",
    ]);
  });
});

describe("normalizeOAuthSettings", () => {
  it("always enables local Hotmail token persistence and normalizes imported invalid emails", () => {
    expect(normalizeOAuthSettings({}).rememberHotmailTokens).toBe(true);
    expect(normalizeOAuthSettings({}).importedInvalidAccountEmails).toEqual([]);
    expect(normalizeOAuthSettings({ rememberHotmailTokens: true }).rememberHotmailTokens).toBe(true);
    expect(normalizeOAuthSettings({ rememberHotmailTokens: false }).rememberHotmailTokens).toBe(true);
  });

  it("keeps valid helper url, preserves password-only hotmail accounts, and normalizes imported invalid emails", () => {
    const settings = normalizeOAuthSettings({
      hotmailHelperUrl: "http://127.0.0.1:17373/",
      importedInvalidAccountEmails: ["A@Outlook.com", "a@outlook.com", "bad-value", "B@Hotmail.com"],
      hotmailAccounts: [
        { id: "", email: "A@Hotmail.com", clientId: "client-a", refreshToken: "token-a", status: "authorized" },
        { id: "", email: "B@Hotmail.com", password: "mail-password", clientId: "client-b", status: "pending" },
        { id: "", email: "broken@hotmail.com", clientId: "", refreshToken: "token-b", status: "pending" },
      ],
    });

    expect(settings.hotmailHelperUrl).toBe(DEFAULT_HOTMAIL_HELPER_URL);
    expect(settings.hotmailAccounts).toEqual([
      expect.objectContaining({
        id: "a@hotmail.com::client-a",
        email: "A@Hotmail.com",
        clientId: "client-a",
        refreshToken: "token-a",
        status: "authorized",
      }),
      expect.objectContaining({
        id: "b@hotmail.com::client-b",
        email: "B@Hotmail.com",
        password: "mail-password",
        clientId: "client-b",
        refreshToken: "",
        status: "pending",
      }),
    ]);
    expect(settings.rememberHotmailTokens).toBe(true);
    expect(settings.importedInvalidAccountEmails).toEqual(["a@outlook.com", "b@hotmail.com"]);
  });

  it("falls back to local helper for invalid helper url", () => {
    expect(normalizeHotmailHelperUrl("not-a-url")).toBe(DEFAULT_HOTMAIL_HELPER_URL);
  });
});

describe("hotmail account helpers", () => {
  it("upserts accounts by deterministic id", () => {
    const first = createHotmailAccount({ email: "a@hotmail.com", password: "old", clientId: "client", refreshToken: "token-1" });
    const second = createHotmailAccount({ email: "a@hotmail.com", password: "new", clientId: "client", refreshToken: "token-2" });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const next = upsertHotmailAccounts([first!], [second!]);

    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(expect.objectContaining({ password: "new", refreshToken: "token-2" }));
  });
});

describe("isOAuthReloginCandidate", () => {
  it("only marks queried quota errors or keeper refresh failures as candidates", () => {
    expect(isOAuthReloginCandidate(makeAccount({ status: "error", last_query_at: null }))).toBe(false);
    expect(isOAuthReloginCandidate(makeAccount({ status: "error", last_query_at: "2026-05-06T00:00:00Z" }))).toBe(true);
    expect(isOAuthReloginCandidate(makeAccount({ disabled: true }))).toBe(false);
    expect(isOAuthReloginCandidate(makeAccount({ has_refresh_token: false }))).toBe(false);
    expect(isOAuthReloginCandidate(makeAccount({ expired: "2026-05-05T00:00:00Z" }))).toBe(false);
    expect(isOAuthReloginCandidate(makeAccount({ auth_index: "idx-a" }), new Set(["idx-a"]))).toBe(true);
  });

  it("marks imported invalid email matches as candidates without quota error evidence", () => {
    expect(
      isOAuthReloginCandidate(
        makeAccount({ email: "A@Hotmail.com", status: "healthy", last_query_at: null }),
        new Set(),
        new Set(["a@hotmail.com"]),
      ),
    ).toBe(true);
  });
});
