import type { AccountItem } from "../types";
import type { SortDirection, SortState } from "../lib/view-model";

interface AccountTableProps {
  items: AccountItem[];
  sortState: SortState;
  selectedAuthIndex: string;
  selectedAuthIndexes: string[];
  onRequestSort: (key: "email" | "plan" | "status" | "priority" | "quota5h" | "quota7d" | "updatedAt") => void;
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
      <div className="grid-panel__body">
        {items.length === 0 ? <p className="empty-hint">当前筛选条件下没有账号。</p> : null}
        {items.length > 0 ? (
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
              {items.map((item) => {
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
                    <td className="quota-grid__updated-at" title={item.last_query_at || undefined}>
                      {renderShortTimestamp(item.last_query_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
}
