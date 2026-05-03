import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountItem } from "../types";
import type { SortDirection, SortState } from "../lib/view-model";

type SortRequestKey = Exclude<SortState["key"], "default">;

interface AccountTableProps {
  items: AccountItem[];
  sortState: SortState;
  selectedAuthIndex: string;
  selectedAuthIndexes: string[];
  onRequestSort: (key: SortRequestKey) => void;
  onSelect: (authIndex: string) => void;
  onToggleSelection: (authIndex: string, checked: boolean) => void;
  onToggleVisibleSelection: (checked: boolean) => void;
}

const STATUS_LABELS: Record<AccountItem["status"], string> = {
  healthy: "正常",
  low: "偏低",
  exhausted: "耗尽",
  error: "异常",
  unknown: "未查",
};
const TABLE_COLUMN_COUNT = 9;
const MOBILE_BREAKPOINT = 760;
const TABLE_ROW_HEIGHT = 72;
const MOBILE_CARD_HEIGHT = 208;
const VIRTUAL_OVERSCAN = 8;
const DEFAULT_TABLE_VIEWPORT_HEIGHT = 720;
const DEFAULT_MOBILE_VIEWPORT_HEIGHT = 680;

function findWindow(item: AccountItem, id: string) {
  return item.windows.find((window) => window.id === id) ?? null;
}

function renderPercent(value: number | null): string {
  if (value === null) {
    return "-";
  }
  return `${Math.round(value)}%`;
}

function pickMeterTone(value: number | null): "healthy" | "warning" | "danger" | "muted" {
  if (value === null) {
    return "muted";
  }
  if (value <= 15) {
    return "danger";
  }
  if (value <= 35) {
    return "warning";
  }
  return "healthy";
}

function renderPriorityValue(value: number | null): string {
  if (value === null) {
    return "-";
  }
  return String(value);
}

function buildSortAriaLabel(label: string, active: boolean, direction: SortDirection): string {
  if (!active || direction === "none") {
    return `${label} 排序`;
  }
  return `${label} 排序 ${direction === "asc" ? "升序" : "降序"}`;
}

function renderSortIcon(active: boolean, direction: SortDirection): string {
  if (!active || direction === "none") {
    return "unfold_more";
  }
  return direction === "asc" ? "arrow_upward" : "arrow_downward";
}

// 表格里只保留短时间戳，避免完整 ISO 时间把右侧列宽全部挤掉。
function renderShortTimestamp(value: string | null): string {
  if (!value) {
    return "-";
  }
  const matched = value.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/);
  if (!matched) {
    return value;
  }
  return `${matched[1]}-${matched[2]} ${matched[3]}`;
}

function readQuotaUpdatedAt(item: AccountItem): string | null {
  return item.quota_updated_at ?? null;
}

function renderQuotaCell(value: number | null, resetLabel: string | null) {
  const width = value === null ? 0 : Math.max(0, Math.min(100, Math.round(value)));
  const tone = pickMeterTone(value);

  return (
    <div className="quota-cell">
      <div className="quota-cell__summary">
        <span className="quota-cell__value">{renderPercent(value)}</span>
        <span className="quota-cell__reset">下次刷新 {resetLabel || "-"}</span>
      </div>
      <span className={`quota-meter quota-meter--${tone}`}>
        <span className="quota-meter__track">
          <span className="quota-meter__fill" style={{ width: `${width}%` }} />
        </span>
      </span>
    </div>
  );
}

function useIsMobileViewport(): boolean {
  const [mobile, setMobile] = useState(() => (typeof window === "undefined" ? false : window.innerWidth <= MOBILE_BREAKPOINT));

  useEffect(() => {
    function updateMobileViewport() {
      setMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    }

    updateMobileViewport();
    window.addEventListener("resize", updateMobileViewport);
    return () => {
      window.removeEventListener("resize", updateMobileViewport);
    };
  }, []);

  return mobile;
}

