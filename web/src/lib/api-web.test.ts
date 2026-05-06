import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLocalCache,
  downloadSelectedAccounts,
  fetchAccountList,
  fetchHotmailVerificationCode,
  loadPayloadCache,
  loadRuntimeConfig,
  pollCodexOAuthStatus,
  queryCachedAccounts,
  runKeeperDirectAction,
  runKeeperMaintenance,
  savePayloadCache,
  saveRuntimeConfig,
  startCodexOAuth,
  submitCodexOAuthCallback,
  syncAccountPriorities,
} from "./api";
import type { AccountItem, RuntimeConfig } from "../types";

const WEB_PAYLOAD_CACHE_KEY = "cpa_codex_quota_cache.payload-cache";
const LEGACY_WEB_PAYLOAD_CACHE_KEY = "cpa-quota-desk.payload-cache";

const demoConfig: RuntimeConfig = {
  cpaBaseUrl: "https://cpa.example/",
  managementKey: "example-management-key",
  queryConcurrency: 2,
  keeperSettings: {
    quotaThreshold: 100,
    expiryThresholdDays: 3,
    enableRefresh: true,
    workerThreads: 2,
  },
  priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
  priorityPlanRanges: {},
  oauthSettings: {
    hotmailHelperUrl: "http://127.0.0.1:17373",
    hotmailAccounts: [],
  },
};

const demoItem: AccountItem = {
  name: "codex-a@example.com-free.json",
  email: "a@example.com",
  plan_type: "free",
  account_id: "acct-a",
  auth_index: "idx-a",
  priority: 10,
  remote_priority: 10,
  status: "unknown",
  windows: [],
  additional_windows: [],
  error: "",
  last_query_at: null,
  quota_updated_at: null,
};

function demoPayload(status: AccountItem["status"] = "healthy") {
  return {
    meta: { generated_at: "2026-04-30T00:00:00Z", total: 1, success: 1, failed: 0 },
    groups: { by_plan: { free: 1 }, by_status: { [status]: 1 } },
    items: [{ ...demoItem, status }],
    error: "",
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

function quotaUsageResponse(remaining5h = 60, remaining7d = 90, reset5h = 1_777_805_580, reset7d = 1_778_126_400): Response {
  return jsonResponse({
    status_code: 200,
    body: JSON.stringify({
      plan_type: "free",
      priority: 10,
      rate_limit: {
        primary_window: { limit_window_seconds: 18000, used_percent: 100 - remaining5h, reset_at: reset5h },
        secondary_window: { limit_window_seconds: 604800, used_percent: 100 - remaining7d, reset_at: reset7d },
      },
    }),
  });
}

function authFilesResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    files: [
      {
        provider: "codex",
        name: "codex-a@example.com-free.json",
        email: "a@example.com",
        plan_type: "free",
        chatgpt_account_id: "acct-a",
        auth_index: "idx-a",
        priority: "10",
        ...overrides,
      },
    ],
  });
}

function authDownloadResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    email: "a@example.com",
    account_id: "acct-a",
    expired: "2026-05-09T08:30:00+08:00",
    ...overrides,
  });
}

function createFakeLocalStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? (values.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } as Storage;
}

type FakeIdbRequest<T> = IDBRequest<T> & {
  fail: (error: DOMException) => void;
  succeed: (value: T) => void;
};

interface FakeIdbStoreState {
  keyPath: string;
  records: Map<IDBValidKey, unknown>;
}

interface FakeIdbDatabaseState {
  version: number;
  stores: Map<string, FakeIdbStoreState>;
}

function createFakeRequest<T>(): FakeIdbRequest<T> {
  const request = {
    error: null,
    result: undefined,
    onerror: null,
    onsuccess: null,
    readyState: "pending",
    source: null,
    transaction: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    fail(error: DOMException) {
      queueMicrotask(() => {
        request.error = error;
        request.readyState = "done";
        request.onerror?.({ target: request } as unknown as Event);
      });
    },
    succeed(value: T) {
      queueMicrotask(() => {
        request.result = value;
        request.readyState = "done";
        request.onsuccess?.({ target: request } as unknown as Event);
      });
    },
  };
  return request as unknown as FakeIdbRequest<T>;
}

function createFakeObjectStore(state: FakeIdbStoreState): IDBObjectStore {
  return {
    get(key: IDBValidKey) {
      const request = createFakeRequest<unknown>();
      request.succeed(state.records.get(key));
      return request;
    },
    put(value: Record<string, unknown>) {
      const request = createFakeRequest<IDBValidKey>();
      request.succeed(value[state.keyPath] as IDBValidKey);
      state.records.set(value[state.keyPath] as IDBValidKey, value);
      return request;
    },
    delete(key: IDBValidKey) {
      const request = createFakeRequest<undefined>();
      state.records.delete(key);
      request.succeed(undefined);
      return request;
    },
    clear() {
      const request = createFakeRequest<undefined>();
      state.records.clear();
      request.succeed(undefined);
      return request;
    },
  } as unknown as IDBObjectStore;
}

