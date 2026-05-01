import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PriorityBatchPanel } from "./PriorityBatchPanel";

describe("PriorityBatchPanel", () => {
  it("默认勾选所有非空分组，并展示组名、账号数和自动区间范围", () => {
    render(
      <PriorityBatchPanel
        open
        priorityCounts={[
          { key: "team", count: 2 },
          { key: "plus", count: 1 },
          { key: "free", count: 0 },
          { key: "pro 5x", count: 0 },
          { key: "pro 20x", count: 0 },
          { key: "unknown", count: 0 },
        ]}
        priorityPlanOrder={["team", "plus", "free", "pro 5x", "pro 20x", "unknown"]}
        saving={false}
        onClose={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(screen.getByRole("dialog", { name: "批量设置优先级" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "调整 team" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "调整 plus" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "调整 free" })).not.toBeChecked();
    expect(screen.getByText("2 个")).toBeInTheDocument();
    expect(screen.getByText("2 - 3")).toBeInTheDocument();
    expect(screen.getByText("1 - 1")).toBeInTheDocument();
  });

  it("生成本地草稿时只回传勾选分组和弹层内调整后的顺序", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(
      <PriorityBatchPanel
        open
        priorityCounts={[
          { key: "team", count: 2 },
          { key: "plus", count: 1 },
          { key: "free", count: 3 },
          { key: "pro 5x", count: 0 },
          { key: "pro 20x", count: 0 },
          { key: "unknown", count: 0 },
        ]}
        priorityPlanOrder={["team", "plus", "free", "pro 5x", "pro 20x", "unknown"]}
        saving={false}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "调整 free" }));
    await user.click(screen.getByRole("button", { name: "右移 plus" }));
    await user.click(screen.getByRole("button", { name: "生成本地草稿" }));

    expect(onSubmit).toHaveBeenCalledWith({
      selectedGroups: ["team", "plus"],
      priorityPlanOrder: ["team", "free", "plus", "pro 5x", "pro 20x", "unknown"],
    });
  });

  it("只勾选一个分组时，卡片区间会立刻收缩成该分组自己的范围", async () => {
    const user = userEvent.setup();

    render(
      <PriorityBatchPanel
        open
        priorityCounts={[
          { key: "team", count: 6 },
          { key: "plus", count: 0 },
          { key: "free", count: 95 },
          { key: "pro 5x", count: 0 },
          { key: "pro 20x", count: 0 },
          { key: "unknown", count: 0 },
        ]}
        priorityPlanOrder={["team", "plus", "free", "pro 5x", "pro 20x", "unknown"]}
        saving={false}
        onClose={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(screen.getByText("96 - 101")).toBeInTheDocument();
    expect(screen.getByText("1 - 95")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "调整 free" }));

    expect(screen.getByText("1 - 6")).toBeInTheDocument();
    expect(screen.queryByText("96 - 101")).not.toBeInTheDocument();
  });
});