function useVirtualWindow(count: number, itemHeight: number, fallbackViewportHeight: number) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(fallbackViewportHeight);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }
    const currentContainer = containerRef.current;

    function updateViewportHeight() {
      const nextHeight = currentContainer.clientHeight || fallbackViewportHeight;
      setViewportHeight(nextHeight);
    }

    function handleScroll() {
      setScrollTop(currentContainer.scrollTop);
    }

    updateViewportHeight();
    currentContainer.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", updateViewportHeight);

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            updateViewportHeight();
          });
    resizeObserver?.observe(currentContainer);

    return () => {
      currentContainer.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", updateViewportHeight);
      resizeObserver?.disconnect();
    };
  }, [fallbackViewportHeight]);

  const range = useMemo(() => {
    if (count <= 0) {
      return {
        start: 0,
        end: 0,
        beforeHeight: 0,
        afterHeight: 0,
        totalHeight: 0,
      };
    }
    const visibleCount = Math.ceil(viewportHeight / itemHeight);
    const maxStart = Math.max(0, count - visibleCount);
    const start = Math.min(maxStart, Math.max(0, Math.floor(scrollTop / itemHeight) - VIRTUAL_OVERSCAN));
    const end = Math.min(count, start + visibleCount + VIRTUAL_OVERSCAN * 2);
    return {
      start,
      end,
      beforeHeight: start * itemHeight,
      afterHeight: Math.max(0, (count - end) * itemHeight),
      totalHeight: count * itemHeight,
    };
  }, [count, itemHeight, scrollTop, viewportHeight]);

  return {
    containerRef,
    ...range,
  };
}

function renderMobileQuota(label: string, value: number | null, resetLabel: string | null) {
  const width = value === null ? 0 : Math.max(0, Math.min(100, Math.round(value)));
  const tone = pickMeterTone(value);

  return (
    <div className="account-card__quota">
      <div className="account-card__quota-meta">
        <span>{label}</span>
        <strong>{renderPercent(value)}</strong>
      </div>
      <span className={`quota-meter quota-meter--${tone}`}>
        <span className="quota-meter__track">
          <span className="quota-meter__fill" style={{ width: `${width}%` }} />
        </span>
      </span>
      <span className="account-card__reset">下次刷新 {resetLabel || "-"}</span>
    </div>
  );
}

function AccountMobileCard({
  item,
  active,
  checked,
  onSelect,
  onToggleSelection,
}: {
  item: AccountItem;
  active: boolean;
  checked: boolean;
  onSelect: (authIndex: string) => void;
  onToggleSelection: (authIndex: string, checked: boolean) => void;
}) {
  const window5h = findWindow(item, "code-5h");
  const window7d = findWindow(item, "code-7d");
  const label = item.email || item.name;

  return (
    <article
      className={active ? "account-card account-card--active" : "account-card"}
      aria-label={`${label} 账号卡片`}
      tabIndex={0}
      onClick={() => onSelect(item.auth_index)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          onSelect(item.auth_index);
        }
      }}
    >
      <div className="account-card__topline">
        <label className="account-card__check">
          <input
            type="checkbox"
            checked={checked}
            aria-label={`选择 ${label}`}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onToggleSelection(item.auth_index, event.target.checked)}
          />
        </label>
        <div className="account-card__identity">
          <strong title={label}>{label}</strong>
          <span title={item.name}>{item.name || "-"}</span>
        </div>
        <span className={`status-chip status-chip--${item.status}`}>{STATUS_LABELS[item.status]}</span>
      </div>
      <div className="account-card__meta">
        <span>{item.plan_type || "unknown"}</span>
        <span>
          优先级 <strong>{renderPriorityValue(item.priority)}</strong>
        </span>
        {item.dirty_priority ? <span className="priority-draft-badge">未同步</span> : null}
        <span>{renderShortTimestamp(item.last_query_at)}</span>
        <span className="account-card__quota-updated">额度 {renderShortTimestamp(readQuotaUpdatedAt(item))}</span>
      </div>
      <div className="account-card__quotas">
        {renderMobileQuota("5h", window5h?.remaining_percent ?? null, window5h?.reset_label ?? null)}
        {renderMobileQuota("7d", window7d?.remaining_percent ?? null, window7d?.reset_label ?? null)}
      </div>
    </article>
  );
}

