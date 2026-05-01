import type { MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { APP_VERSION_LABEL } from "../lib/app-version";
import { openExternalUrl } from "../lib/api";

type WindowHandle = ReturnType<typeof getCurrentWindow>;
const REPOSITORY_URL = "https://github.com/MarkLunaCoder/CPA_Codex_Quota_Mgt";

function hasTauriWindowRuntime(): boolean {
  // 普通 Web 版没有桌面窗口句柄，标题栏只保留设置入口，避免显示无效的最小化/关闭按钮。
  return typeof window !== "undefined" && Boolean((window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function resolveWindowHandle(): WindowHandle | null {
  if (!hasTauriWindowRuntime()) {
    return null;
  }
  try {
    return getCurrentWindow();
  } catch (error) {
    // 普通网页环境和单测环境没有 Tauri 注入对象，这里只记日志，不让按钮静默失效。
    console.warn("当前环境没有可用的 Tauri 窗口句柄", error);
    return null;
  }
}

async function withCurrentWindow(action: (windowHandle: WindowHandle) => Promise<void>) {
  const windowHandle = resolveWindowHandle();
  if (!windowHandle) {
    return;
  }
  try {
    await action(windowHandle);
  } catch (error) {
    // 窗口控制失败时保留日志，避免再次出现“按钮没反应但没有任何线索”。
    console.error("Tauri 窗口控制调用失败", error);
  }
}

interface WindowChromeProps {
  onOpenSettings: () => void;
}

// 自绘标题栏只保留一个清晰的产品标题，并把可拖拽区域和控制按钮彻底分开。
export function WindowChrome({ onOpenSettings }: WindowChromeProps) {
  const tauriWindowAvailable = hasTauriWindowRuntime();

  function handleDragMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (!tauriWindowAvailable) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (event.detail >= 2) {
      // 双击标题栏保持和原生窗口一致，直接切换最大化状态。
      void withCurrentWindow((windowHandle) => windowHandle.toggleMaximize());
      return;
    }
    // 手动调用 startDragging 比单纯依赖 data-tauri-drag-region 更稳，标题文字本身也能拖动。
    void withCurrentWindow((windowHandle) => windowHandle.startDragging());
  }

  function handleRepositoryClick(event: ReactMouseEvent<HTMLAnchorElement>) {
    // 外链统一经由运行时适配层处理，Web 新开页，桌面端则交给系统默认浏览器。
    event.preventDefault();
    void openExternalUrl(REPOSITORY_URL);
  }

  return (
    <div className="window-chrome">
      <div
        className="window-chrome__drag-region"
        data-tauri-drag-region
        data-testid="window-drag-region"
        onMouseDown={handleDragMouseDown}
      >
        <div className="window-chrome__brand" data-tauri-drag-region>
          <span className="window-chrome__brand-dot" data-tauri-drag-region aria-hidden="true" />
          <div className="window-chrome__brand-copy" data-tauri-drag-region>
            <strong className="window-chrome__title" data-tauri-drag-region>
              Codex 额度监控台
            </strong>
            <span className="window-chrome__version" data-tauri-drag-region>
              {APP_VERSION_LABEL}
            </span>
          </div>
        </div>
        <div className="window-chrome__drag-spacer" data-tauri-drag-region />
      </div>
      <a
        className="window-chrome__repo-link"
        href={REPOSITORY_URL}
        aria-label="打开 GitHub 仓库"
        target="_blank"
        rel="noreferrer noopener"
        onClick={handleRepositoryClick}
      >
        github.com/MarkLunaCoder/CPA_Codex_Quota_Mgt
      </a>
      <div className="window-chrome__actions">
        <button type="button" className="window-chrome__button" aria-label="打开设置" onClick={onOpenSettings}>
          <span className="material-symbols-outlined">settings</span>
        </button>
        {tauriWindowAvailable ? (
          <>
            <button type="button" className="window-chrome__button" aria-label="最小化窗口" onClick={() => void withCurrentWindow((windowHandle) => windowHandle.minimize())}>
              <span className="material-symbols-outlined">remove</span>
            </button>
            <button type="button" className="window-chrome__button" aria-label="最大化窗口" onClick={() => void withCurrentWindow((windowHandle) => windowHandle.toggleMaximize())}>
              <span className="material-symbols-outlined">crop_square</span>
            </button>
            <button type="button" className="window-chrome__button window-chrome__button--danger" aria-label="关闭窗口" onClick={() => void withCurrentWindow((windowHandle) => windowHandle.close())}>
              <span className="material-symbols-outlined">close</span>
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
