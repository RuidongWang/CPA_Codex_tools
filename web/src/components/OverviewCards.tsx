import { useI18n } from "../lib/i18n";
import type { OverviewStat } from "../lib/view-model";

interface OverviewCardsProps {
  stats: OverviewStat[];
  selectedStatus: string;
  onSelectStatus: (status: string) => void;
}

// 总览卡故意保持克制，只突出数值和标签，不额外塞解释性废话。
export function OverviewCards({ stats, selectedStatus, onSelectStatus }: OverviewCardsProps) {
  const { t } = useI18n();
  return (
    <section className="metric-grid" aria-label={t("overview.label")}>
      {stats.map((stat) => {
        const label = t(`overview.${stat.key}` as Parameters<typeof t>[0]);
        return (
          <button
            key={stat.key}
            type="button"
            aria-label={`${label} ${stat.value}`}
            className={selectedStatus === stat.statusFilter ? `metric-card metric-card--${stat.tone} metric-card--active` : `metric-card metric-card--${stat.tone}`}
            onClick={() => onSelectStatus(stat.statusFilter)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">{stat.icon}</span>
            <span className="metric-card__label">{label}</span>
            <strong className="metric-card__value">{stat.value.toLocaleString()}</strong>
          </button>
        );
      })}
    </section>
  );
}
