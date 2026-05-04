import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import App from "./App";
import { README_DEMO_CONFIG } from "./lib/readme-demo";

const { listPayload, mockApi } = vi.hoisted(() => ({
  listPayload: {
    meta: {
      generated_at: "2026-04-25T01:00:00+08:00",
      total: 3,
      success: 0,
      failed: 0,
    },
    groups: {
      by_plan: { free: 1, team: 2 },
      by_status: { unknown: 3 },
    },
    items: [
      {
        name: "codex-free.json",
        email: "free@example.com",
        plan_type: "free",
        account_id: "acct-free",
        auth_index: "idx-free",
        priority: 99,
        status: "unknown" as const,
        windows: [],
        additional_windows: [],
        error: "",
        last_query_at: null,
        quota_updated_at: null,
      },
      {
        name: "codex-team-a.json",
        email: "team-a@example.com",
        plan_type: "team",
        account_id: "acct-team-a",
        auth_index: "idx-team-a",
        priority: 80,
        status: "unknown" as const,
        windows: [],
        additional_windows: [],
        error: "",
        last_query_at: null,
        quota_updated_at: null,
      },
      {
        name: "codex-team-b.json",
        email: "team-b@example.com",
        plan_type: "team",
        account_id: "acct-team-b",
        auth_index: "idx-team-b",
        priority: 79,
        status: "unknown" as const,
        windows: [],
        additional_windows: [],
        error: "",
        last_query_at: null,
        quota_updated_at: null,
      },
    ],
    error: "",
  },
  mockApi: {
    loadRuntimeConfig: vi.fn(),
    loadPayloadCache: vi.fn(),
    saveRuntimeConfig: vi.fn(),
    savePayloadCache: vi.fn(),
    clearLocalCache: vi.fn(),
    fetchAccountList: vi.fn(),
    queryCachedAccounts: vi.fn(),
    runKeeperDirectAction: vi.fn(),
    runKeeperMaintenance: vi.fn(),
    downloadSelectedAccounts: vi.fn(),
    querySingleAccount: vi.fn(),
    syncAccountPriorities: vi.fn(),
  },
}));

vi.mock("./lib/api", () => ({
  DEFAULT_CPA_BASE_URL: "https://cpa.example/",
  DEFAULT_QUERY_CONCURRENCY: 6,
  DEFAULT_KEEPER_SETTINGS: {
    quotaThreshold: 100,
    expiryThresholdDays: 3,
    enableRefresh: true,
    workerThreads: 6,
  },
  loadRuntimeConfig: mockApi.loadRuntimeConfig,
  loadPayloadCache: mockApi.loadPayloadCache,
  saveRuntimeConfig: mockApi.saveRuntimeConfig,
  savePayloadCache: mockApi.savePayloadCache,
  clearLocalCache: mockApi.clearLocalCache,
  fetchAccountList: mockApi.fetchAccountList,
  queryCachedAccounts: mockApi.queryCachedAccounts,
  runKeeperDirectAction: mockApi.runKeeperDirectAction,
  runKeeperMaintenance: mockApi.runKeeperMaintenance,
  downloadSelectedAccounts: mockApi.downloadSelectedAccounts,
  querySingleAccount: mockApi.querySingleAccount,
  syncAccountPriorities: mockApi.syncAccountPriorities,
}));

// 批量返回值按 auth_index 回填，确保一次 checker 调用后的列表合并仍然可验证。
function buildQueryPayload(authIndexes: string[]) {
  const quotaByAuthIndex: Record<string, { quota5h: number; quota7d: number; queriedAt: string; reset5h: string; reset7d: string }> = {
    "idx-free": {
      quota5h: 80,
      quota7d: 60,
      queriedAt: "2026-04-25T01:05:00+08:00",
      reset5h: "04-25 06:00",
      reset7d: "04-29 06:00",
    },
    "idx-team-a": {
      quota5h: 45,
      quota7d: 90,
      queriedAt: "2026-04-25T01:08:00+08:00",
      reset5h: "04-25 07:30",
      reset7d: "04-29 07:30",
    },
    "idx-team-b": {
      quota5h: 20,
      quota7d: 35,
      queriedAt: "2026-04-25T01:12:00+08:00",
      reset5h: "04-25 09:00",
      reset7d: "04-29 09:00",
    },
  };
  const items = authIndexes.map((authIndex) => {
    const item = listPayload.items.find((candidate) => candidate.auth_index === authIndex);
    if (!item) {
      throw new Error(`unknown auth index: ${authIndex}`);
    }
    const quota = quotaByAuthIndex[authIndex];
    return {
      ...item,
      status: "healthy" as const,
      windows: [
        {
          id: "code-5h",
          label: "代码 5h",
          used_percent: quota ? 100 - quota.quota5h : 20,
          remaining_percent: quota?.quota5h ?? 80,
          reset_label: quota?.reset5h ?? "04-25 06:00",
          exhausted: false,
        },
        {
          id: "code-7d",
          label: "代码 7d",
          used_percent: quota ? 100 - quota.quota7d : 40,
          remaining_percent: quota?.quota7d ?? 60,
          reset_label: quota?.reset7d ?? "04-29 06:00",
          exhausted: false,
        },
      ],
      last_query_at: quota?.queriedAt ?? "2026-04-25T01:05:00+08:00",
      quota_updated_at: quota?.reset5h ?? "04-25 06:00",
    };
  });

  return {
    ...listPayload,
    meta: { generated_at: "2026-04-25T01:05:00+08:00", total: items.length, success: items.length, failed: 0 },
    groups: {
      by_plan: items.reduce<Record<string, number>>((result, item) => {
        result[item.plan_type] = (result[item.plan_type] ?? 0) + 1;
        return result;
      }, {}),
      by_status: { healthy: items.length },
    },
    items,
    error: "",
  };
}

type MockItem = (typeof listPayload.items)[number];

function makeItem(overrides: Partial<MockItem> = {}): MockItem {
  // 单测优先复用已有账号形状，避免每个用例都手写完整 payload。
  return {
    ...listPayload.items[0],
    name: "codex-free.json",
    email: "free@example.com",
    plan_type: "free",
    account_id: "acct-free",
    auth_index: "idx-free",
    priority: 99,
    remote_priority: 99,
    draft_priority: undefined,
    dirty_priority: false,
    status: "unknown",
    windows: [],
    additional_windows: [],
    error: "",
    last_query_at: null,
    quota_updated_at: null,
    ...overrides,
  };
}

