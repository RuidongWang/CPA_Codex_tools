export type SidebarPage = "quota" | "config" | "keeper";

interface SidebarFiltersProps {
  activePage: SidebarPage;
  onPageChange: (page: SidebarPage) => void;
  accountCount: number;
}

const PAGE_NAV_ITEMS: Array<{ key: SidebarPage; label: string; icon: string }> = [
  { key: "quota", label: "额度", icon: "monitoring" },
  { key: "config", label: "配置", icon: "tune" },
  { key: "keeper", label: "Keeper", icon: "shield" },
];

function pageAriaLabel(page: SidebarPage): string {
  if (page === "quota") {
    return "额度页面";
  }
  if (page === "config") {
    return "配置页面";
  }
  return "Keeper页面";
}

export function SidebarFilters(props: SidebarFiltersProps) {
  return (
    <aside className="rail">
      <div className="rail__brand" aria-hidden="true">
        <span className="material-symbols-outlined">monitoring</span>
        <span className="rail__brand-mark">CPA OPS</span>
      </div>
      <nav className="rail__pages" aria-label="页面导航">
        {PAGE_NAV_ITEMS.map((item) => {
          const active = props.activePage === item.key;
          return (
            <button
              key={item.key}
              type="button"
              aria-label={pageAriaLabel(item.key)}
              className={active ? "rail-button rail-button--active" : "rail-button"}
              onClick={() => props.onPageChange(item.key)}
            >
              <span className="material-symbols-outlined">{item.icon}</span>
              <span className="rail-button__label">{item.label}</span>
              <span className="rail-button__count">{props.accountCount}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
