import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { WindowChrome } from "./WindowChrome";
import { APP_VERSION_LABEL } from "../lib/app-version";

describe("WindowChrome", () => {
  it("展示 Web 顶栏、版本号、仓库链接和设置入口", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const onLogout = vi.fn();

    render(<WindowChrome onOpenSettings={onOpenSettings} onLogout={onLogout} />);

    const repositoryLink = screen.getByRole("link", { name: "打开 GitHub 仓库" });
    expect(repositoryLink).toHaveAttribute("href", "https://github.com/RuidongWang/CPA_Codex_tools");
    expect(repositoryLink).toHaveAttribute("target", "_blank");
    expect(repositoryLink).toHaveAttribute("rel", "noreferrer noopener");
    expect(screen.getByText(APP_VERSION_LABEL)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开设置" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "退出登录" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "最小化窗口" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "最大化窗口" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关闭窗口" })).not.toBeInTheDocument();
  });
});
