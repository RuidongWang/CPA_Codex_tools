import { describe, expect, it } from "vitest";
import { buildAutoPriorityDrafts, buildPriorityPlanPreview } from "./priority";
import type { AccountItem } from "../types";

function makeAccount(overrides: Partial<AccountItem> = {}): AccountItem {
  // 只保留优先级分配真正关心的字段，避免测试被无关展示字段拖累。
  return {
    name: "codex-free.json",
    email: "free@example.com",
    plan_type: "free",
    account_id: "acct-free",
    auth_index: "idx-free",
    priority: null,
    remote_priority: null,
    draft_priority: undefined,
    dirty_priority: false,
    status: "unknown",
    windows: [],
    additional_windows: [],
    error: "",
    timings_ms: {},
    last_query_at: null,
    quota_updated_at: null,
    ...overrides,
  };
}

describe("buildPriorityPlanPreview", () => {
  it("会根据账号总数和分组顺序自动生成连续区间", () => {
    const preview = buildPriorityPlanPreview(
      [
        { key: "team", count: 5 },
        { key: "plus", count: 5 },
        { key: "free", count: 40 },
      ],
      ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
    );

    expect(preview).toEqual([
      { key: "team", count: 5, maxPriority: 50, minPriority: 46 },
      { key: "plus", count: 5, maxPriority: 45, minPriority: 41 },
      { key: "free", count: 40, maxPriority: 40, minPriority: 1 },
      { key: "pro 5x", count: 0, maxPriority: null, minPriority: null },
      { key: "pro 20x", count: 0, maxPriority: null, minPriority: null },
      { key: "unknown", count: 0, maxPriority: null, minPriority: null },
    ]);
  });

  it("只勾选单个分组时，会按勾选范围重新收缩区间", () => {
    const preview = buildPriorityPlanPreview(
      [
        { key: "team", count: 5 },
        { key: "plus", count: 5 },
        { key: "free", count: 40 },
        { key: "pro 5x", count: 0 },
        { key: "pro 20x", count: 0 },
        { key: "unknown", count: 0 },
      ],
      ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
      ["team"],
    );

    expect(preview).toEqual([
      { key: "team", count: 5, maxPriority: 5, minPriority: 1 },
      { key: "plus", count: 5, maxPriority: null, minPriority: null },
      { key: "free", count: 40, maxPriority: null, minPriority: null },
      { key: "pro 5x", count: 0, maxPriority: null, minPriority: null },
      { key: "pro 20x", count: 0, maxPriority: null, minPriority: null },
      { key: "unknown", count: 0, maxPriority: null, minPriority: null },
    ]);
  });
});

describe("buildAutoPriorityDrafts", () => {
  it("按手动区间把账号分桶到固定优先级档位", () => {
    const accounts = Array.from({ length: 200 }, (_, index) =>
      makeAccount({
        auth_index: `idx-free-${index + 1}`,
        name: `codex-free-${index + 1}.json`,
        email: `free-${index + 1}@example.com`,
        plan_type: "free",
      }),
    );

    const draft = buildAutoPriorityDrafts(
      accounts,
      ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
      ["free"],
      { free: { minPriority: 1, maxPriority: 20 } },
    );

    expect(draft["idx-free-1"]).toBe(20);
    expect(draft["idx-free-10"]).toBe(20);
    expect(draft["idx-free-11"]).toBe(19);
    expect(draft["idx-free-190"]).toBe(2);
    expect(draft["idx-free-191"]).toBe(1);
    expect(draft["idx-free-200"]).toBe(1);
  });

  it("手动区间分桶有余数时会把余数归到最后一个最低优先级档位", () => {
    const accounts = Array.from({ length: 205 }, (_, index) =>
      makeAccount({
        auth_index: `idx-free-${index + 1}`,
        name: `codex-free-${index + 1}.json`,
        email: `free-${index + 1}@example.com`,
        plan_type: "free",
      }),
    );

    const draft = buildAutoPriorityDrafts(
      accounts,
      ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
      ["free"],
      { free: { minPriority: 1, maxPriority: 20 } },
    );

    expect(draft["idx-free-200"]).toBe(1);
    expect(draft["idx-free-201"]).toBe(1);
    expect(draft["idx-free-205"]).toBe(1);
  });

  it("账号数小于手动区间档位数时会从最高优先级逐个递减", () => {
    const accounts = Array.from({ length: 5 }, (_, index) =>
      makeAccount({
        auth_index: `idx-free-${index + 1}`,
        name: `codex-free-${index + 1}.json`,
        email: `free-${index + 1}@example.com`,
        plan_type: "free",
      }),
    );

    const draft = buildAutoPriorityDrafts(
      accounts,
      ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
      ["free"],
      { free: { minPriority: 1, maxPriority: 20 } },
    );

    expect(draft).toMatchObject({
      "idx-free-1": 20,
      "idx-free-2": 19,
      "idx-free-3": 18,
      "idx-free-4": 17,
      "idx-free-5": 16,
    });
  });

  it("手动区间最小值和最大值相同时会把整组账号设置成同一个优先级", () => {
    const accounts = Array.from({ length: 3 }, (_, index) =>
      makeAccount({
        auth_index: `idx-free-${index + 1}`,
        name: `codex-free-${index + 1}.json`,
        email: `free-${index + 1}@example.com`,
        plan_type: "free",
      }),
    );

    const draft = buildAutoPriorityDrafts(
      accounts,
      ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
      ["free"],
      { free: { minPriority: 20, maxPriority: 20 } },
    );

    expect(Object.values(draft)).toEqual([20, 20, 20]);
  });

  it("会按传入账号列表顺序在分组内生成降序优先级", () => {
    const draft = buildAutoPriorityDrafts(
      [
        makeAccount({
          auth_index: "idx-team-b",
          name: "codex-team-b.json",
          email: "team-b@example.com",
          plan_type: "team",
          windows: [{ id: "code-5h", label: "5h", used_percent: 50, remaining_percent: 50, reset_at: "2026-04-29T15:00:00Z", reset_label: "04-29 15:00", exhausted: false }],
        }),
        makeAccount({
          auth_index: "idx-team-a",
          name: "codex-team-a.json",
          email: "team-a@example.com",
          plan_type: "team",
          windows: [{ id: "code-5h", label: "5h", used_percent: 50, remaining_percent: 50, reset_at: "2026-04-29T12:00:00Z", reset_label: "04-29 12:00", exhausted: false }],
        }),
      ],
      ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
    );

    expect(draft["idx-team-b"]).toBeGreaterThan(draft["idx-team-a"]);
  });

  it("只会为勾选分组生成本地优先级草稿", () => {
    const draft = buildAutoPriorityDrafts(
      [
        makeAccount({
          auth_index: "idx-team-a",
          name: "codex-team-a.json",
          email: "team-a@example.com",
          plan_type: "team",
          windows: [{ id: "code-5h", label: "5h", used_percent: 50, remaining_percent: 50, reset_at: "2026-04-29T12:00:00Z", reset_label: "04-29 12:00", exhausted: false }],
        }),
        makeAccount({
          auth_index: "idx-free-a",
          name: "codex-free-a.json",
          email: "free-a@example.com",
          plan_type: "free",
          windows: [{ id: "code-5h", label: "5h", used_percent: 50, remaining_percent: 50, reset_at: "2026-04-29T10:00:00Z", reset_label: "04-29 10:00", exhausted: false }],
        }),
      ],
      ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
      ["team"],
    );

    expect(draft["idx-team-a"]).toBe(1);
    expect(draft["idx-free-a"]).toBeUndefined();
  });
});
