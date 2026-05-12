import { useI18n, type I18nKey } from "../lib/i18n";

export type SidebarPage = "quota" | "config" | "keeper" | "oauth";

interface SidebarFiltersProps {
  activePage: SidebarPage;
  onPageChange: (page: SidebarPage) => void;
  accountCount: number;
}

const PAGE_NAV_ITEMS: Array<{ key: SidebarPage; label: string; icon: string }> = [
  { key: "quota", label: "额度", icon: "monitoring" },
  { key: "config", label: "配置", icon: "tune" },
  { key: "keeper", label: "Keeper", icon: "shield" },
  { key: "oauth", label: "OAuth", icon: "key" },
];

function pageLabelKey(page: SidebarPage): I18nKey {
  return `sidebar.${page}` as I18nKey;
}

function pageAriaLabelKey(page: SidebarPage): I18nKey {
  if (page === "quota") {
    return "sidebar.quotaAria";
  }
  if (page === "config") {
    return "sidebar.configAria";
  }
  if (page === "keeper") {
    return "sidebar.keeperAria";
  }
  return "sidebar.oauthAria";
}

export function SidebarFilters(props: SidebarFiltersProps) {
  const { t } = useI18n();
  return (
    <aside className="rail">
      <div className="rail__brand" aria-hidden="true">
        <span className="material-symbols-outlined">monitoring</span>
        <span className="rail__brand-mark">CPA OPS</span>
      </div>
      <nav className="rail__pages" aria-label={t("sidebar.nav")}>
        {PAGE_NAV_ITEMS.map((item) => {
          const active = props.activePage === item.key;
          return (
            <button
              key={item.key}
              type="button"
              aria-label={t(pageAriaLabelKey(item.key))}
              className={active ? "rail-button rail-button--active" : "rail-button"}
              onClick={() => props.onPageChange(item.key)}
            >
              <span className="material-symbols-outlined">{item.icon}</span>
              <span className="rail-button__label">{t(pageLabelKey(item.key))}</span>
              <span className="rail-button__count">{props.accountCount}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
