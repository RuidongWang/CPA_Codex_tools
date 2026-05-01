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
  it("会把即将刷新额度的账号分到更高的优先级", () => {
    const draft = buildAutoPriorityDrafts(
      [
        makeAccount({
          auth_index: "idx-team-a",
          name: "codex-team-a.json",
          email: "team-a@example.com",
          plan_type: "team",
          windows: [{ id: "code-5h", label: "5h", used_percent: 50, remaining_percent: 50, reset_label: "2026-04-29T12:00:00Z", exhausted: false }],
        }),
        makeAccount({
          auth_index: "idx-team-b",
          name: "codex-team-b.json",
          email: "team-b@example.com",
          plan_type: "team",
          windows: [{ id: "code-5h", label: "5h", used_percent: 50, remaining_percent: 50, reset_label: "2026-04-29T15:00:00Z", exhausted: false }],
        }),
      ],
      ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
    );

    expect(draft["idx-team-a"]).toBeGreaterThan(draft["idx-team-b"]);
  });

  it("只会为勾选分组生成本地优先级草稿", () => {
    const draft = buildAutoPriorityDrafts(
      [
        makeAccount({
          auth_index: "idx-team-a",
          name: "codex-team-a.json",
          email: "team-a@example.com",
          plan_type: "team",
          windows: [{ id: "code-5h", label: "5h", used_percent: 50, remaining_percent: 50, reset_label: "2026-04-29T12:00:00Z", exhausted: false }],
        }),
        makeAccount({
          auth_index: "idx-free-a",
          name: "codex-free-a.json",
          email: "free-a@example.com",
          plan_type: "free",
          windows: [{ id: "code-5h", label: "5h", used_percent: 50, remaining_percent: 50, reset_label: "2026-04-29T10:00:00Z", exhausted: false }],
        }),
      ],
      ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
      ["team"],
    );

    expect(draft["idx-team-a"]).toBe(1);
    expect(draft["idx-free-a"]).toBeUndefined();
  });
});
