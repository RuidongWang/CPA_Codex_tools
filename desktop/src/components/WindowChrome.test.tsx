import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { WindowChrome } from "./WindowChrome";
import { APP_VERSION_LABEL } from "../lib/app-version";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

const windowHandle = {
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  startDragging: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => windowHandle),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

  beforeEach(() => {
  vi.clearAllMocks();
  (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});

describe("WindowChrome", () => {
  it("窗口控制按钮会调用对应的 Tauri 窗口方法", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();

    render(<WindowChrome onOpenSettings={onOpenSettings} />);

    await user.click(screen.getByRole("button", { name: "打开设置" }));
    await user.click(screen.getByRole("button", { name: "最小化窗口" }));
    await user.click(screen.getByRole("button", { name: "最大化窗口" }));
    await user.click(screen.getByRole("button", { name: "关闭窗口" }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(windowHandle.minimize).toHaveBeenCalledTimes(1);
    expect(windowHandle.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(windowHandle.close).toHaveBeenCalledTimes(1);
  });

  it("标题栏拖拽区支持拖动和双击最大化", () => {
    render(<WindowChrome onOpenSettings={() => undefined} />);

    const dragRegion = screen.getByTestId("window-drag-region");

    // 单击按下时应该触发窗口拖动。
    fireEvent.mouseDown(dragRegion, { buttons: 1, detail: 1 });
    expect(windowHandle.startDragging).toHaveBeenCalledTimes(1);

    // 双击按下时应该复用原生标题栏的最大化行为。
    fireEvent.mouseDown(dragRegion, { buttons: 1, detail: 2 });
    expect(windowHandle.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("普通 Web 环境不展示桌面窗口控制按钮", () => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

    render(<WindowChrome onOpenSettings={() => undefined} />);

    const repositoryLink = screen.getByRole("link", { name: "打开 GitHub 仓库" });
    expect(repositoryLink).toHaveAttribute("href", "https://github.com/MarkLunaCoder/CPA_Codex_Quota_Mgt");
    expect(repositoryLink).toHaveAttribute("target", "_blank");
    expect(repositoryLink).toHaveAttribute("rel", "noreferrer noopener");
    expect(screen.getByText(APP_VERSION_LABEL)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开设置" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "最小化窗口" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "最大化窗口" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关闭窗口" })).not.toBeInTheDocument();
  });

  it("点击 GitHub 链接会主动新开页面", async () => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(<WindowChrome onOpenSettings={() => undefined} />);

    await user.click(screen.getByRole("link", { name: "打开 GitHub 仓库" }));

    expect(openSpy).toHaveBeenCalledWith(
      "https://github.com/MarkLunaCoder/CPA_Codex_Quota_Mgt",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("桌面端点击 GitHub 链接会交给 Tauri 命令层打开外部浏览器", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(<WindowChrome onOpenSettings={() => undefined} />);

    await user.click(screen.getByRole("link", { name: "打开 GitHub 仓库" }));

    expect(invokeMock).toHaveBeenCalledWith("open_external_url", {
      url: "https://github.com/MarkLunaCoder/CPA_Codex_Quota_Mgt",
    });
    expect(openSpy).not.toHaveBeenCalled();
  });
});
