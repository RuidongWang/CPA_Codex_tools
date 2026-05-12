import {
  DEFAULT_KEEPER_SETTINGS,
  DEFAULT_QUERY_CONCURRENCY,
  DEFAULT_UI_SETTINGS,
  inspectManagementBaseUrl,
  normalizePayload,
  normalizeRuntimeConfig,
} from "./api";

// 先锁住后端 payload 的最小契约，避免界面层直接依赖松散原始结构。
describe("normalizePayload", () => {
  it("keeps grouped list payload stable", () => {
    const payload = normalizePayload({
      meta: { total: 1, success: 0, failed: 0 },
      groups: { by_plan: { free: 1 }, by_status: { unknown: 1 } },
      items: [
        {
          name: "codex-a.json",
          email: "a@example.com",
          plan_type: "free",
          account_id: "acct-a",
          auth_index: "idx-a",
          priority: 99,
          status: "unknown",
          windows: [],
          additional_windows: [],
          error: "",
          last_query_at: null,
        },
      ],
      error: "",
    });

    expect(payload.meta.total).toBe(1);
    expect(payload.groups.by_plan.free).toBe(1);
    expect(payload.items[0].priority).toBe(99);
    expect(payload.items[0].status).toBe("unknown");
  });

  it("normalizes pro and pro-lite aliases into plan buckets", () => {
    const payload = normalizePayload({
      meta: { total: 4, success: 0, failed: 0 },
      groups: { by_plan: { pro: 1, prolite: 1, "pro-lite": 1, pro_lite: 1 }, by_status: { unknown: 4 } },
      items: [
        {
          name: "codex-pro.json",
          email: "pro@example.com",
          plan_type: "pro",
          account_id: "acct-pro",
          auth_index: "idx-pro",
          priority: 90,
          status: "unknown",
          windows: [],
          additional_windows: [],
          error: "",
          last_query_at: null,
        },
        {
          name: "codex-pro-lite.json",
          email: "prolite@example.com",
          plan_type: "prolite",
          account_id: "acct-prolite",
          auth_index: "idx-prolite",
          priority: 80,
          status: "unknown",
          windows: [],
          additional_windows: [],
          error: "",
          last_query_at: null,
        },
        {
          name: "codex-pro-lite-hyphen.json",
          email: "prolite-hyphen@example.com",
          plan_type: "pro-lite",
          account_id: "acct-prolite-hyphen",
          auth_index: "idx-prolite-hyphen",
          priority: 70,
          status: "unknown",
          windows: [],
          additional_windows: [],
          error: "",
          last_query_at: null,
        },
        {
          name: "codex-pro-lite-underscore.json",
          email: "prolite-underscore@example.com",
          plan_type: "pro_lite",
          account_id: "acct-prolite-underscore",
          auth_index: "idx-prolite-underscore",
          priority: 60,
          status: "unknown",
          windows: [],
          additional_windows: [],
          error: "",
          last_query_at: null,
        },
      ],
      error: "",
    });

    expect(payload.items.map((item) => item.plan_type)).toEqual(["pro 20x", "pro 5x", "pro 5x", "pro 5x"]);
  });
});

describe("normalizeRuntimeConfig", () => {
  it("fills query concurrency defaults", () => {
    const config = normalizeRuntimeConfig({
      cpaBaseUrl: "https://cpa.example/",
      managementKey: "example-management-key",
    });

    expect(config.queryConcurrency).toBe(DEFAULT_QUERY_CONCURRENCY);
    expect(config.keeperSettings).toEqual(DEFAULT_KEEPER_SETTINGS);
    expect(config.priorityPlanOrder).toEqual(["team", "plus", "free", "pro 5x", "pro 20x", "unknown"]);
    expect(config.priorityPlanRanges).toEqual({});
    expect(config.oauthSettings).toEqual({
      hotmailHelperUrl: "http://127.0.0.1:17373",
      hotmailAccounts: [],
      rememberHotmailTokens: true,
      importedInvalidAccountEmails: [],
    });
    expect(config.uiSettings).toEqual(DEFAULT_UI_SETTINGS);
  });

  it("normalizes UI settings and rejects unsupported values", () => {
    expect(normalizeRuntimeConfig({ uiSettings: { themeMode: "light", language: "en" } }).uiSettings).toEqual({
      themeMode: "light",
      language: "en",
    });
    expect(normalizeRuntimeConfig({ uiSettings: { themeMode: "sepia", language: "jp" } as never }).uiSettings).toEqual(DEFAULT_UI_SETTINGS);
  });

  it("normalizes keeper settings into safe bounds", () => {
    const config = normalizeRuntimeConfig({
      cpaBaseUrl: "https://cpa.example/",
      managementKey: "example-management-key",
      keeperSettings: {
        quotaThreshold: 180,
        expiryThresholdDays: -1,
        enableRefresh: false,
        workerThreads: 0,
      },
    });

    expect(config.keeperSettings).toEqual({
      quotaThreshold: 100,
      expiryThresholdDays: 0,
      enableRefresh: false,
      workerThreads: 1,
    });
  });

  it("normalizes priority plan ranges and drops invalid entries", () => {
    const config = normalizeRuntimeConfig({
      cpaBaseUrl: "https://cpa.example/",
      managementKey: "example-management-key",
      priorityPlanRanges: {
        free: { minPriority: 20, maxPriority: 1 },
        team: { minPriority: "10", maxPriority: "20" } as never,
        plus: { minPriority: "abc", maxPriority: 5 } as never,
      },
    });

    expect(config.priorityPlanRanges).toEqual({
      team: { minPriority: 10, maxPriority: 20 },
      free: { minPriority: 1, maxPriority: 20 },
    });
  });
});

describe("inspectManagementBaseUrl", () => {
  it("rejects invalid URL syntax and embedded credentials", () => {
    expect(inspectManagementBaseUrl("https://")).toEqual(
      expect.objectContaining({
        valid: false,
        warning: expect.stringContaining("CPA 地址格式无效"),
      }),
    );
    expect(inspectManagementBaseUrl("https://user:pass@cpa.example/")).toEqual(
      expect.objectContaining({
        valid: false,
        warning: expect.stringContaining("不能包含用户名或密码"),
      }),
    );
  });

  it("rejects non-http protocols before management requests are built", () => {
    const safety = inspectManagementBaseUrl("javascript:alert(1)");

    expect(safety.valid).toBe(false);
    expect(safety.warning).toContain("仅支持 HTTP 或 HTTPS");
  });

  it("warns when a management key would be sent over non-local HTTP", () => {
    expect(inspectManagementBaseUrl("http://134.185.91.116:8317").warning).toContain("非 HTTPS");
    expect(inspectManagementBaseUrl("http://127.0.0.1:8317").warning).toBe("");
    expect(inspectManagementBaseUrl("https://cpa.example/").warning).toBe("");
  });
});
