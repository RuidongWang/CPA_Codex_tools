import { APP_VERSION_LABEL } from "../lib/app-version";

interface WindowChromeProps {
  onOpenSettings: () => void;
  onLogout: () => void;
}

// Web-only 顶栏保留产品标题、退出和设置入口。
export function WindowChrome({ onOpenSettings, onLogout }: WindowChromeProps) {
  return (
    <div className="window-chrome">
      <div className="window-chrome__drag-region" data-testid="window-brand-region">
        <div className="window-chrome__brand">
          <span className="window-chrome__brand-dot" aria-hidden="true" />
          <div className="window-chrome__brand-copy">
            <strong className="window-chrome__title">
              Codex 额度监控台
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
          aria-label="退出登录"
          onClick={onLogout}
        >
          <span className="material-symbols-outlined">logout</span>
        </button>
        <button type="button" className="window-chrome__button" aria-label="打开设置" onClick={onOpenSettings}>
          <span className="material-symbols-outlined">settings</span>
        </button>
      </div>
    </div>
  );
}