function makePayload(overrides: Partial<typeof listPayload> & { items?: MockItem[] } = {}) {
  const items = overrides.items ?? [makeItem()];
  return {
    ...listPayload,
    meta: {
      generated_at: "2026-04-25T01:00:00+08:00",
      total: items.length,
      success: 0,
      failed: 0,
      ...overrides.meta,
    },
    groups: {
      by_plan: items.reduce<Record<string, number>>((result, item) => {
        result[item.plan_type] = (result[item.plan_type] ?? 0) + 1;
        return result;
      }, {}),
      by_status: items.reduce<Record<string, number>>((result, item) => {
        result[item.status] = (result[item.status] ?? 0) + 1;
        return result;
      }, {}),
      ...overrides.groups,
    },
    items,
    error: overrides.error ?? "",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState({}, "", "/");
  mockApi.loadRuntimeConfig.mockResolvedValue({
    cpaBaseUrl: "https://cpa.example/",
    managementKey: "demo-key",
    queryConcurrency: 6,
    priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
  });
  mockApi.loadPayloadCache.mockResolvedValue(null);
  mockApi.saveRuntimeConfig.mockResolvedValue(undefined);
  mockApi.savePayloadCache.mockResolvedValue(undefined);
  mockApi.clearLocalCache.mockResolvedValue(undefined);
  mockApi.fetchAccountList.mockResolvedValue(listPayload);
  mockApi.queryCachedAccounts.mockImplementation(async (_config, items: typeof listPayload.items) => buildQueryPayload(items.map((item) => item.auth_index)));
  mockApi.runKeeperDirectAction.mockImplementation(async (_config, items: typeof listPayload.items, action: "disable" | "refresh" | "delete") => ({
    summary: {
      generated_at: "2026-04-25T01:11:00+08:00",
      dry_run: false,
      total: items.length,
      alive: action === "delete" ? 0 : items.length,
      dead: action === "delete" ? items.length : 0,
      disabled: action === "disable" ? items.length : 0,
      enabled: 0,
      refreshed: action === "refresh" ? items.length : 0,
      refresh_candidates: 0,
      skipped: 0,
      network_error: 0,
      errors: 0,
    },
    items: items.map((item) => ({
      name: item.name,
      email: item.email,
      auth_index: item.auth_index,
      plan_type: item.plan_type,
      disabled: action === "disable",
      expired: item.expired ?? "",
      remaining_label: "已处理",
      has_refresh_token: Boolean(item.has_refresh_token),
      primary_label: "",
      primary_used_percent: null,
      secondary_label: "",
      secondary_used_percent: null,
      action,
      outcome: action === "delete" ? "dead" : "alive",
      applied: true,
      refresh_candidate: false,
      refreshed: action === "refresh",
      reason: action === "disable" ? "已手动禁用证书" : action === "refresh" ? "已手动刷新证书" : "已手动删除证书",
    })),
  }));
  mockApi.runKeeperMaintenance.mockResolvedValue({
    summary: {
      generated_at: "2026-04-25T01:10:00+08:00",
      dry_run: true,
      total: 3,
      alive: 2,
      dead: 1,
      disabled: 1,
      enabled: 0,
      refreshed: 0,
      refresh_candidates: 0,
      skipped: 0,
      network_error: 0,
      errors: 0,
    },
    items: [
      {
        name: "codex-free.json",
        email: "free@example.com",
        auth_index: "idx-free",
        plan_type: "free",
        disabled: false,
        expired: "2099-01-01T00:00:00Z",
        remaining_label: "99天",
        has_refresh_token: true,
        primary_label: "Week",
        primary_used_percent: 100,
        secondary_label: "",
        secondary_used_percent: null,
        action: "disable",
        outcome: "alive",
        applied: false,
        refresh_candidate: false,
        refreshed: false,
        reason: "Week额度 100% >= 100%",
      },
    ],
  });
  mockApi.downloadSelectedAccounts.mockResolvedValue([]);
  mockApi.syncAccountPriorities.mockResolvedValue(undefined);
});

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.useRealTimers();
});