function createFakeDatabase(state: FakeIdbDatabaseState): IDBDatabase {
  return {
    close: vi.fn(),
    createObjectStore(name: string, options?: IDBObjectStoreParameters) {
      const storeState: FakeIdbStoreState = {
        keyPath: typeof options?.keyPath === "string" ? options.keyPath : "id",
        records: new Map(),
      };
      state.stores.set(name, storeState);
      return createFakeObjectStore(storeState);
    },
    objectStoreNames: {
      contains(name: string) {
        return state.stores.has(name);
      },
    },
    transaction(name: string) {
      const storeState = state.stores.get(name);
      if (!storeState) {
        throw new DOMException(`Missing object store ${name}`, "NotFoundError");
      }
      return {
        objectStore() {
          return createFakeObjectStore(storeState);
        },
      } as unknown as IDBTransaction;
    },
  } as unknown as IDBDatabase;
}

function createFakeIndexedDB(): IDBFactory {
  const databases = new Map<string, FakeIdbDatabaseState>();
  return {
    open(name: string, version?: number) {
      const request = createFakeRequest<IDBDatabase>() as IDBOpenDBRequest & {
        fail: (error: DOMException) => void;
        succeed: (value: IDBDatabase) => void;
      };
      request.onupgradeneeded = null;
      queueMicrotask(() => {
        let state = databases.get(name);
        const nextVersion = version ?? state?.version ?? 1;
        const needsUpgrade = !state || nextVersion > state.version;
        if (!state) {
          state = { version: nextVersion, stores: new Map() };
          databases.set(name, state);
        } else {
          state.version = nextVersion;
        }
        const db = createFakeDatabase(state);
        request.result = db;
        if (needsUpgrade) {
          request.onupgradeneeded?.({ target: request } as unknown as IDBVersionChangeEvent);
        }
        request.succeed(db);
      });
      return request;
    },
    deleteDatabase(name: string) {
      const request = createFakeRequest<undefined>() as IDBOpenDBRequest & {
        succeed: (value: undefined) => void;
      };
      databases.delete(name);
      request.succeed(undefined);
      return request;
    },
  } as unknown as IDBFactory;
}

function createFailingIndexedDB(): IDBFactory {
  return {
    open() {
      const request = createFakeRequest<IDBDatabase>() as IDBOpenDBRequest & {
        fail: (error: DOMException) => void;
      };
      request.onupgradeneeded = null;
      request.fail(new DOMException("IndexedDB unavailable", "UnknownError"));
      return request;
    },
    deleteDatabase() {
      const request = createFakeRequest<undefined>() as IDBOpenDBRequest & {
        fail: (error: DOMException) => void;
      };
      request.fail(new DOMException("IndexedDB unavailable", "UnknownError"));
      return request;
    },
  } as unknown as IDBFactory;
}