// 主表优先强调邮箱、额度和优先级，并把多选控制直接放进每一行。
export function AccountTable({
  items,
  sortState,
  selectedAuthIndex,
  selectedAuthIndexes,
  onRequestSort,
  onSelect,
  onToggleSelection,
  onToggleVisibleSelection,
}: AccountTableProps) {
  const selectedSet = new Set(selectedAuthIndexes);
  const allVisibleChecked = items.length > 0 && items.every((item) => selectedSet.has(item.auth_index));
  const activeSortKey = sortState.key;
  const activeSortDirection = sortState.direction;
  const isMobile = useIsMobileViewport();
  const tableVirtual = useVirtualWindow(items.length, TABLE_ROW_HEIGHT, DEFAULT_TABLE_VIEWPORT_HEIGHT);
  const mobileVirtual = useVirtualWindow(items.length, MOBILE_CARD_HEIGHT, DEFAULT_MOBILE_VIEWPORT_HEIGHT);
  const tableItems = items.slice(tableVirtual.start, tableVirtual.end);
  const mobileItems = items.slice(mobileVirtual.start, mobileVirtual.end);

  return (
    <section className="grid-panel">
      <div className="grid-panel__header">
        <div className="panel-heading panel-heading--compact">
          <p className="panel-heading__eyebrow">账号列表</p>
        </div>
        <div className="grid-panel__summary">
          <span>{items.length} 个结果</span>
          <span>{selectedAuthIndexes.length} 已选</span>
        </div>
      </div>
      <div className={isMobile ? "grid-panel__body account-list-body account-list-body--mobile" : "grid-panel__body account-list-body"} ref={isMobile ? mobileVirtual.containerRef : tableVirtual.containerRef}>
        {items.length === 0 ? <p className="empty-hint">当前筛选条件下没有账号。</p> : null}
        {items.length > 0 && isMobile ? (
          <div className="account-card-list" data-testid="account-card-list" style={{ minHeight: `${mobileVirtual.totalHeight}px` }}>
            <div style={{ height: `${mobileVirtual.beforeHeight}px` }} aria-hidden="true" />
            {mobileItems.map((item) => (
              <AccountMobileCard
                key={item.auth_index}
                item={item}
                active={selectedAuthIndex === item.auth_index}
                checked={selectedSet.has(item.auth_index)}
                onSelect={onSelect}
                onToggleSelection={onToggleSelection}
              />
            ))}
            <div style={{ height: `${mobileVirtual.afterHeight}px` }} aria-hidden="true" />
          </div>
        ) : null}
        {items.length > 0 && !isMobile ? (
          <table className="quota-grid">
            <thead>
              <tr>
                <th className="quota-grid__checkbox">
                  <input
                    type="checkbox"
                    checked={allVisibleChecked}
                    aria-label="选择当前列表全部账号"
                    onChange={(event) => onToggleVisibleSelection(event.target.checked)}
                  />
                </th>
                <th>
                  <button
                    type="button"
                    className={activeSortKey === "email" ? "quota-grid__sort quota-grid__sort--active" : "quota-grid__sort"}
                    aria-label={buildSortAriaLabel("邮箱", activeSortKey === "email", activeSortDirection)}
                    onClick={() => onRequestSort("email")}
                  >
                    <span>邮箱</span>
                    <span className="material-symbols-outlined" aria-hidden="true">
                      {renderSortIcon(activeSortKey === "email", activeSortDirection)}
                    </span>
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={activeSortKey === "priority" ? "quota-grid__sort quota-grid__sort--active" : "quota-grid__sort"}
                    aria-label={buildSortAriaLabel("优先级", activeSortKey === "priority", activeSortDirection)}
                    onClick={() => onRequestSort("priority")}
                  >
                    <span>优先级</span>
                    <span className="material-symbols-outlined" aria-hidden="true">
                      {renderSortIcon(activeSortKey === "priority", activeSortDirection)}
                    </span>
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={activeSortKey === "plan" ? "quota-grid__sort quota-grid__sort--active" : "quota-grid__sort"}
                    aria-label={buildSortAriaLabel("分组", activeSortKey === "plan", activeSortDirection)}
                    onClick={() => onRequestSort("plan")}
                  >
                    <span>分组</span>
                    <span className="material-symbols-outlined" aria-hidden="true">
                      {renderSortIcon(activeSortKey === "plan", activeSortDirection)}
                    </span>
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={activeSortKey === "status" ? "quota-grid__sort quota-grid__sort--active" : "quota-grid__sort"}
                    aria-label={buildSortAriaLabel("状态", activeSortKey === "status", activeSortDirection)}
                    onClick={() => onRequestSort("status")}
                  >
                    <span>状态</span>
                    <span className="material-symbols-outlined" aria-hidden="true">
                      {renderSortIcon(activeSortKey === "status", activeSortDirection)}
                    </span>
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={activeSortKey === "quota5h" ? "quota-grid__sort quota-grid__sort--active" : "quota-grid__sort"}
                    aria-label={buildSortAriaLabel("5h 额度", activeSortKey === "quota5h", activeSortDirection)}
                    onClick={() => onRequestSort("quota5h")}
                  >
                    <span>5h 额度</span>
                    <span className="material-symbols-outlined" aria-hidden="true">
                      {renderSortIcon(activeSortKey === "quota5h", activeSortDirection)}
                    </span>
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={activeSortKey === "quota7d" ? "quota-grid__sort quota-grid__sort--active" : "quota-grid__sort"}
                    aria-label={buildSortAriaLabel("7d 额度", activeSortKey === "quota7d", activeSortDirection)}
                    onClick={() => onRequestSort("quota7d")}
                  >
                    <span>7d 额度</span>
                    <span className="material-symbols-outlined" aria-hidden="true">
                      {renderSortIcon(activeSortKey === "quota7d", activeSortDirection)}
                    </span>
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={activeSortKey === "quotaUpdatedAt" ? "quota-grid__sort quota-grid__sort--active" : "quota-grid__sort"}
                    aria-label={buildSortAriaLabel("额度更新时间", activeSortKey === "quotaUpdatedAt", activeSortDirection)}
                    onClick={() => onRequestSort("quotaUpdatedAt")}
                  >
                    <span>额度更新时间</span>
                    <span className="material-symbols-outlined" aria-hidden="true">
                      {renderSortIcon(activeSortKey === "quotaUpdatedAt", activeSortDirection)}
                    </span>
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={activeSortKey === "updatedAt" ? "quota-grid__sort quota-grid__sort--active" : "quota-grid__sort"}
                    aria-label={buildSortAriaLabel("更新时间", activeSortKey === "updatedAt", activeSortDirection)}
                    onClick={() => onRequestSort("updatedAt")}
                  >
                    <span>更新时间</span>
                    <span className="material-symbols-outlined" aria-hidden="true">
                      {renderSortIcon(activeSortKey === "updatedAt", activeSortDirection)}
                    </span>
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {tableVirtual.beforeHeight > 0 ? (
                <tr aria-hidden="true">
                  <td className="quota-grid__spacer" colSpan={TABLE_COLUMN_COUNT} style={{ height: `${tableVirtual.beforeHeight}px` }} />
                </tr>
              ) : null}
              {tableItems.map((item) => {
                const window5h = findWindow(item, "code-5h");
                const window7d = findWindow(item, "code-7d");
                const active = selectedAuthIndex === item.auth_index;
                const checked = selectedSet.has(item.auth_index);
                return (
                  <tr
                    key={item.auth_index}
                    className={active ? "quota-grid__row quota-grid__row--active" : "quota-grid__row"}
                    onClick={() => onSelect(item.auth_index)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        onSelect(item.auth_index);
                      }
                    }}
                    tabIndex={0}
                    aria-selected={active}
                  >
                    <td className="quota-grid__checkbox">
                      <input
                        type="checkbox"
                        checked={checked}
                        aria-label={`选择 ${item.email || item.name}`}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => onToggleSelection(item.auth_index, event.target.checked)}
                      />
                    </td>
                    <td className="quota-grid__email">
                      <span title={item.email || item.name}>{item.email || item.name}</span>
                    </td>
                    <td>
                      <div className="priority-cell">
                        <span className="priority-chip priority-chip--value">{renderPriorityValue(item.priority)}</span>
                        {item.dirty_priority ? <span className="priority-draft-badge">未同步</span> : null}
                      </div>
                    </td>
                    <td>{item.plan_type || "unknown"}</td>
                    <td>
                      <span className={`status-chip status-chip--${item.status}`}>{STATUS_LABELS[item.status]}</span>
                    </td>
                    <td>{renderQuotaCell(window5h?.remaining_percent ?? null, window5h?.reset_label ?? null)}</td>
                    <td>{renderQuotaCell(window7d?.remaining_percent ?? null, window7d?.reset_label ?? null)}</td>
                    <td className="quota-grid__quota-updated-at" title={readQuotaUpdatedAt(item) || undefined}>
                      {renderShortTimestamp(readQuotaUpdatedAt(item))}
                    </td>
                    <td className="quota-grid__updated-at" title={item.last_query_at || undefined}>
                      {renderShortTimestamp(item.last_query_at)}
                    </td>
                  </tr>
                );
              })}
              {tableVirtual.afterHeight > 0 ? (
                <tr aria-hidden="true">
                  <td className="quota-grid__spacer" colSpan={TABLE_COLUMN_COUNT} style={{ height: `${tableVirtual.afterHeight}px` }} />
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
}
