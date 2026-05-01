import { PLAN_NAV_ITEMS } from "../lib/view-model";

interface SidebarFiltersProps {
  planCounts: Record<string, number>;
  selectedPlan: string;
  onPlanChange: (plan: string) => void;
}

// 左侧导航直接沿用计划原始分组名，避免和后端口径出现二次映射。
export function SidebarFilters(props: SidebarFiltersProps) {
  const allCount = Object.values(props.planCounts).reduce((sum, count) => sum + count, 0);

  return (
    <aside className="rail">
      <div className="rail__brand" aria-hidden="true">
        <span className="material-symbols-outlined">desktop_windows</span>
        <span className="rail__brand-mark">CPA OPS</span>
      </div>
      <div className="rail__nav">
        {PLAN_NAV_ITEMS.map((item) => {
          const count = item.key === "all" ? allCount : (props.planCounts[item.key] ?? 0);
          const active = props.selectedPlan === item.key;
          return (
            <button
              key={item.key}
              type="button"
              aria-label={item.key}
              className={active ? "rail-button rail-button--active" : "rail-button"}
              onClick={() => props.onPlanChange(item.key)}
            >
              <span className="material-symbols-outlined">{item.icon}</span>
              <span className="rail-button__label">{item.label}</span>
              <span className="rail-button__count">{count}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
