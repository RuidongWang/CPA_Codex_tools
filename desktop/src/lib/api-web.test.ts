import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLocalCache,
  downloadSelectedAccounts,
  fetchAccountList,
  loadPayloadCache,
  loadRuntimeConfig,
  queryCachedAccounts,
  savePayloadCache,
  saveRuntimeConfig,
  syncAccountPriorities,
} from "./api";
import type { AccountItem, RuntimeConfig } from "../types";

const demoConfig: RuntimeConfig = {
  cpaBaseUrl: "https://cpa.example/",
  managementKey: "example-management-key",
  backupPath: "",
  queryConcurrency: 2,
  priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
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
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

describe("browser runtime api", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    // Web 运行时必须只走浏览器 fetch，不能再依赖 Tauri invoke 或 Python worker。
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.clear();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:codex-backup") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });

  it("fetchAccountList 在非 Tauri 环境直接读取 CPA auth-files", async () => {
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
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status_code: 200,
        body: JSON.stringify({
          plan_type: "free",
          priority: 10,
          rate_limit: {
            primary_window: { limit_window_seconds: 18000, used_percent: 40, reset_after_seconds: 3600 },
            secondary_window: { limit_window_seconds: 604800, used_percent: 10, reset_after_seconds: 7200 },
          },
        }),
      }),
    );

    const progress: Array<{ completed: number; total: number; currentLabel: string }> = [];
    const payload = await queryCachedAccounts(demoConfig, [demoItem], (event) => progress.push(event));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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
        windows: expect.arrayContaining([
          expect.objectContaining({ id: "code-5h", remaining_percent: 60 }),
          expect.objectContaining({ id: "code-7d", remaining_percent: 90 }),
        ]),
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

  it("savePayloadCache 和 loadPayloadCache 使用固定缓存命名空间", async () => {
    await savePayloadCache({
      meta: { generated_at: "2026-04-30T00:00:00Z", total: 1, success: 1, failed: 0 },
      groups: { by_plan: { free: 1 }, by_status: { healthy: 1 } },
      items: [{ ...demoItem, status: "healthy" }],
      error: "",
    });

    const payload = await loadPayloadCache();

    expect(payload?.items[0].auth_index).toBe("idx-a");
    expect(window.localStorage.getItem("cpa_codex_quota_cache.payload-cache")).toContain("idx-a");
    expect(window.localStorage.getItem("cpa-quota-desk.payload-cache")).toBeNull();
  });

  it("saveRuntimeConfig 使用固定缓存命名空间", async () => {
    await saveRuntimeConfig(demoConfig);

    expect(window.localStorage.getItem("cpa_codex_quota_cache.runtime-config")).toContain("example-management-key");
    expect(window.localStorage.getItem("cpa-quota-desk.runtime-config")).toBeNull();
  });

  it("clearLocalCache 会同时清掉新旧缓存命名空间", async () => {
    window.localStorage.setItem("cpa_codex_quota_cache.runtime-config", JSON.stringify(demoConfig));
    window.localStorage.setItem("cpa_codex_quota_cache.payload-cache", JSON.stringify({ items: [demoItem] }));
    window.localStorage.setItem("cpa-quota-desk.runtime-config", JSON.stringify({ cpaBaseUrl: "https://legacy.example/" }));
    window.localStorage.setItem("cpa-quota-desk.payload-cache", JSON.stringify({ items: [] }));

    await clearLocalCache();

    expect(window.localStorage.getItem("cpa_codex_quota_cache.runtime-config")).toBeNull();
    expect(window.localStorage.getItem("cpa_codex_quota_cache.payload-cache")).toBeNull();
    expect(window.localStorage.getItem("cpa-quota-desk.runtime-config")).toBeNull();
    expect(window.localStorage.getItem("cpa-quota-desk.payload-cache")).toBeNull();
  });
});
