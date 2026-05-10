import type { AccountItem, HotmailAccount, OAuthJob, OAuthJobErrorType } from "../types";

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

const OAUTH_BRIDGE_ACTION_SET = new Set<string>(OAUTH_BRIDGE_ACTIONS);

export type OAuthBridgeAction = (typeof OAUTH_BRIDGE_ACTIONS)[number];
export type OAuthBridgeErrorType = OAuthJobErrorType;

export interface OAuthBridgeRequest {
  source: typeof OAUTH_BRIDGE_REQUEST_SOURCE;
  type: typeof OAUTH_BRIDGE_REQUEST_TYPE;
  requestId: string;
  version?: number;
  action: OAuthBridgeAction;
  payload?: Record<string, unknown>;
}

export interface OAuthBridgeError {
  errorType: OAuthBridgeErrorType;
  code: string;
  message: string;
  [key: string]: unknown;
}

export type OAuthBridgeResponseBody =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: OAuthBridgeError; result?: Record<string, unknown> };

export interface OAuthBridgeHotmailAccount {
  id: string;
  email: string;
  clientId: string;
  status: HotmailAccount["status"];
  lastCodeAt?: string;
  lastError?: string;
  hasRefreshToken: boolean;
}

export interface OAuthBridgeAccount {
  name: string;
  email: string;
  planType: string;
  authIndex: string;
  accountId: string;
  status: AccountItem["status"];
  error: string;
}

export interface OAuthBridgeQueueJob
  extends Omit<OAuthJob, "rejectedCodeFingerprints" | "lastPageSnapshot"> {
  hasPageSnapshot: boolean;
}

export function isOAuthBridgeAction(value: unknown): value is OAuthBridgeAction {
  return typeof value === "string" && OAUTH_BRIDGE_ACTION_SET.has(value);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOAuthBridgeRequest(value: unknown): value is OAuthBridgeRequest {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    value.source === OAUTH_BRIDGE_REQUEST_SOURCE &&
    value.type === OAUTH_BRIDGE_REQUEST_TYPE &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    isOAuthBridgeAction(value.action) &&
    (value.payload === undefined || isPlainRecord(value.payload))
  );
}

export function createOAuthBridgeError(
  errorType: OAuthBridgeErrorType,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): OAuthBridgeError {
  return {
    errorType,
    code,
    message,
    ...extra,
  };
}

export function postOAuthBridgeResponse(request: Pick<OAuthBridgeRequest, "requestId">, body: OAuthBridgeResponseBody): void {
  const targetOrigin = window.location.origin === "null" ? "*" : window.location.origin;
  window.postMessage(
    {
      source: OAUTH_BRIDGE_RESPONSE_SOURCE,
      type: OAUTH_BRIDGE_RESPONSE_TYPE,
      version: OAUTH_BRIDGE_VERSION,
      requestId: request.requestId,
      ...body,
    },
    targetOrigin,
  );
}

export function toOAuthBridgeAccount(item: AccountItem): OAuthBridgeAccount {
  return {
    name: item.name,
    email: item.email,
    planType: item.plan_type,
    authIndex: item.auth_index,
    accountId: item.account_id,
    status: item.status,
    error: item.error,
  };
}

export function toOAuthBridgeHotmailAccount(account: HotmailAccount): OAuthBridgeHotmailAccount {
  return {
    id: account.id,
    email: account.email,
    clientId: account.clientId,
    status: account.status,
    lastCodeAt: account.lastCodeAt,
    lastError: account.lastError,
    hasRefreshToken: Boolean(account.refreshToken),
  };
}

export function toOAuthBridgeQueueJob(job: OAuthJob): OAuthBridgeQueueJob {
  const { rejectedCodeFingerprints: _rejectedCodeFingerprints, lastPageSnapshot, ...safeJob } = job;
  return {
    ...safeJob,
    hasPageSnapshot: lastPageSnapshot !== null,
  };
}
