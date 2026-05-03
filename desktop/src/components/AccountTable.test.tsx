import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountTable } from "./AccountTable";
import type { AccountItem } from "../types";
import type { SortState } from "../lib/view-model";

const BASE_SORT: SortState = { key: "default", direction: "none" };

function setViewportWidth(width: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: width,
    });
    window.dispatchEvent(new Event("resize"));
  });
}

function makeAccount(index: number, prefix = "large"): AccountItem {
  const padded = String(index).padStart(3, "0");
  return {
    name: `codex-${prefix}-${padded}.json`,
    email: `${prefix}-${padded}@example.com`,
    plan_type: index % 2 === 0 ? "team" : "free",
    account_id: `acct-${prefix}-${padded}`,
    auth_index: `idx-${prefix}-${padded}`,
    priority: 100 - index,
    remote_priority: 100 - index,
    draft_priority: undefined,
    dirty_priority: false,
    status: index % 5 === 0 ? "healthy" : "unknown",
    windows: [
      {
        id: "code-5h",
        label: "代码 5h",
        used_percent: 12,
        remaining_percent: 88,
        reset_label: "05-02 15:00",
        exhausted: false,
      },
      {
        id: "code-7d",
        label: "代码 7d",
        used_percent: 56,
        remaining_percent: 44,
        reset_label: "05-06 09:00",
        exhausted: false,
      },
    ],
    additional_windows: [],
    error: "",
    last_query_at: "2026-05-02T10:30:00+08:00",
    quota_updated_at: "05-03 14:22",
  };
}

function renderTable(items: AccountItem[], overrides: Partial<ComponentProps<typeof AccountTable>> = {}) {
  return render(
    <AccountTable
      items={items}
      sortState={BASE_SORT}
      selectedAuthIndex=""
      selectedAuthIndexes={[]}
      onRequestSort={vi.fn()}
      onSelect={vi.fn()}
      onToggleSelection={vi.fn()}
      onToggleVisibleSelection={vi.fn()}
      {...overrides}
    />,
  );
}

afterEach(() => {
  setViewportWidth(1024);
});

describe("AccountTable", () => {
  it("virtualizes large desktop account lists instead of rendering every row", () => {
    setViewportWidth(1280);
    const items = Array.from({ length: 250 }, (_, index) => makeAccount(index));

    const { container } = renderTable(items);

    expect(screen.getByText("large-000@example.com")).toBeInTheDocument();
    expect(screen.queryByText("large-249@example.com")).not.toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBeLessThan(80);
    const spacer = container.querySelector(".quota-grid__spacer");
    expect(spacer).toHaveAttribute("colspan", "9");
  });

  it("shows quota updated time in the desktop table and requests quota updated sorting", async () => {
    const user = userEvent.setup();
    const onRequestSort = vi.fn();

    renderTable([makeAccount(0, "quota")], { onRequestSort });

    expect(screen.getByRole("columnheader", { name: "额度更新时间" })).toBeInTheDocument();
    expect(screen.getByText("05-03 14:22")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "额度更新时间 排序" }));
    expect(onRequestSort).toHaveBeenCalledWith("quotaUpdatedAt");
  });

  it("uses a mobile card list that exposes account quota and selection details", () => {
    setViewportWidth(390);
    const items = [makeAccount(0, "mobile"), { ...makeAccount(1, "mobile"), quota_updated_at: null }];

    renderTable(items, {
      selectedAuthIndex: "idx-mobile-000",
      selectedAuthIndexes: ["idx-mobile-000"],
    });

    const cardList = screen.getByTestId("account-card-list");
    const firstCard = within(cardList).getByLabelText("mobile-000@example.com 账号卡片");
    const secondCard = within(cardList).getByLabelText("mobile-001@example.com 账号卡片");

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(within(firstCard).getByText("mobile-000@example.com")).toBeInTheDocument();
    expect(within(firstCard).getByText("codex-mobile-000.json")).toBeInTheDocument();
    expect(within(firstCard).getByText("team")).toBeInTheDocument();
    expect(within(firstCard).getByText("正常")).toBeInTheDocument();
    expect(within(firstCard).getByText("100")).toBeInTheDocument();
    expect(within(firstCard).getByText("88%")).toBeInTheDocument();
    expect(within(firstCard).getByText("44%")).toBeInTheDocument();
    expect(within(firstCard).getByText("05-02 10:30")).toBeInTheDocument();
    expect(within(firstCard).getByText("额度 05-03 14:22")).toBeInTheDocument();
    expect(within(secondCard).getByText("额度 -")).toBeInTheDocument();
    expect(within(firstCard).getByRole("checkbox", { name: "选择 mobile-000@example.com" })).toBeChecked();
  });
});
