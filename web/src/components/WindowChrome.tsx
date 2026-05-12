import { APP_VERSION_LABEL } from "../lib/app-version";
import { useI18n } from "../lib/i18n";

interface WindowChromeProps {
  onOpenSettings: () => void;
  onLogout: () => void;
}

// Web-only 顶栏保留产品标题、退出和设置入口。
export function WindowChrome({ onOpenSettings, onLogout }: WindowChromeProps) {
  const { t } = useI18n();
  return (
    <div className="window-chrome">
      <div className="window-chrome__drag-region" data-testid="window-brand-region">
        <div className="window-chrome__brand">
          <span className="window-chrome__brand-dot" aria-hidden="true" />
          <div className="window-chrome__brand-copy">
            <strong className="window-chrome__title">
              {t("app.title")}
            </strong>
            <span className="window-chrome__version">
              {APP_VERSION_LABEL}
            </span>
          </div>
        </div>
        <div className="window-chrome__drag-spacer" />
      </div>
      <div className="window-chrome__actions">
        <button
          type="button"
          className="window-chrome__button window-chrome__button--danger"
          aria-label={t("window.logout")}
          onClick={onLogout}
        >
          <span className="material-symbols-outlined">logout</span>
        </button>
        <button type="button" className="window-chrome__button" aria-label={t("window.settings")} onClick={onOpenSettings}>
          <span className="material-symbols-outlined">settings</span>
        </button>
      </div>
    </div>
  );
}
