import { buildCommonArgs, DEFAULT_QUERY_CONCURRENCY, normalizePayload, normalizeRuntimeConfig, parsePayloadOutput } from "./api";

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

  it("normalizes pro and pro-lite aliases into desktop plan buckets", () => {
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

describe("parsePayloadOutput", () => {
  it("supports tauri object payload directly", () => {
    const payload = parsePayloadOutput({
      meta: { total: 1, success: 1, failed: 0 },
      groups: { by_plan: { team: 1 }, by_status: { healthy: 1 } },
      items: [
        {
          name: "codex-b.json",
          email: "b@example.com",
          plan_type: "team",
          account_id: "acct-b",
          auth_index: "idx-b",
          priority: 80,
          status: "healthy",
          windows: [],
          additional_windows: [],
          error: "",
          last_query_at: "2026-04-27T01:00:00+08:00",
        },
      ],
      error: "",
    });

    expect(payload.items[0].email).toBe("b@example.com");
    expect(payload.items[0].status).toBe("healthy");
  });

  it("rejects empty string payload with readable message", () => {
    expect(() => parsePayloadOutput("   ")).toThrow("桌面端没有收到账号数据，请重新加载账号");
  });

  it("rejects broken json payload with readable message", () => {
    expect(() => parsePayloadOutput("{")).toThrow("桌面端收到的账号数据不是合法 JSON");
  });
});

describe("normalizeRuntimeConfig", () => {
  it("fills backup path and query concurrency defaults", () => {
    const config = normalizeRuntimeConfig({
      cpaBaseUrl: "https://cpa.example/",
      managementKey: "example-management-key",
    });

    expect(config.backupPath).toBe("");
    expect(config.queryConcurrency).toBe(DEFAULT_QUERY_CONCURRENCY);
    expect(config.priorityPlanOrder).toEqual(["team", "plus", "free", "pro 5x", "pro 20x", "unknown"]);
  });
});

describe("buildCommonArgs", () => {
  it("includes max-workers when query concurrency is configured", () => {
    const args = buildCommonArgs({
      cpaBaseUrl: "https://cpa.example/",
      managementKey: "example-management-key",
      backupPath: "D:\\backup",
      queryConcurrency: 4,
      priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
    });

    expect(args).toContain("--max-workers");
    expect(args).toContain("4");
  });
});
