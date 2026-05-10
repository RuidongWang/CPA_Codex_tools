import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import type { RuntimeConfig } from "../types";

const baseConfig: RuntimeConfig = {
  cpaBaseUrl: "https://cpa.example/",
  managementKey: "example-management-key",
  queryConcurrency: 6,
  keeperSettings: {
    quotaThreshold: 100,
    expiryThresholdDays: 3,
    enableRefresh: true,
    workerThreads: 6,
  },
  priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
  priorityPlanRanges: {},
  oauthSettings: {
    hotmailHelperUrl: "http://127.0.0.1:17373",
    hotmailAccounts: [],
    rememberHotmailTokens: false,
    importedInvalidAccountEmails: [],
  },
};

describe("SettingsPanel", () => {
  it("展示查询并发、Keeper 策略和缓存清理设置项", () => {
    render(
      <SettingsPanel
        open
        config={baseConfig}
        saving={false}
        clearingCache={false}
        busy={false}
        onClose={() => undefined}
        onSave={() => undefined}
        onClearCache={() => undefined}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "查询设置" });

    expect(within(dialog).getByLabelText("并发数")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("禁用阈值")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("过期阈值天数")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("维护并发数")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("维护时自动刷新临期证书")).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "清空本地缓存" })).toBeInTheDocument();
    expect(within(dialog).getByText("账号配置备份会通过浏览器直接下载 JSON 文件，不需要配置本地路径。")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("查询并发数")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("优先级顺序")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "左移" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "右移" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText("开源仓库")).not.toBeInTheDocument();
  });

  it("保存时回传查询和 Keeper 设置", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(
      <SettingsPanel
        open
        config={baseConfig}
        saving={false}
        clearingCache={false}
        busy={false}
        onClose={() => undefined}
        onSave={onSave}
        onClearCache={() => undefined}
      />,
    );

    await user.clear(screen.getByLabelText("并发数"));
    await user.type(screen.getByLabelText("并发数"), "4");
    await user.clear(screen.getByLabelText("禁用阈值"));
    await user.type(screen.getByLabelText("禁用阈值"), "95");
    await user.clear(screen.getByLabelText("过期阈值天数"));
    await user.type(screen.getByLabelText("过期阈值天数"), "2");
    await user.clear(screen.getByLabelText("维护并发数"));
    await user.type(screen.getByLabelText("维护并发数"), "8");
    await user.click(screen.getByLabelText("维护时自动刷新临期证书"));
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    expect(onSave).toHaveBeenCalledWith({
      queryConcurrency: 4,
      keeperSettings: {
        quotaThreshold: 95,
        expiryThresholdDays: 2,
        enableRefresh: false,
        workerThreads: 8,
      },
    });
  });

  it("点击清空本地缓存会触发对应回调", async () => {
    const user = userEvent.setup();
    const onClearCache = vi.fn();

    render(
      <SettingsPanel
        open
        config={baseConfig}
        saving={false}
        clearingCache={false}
        busy={false}
        onClose={() => undefined}
        onSave={() => undefined}
        onClearCache={onClearCache}
      />,
    );

    await user.click(screen.getByRole("button", { name: "清空本地缓存" }));

    expect(onClearCache).toHaveBeenCalledTimes(1);
  });
});
