import type { OverviewStat } from "../lib/view-model";

interface OverviewCardsProps {
  stats: OverviewStat[];
  selectedStatus: string;
  onSelectStatus: (status: string) => void;
}

// 总览卡故意保持克制，只突出数值和标签，不额外塞解释性废话。
export function OverviewCards({ stats, selectedStatus, onSelectStatus }: OverviewCardsProps) {
  return (
    <section className="metric-grid" aria-label="总览">
      {stats.map((stat) => (
        <button
          key={stat.key}
          type="button"
          aria-label={`${stat.label} ${stat.value}`}
          className={selectedStatus === stat.statusFilter ? `metric-card metric-card--${stat.tone} metric-card--active` : `metric-card metric-card--${stat.tone}`}
          onClick={() => onSelectStatus(stat.statusFilter)}
        >
          <div className="metric-card__top">
            <p className="metric-card__label">{stat.label}</p>
            <span className="material-symbols-outlined">{stat.icon}</span>
          </div>
          <strong className="metric-card__value">{stat.value.toLocaleString()}</strong>
        </button>
      ))}
    </section>
  );
}
