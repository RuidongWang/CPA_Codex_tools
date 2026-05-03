import { APP_VERSION_LABEL } from "../lib/app-version";

const REPOSITORY_URL = "https://github.com/RuidongWang/CPA_Codex_tools";

interface WindowChromeProps {
  onOpenSettings: () => void;
}

// Web-only 顶栏只保留产品标题、仓库链接和设置入口。
export function WindowChrome({ onOpenSettings }: WindowChromeProps) {
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
      <a
        className="window-chrome__repo-link"
        href={REPOSITORY_URL}
        aria-label="打开 GitHub 仓库"
        target="_blank"
        rel="noreferrer noopener"
      >
        github.com/RuidongWang/CPA_Codex_tools
      </a>
      <div className="window-chrome__actions">
        <button type="button" className="window-chrome__button" aria-label="打开设置" onClick={onOpenSettings}>
          <span className="material-symbols-outlined">settings</span>
        </button>
      </div>
    </div>
  );
}
