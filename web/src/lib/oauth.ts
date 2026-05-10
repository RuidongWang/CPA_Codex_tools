import type { AccountItem, HotmailAccount, OAuthSettings } from "../types";

export const DEFAULT_HOTMAIL_HELPER_URL = "http://127.0.0.1:17373";

export const DEFAULT_OAUTH_SETTINGS: OAuthSettings = {
  hotmailHelperUrl: DEFAULT_HOTMAIL_HELPER_URL,
  hotmailAccounts: [],
  rememberHotmailTokens: false,
};

export type HotmailImportAccount = Pick<HotmailAccount, "email" | "password" | "clientId" | "refreshToken">;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildHotmailAccountId(email: string, clientId: string): string {
  return `${email.trim().toLowerCase()}::${clientId.trim()}`;
}

export function normalizeHotmailHelperUrl(input: unknown): string {
  const raw = normalizeText(input) || DEFAULT_HOTMAIL_HELPER_URL;
  try {
    const parsed = new URL(raw);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_HOTMAIL_HELPER_URL;
  }
}

export function parseHotmailImportText(rawText: string): HotmailImportAccount[] {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .filter((line, index) => !(index === 0 && /^账号----密码----ID----Token$/i.test(line)))
    .map((line) => line.split("----").map((part) => part.trim()))
    .filter((parts) => parts.length >= 4 && parts[0] && parts[2] && parts[3])
    .map(([email, password, clientId, refreshToken]) => ({
      email,
      password,
      clientId,
      refreshToken,
    }));
}

export function createHotmailAccount(input: HotmailImportAccount | Partial<HotmailAccount>): HotmailAccount | null {
  const raw = input as Partial<HotmailAccount>;
  const email = normalizeText(input.email);
  const clientId = normalizeText(input.clientId);
  const refreshToken = normalizeText(input.refreshToken);
  if (!email || !clientId || !refreshToken) {
    return null;
  }
  return {
    id: normalizeText(raw.id) || buildHotmailAccountId(email, clientId),
    email,
    password: normalizeText(input.password),
    clientId,
    refreshToken,
    status: raw.status === "authorized" || raw.status === "error" ? raw.status : "pending",
    lastCode: normalizeText(raw.lastCode) || undefined,
    lastCodeAt: normalizeText(raw.lastCodeAt) || undefined,
    lastError: normalizeText(raw.lastError) || undefined,
    updatedAt: normalizeText(raw.updatedAt) || undefined,
  };
}

export function upsertHotmailAccounts(accounts: HotmailAccount[], incoming: HotmailAccount[]): HotmailAccount[] {
  const next = [...accounts];
  for (const account of incoming) {
    const index = next.findIndex((candidate) => candidate.id === account.id);
    if (index === -1) {
      next.push(account);
    } else {
      next[index] = { ...next[index], ...account };
    }
  }
  return next;
}

export function normalizeOAuthSettings(input: Partial<OAuthSettings> | null | undefined): OAuthSettings {
  const raw = input ?? {};
  const accounts = Array.isArray(raw.hotmailAccounts)
    ? raw.hotmailAccounts.map((account) => createHotmailAccount(account)).filter((account): account is HotmailAccount => Boolean(account))
    : [];
  return {
    hotmailHelperUrl: normalizeHotmailHelperUrl(raw.hotmailHelperUrl),
    hotmailAccounts: accounts,
    rememberHotmailTokens: raw.rememberHotmailTokens === true,
  };
}

export function isQuotaQueryError(item: AccountItem): boolean {
  return item.status === "error" && Boolean(normalizeText(item.last_query_at));
}

export function isOAuthReloginCandidate(
  item: AccountItem,
  keeperRefreshFailureAuthIndexes: ReadonlySet<string> = new Set(),
): boolean {
  return isQuotaQueryError(item) || keeperRefreshFailureAuthIndexes.has(item.auth_index);
}
