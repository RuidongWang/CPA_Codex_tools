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
    expect(screen.getByLabelText("team 最小优先级")).toHaveValue(2);
    expect(screen.getByLabelText("team 最大优先级")).toHaveValue(3);
    expect(screen.getByLabelText("plus 最小优先级")).toHaveValue(1);
    expect(screen.getByLabelText("plus 最大优先级")).toHaveValue(1);
  });

  it("允许为分组输入优先级区间，并预览固定档位分桶", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(
      <PriorityBatchPanel
        open
        priorityCounts={[
          { key: "team", count: 0 },
          { key: "plus", count: 0 },
          { key: "free", count: 200 },
          { key: "pro 5x", count: 0 },
          { key: "pro 20x", count: 0 },
          { key: "unknown", count: 0 },
        ]}
        priorityPlanOrder={["team", "plus", "free", "pro 5x", "pro 20x", "unknown"]}
        priorityPlanRanges={{ free: { minPriority: 1, maxPriority: 20 } }}
        saving={false}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByLabelText("free 最小优先级")).toHaveValue(1);
    expect(screen.getByLabelText("free 最大优先级")).toHaveValue(20);
    expect(screen.getByText("20档 · 每档10个")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("free 最大优先级"));
    await user.type(screen.getByLabelText("free 最大优先级"), "25");
    expect(screen.getByText("25档 · 每档8个")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "生成本地草稿" }));
    expect(onSubmit).toHaveBeenCalledWith({
      selectedGroups: ["free"],
      priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
      priorityPlanRanges: { free: { minPriority: 1, maxPriority: 25 } },
    });
  });

  it("区间数字相同时提示整组账号会设置为同一个优先级", () => {
    render(
      <PriorityBatchPanel
        open
        priorityCounts={[
          { key: "team", count: 0 },
          { key: "plus", count: 0 },
          { key: "free", count: 3 },
          { key: "pro 5x", count: 0 },
          { key: "pro 20x", count: 0 },
          { key: "unknown", count: 0 },
        ]}
        priorityPlanOrder={["team", "plus", "free", "pro 5x", "pro 20x", "unknown"]}
        priorityPlanRanges={{ free: { minPriority: 20, maxPriority: 20 } }}
        saving={false}
        onClose={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(screen.getByText("1档 · 全部设为20")).toBeInTheDocument();
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
      priorityPlanRanges: {
        team: { minPriority: 5, maxPriority: 6 },
        plus: { minPriority: 4, maxPriority: 4 },
        free: { minPriority: 1, maxPriority: 3 },
      },
    });
  });

  it("取消勾选分组时只改变作用范围，不会隐式改写其它分组区间", async () => {
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

    expect(screen.getByLabelText("team 最小优先级")).toHaveValue(96);
    expect(screen.getByLabelText("team 最大优先级")).toHaveValue(101);
    expect(screen.getByLabelText("free 最小优先级")).toHaveValue(1);
    expect(screen.getByLabelText("free 最大优先级")).toHaveValue(95);

    await user.click(screen.getByRole("checkbox", { name: "调整 free" }));

    expect(screen.getAllByText("不调整").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("checkbox", { name: "调整 free" }));

    expect(screen.getByLabelText("free 最小优先级")).toHaveValue(1);
    expect(screen.getByLabelText("free 最大优先级")).toHaveValue(95);
  });
});
