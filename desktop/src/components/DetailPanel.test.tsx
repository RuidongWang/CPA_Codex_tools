import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DetailPanel } from "./DetailPanel";
import type { AccountItem } from "../types";

function buildItem(overrides: Partial<AccountItem> = {}): AccountItem {
  return {
    name: "codex-free.json",
    email: "free@example.com",
    plan_type: "free",
    account_id: "acct-free",
    auth_index: "idx-free",
    priority: 95,
    remote_priority: 95,
    draft_priority: 92,
    dirty_priority: true,
    status: "low",
    windows: [
      {
        id: "code-5h",
        label: "5h 额度",
        used_percent: 20,
        remaining_percent: 80,
        reset_label: "下次刷新 05-05 12:00",
        exhausted: false,
      },
      {
        id: "code-7d",
        label: "7d 额度",
        used_percent: 40,
        remaining_percent: 60,
        reset_label: "下次刷新 05-08 12:00",
        exhausted: false,
      },
    ],
    additional_windows: [],
    error: "",
    last_query_at: "2026-04-29T22:49:23+08:00",
    quota_updated_at: "05-05 12:00",
    ...overrides,
  };
}

describe("DetailPanel", () => {
  it("把优先级操作提前，并去掉左侧列表已展示的重复信息", () => {
    const onApplyPriority = vi.fn();
    const onResetPriority = vi.fn();

    render(<DetailPanel item={buildItem()} onApplyPriority={onApplyPriority} onResetPriority={onResetPriority} />);

    const priorityTitle = screen.getByText("优先级");
    const basicTitle = screen.getByText("基础信息");
    // 优先级操作需要尽量靠前，避免小窗里先滚动一屏才能看到。
    expect(priorityTitle.compareDocumentPosition(basicTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "应用到本地草稿" })).toBeInTheDocument();
    expect(screen.queryByText("分组")).not.toBeInTheDocument();
    expect(screen.queryByText("邮箱")).not.toBeInTheDocument();
    expect(screen.queryByText("5h 窗口")).not.toBeInTheDocument();
    expect(screen.queryByText("7d 窗口")).not.toBeInTheDocument();
  });

  it("优先级输入框为空时不会把草稿误写成 0", async () => {
    const user = userEvent.setup();
    const onApplyPriority = vi.fn();

    render(<DetailPanel item={buildItem()} onApplyPriority={onApplyPriority} onResetPriority={() => undefined} />);

    await user.clear(screen.getByRole("spinbutton", { name: "优先级输入框" }));

    expect(screen.getByRole("button", { name: "应用到本地草稿" })).toBeDisabled();
    expect(onApplyPriority).not.toHaveBeenCalled();
  });
});
