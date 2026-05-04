import { PLAN_NAV_ITEMS } from "../lib/view-model";

interface PlanFilterBarProps {
  planCounts: Record<string, number>;
  selectedPlan: string;
  search: string;
  busy: boolean;
  onPlanChange: (plan: string) => void;
  onSearchChange: (value: string) => void;
}

export function PlanFilterBar(props: PlanFilterBarProps) {
  const allCount = Object.values(props.planCounts).reduce((sum, count) => sum + count, 0);

  return (
    <nav className="plan-filter-strip" aria-label="计划筛选">
      <div className="plan-filter-strip__items">
        {PLAN_NAV_ITEMS.map((item) => {
          const count = item.key === "all" ? allCount : (props.planCounts[item.key] ?? 0);
          const active = props.selectedPlan === item.key;
          return (
            <button
              key={item.key}
              type="button"
              aria-label={item.key}
              className={active ? "plan-filter-button plan-filter-button--active" : "plan-filter-button"}
              onClick={() => props.onPlanChange(item.key)}
            >
              <span className="material-symbols-outlined">{item.icon}</span>
              <span className="plan-filter-button__label">{item.label}</span>
              <span className="plan-filter-button__count">{count}</span>
            </button>
          );
        })}
      </div>
      <label className="command-field command-field--search plan-filter-search">
        <span className="material-symbols-outlined">search</span>
        <input
          className="command-field__input"
          value={props.search}
          disabled={props.busy}
          onChange={(event) => props.onSearchChange(event.target.value)}
          placeholder="按邮箱搜索"
        />
      </label>
    </nav>
  );
}