describe("App", () => {
  it("README 演示模式会直接加载虚构数据而不是请求真实接口", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?demo=readme");

    render(<App />);

    expect(await screen.findByText("已载入 README 演示数据")).toBeInTheDocument();
    expect(screen.getByText("ops-team-alpha@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "配置页面" }));
    expect(screen.getByDisplayValue(README_DEMO_CONFIG.cpaBaseUrl)).toBeInTheDocument();
    expect(mockApi.fetchAccountList).not.toHaveBeenCalled();
    expect(mockApi.loadRuntimeConfig).not.toHaveBeenCalled();
  });

  it("CPA 地址留空时不会再自动加载账号，而是等待补齐管理配置", async () => {
    mockApi.loadRuntimeConfig.mockResolvedValueOnce({
      cpaBaseUrl: "",
      managementKey: "demo-key",
      queryConcurrency: 6,
      priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
    });

    render(<App />);

    expect(await screen.findByText("等待输入管理配置")).toBeInTheDocument();
    expect(screen.queryByText("free@example.com")).not.toBeInTheDocument();
    expect(mockApi.fetchAccountList).not.toHaveBeenCalled();
  });

  it("初始化失败时会展示 Rust 返回的具体错误", async () => {
    mockApi.loadRuntimeConfig.mockRejectedValueOnce("配置目录不可用");

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("配置目录不可用");
  });

  it("加载账号后展示中文监控台和中文表头", async () => {
    render(<App />);

    expect((await screen.findAllByText("Codex 额度监控台")).length).toBe(1);
    expect(screen.queryByText("全局额度监控")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("https://cpa.example/")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("按邮箱搜索")).toBeInTheDocument();
    expect(await screen.findByText("free@example.com")).toBeInTheDocument();
    expect(screen.getAllByText("free").length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "邮箱" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "分组" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "状态" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "5h 额度" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "7d 额度" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "额度更新时间" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "优先级" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "更新时间" })).toBeInTheDocument();
    expect(screen.getByText("99")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查询筛选结果 (3)" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("docs")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("support")).not.toBeInTheDocument();
    expect(screen.queryByText("notifications")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开设置" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "status-all" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("状态摘要")).not.toBeInTheDocument();
    expect(screen.queryByText("3 个结果")).not.toBeInTheDocument();
    expect(screen.queryByText("0 已选")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "all" })).toHaveTextContent("全部");
    expect(screen.getByRole("button", { name: "free" })).toHaveTextContent("free");
    expect(screen.getByRole("button", { name: "plus" })).toHaveTextContent("plus");
    expect(screen.getByRole("button", { name: "team" })).toHaveTextContent("team");
    expect(screen.getByRole("button", { name: "unknown" })).toHaveTextContent("未知");
    expect(screen.queryByText("额度巡检主表")).not.toBeInTheDocument();
  });

  it("计划筛选移动到主内容横向筛选条", async () => {
    render(<App />);

    expect(await screen.findByText("free@example.com")).toBeInTheDocument();
    const pageNav = screen.getByRole("navigation", { name: "页面导航" });
    const planFilterBar = screen.getByRole("navigation", { name: "计划筛选" });

    expect(planFilterBar).toHaveClass("plan-filter-strip");
    expect(within(planFilterBar).getByRole("button", { name: "all" })).toHaveTextContent("全部");
    expect(within(planFilterBar).getByRole("button", { name: "free" })).toHaveTextContent("free");
    expect(within(planFilterBar).getByRole("button", { name: "team" })).toHaveTextContent("team");
    expect(within(planFilterBar).getByPlaceholderText("按邮箱搜索")).toBeInTheDocument();
    expect(within(pageNav).queryByRole("button", { name: "free" })).not.toBeInTheDocument();
  });

  it("连接配置放在独立配置页面", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("free@example.com")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("https://cpa.example/")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "配置页面" }));

    const configPage = screen.getByRole("region", { name: "配置页面" });
    expect(within(configPage).getByRole("region", { name: "连接配置" })).toBeInTheDocument();
    expect(within(configPage).getByDisplayValue("https://cpa.example/")).toBeInTheDocument();
    expect(within(configPage).getByDisplayValue("demo-key")).toBeInTheDocument();

    await user.click(within(configPage).getByRole("button", { name: "保存配置" }));

    await waitFor(() => {
      expect(mockApi.saveRuntimeConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          cpaBaseUrl: "https://cpa.example/",
          managementKey: "demo-key",
        }),
      );
    });
  });

  it("新版监控台展示操作台、账号列表和排障详情分区标题", async () => {
    render(<App />);

    expect(await screen.findByText("free@example.com")).toBeInTheDocument();
    expect(screen.getByText("操作台")).toBeInTheDocument();
    expect(screen.getByText("账号列表")).toBeInTheDocument();
    expect(screen.queryByText("账号维护监控")).not.toBeInTheDocument();
    expect(screen.queryByText("排障详情")).not.toBeInTheDocument();
    expect(screen.queryByText("当前账号")).not.toBeInTheDocument();
  });

  it("Keeper 放在独立操作页面中", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("free@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keeper页面" }));

    const keeperPage = screen.getByRole("region", { name: "Keeper 操作页面" });
    expect(within(keeperPage).getByText("账号维护监控")).toBeInTheDocument();
    expect(within(keeperPage).getByText("刷新配置")).toBeInTheDocument();
    expect(within(keeperPage).getByText("账号列表")).toBeInTheDocument();
    expect(within(keeperPage).getByText("free@example.com")).toBeInTheDocument();
    expect(within(keeperPage).queryByText("等待 Keeper 运行结果")).not.toBeInTheDocument();
  });

  it("Keeper 页可以对账号列表选中项直接禁用、刷新和删除证书", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("free@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keeper页面" }));

    const keeperPage = screen.getByRole("region", { name: "Keeper 操作页面" });
    expect(within(keeperPage).getByRole("button", { name: "设置禁用 (0)" })).toBeDisabled();

    await user.click(within(keeperPage).getByRole("checkbox", { name: "选择 free@example.com" }));
    await user.click(within(keeperPage).getByRole("button", { name: "设置禁用 (1)" }));

    await waitFor(() => {
      expect(mockApi.runKeeperDirectAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ managementKey: "demo-key" }),
        [expect.objectContaining({ auth_index: "idx-free" })],
        "disable",
        expect.any(Function),
      );
    });
    expect(await screen.findByText("已禁用 1 个选中证书")).toBeInTheDocument();
    await waitFor(() => expect(within(keeperPage).getByRole("button", { name: "刷新证书 (0)" })).toBeDisabled());

    await user.click(within(keeperPage).getByRole("checkbox", { name: "选择 free@example.com" }));
    await user.click(within(keeperPage).getByRole("button", { name: "刷新证书 (1)" }));

    await waitFor(() => {
      expect(mockApi.runKeeperDirectAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ managementKey: "demo-key" }),
        [expect.objectContaining({ auth_index: "idx-free" })],
        "refresh",
        expect.any(Function),
      );
    });
    expect(await screen.findByText("已刷新 1 个选中证书")).toBeInTheDocument();
    await waitFor(() => expect(within(keeperPage).getByRole("button", { name: "删除证书 (0)" })).toBeDisabled());

    await user.click(within(keeperPage).getByRole("checkbox", { name: "选择 free@example.com" }));
    await user.click(within(keeperPage).getByRole("button", { name: "删除证书 (1)" }));

    await waitFor(() => {
      expect(mockApi.runKeeperDirectAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ managementKey: "demo-key" }),
        [expect.objectContaining({ auth_index: "idx-free" })],
        "delete",
        expect.any(Function),
      );
    });
    expect(await screen.findByText("已删除 1 个选中证书")).toBeInTheDocument();
  });

  it("Keeper 演练会调用维护接口并展示结果", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("free@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keeper页面" }));
    await user.click(screen.getByRole("button", { name: "演练扫描" }));

    await waitFor(() => {
      expect(mockApi.runKeeperMaintenance).toHaveBeenCalledWith(
        expect.objectContaining({ managementKey: "demo-key" }),
        listPayload.items,
        { dryRun: true },
        expect.any(Function),
      );
    });
    expect(await screen.findByText("Keeper 演练完成：删除 1，禁用 1，启用 0，刷新 0")).toBeInTheDocument();
    expect(screen.getByText("Week额度 100% >= 100%")).toBeInTheDocument();
  });

  it("Keeper 操作页可以保存刷新配置", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("free@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keeper页面" }));

    const keeperPage = screen.getByRole("region", { name: "Keeper 操作页面" });
    await user.clear(within(keeperPage).getByLabelText("刷新阈值天数"));
    await user.type(within(keeperPage).getByLabelText("刷新阈值天数"), "5");
    await user.clear(within(keeperPage).getByLabelText("维护并发数"));
    await user.type(within(keeperPage).getByLabelText("维护并发数"), "9");
    await user.click(within(keeperPage).getByLabelText("维护时自动刷新临期证书"));
    await user.click(within(keeperPage).getByRole("button", { name: "保存 Keeper 配置" }));

    await waitFor(() => {
      expect(mockApi.saveRuntimeConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          queryConcurrency: 6,
          keeperSettings: expect.objectContaining({
            quotaThreshold: 100,
            expiryThresholdDays: 5,
            enableRefresh: false,
            workerThreads: 9,
          }),
        }),
      );
    });
  });

  it("标题栏只保留主标题，不再显示副标题", async () => {
    render(<App />);

    expect(await screen.findByText("free@example.com")).toBeInTheDocument();
    expect(screen.getByText("Codex 额度监控台")).toBeInTheDocument();
    expect(screen.queryByText("生产巡检工作台")).not.toBeInTheDocument();
  });

  it("工具区不再显示说明型文案", async () => {
    render(<App />);

    expect(await screen.findByText("free@example.com")).toBeInTheDocument();
    expect(screen.queryByText("连接与查询")).not.toBeInTheDocument();
    expect(screen.queryByText("管理配置、筛选入口和选中查询都收在这里。")).not.toBeInTheDocument();
  });

  it("总览区展示五张指标卡并包含耗尽指标", async () => {
    render(<App />);

    expect(await screen.findByText("free@example.com")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "账号总数 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "状态正常 0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "额度偏低 0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "额度耗尽 0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查询异常 0" })).toBeInTheDocument();
  });

  it("大卡片点击后会直接切换状态筛选", async () => {
    const user = userEvent.setup();
    mockApi.fetchAccountList.mockResolvedValueOnce({
      ...listPayload,
      groups: {
        by_plan: { free: 1, team: 2 },
        by_status: { error: 1, unknown: 2 },
      },
      items: [
        {
          ...listPayload.items[0],
          status: "error" as const,
          error: "额度接口失败",
        },
        listPayload.items[1],
        listPayload.items[2],
      ],
    });

    render(<App />);

    expect(await screen.findByText("free@example.com")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "查询异常 1" }));

    expect(screen.getByText("free@example.com")).toBeInTheDocument();
    expect(screen.queryByText("team-a@example.com")).not.toBeInTheDocument();
  });

  it("按分组筛选后只保留对应账号并同步详情", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("button", { name: "free" }));

    expect(screen.getByText("free@example.com")).toBeInTheDocument();
    expect(screen.queryByText("team-a@example.com")).not.toBeInTheDocument();

    const row = screen.getAllByRole("row").find((candidate) => within(candidate).queryByText("free@example.com"));
    expect(row).toBeDefined();
    if (row) {
      await user.click(row);
    }

    expect(row).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("当前账号")).not.toBeInTheDocument();
    expect(screen.queryByText("账号索引")).not.toBeInTheDocument();
  });

  it("切换分组后只按当前分组统计选中账号", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("checkbox", { name: "选择 free@example.com" }));
    expect(screen.getByRole("button", { name: "查询选中账号 (1)" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "team" }));
    expect(screen.getByRole("button", { name: "查询选中账号 (0)" })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "选择 team-a@example.com" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 team-b@example.com" }));
    expect(screen.getByRole("button", { name: "查询选中账号 (2)" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "all" }));
    expect(screen.getByRole("button", { name: "查询选中账号 (1)" })).toBeEnabled();
  });

  it("只根据复选框选中的账号执行查询", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("free@example.com");

    const freeRow = screen.getAllByRole("row").find((candidate) => within(candidate).queryByText("free@example.com"));
    expect(freeRow).toBeDefined();
    if (freeRow) {
      await user.click(freeRow);
    }

    // 行选中只用于查看详情，不能代替勾选账号执行查询。
    expect(screen.getByRole("button", { name: "查询选中账号 (0)" })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "选择 free@example.com" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 team-a@example.com" }));

    const querySelectedButton = screen.getByRole("button", { name: "查询选中账号 (2)" });
    expect(querySelectedButton).toBeEnabled();

    await user.click(querySelectedButton);

    await waitFor(() => {
      expect(mockApi.queryCachedAccounts).toHaveBeenCalledTimes(1);
    });
    expect(mockApi.queryCachedAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ managementKey: "demo-key" }),
      [
        expect.objectContaining({ auth_index: "idx-free", email: "free@example.com" }),
        expect.objectContaining({ auth_index: "idx-team-a", email: "team-a@example.com" }),
      ],
      expect.any(Function),
    );
  });

  it("设置面板可以保存并发数", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("button", { name: "打开设置" }));

    const dialog = await screen.findByRole("dialog", { name: "查询设置" });
    expect(dialog).toBeInTheDocument();
    const concurrencyInput = screen.getByLabelText("并发数");

    // 优先级批量分配已经迁回主界面弹层，设置页只保留本地配置项。
    expect(within(dialog).queryByText("优先级顺序")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "左移" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "右移" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "生成本地草稿" })).not.toBeInTheDocument();

    await user.clear(concurrencyInput);
    await user.type(concurrencyInput, "4");
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      expect(mockApi.saveRuntimeConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          queryConcurrency: 4,
        }),
      );
    });
  });

  it("设置面板可以一键清空本地缓存并重置界面状态", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("button", { name: "配置页面" }));
    expect(screen.getByDisplayValue("https://cpa.example/")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开设置" }));
    await user.click(await screen.findByRole("button", { name: "清空本地缓存" }));

    await waitFor(() => {
      expect(mockApi.clearLocalCache).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("free@example.com")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("https://cpa.example/")).toHaveValue("");
    expect(screen.getByPlaceholderText("输入管理密钥")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "额度页面" }));
    expect(screen.getByText("本地缓存已清空，等待输入管理配置")).toBeInTheDocument();
  });

  it("会拦截页面右键菜单", async () => {
    render(<App />);
    await screen.findByText("free@example.com");

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("缺少管理密钥时会恢复上次缓存的额度结果", async () => {
    mockApi.loadRuntimeConfig.mockResolvedValueOnce({
      cpaBaseUrl: "https://cpa.example/",
      managementKey: "",
      queryConcurrency: 6,
      priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
    });
    mockApi.loadPayloadCache.mockResolvedValueOnce(buildQueryPayload(["idx-free"]));

    render(<App />);

    expect(await screen.findByText("下次刷新 04-25 06:00")).toBeInTheDocument();
    expect(screen.getAllByText("free@example.com").length).toBeGreaterThan(0);
    expect(mockApi.fetchAccountList).not.toHaveBeenCalled();
  });

  it("启动拉取远端列表时会移除缓存里已经不存在的账号", async () => {
    const staleItem = makeItem({
      name: "codex-stale.json",
      email: "stale@example.com",
      account_id: "acct-stale",
      auth_index: "idx-stale",
      plan_type: "team",
      priority: 1,
      remote_priority: 1,
    });
    mockApi.loadPayloadCache.mockResolvedValueOnce(
      makePayload({
        items: [...listPayload.items, staleItem],
      }),
    );

    render(<App />);

    expect(await screen.findByText("free@example.com")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("stale@example.com")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "账号总数 3" })).toBeInTheDocument();
  });

  it("重新加载账号时会显示远端最新优先级，而不是被旧缓存覆盖", async () => {
    mockApi.loadPayloadCache.mockResolvedValue(
      makePayload({
        items: [makeItem({ auth_index: "idx-free", priority: 10, remote_priority: 10 })],
      }),
    );
    mockApi.fetchAccountList.mockResolvedValue(
      makePayload({
        items: [makeItem({ auth_index: "idx-free", priority: 88, remote_priority: 88 })],
      }),
    );

    render(<App />);

    await waitFor(
      () => {
        expect(screen.getAllByText("88").length).toBeGreaterThan(0);
      },
      { timeout: 2000 },
    );
    expect(screen.queryByText("10")).not.toBeInTheDocument();
  });

  it("重新加载账号时会移除远端已经删除的旧账号", async () => {
    const user = userEvent.setup();
    const staleItem = makeItem({
      name: "codex-stale.json",
      email: "stale@example.com",
      account_id: "acct-stale",
      auth_index: "idx-stale",
      plan_type: "team",
      priority: 1,
      remote_priority: 1,
    });
    mockApi.fetchAccountList
      .mockResolvedValueOnce(
        makePayload({
          items: [...listPayload.items, staleItem],
        }),
      )
      .mockResolvedValueOnce(listPayload);

    render(<App />);

    expect(await screen.findByText("stale@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "加载账号" }));

    await waitFor(() => {
      expect(screen.queryByText("stale@example.com")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "账号总数 3" })).toBeInTheDocument();
  });

  it("批量设置优先级入口只更新本地草稿，不直接同步远端", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("button", { name: "批量设置优先级" }));
    await user.click(screen.getByRole("button", { name: "生成本地草稿" }));

    expect(screen.getAllByText("未同步").length).toBeGreaterThan(0);
    expect(mockApi.syncAccountPriorities).not.toHaveBeenCalled();
  });

  it("批量设置优先级只会改动勾选分组", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("button", { name: "批量设置优先级" }));
    await user.click(screen.getByRole("checkbox", { name: "调整 free" }));
    await user.click(screen.getByRole("button", { name: "生成本地草稿" }));

    const freeRow = screen.getAllByRole("row").find((candidate) => within(candidate).queryByText("free@example.com"));
    const teamRow = screen.getAllByRole("row").find((candidate) => within(candidate).queryByText("team-a@example.com"));
    expect(freeRow).toBeDefined();
    expect(teamRow).toBeDefined();
    if (freeRow) {
      expect(within(freeRow).queryByText("未同步")).not.toBeInTheDocument();
      expect(within(freeRow).getByText("99")).toBeInTheDocument();
    }
    if (teamRow) {
      expect(within(teamRow).getByText("未同步")).toBeInTheDocument();
      expect(within(teamRow).getByText("2")).toBeInTheDocument();
    }
  });

  it("同步到远端在缺少新备份时会弹出确认对话框", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("button", { name: "批量设置优先级" }));
    await user.click(screen.getByRole("button", { name: "生成本地草稿" }));

    const syncButton = screen.getByRole("button", { name: "同步到远端" });
    expect(syncButton).toBeEnabled();

    await user.click(syncButton);

    expect(await screen.findByRole("dialog", { name: "同步前确认" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "先下载全部再同步" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "我已下载，直接同步" })).toBeInTheDocument();
  });

  it("同步前确认允许跳过备份直接同步", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("button", { name: "批量设置优先级" }));
    await user.click(screen.getByRole("button", { name: "生成本地草稿" }));
    await user.click(screen.getByRole("button", { name: "同步到远端" }));
    await user.click(await screen.findByRole("button", { name: "我已下载，直接同步" }));

    await waitFor(() => {
      expect(mockApi.syncAccountPriorities).toHaveBeenCalledTimes(1);
    });
  });

  it("同步前确认可以先执行全量备份再继续同步", async () => {
    const user = userEvent.setup();
    mockApi.loadRuntimeConfig.mockResolvedValueOnce({
      cpaBaseUrl: "https://cpa.example/",
      managementKey: "demo-key",
      queryConcurrency: 6,
      priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
    });
    mockApi.downloadSelectedAccounts.mockResolvedValueOnce([
      { name: "codex-free.json", destinationPath: "D:\\backup\\codex\\codex-free.json" },
    ]);

    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("button", { name: "批量设置优先级" }));
    await user.click(screen.getByRole("button", { name: "生成本地草稿" }));
    await user.click(screen.getByRole("button", { name: "同步到远端" }));
    await user.click(await screen.findByRole("button", { name: "先下载全部再同步" }));

    await waitFor(() => {
      expect(mockApi.downloadSelectedAccounts).toHaveBeenCalledTimes(1);
      expect(mockApi.syncAccountPriorities).toHaveBeenCalledTimes(1);
    });
  });

  it("额度页不再展示单账号详情和优先级编辑入口", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByText("free@example.com"));

    expect(screen.queryByText("当前账号")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "优先级输入框" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "应用到本地草稿" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "恢复远端值" })).not.toBeInTheDocument();
  });

  it("可以一键清除本地优先级草稿并恢复远端状态", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("button", { name: "批量设置优先级" }));
    await user.click(screen.getByRole("button", { name: "生成本地草稿" }));
    expect(screen.getAllByText("未同步").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "清除本地草稿" }));

    expect(screen.getByText("已清除本地优先级草稿")).toBeInTheDocument();
    expect(screen.queryByText("未同步")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "同步到远端" })).toBeDisabled();
  });

  it("批量查询进度会按账号逐步更新", async () => {
    const user = userEvent.setup();
    let finishQuery: (() => void) | null = null;
    mockApi.queryCachedAccounts.mockImplementationOnce(
      (_config, items: typeof listPayload.items, onProgress?: (event: { completed: number; total: number; currentLabel: string }) => void) =>
        new Promise((resolve) => {
          onProgress?.({
            completed: 1,
            total: items.length,
            currentLabel: "free@example.com",
          });
          finishQuery = () => {
            onProgress?.({
              completed: items.length,
              total: items.length,
              currentLabel: "team-a@example.com",
            });
            resolve(buildQueryPayload(items.map((item) => item.auth_index)));
          };
        }),
    );

    render(<App />);
    await screen.findByText("free@example.com");

    await user.click(screen.getByRole("checkbox", { name: "选择 free@example.com" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 team-a@example.com" }));
    await user.click(screen.getByRole("button", { name: "查询选中账号 (2)" }));

    expect(await screen.findByText("1 / 2")).toBeInTheDocument();
    expect(screen.getAllByText("free@example.com").length).toBeGreaterThan(0);
    // 进度条必须是主容器上的独立浮层，不能再塞回工具条里挤按钮。
    const progressRoot = document.querySelector(".scan-progress");
    expect(progressRoot).not.toBeNull();
    expect(progressRoot?.parentElement).toHaveClass("stitch-main");
    expect(progressRoot?.closest(".command-bar")).toBeNull();

    await act(async () => {
      finishQuery?.();
    });

    expect(await screen.findByText("2 / 2")).toBeInTheDocument();
    expect(screen.getByText(/总耗时/)).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1900));
    });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await waitFor(() => {
      expect(screen.queryByText("2 / 2")).not.toBeInTheDocument();
    });
  });

  it("下载到本地会按账号逐步更新进度条，并在完成前保持常驻", async () => {
    const user = userEvent.setup();
    let finishBackup: (() => void) | null = null;
    mockApi.loadRuntimeConfig.mockResolvedValueOnce({
      cpaBaseUrl: "https://cpa.example/",
      managementKey: "demo-key",
      queryConcurrency: 6,
      priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
    });
    mockApi.downloadSelectedAccounts.mockImplementationOnce(
      (_config, items: typeof listPayload.items, onProgress?: (event: { completed: number; total: number; currentLabel: string }) => void) =>
        new Promise((resolve) => {
          onProgress?.({
            completed: 1,
            total: items.length,
            currentLabel: "codex-free.json",
          });
          finishBackup = () => {
            onProgress?.({
              completed: items.length,
              total: items.length,
              currentLabel: "codex-team-b.json",
            });
            resolve(items.map((item) => ({ name: item.name, destinationPath: `D:\\backup\\codex\\${item.name}` })));
          };
        }),
    );

    render(<App />);
    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("button", { name: "下载所有账号" }));

    expect(await screen.findByText("远端账号下载进度")).toBeInTheDocument();
    expect(await screen.findByText("1 / 3")).toBeInTheDocument();
    expect(screen.getByText("codex-free.json")).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2300));
    });
    expect(screen.getByText("1 / 3")).toBeInTheDocument();

    await act(async () => {
      finishBackup?.();
    });

    expect(await screen.findByText("3 / 3")).toBeInTheDocument();
    expect(screen.getByText(/总耗时/)).toBeInTheDocument();
  });

  it("下载进度事件密集到达时也会显示中间步进", async () => {
    vi.useFakeTimers();
    const denseItems = Array.from({ length: 101 }, (_unused, index) =>
      makeItem({
        name: `dense-${index}.json`,
        email: `dense-${index}@example.com`,
        account_id: `acct-dense-${index}`,
        auth_index: `idx-dense-${index}`,
        priority: 200 - index,
        remote_priority: 200 - index,
      }),
    );
    mockApi.loadRuntimeConfig.mockResolvedValueOnce({
      cpaBaseUrl: "https://cpa.example/",
      managementKey: "demo-key",
      queryConcurrency: 6,
      priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
    });
    mockApi.fetchAccountList.mockResolvedValueOnce(
      makePayload({
        items: denseItems,
      }),
    );
    mockApi.downloadSelectedAccounts.mockImplementationOnce(
      async (_config, items: typeof denseItems, onProgress?: (event: { completed: number; total: number; currentLabel: string }) => void) => {
        items.forEach((item, index) => {
          onProgress?.({
            completed: index + 1,
            total: items.length,
            currentLabel: item.name,
          });
        });
        return items.map((item) => ({ name: item.name, destinationPath: `D:\\backup\\codex\\${item.name}` }));
      },
    );

    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
      await Promise.resolve();
    });
    expect(screen.getByText("dense-0@example.com")).toBeInTheDocument();

    act(() => {
      screen.getByRole("button", { name: "下载所有账号" }).click();
    });
    expect(screen.getByText("远端账号下载进度")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
      await Promise.resolve();
    });

    const progressbar = screen.getByRole("progressbar");
    expect(progressbar).toHaveAttribute("aria-valuenow", "0");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
      await Promise.resolve();
    });

    const midValue = Number(progressbar.getAttribute("aria-valuenow") ?? "0");
    expect(midValue).toBeGreaterThan(0);
    expect(midValue).toBeLessThan(denseItems.length);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
      await Promise.resolve();
    });

    expect(screen.getByText(`${denseItems.length} / ${denseItems.length}`)).toBeInTheDocument();
    expect(screen.getByText("本轮下载已结束")).toBeInTheDocument();
  });

  it("同步到远端会按账号逐步更新进度条，并在完成前保持常驻", async () => {
    const user = userEvent.setup();
    let finishSync: (() => void) | null = null;
    mockApi.loadRuntimeConfig.mockResolvedValueOnce({
      cpaBaseUrl: "https://cpa.example/",
      managementKey: "demo-key",
      queryConcurrency: 6,
      priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
    });
    mockApi.downloadSelectedAccounts.mockResolvedValueOnce(
      listPayload.items.map((item) => ({ name: item.name, destinationPath: `D:\\backup\\codex\\${item.name}` })),
    );
    mockApi.syncAccountPriorities.mockImplementationOnce(
      (_config, changes: Array<{ name: string; priority: number }>, onProgress?: (event: { completed: number; total: number; currentLabel: string }) => void) =>
        new Promise((resolve) => {
          onProgress?.({
            completed: 1,
            total: changes.length,
            currentLabel: changes[0]?.name ?? "",
          });
          finishSync = () => {
            onProgress?.({
              completed: changes.length,
              total: changes.length,
              currentLabel: changes.at(-1)?.name ?? "",
            });
            resolve(undefined);
          };
        }),
    );

    render(<App />);
    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("button", { name: "批量设置优先级" }));
    await user.click(screen.getByRole("button", { name: "生成本地草稿" }));
    await user.click(screen.getByRole("button", { name: "同步到远端" }));
    await user.click(await screen.findByRole("button", { name: "我已下载，直接同步" }));

    expect(await screen.findByText("优先级同步进度")).toBeInTheDocument();
    expect(await screen.findByText("1 / 3")).toBeInTheDocument();
    expect(screen.getByText("codex-free.json")).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2300));
    });
    expect(screen.getByText("1 / 3")).toBeInTheDocument();

    await act(async () => {
      finishSync?.();
    });

    expect(await screen.findByText("3 / 3")).toBeInTheDocument();
    expect(screen.getByText(/总耗时/)).toBeInTheDocument();
  });

  it("未勾选账号时会下载全部远端账号", async () => {
    const user = userEvent.setup();
    mockApi.loadRuntimeConfig.mockResolvedValueOnce({
      cpaBaseUrl: "https://cpa.example/",
      managementKey: "demo-key",
      queryConcurrency: 6,
      priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
    });

    render(<App />);
    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("button", { name: "下载所有账号" }));

    await waitFor(() => {
      expect(mockApi.downloadSelectedAccounts).toHaveBeenCalledWith(
        expect.objectContaining({
          managementKey: "demo-key",
        }),
        [
          expect.objectContaining({ name: "codex-free.json", auth_index: "idx-free" }),
          expect.objectContaining({ name: "codex-team-a.json", auth_index: "idx-team-a" }),
          expect.objectContaining({ name: "codex-team-b.json", auth_index: "idx-team-b" }),
        ],
        expect.any(Function),
      );
    });
  });

  it("勾选账号后会改成下载选中，并只下载选中的远端账号", async () => {
    const user = userEvent.setup();
    mockApi.loadRuntimeConfig.mockResolvedValueOnce({
      cpaBaseUrl: "https://cpa.example/",
      managementKey: "demo-key",
      queryConcurrency: 6,
      priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
    });

    render(<App />);
    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("checkbox", { name: "选择 free@example.com" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 team-a@example.com" }));
    await user.click(screen.getByRole("button", { name: "下载选中 (2)" }));

    await waitFor(() => {
      expect(mockApi.downloadSelectedAccounts).toHaveBeenCalledWith(
        expect.objectContaining({
          managementKey: "demo-key",
        }),
        [
          expect.objectContaining({ name: "codex-free.json", auth_index: "idx-free" }),
          expect.objectContaining({ name: "codex-team-a.json", auth_index: "idx-team-a" }),
        ],
        expect.any(Function),
      );
    });
  });

  it("优先级按钮沿用主操作按钮配色", async () => {
    render(<App />);

    expect(await screen.findByText("free@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加载账号" })).toHaveClass("command-button--primary");
    expect(screen.getByRole("button", { name: "批量设置优先级" })).toHaveClass("command-button");
    expect(screen.getByRole("button", { name: "下载所有账号" })).toHaveClass("command-button--primary");
    expect(screen.getByRole("button", { name: "同步到远端" })).toHaveClass("command-button--primary");
    expect(screen.getByRole("button", { name: "查询选中账号 (0)" })).toHaveClass("command-button--primary");
  });

  it("查询结果会在额度列显示下次刷新时间", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("checkbox", { name: "选择 free@example.com" }));
    await user.click(screen.getByRole("button", { name: "查询选中账号 (1)" }));

    expect(await screen.findByText("下次刷新 04-25 06:00")).toBeInTheDocument();
    expect(screen.getByText("下次刷新 04-29 06:00")).toBeInTheDocument();
    expect(screen.getByText("04-25 06:00")).toBeInTheDocument();
    expect(screen.getByText("04-25 01:05")).toBeInTheDocument();
    expect(screen.getByTitle("2026-04-25T01:05:00+08:00")).toBeInTheDocument();
    expect(mockApi.savePayloadCache).toHaveBeenCalled();
  });

  it("点击优先级列表头会按升序、降序和默认顺序切换", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("free@example.com")).toBeInTheDocument();

    const readFirstEmail = () => {
      const bodyRows = screen.getAllByRole("row").slice(1);
      return within(bodyRows[0]).getByText(/@example\.com$/).textContent;
    };

    expect(readFirstEmail()).toBe("free@example.com");

    await user.click(screen.getByRole("button", { name: "优先级 排序" }));
    expect(readFirstEmail()).toBe("team-b@example.com");

    await user.click(screen.getByRole("button", { name: "优先级 排序 升序" }));
    expect(readFirstEmail()).toBe("free@example.com");

    await user.click(screen.getByRole("button", { name: "优先级 排序 降序" }));
    expect(readFirstEmail()).toBe("free@example.com");
  });

  it("点击邮箱列表头会按字母升序和降序切换", async () => {
    const user = userEvent.setup();
    mockApi.fetchAccountList.mockResolvedValueOnce({
      ...listPayload,
      items: [
        {
          ...listPayload.items[0],
          email: "zulu@example.com",
          auth_index: "idx-zulu",
          name: "codex-zulu.json",
        },
        {
          ...listPayload.items[1],
          email: "alpha@example.com",
          auth_index: "idx-alpha",
          name: "codex-alpha.json",
        },
        {
          ...listPayload.items[2],
          email: "mike@example.com",
          auth_index: "idx-mike",
          name: "codex-mike.json",
        },
      ],
    });

    render(<App />);

    expect(await screen.findByText("zulu@example.com")).toBeInTheDocument();

    const readEmails = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getByText(/@example\.com$/).textContent);

    await user.click(screen.getByRole("button", { name: "邮箱 排序" }));
    expect(readEmails()).toEqual(["alpha@example.com", "mike@example.com", "zulu@example.com"]);

    await user.click(screen.getByRole("button", { name: "邮箱 排序 升序" }));
    expect(readEmails()).toEqual(["zulu@example.com", "mike@example.com", "alpha@example.com"]);
  });

  it("点击分组列表头会按分组文本升序和降序切换", async () => {
    const user = userEvent.setup();
    mockApi.fetchAccountList.mockResolvedValueOnce({
      ...listPayload,
      items: [
        {
          ...listPayload.items[0],
          email: "plus@example.com",
          plan_type: "plus",
          auth_index: "idx-plus",
          name: "codex-plus.json",
        },
        {
          ...listPayload.items[1],
          email: "free@example.com",
          plan_type: "free",
          auth_index: "idx-free",
          name: "codex-free.json",
        },
        {
          ...listPayload.items[2],
          email: "team@example.com",
          plan_type: "team",
          auth_index: "idx-team",
          name: "codex-team.json",
        },
      ],
      groups: {
        by_plan: { plus: 1, free: 1, team: 1 },
        by_status: { unknown: 3 },
      },
    });

    render(<App />);
    expect(await screen.findByText("plus@example.com")).toBeInTheDocument();

    const readPlans = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[3]?.textContent);

    await user.click(screen.getByRole("button", { name: "分组 排序" }));
    expect(readPlans()).toEqual(["free", "plus", "team"]);

    await user.click(screen.getByRole("button", { name: "分组 排序 升序" }));
    expect(readPlans()).toEqual(["team", "plus", "free"]);
  });

  it("会把已归一化的 Pro 20x 和 Pro 5x 分组展示成大写文案", async () => {
    mockApi.fetchAccountList.mockResolvedValueOnce({
      ...listPayload,
      items: [
        {
          ...listPayload.items[0],
          email: "pro@example.com",
          plan_type: "pro 20x",
          auth_index: "idx-pro",
          name: "codex-pro.json",
        },
        {
          ...listPayload.items[1],
          email: "prolite@example.com",
          plan_type: "pro 5x",
          auth_index: "idx-prolite",
          name: "codex-pro-lite.json",
        },
      ],
      groups: {
        by_plan: { "pro 20x": 1, "pro 5x": 1 },
        by_status: { unknown: 2 },
      },
    });

    render(<App />);
    expect(await screen.findByText("pro@example.com")).toBeInTheDocument();

    const readPlans = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[3]?.textContent);

    expect(readPlans()).toEqual(["pro 20x", "pro 5x"]);
    expect(screen.getByRole("button", { name: "pro 20x" })).toHaveTextContent("Pro 20x");
    expect(screen.getByRole("button", { name: "pro 5x" })).toHaveTextContent("Pro 5x");
  });

  it("点击状态列表头会按状态顺序升序和降序切换", async () => {
    const user = userEvent.setup();
    mockApi.fetchAccountList.mockResolvedValueOnce({
      ...listPayload,
      items: [
        {
          ...listPayload.items[0],
          email: "error@example.com",
          status: "error" as const,
          auth_index: "idx-error",
          name: "codex-error.json",
          error: "bad request",
        },
        {
          ...listPayload.items[1],
          email: "healthy@example.com",
          status: "healthy" as const,
          auth_index: "idx-healthy",
          name: "codex-healthy.json",
        },
        {
          ...listPayload.items[2],
          email: "unknown@example.com",
          status: "unknown" as const,
          auth_index: "idx-unknown",
          name: "codex-unknown.json",
        },
      ],
      groups: {
        by_plan: { free: 1, team: 2 },
        by_status: { error: 1, healthy: 1, unknown: 1 },
      },
    });

    render(<App />);
    expect(await screen.findByText("error@example.com")).toBeInTheDocument();

    const readEmails = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getByText(/@example\.com$/).textContent);

    await user.click(screen.getByRole("button", { name: "状态 排序" }));
    expect(readEmails()).toEqual(["healthy@example.com", "error@example.com", "unknown@example.com"]);

    await user.click(screen.getByRole("button", { name: "状态 排序 升序" }));
    expect(readEmails()).toEqual(["unknown@example.com", "error@example.com", "healthy@example.com"]);
  });

  it("点击 5h 额度列表头会按真实数值排序并把空值沉底", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("checkbox", { name: "选择 free@example.com" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 team-a@example.com" }));
    await user.click(screen.getByRole("button", { name: "查询选中账号 (2)" }));

    const readEmails = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getByText(/@example\.com$/).textContent);

    expect(readEmails()).toEqual(["free@example.com", "team-a@example.com", "team-b@example.com"]);

    await user.click(await screen.findByRole("button", { name: "5h 额度 排序" }));
    expect(readEmails()).toEqual(["team-a@example.com", "free@example.com", "team-b@example.com"]);

    await user.click(screen.getByRole("button", { name: "5h 额度 排序 升序" }));
    expect(readEmails()).toEqual(["free@example.com", "team-a@example.com", "team-b@example.com"]);
  });

  it("点击 更新时间 列表头会按时间升序和降序切换", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("checkbox", { name: "选择 free@example.com" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 team-a@example.com" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 team-b@example.com" }));
    await user.click(screen.getByRole("button", { name: "查询选中账号 (3)" }));

    const readEmails = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getByText(/@example\.com$/).textContent);

    await user.click(await screen.findByRole("button", { name: "更新时间 排序" }));
    expect(readEmails()).toEqual(["free@example.com", "team-a@example.com", "team-b@example.com"]);

    await user.click(screen.getByRole("button", { name: "更新时间 排序 升序" }));
    expect(readEmails()).toEqual(["team-b@example.com", "team-a@example.com", "free@example.com"]);
  });

  it("保存配置失败时仍继续刷新账号列表", async () => {
    const user = userEvent.setup();
    mockApi.saveRuntimeConfig.mockRejectedValueOnce(new Error("写入配置文件失败"));
    render(<App />);

    await screen.findByText("free@example.com");
    await user.click(screen.getByRole("button", { name: "加载账号" }));

    await waitFor(() => {
      expect(mockApi.fetchAccountList).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("配置保存失败，本次仍按当前输入加载。写入配置文件失败");
    expect(screen.getByText("账号列表已刷新，配置未保存")).toBeInTheDocument();
  });
});