describe("browser runtime api", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    // Web 运行时必须只走浏览器 fetch。
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("indexedDB", createFakeIndexedDB());
    Object.defineProperty(window, "localStorage", { configurable: true, value: createFakeLocalStorage() });
    window.localStorage.clear();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:codex-backup") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetchAccountList 在浏览器环境直接读取 CPA auth-files", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            provider: "codex",
            name: "codex-pro.json",
            email: "pro@example.com",
            plan_type: "pro",
            chatgpt_account_id: "acct-pro",
            auth_index: "idx-pro",
            priority: "88",
          },
          { provider: "claude", name: "claude.json" },
        ],
      }),
    );

    const payload = await fetchAccountList(demoConfig);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = readHeaders(init);

    expect(url).toBe("https://cpa.example/v0/management/auth-files");
    expect(headers.get("authorization")).toBe("Bearer example-management-key");
    expect(headers.get("x-management-key")).toBe("example-management-key");
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toEqual(
      expect.objectContaining({
        email: "pro@example.com",
        plan_type: "pro 20x",
        account_id: "acct-pro",
        auth_index: "idx-pro",
        priority: 88,
      }),
    );
  });

  it("fetchAccountList 在浏览器里缺少 CPA 地址时直接报错", async () => {
    await expect(fetchAccountList({ ...demoConfig, cpaBaseUrl: "   " })).rejects.toThrow("请先填写 CPA 地址");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queryCachedAccounts 在浏览器里通过 CPA api-call 查询并发出进度", async () => {
    fetchMock.mockResolvedValueOnce(authFilesResponse());
    fetchMock.mockResolvedValueOnce(authDownloadResponse());
    fetchMock.mockResolvedValueOnce(quotaUsageResponse());

    const progress: Array<{ completed: number; total: number; currentLabel: string }> = [];
    const payload = await queryCachedAccounts(demoConfig, [demoItem], (event) => progress.push(event));
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    const requestBody = JSON.parse(String(init.body));

    expect(url).toBe("https://cpa.example/v0/management/api-call");
    expect(init.method).toBe("POST");
    expect(requestBody).toEqual(
      expect.objectContaining({
        auth_index: "idx-a",
        method: "GET",
        url: "https://chatgpt.com/backend-api/wham/usage",
      }),
    );
    expect(payload.items[0]).toEqual(
      expect.objectContaining({
        status: "healthy",
        quota_updated_at: "05-03 18:53",
        windows: expect.arrayContaining([
          expect.objectContaining({ id: "code-5h", remaining_percent: 60, reset_label: "05-03 18:53" }),
          expect.objectContaining({ id: "code-7d", remaining_percent: 90 }),
        ]),
      }),
    );
    expect(progress).toEqual([expect.objectContaining({ completed: 1, total: 1, currentLabel: "a@example.com" })]);
  });

  it("queryCachedAccounts 会先刷新 auth-files 并把 expired 写入查询结果", async () => {
    fetchMock.mockResolvedValueOnce(authFilesResponse({ expired: "2026-05-09T08:30:00+08:00" }));
    fetchMock.mockResolvedValueOnce(authDownloadResponse({ expired: "2026-05-09T08:30:00+08:00" }));
    fetchMock.mockResolvedValueOnce(quotaUsageResponse());

    const payload = await queryCachedAccounts(demoConfig, [{ ...demoItem, expired: "2026-05-01T00:00:00+08:00" }]);
    const [authUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [downloadUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    const [quotaUrl] = fetchMock.mock.calls[2] as [string, RequestInit];

    expect(authUrl).toBe("https://cpa.example/v0/management/auth-files");
    expect(downloadUrl).toBe("https://cpa.example/v0/management/auth-files/download?name=codex-a%40example.com-free.json");
    expect(quotaUrl).toBe("https://cpa.example/v0/management/api-call");
    expect(payload.items[0]).toEqual(
      expect.objectContaining({
        auth_index: "idx-a",
        expired: "2026-05-09T08:30:00+08:00",
        status: "healthy",
      }),
    );
  });

  it("queryCachedAccounts 会把 refreshed expired 写入本地快照供后续列表恢复", async () => {
    fetchMock.mockResolvedValueOnce(authFilesResponse({ expired: "2026-05-09T08:30:00+08:00" }));
    fetchMock.mockResolvedValueOnce(authDownloadResponse({ expired: "2026-05-09T08:30:00+08:00" }));
    fetchMock.mockResolvedValueOnce(quotaUsageResponse());
    await queryCachedAccounts(demoConfig, [demoItem]);
    fetchMock.mockResolvedValueOnce(authFilesResponse({ expired: undefined }));

    const payload = await fetchAccountList(demoConfig);

    expect(payload.items[0]).toEqual(
      expect.objectContaining({
        auth_index: "idx-a",
        expired: "2026-05-09T08:30:00+08:00",
        status: "healthy",
      }),
    );
  });

  it("queryCachedAccounts 在列表摘要没有 expired 时会下载账号文件更新 token 过期时间", async () => {
    fetchMock.mockResolvedValueOnce(authFilesResponse({ expired: undefined }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        email: "a@example.com",
        account_id: "acct-a",
        expired: "2026-05-10T09:15:00+08:00",
      }),
    );
    fetchMock.mockResolvedValueOnce(quotaUsageResponse());

    const payload = await queryCachedAccounts(demoConfig, [{ ...demoItem, expired: "2026-05-01T00:00:00+08:00" }]);
    const [downloadUrl] = fetchMock.mock.calls[1] as [string, RequestInit];

    expect(downloadUrl).toBe("https://cpa.example/v0/management/auth-files/download?name=codex-a%40example.com-free.json");
    expect(payload.items[0]).toEqual(
      expect.objectContaining({
        expired: "2026-05-10T09:15:00+08:00",
        status: "healthy",
      }),
    );
  });

  it("successful Web queryCachedAccounts writes a quota snapshot with the 5h reset label as quota_updated_at", async () => {
    fetchMock.mockResolvedValueOnce(authFilesResponse());
    fetchMock.mockResolvedValueOnce(authDownloadResponse());
    fetchMock.mockResolvedValueOnce(quotaUsageResponse(55, 88));

    const queried = await queryCachedAccounts(demoConfig, [demoItem]);
    const quotaUpdatedAt = queried.items[0].quota_updated_at;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            provider: "codex",
            name: "codex-a-renamed-free.json",
            email: "fresh-a@example.com",
            plan_type: "free",
            chatgpt_account_id: "acct-a",
            auth_index: "idx-a",
            priority: "99",
          },
        ],
      }),
    );

    const payload = await fetchAccountList(demoConfig);

    expect(quotaUpdatedAt).toBe("05-03 18:53");
    expect(payload.items[0]).toEqual(
      expect.objectContaining({
        name: "codex-a-renamed-free.json",
        email: "fresh-a@example.com",
        priority: 99,
        status: "healthy",
        quota_updated_at: quotaUpdatedAt,
        windows: expect.arrayContaining([
          expect.objectContaining({ id: "code-5h", remaining_percent: 55 }),
          expect.objectContaining({ id: "code-7d", remaining_percent: 88 }),
        ]),
      }),
    );
  });

  it("failed Web query preserves existing quota_updated_at when merged through a later list load", async () => {
    fetchMock.mockResolvedValueOnce(authFilesResponse());
    fetchMock.mockResolvedValueOnce(authDownloadResponse());
    fetchMock.mockResolvedValueOnce(quotaUsageResponse(64, 91));
    const successful = await queryCachedAccounts(demoConfig, [demoItem]);
    const quotaUpdatedAt = successful.items[0].quota_updated_at;
    fetchMock.mockResolvedValueOnce(authFilesResponse());
    fetchMock.mockResolvedValueOnce(authDownloadResponse());
    fetchMock.mockResolvedValueOnce(jsonResponse({ status_code: 503, body: "upstream unavailable" }));

    const failed = await queryCachedAccounts(demoConfig, [demoItem]);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            provider: "codex",
            name: "codex-a@example.com-free.json",
            email: "a@example.com",
            plan_type: "free",
            chatgpt_account_id: "acct-a",
            auth_index: "idx-a",
            priority: "10",
          },
        ],
      }),
    );

    const payload = await fetchAccountList(demoConfig);

    expect(quotaUpdatedAt).toEqual(expect.any(String));
    expect(failed.items[0]).toEqual(
      expect.objectContaining({
        status: "error",
        error: expect.any(String),
        quota_updated_at: quotaUpdatedAt,
      }),
    );
    expect(payload.items[0]).toEqual(
      expect.objectContaining({
        status: "error",
        error: failed.items[0].error,
        last_query_at: failed.items[0].last_query_at,
        quota_updated_at: quotaUpdatedAt,
        windows: expect.arrayContaining([expect.objectContaining({ id: "code-5h", remaining_percent: 64 })]),
      }),
    );
  });

  it("fresh fetchAccountList merges quota snapshots into unknown list rows", async () => {
    fetchMock.mockResolvedValueOnce(authFilesResponse());
    fetchMock.mockResolvedValueOnce(authDownloadResponse());
    fetchMock.mockResolvedValueOnce(quotaUsageResponse(42, 73));
    const queried = await queryCachedAccounts(demoConfig, [demoItem]);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            provider: "codex",
            name: "codex-a-latest-free.json",
            email: "latest-a@example.com",
            plan_type: "free",
            chatgpt_account_id: "acct-a-latest",
            auth_index: "idx-a",
            priority: "77",
          },
        ],
      }),
    );

    const payload = await fetchAccountList(demoConfig);

    expect(payload.items[0]).toEqual(
      expect.objectContaining({
        name: "codex-a-latest-free.json",
        email: "latest-a@example.com",
        account_id: "acct-a-latest",
        priority: 77,
        status: "healthy",
        last_query_at: queried.items[0].last_query_at,
        quota_updated_at: queried.items[0].quota_updated_at,
        windows: expect.arrayContaining([expect.objectContaining({ id: "code-7d", remaining_percent: 73 })]),
      }),
    );
  });

  it("clearLocalCache clears quota snapshots", async () => {
    fetchMock.mockResolvedValueOnce(authFilesResponse());
    fetchMock.mockResolvedValueOnce(authDownloadResponse());
    fetchMock.mockResolvedValueOnce(quotaUsageResponse(33, 66));
    await queryCachedAccounts(demoConfig, [demoItem]);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        files: [{ provider: "codex", name: "codex-a@example.com-free.json", auth_index: "idx-a", priority: "10" }],
      }),
    );
    const beforeClear = await fetchAccountList(demoConfig);

    await clearLocalCache();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        files: [{ provider: "codex", name: "codex-a@example.com-free.json", auth_index: "idx-a", priority: "10" }],
      }),
    );
    const afterClear = await fetchAccountList(demoConfig);

    expect(beforeClear.items[0]).toEqual(
      expect.objectContaining({
        status: "healthy",
        quota_updated_at: expect.any(String),
        windows: expect.arrayContaining([expect.objectContaining({ id: "code-7d", remaining_percent: 66 })]),
      }),
    );
    expect(afterClear.items[0]).toEqual(
      expect.objectContaining({
        status: "unknown",
        quota_updated_at: null,
        windows: [],
      }),
    );
  });

  it("queryCachedAccounts 在单账号 CPA 请求卡住时会超时收敛成错误结果", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(authFilesResponse());
    fetchMock.mockResolvedValueOnce(authDownloadResponse());
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const progress: Array<{ completed: number; total: number; currentLabel: string }> = [];
    const queryPromise = queryCachedAccounts(demoConfig, [demoItem], (event) => progress.push(event));
    let settled = false;
    queryPromise.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(31_000);
    await Promise.resolve();

    expect(settled).toBe(true);
    const payload = await queryPromise;
    expect(payload.items[0]).toEqual(
      expect.objectContaining({
        auth_index: "idx-a",
        status: "error",
        error: "CPA 管理接口请求超时（30 秒）",
      }),
    );
    expect(progress).toEqual([expect.objectContaining({ completed: 1, total: 1, currentLabel: "a@example.com" })]);
  });

  it("downloadSelectedAccounts 在浏览器里下载远端账号文件而不是要求本地路径", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ email: "a@example.com" }));

    const progress: Array<{ completed: number; total: number; currentLabel: string }> = [];
    const downloaded = await downloadSelectedAccounts(demoConfig, [demoItem], (event) => progress.push(event));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("https://cpa.example/v0/management/auth-files/download?name=codex-a%40example.com-free.json");
    expect(init.method).toBe("GET");
    expect(downloaded).toEqual([
      {
        name: "codex-a@example.com-free.json",
        destinationPath: "browser-download:codex-a@example.com-free.json",
      },
    ]);
    expect(progress).toEqual([expect.objectContaining({ completed: 1, total: 1, currentLabel: "codex-a@example.com-free.json" })]);
  });

  it("startCodexOAuth 通过 CPA 管理接口生成 WebUI OAuth 链接", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      url: "https://auth.openai.com/oauth?state=oauth-state-1",
    }));

    const result = await startCodexOAuth(demoConfig);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("https://cpa.example/v0/management/codex-auth-url?is_webui=true");
    expect(init.method).toBe("GET");
    expect(result).toEqual({
      authUrl: "https://auth.openai.com/oauth?state=oauth-state-1",
      state: "oauth-state-1",
      raw: { url: "https://auth.openai.com/oauth?state=oauth-state-1" },
    });
  });

  it("pollCodexOAuthStatus 通过 state 查询 CPA OAuth 登录状态", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      status: "success",
      email: "a@hotmail.com",
      message: "认证成功",
    }));

    const result = await pollCodexOAuthStatus(demoConfig, "oauth-state-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("https://cpa.example/v0/management/get-auth-status?state=oauth-state-1");
    expect(init.method).toBe("GET");
    expect(result).toEqual(expect.objectContaining({
      state: "oauth-state-1",
      status: "success",
      email: "a@hotmail.com",
      message: "认证成功",
    }));
  });

  it("submitCodexOAuthCallback 通过 CPA 管理接口提交 Codex OAuth 回调 URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ok" }));

    const result = await submitCodexOAuthCallback(
      demoConfig,
      "oauth-state-1",
      "http://localhost:1455/auth/callback?code=oauth-code&state=oauth-state-1",
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("https://cpa.example/v0/management/oauth-callback");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      provider: "codex",
      redirect_url: "http://localhost:1455/auth/callback?code=oauth-code&state=oauth-state-1",
      state: "oauth-state-1",
    });
    expect(result).toEqual(expect.objectContaining({
      status: "success",
      message: "回调 URL 已提交",
    }));
  });

  it("fetchHotmailVerificationCode 通过 CPA api-call 对接 Microsoft API 获取验证码", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        status_code: 200,
        body: JSON.stringify({
          access_token: "microsoft-access-token",
          refresh_token: "next-refresh-token",
        }),
      }))
      .mockResolvedValueOnce(jsonResponse({
        status_code: 200,
        body: JSON.stringify({
          value: [
            {
              id: "message-1",
              subject: "Your temporary ChatGPT verification code",
              from: { emailAddress: { address: "noreply@tm.openai.com", name: "OpenAI" } },
              bodyPreview: "Enter this temporary verification code to continue: 123456",
              receivedDateTime: "2026-05-06T04:45:00Z",
            },
          ],
        }),
      }));

    const result = await fetchHotmailVerificationCode({
      config: demoConfig,
      helperUrl: "http://127.0.0.1:17373/",
      account: {
        id: "a@hotmail.com::client-id",
        email: "a@hotmail.com",
        clientId: "client-id",
        refreshToken: "refresh-token",
        status: "authorized",
      },
      filterAfterTimestamp: 1770000000000,
      excludeCodes: ["000000"],
      mailboxes: ["INBOX"],
      authIndex: "idx-a",
    });
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [messagesUrl, messagesInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const tokenBody = JSON.parse(String(tokenInit.body));
    const messagesBody = JSON.parse(String(messagesInit.body));

    expect(tokenUrl).toBe("https://cpa.example/v0/management/api-call");
    expect(tokenBody).toEqual(expect.objectContaining({
      auth_index: "idx-a",
      method: "POST",
      url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      data: expect.stringContaining("refresh_token=refresh-token"),
    }));
    expect(messagesUrl).toBe("https://cpa.example/v0/management/api-call");
    expect(messagesBody).toEqual(expect.objectContaining({
      auth_index: "idx-a",
      method: "GET",
      url: expect.stringContaining("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?"),
      header: expect.objectContaining({
        Authorization: "Bearer microsoft-access-token",
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      code: "123456",
      nextRefreshToken: "next-refresh-token",
      transport: "graph",
    }));
  });

  it("fetchHotmailVerificationCode 在 CPA 代理 Microsoft API 失败时返回可操作的中文错误", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(fetchHotmailVerificationCode({
      config: demoConfig,
      helperUrl: "http://127.0.0.1:17373",
      account: {
        id: "a@hotmail.com::client-id",
        email: "a@hotmail.com",
        clientId: "client-id",
        refreshToken: "refresh-token",
        status: "authorized",
      },
    })).rejects.toThrow("CPA 代理 Microsoft API 请求失败");
  });

  it("syncAccountPriorities 在浏览器里直接 PATCH CPA fields 接口", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));

    const progress: Array<{ completed: number; total: number; currentLabel: string }> = [];
    await syncAccountPriorities(demoConfig, [{ name: "codex-a@example.com-free.json", priority: 77 }], (event) => {
      progress.push(event);
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("https://cpa.example/v0/management/auth-files/fields");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ name: "codex-a@example.com-free.json", priority: 77 });
    expect(progress).toEqual([expect.objectContaining({ completed: 1, total: 1, currentLabel: "codex-a@example.com-free.json" })]);
  });

  it("runKeeperDirectAction 可以直接禁用选中的证书", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));

    const progress: Array<{ completed: number; total: number; currentLabel: string }> = [];
    const result = await runKeeperDirectAction(demoConfig, [demoItem], "disable", (event) => progress.push(event));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("https://cpa.example/v0/management/auth-files/status");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ name: "codex-a@example.com-free.json", disabled: true });
    expect(result.summary).toEqual(expect.objectContaining({ dry_run: false, total: 1, disabled: 1, errors: 0 }));
    expect(result.items[0]).toEqual(expect.objectContaining({ action: "disable", applied: true, reason: "已手动禁用证书" }));
    expect(progress).toEqual([expect.objectContaining({ completed: 1, total: 1, currentLabel: "a@example.com" })]);
  });

  it("runKeeperDirectAction 可以直接删除选中的证书", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));

    const result = await runKeeperDirectAction(demoConfig, [demoItem], "delete");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("https://cpa.example/v0/management/auth-files?name=codex-a%40example.com-free.json");
    expect(init.method).toBe("DELETE");
    expect(result.summary).toEqual(expect.objectContaining({ dry_run: false, total: 1, dead: 1, errors: 0 }));
    expect(result.items[0]).toEqual(expect.objectContaining({ action: "delete", applied: true, reason: "已手动删除证书" }));
  });

  it("runKeeperDirectAction 可以直接刷新选中的证书", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T00:00:00Z"));
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          email: "a@example.com",
          access_token: "old-access-token",
          refresh_token: "old-refresh-token",
          id_token: "old-id-token",
          account_id: "acct-a",
          disabled: true,
          expired: "2026-05-04T00:00:00Z",
          type: "codex",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status_code: 200,
          body: JSON.stringify({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            id_token: "new-id-token",
            expires_in: 864000,
          }),
        }),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    const result = await runKeeperDirectAction(demoConfig, [demoItem], "refresh");
    const [downloadUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [refreshUrl, refreshInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    const [statusUrl, statusInit] = fetchMock.mock.calls[3] as [string, RequestInit];
    const uploadedAuth = JSON.parse(String(uploadInit.body));

    expect(downloadUrl).toBe("https://cpa.example/v0/management/auth-files/download?name=codex-a%40example.com-free.json");
    expect(refreshUrl).toBe("https://cpa.example/v0/management/api-call");
    expect(JSON.parse(String(refreshInit.body))).toEqual(
      expect.objectContaining({
        method: "POST",
        url: "https://auth.openai.com/oauth/token",
        data: expect.stringContaining("old-refresh-token"),
      }),
    );
    expect(uploadUrl).toBe("https://cpa.example/v0/management/auth-files?name=codex-a%40example.com-free.json");
    expect(uploadedAuth).toEqual(
      expect.objectContaining({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        id_token: "new-id-token",
        expired: "2026-05-13T00:00:00.000Z",
        last_refresh: "2026-05-03T00:00:00.000Z",
      }),
    );
    expect(statusUrl).toBe("https://cpa.example/v0/management/auth-files/status");
    expect(JSON.parse(String(statusInit.body))).toEqual({ name: "codex-a@example.com-free.json", disabled: true });
    expect(result.summary).toEqual(expect.objectContaining({ dry_run: false, total: 1, refreshed: 1, errors: 0 }));
    expect(result.items[0]).toEqual(expect.objectContaining({ action: "refresh", applied: true, refreshed: true, reason: "已手动刷新证书" }));
  });

  it("runKeeperMaintenance 演练模式会生成禁用动作但不写远端", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          email: "a@example.com",
          access_token: "access-token",
          refresh_token: "refresh-token",
          account_id: "acct-a",
          disabled: false,
          expired: "2099-01-01T00:00:00Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status_code: 200,
          body: JSON.stringify({
            plan_type: "free",
            rate_limit: {
              primary_window: { used_percent: 100, limit_window_seconds: 604800 },
              secondary_window: null,
            },
            credits: { has_credits: false },
          }),
        }),
      );

    const result = await runKeeperMaintenance(demoConfig, [demoItem], { dryRun: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.summary).toEqual(expect.objectContaining({ dry_run: true, total: 1, disabled: 1, dead: 0 }));
    expect(result.items[0]).toEqual(expect.objectContaining({ action: "disable", applied: false, reason: "Week额度 100% >= 100%" }));
  });

  it("runKeeperMaintenance 执行模式会刷新已禁用且临近过期的 token 并上传回 CPA", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T00:00:00Z"));
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          email: "a@example.com",
          access_token: "old-access-token",
          refresh_token: "old-refresh-token",
          id_token: "old-id-token",
          account_id: "acct-a",
          disabled: true,
          expired: "2026-05-04T00:00:00Z",
          type: "codex",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status_code: 200,
          body: JSON.stringify({
            plan_type: "free",
            rate_limit: {
              primary_window: { used_percent: 100, limit_window_seconds: 604800 },
              secondary_window: null,
            },
            credits: { has_credits: false },
          }),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status_code: 200,
          body: JSON.stringify({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            id_token: "new-id-token",
            expires_in: 864000,
          }),
        }),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    const result = await runKeeperMaintenance(demoConfig, [demoItem], { dryRun: false });
    const [refreshUrl, refreshInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    const refreshBody = JSON.parse(String(refreshInit.body));
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[3] as [string, RequestInit];
    const uploadedAuth = JSON.parse(String(uploadInit.body));
    const [statusUrl, statusInit] = fetchMock.mock.calls[4] as [string, RequestInit];

    expect(refreshUrl).toBe("https://cpa.example/v0/management/api-call");
    expect(refreshBody).toEqual(
      expect.objectContaining({
        method: "POST",
        url: "https://auth.openai.com/oauth/token",
        data: expect.stringContaining("old-refresh-token"),
      }),
    );
    expect(uploadUrl).toBe("https://cpa.example/v0/management/auth-files?name=codex-a%40example.com-free.json");
    expect(uploadInit.method).toBe("POST");
    expect(uploadedAuth).toEqual(
      expect.objectContaining({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        id_token: "new-id-token",
        expired: "2026-05-13T00:00:00.000Z",
        last_refresh: "2026-05-03T00:00:00.000Z",
      }),
    );
    expect(statusUrl).toBe("https://cpa.example/v0/management/auth-files/status");
    expect(JSON.parse(String(statusInit.body))).toEqual({ name: "codex-a@example.com-free.json", disabled: true });
    expect(result.summary).toEqual(expect.objectContaining({ dry_run: false, total: 1, refreshed: 1, refresh_candidates: 1 }));
    expect(result.items[0]).toEqual(expect.objectContaining({ action: "refresh", applied: true, refresh_candidate: true, outcome: "alive" }));
  });

  it("loadRuntimeConfig 会把旧 localStorage key 迁移到固定缓存命名空间", async () => {
    window.localStorage.setItem(
      "cpa-quota-desk.runtime-config",
      JSON.stringify({
        cpaBaseUrl: "https://legacy.example/",
        managementKey: "legacy-key",
        queryConcurrency: 5,
      }),
    );

    const config = await loadRuntimeConfig();

    expect(config.cpaBaseUrl).toBe("https://legacy.example/");
    expect(config.managementKey).toBe("legacy-key");
    expect(window.localStorage.getItem("cpa-quota-desk.runtime-config")).toBeNull();
    expect(window.localStorage.getItem("cpa_codex_quota_cache.runtime-config")).toContain("legacy-key");
  });

  it("savePayloadCache 和 loadPayloadCache 在浏览器里使用 IndexedDB 而不是 localStorage payload", async () => {
    await savePayloadCache(demoPayload("healthy"));

    const payload = await loadPayloadCache();

    expect(payload?.items[0].auth_index).toBe("idx-a");
    expect(window.localStorage.getItem(WEB_PAYLOAD_CACHE_KEY)).toBeNull();
    expect(window.localStorage.getItem(LEGACY_WEB_PAYLOAD_CACHE_KEY)).toBeNull();
  });

  it("loadPayloadCache 会把旧 localStorage payload 迁移到 IndexedDB 并删除旧 key", async () => {
    window.localStorage.setItem(WEB_PAYLOAD_CACHE_KEY, JSON.stringify(demoPayload("low")));

    const payload = await loadPayloadCache();

    expect(payload?.items[0]).toEqual(expect.objectContaining({ auth_index: "idx-a", status: "low" }));
    expect(window.localStorage.getItem(WEB_PAYLOAD_CACHE_KEY)).toBeNull();

    window.localStorage.clear();
    const migratedPayload = await loadPayloadCache();

    expect(migratedPayload?.items[0]).toEqual(expect.objectContaining({ auth_index: "idx-a", status: "low" }));
  });

  it("old Web payloads without quota_updated_at normalize to null", async () => {
    window.localStorage.setItem(
      WEB_PAYLOAD_CACHE_KEY,
      JSON.stringify({
        ...demoPayload("healthy"),
        items: [{ ...demoItem, quota_updated_at: undefined }],
      }),
    );

    const payload = await loadPayloadCache();

    expect(payload?.items[0]).toEqual(expect.objectContaining({ auth_index: "idx-a", quota_updated_at: null }));
  });

  it("cached Web payloads with old query-time quota_updated_at are corrected from the 5h reset label", async () => {
    window.localStorage.setItem(
      WEB_PAYLOAD_CACHE_KEY,
      JSON.stringify({
        ...demoPayload("healthy"),
        items: [
          {
            ...demoItem,
            windows: [
              {
                id: "code-5h",
                label: "5h",
                used_percent: 0,
                remaining_percent: 100,
                reset_label: "05-03 18:53",
                exhausted: false,
              },
            ],
            quota_updated_at: "2026-05-03T14:22:00+08:00",
          },
        ],
      }),
    );

    const payload = await loadPayloadCache();

    expect(payload?.items[0]).toEqual(expect.objectContaining({ auth_index: "idx-a", quota_updated_at: "05-03 18:53" }));
  });

  it("loadPayloadCache 会迁移更早的 legacy localStorage payload key", async () => {
    window.localStorage.setItem(LEGACY_WEB_PAYLOAD_CACHE_KEY, JSON.stringify(demoPayload("exhausted")));

    const payload = await loadPayloadCache();

    expect(payload?.items[0]).toEqual(expect.objectContaining({ auth_index: "idx-a", status: "exhausted" }));
    expect(window.localStorage.getItem(LEGACY_WEB_PAYLOAD_CACHE_KEY)).toBeNull();
    expect(window.localStorage.getItem(WEB_PAYLOAD_CACHE_KEY)).toBeNull();
  });

  it("loadPayloadCache 在 IndexedDB 不可用时仍回退读取旧 localStorage payload", async () => {
    vi.stubGlobal("indexedDB", createFailingIndexedDB());
    window.localStorage.setItem(WEB_PAYLOAD_CACHE_KEY, JSON.stringify(demoPayload("healthy")));

    const payload = await loadPayloadCache();

    expect(payload?.items[0].auth_index).toBe("idx-a");
    expect(window.localStorage.getItem(WEB_PAYLOAD_CACHE_KEY)).toContain("idx-a");
  });

  it("savePayloadCache 在 IndexedDB 写入失败时不阻塞调用方", async () => {
    vi.stubGlobal("indexedDB", createFailingIndexedDB());

    await expect(savePayloadCache(demoPayload("healthy"))).resolves.toBeUndefined();
    await expect(loadPayloadCache()).resolves.toBeNull();
  });

  it("saveRuntimeConfig 使用固定缓存命名空间", async () => {
    await saveRuntimeConfig(demoConfig);

    expect(window.localStorage.getItem("cpa_codex_quota_cache.runtime-config")).toContain("example-management-key");
    expect(window.localStorage.getItem("cpa-quota-desk.runtime-config")).toBeNull();
  });

  it("clearLocalCache 会同时清掉新旧缓存命名空间", async () => {
    window.localStorage.setItem("cpa_codex_quota_cache.runtime-config", JSON.stringify(demoConfig));
    window.localStorage.setItem(WEB_PAYLOAD_CACHE_KEY, JSON.stringify({ items: [demoItem] }));
    window.localStorage.setItem("cpa-quota-desk.runtime-config", JSON.stringify({ cpaBaseUrl: "https://legacy.example/" }));
    window.localStorage.setItem(LEGACY_WEB_PAYLOAD_CACHE_KEY, JSON.stringify({ items: [] }));
    await savePayloadCache(demoPayload("healthy"));

    await clearLocalCache();

    expect(window.localStorage.getItem("cpa_codex_quota_cache.runtime-config")).toBeNull();
    expect(window.localStorage.getItem(WEB_PAYLOAD_CACHE_KEY)).toBeNull();
    expect(window.localStorage.getItem("cpa-quota-desk.runtime-config")).toBeNull();
    expect(window.localStorage.getItem(LEGACY_WEB_PAYLOAD_CACHE_KEY)).toBeNull();
    expect(await loadPayloadCache()).toBeNull();
  });
});
