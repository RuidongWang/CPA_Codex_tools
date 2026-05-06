import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodexOAuthPanel } from "./CodexOAuthPanel";
import type { AccountItem, OAuthSettings } from "../types";

function makeAccount(overrides: Partial<AccountItem> = {}): AccountItem {
  return {
    name: "codex-a.json",
    email: "a@hotmail.com",
    plan_type: "free",
    account_id: "acct-a",
    auth_index: "idx-a",
    priority: null,
    status: "error",
    windows: [],
    additional_windows: [],
    error: "Token 失效",
    has_refresh_token: false,
    last_query_at: "2026-05-06T00:00:00Z",
    quota_updated_at: null,
    ...overrides,
  };
}

const emptySettings: OAuthSettings = {
  hotmailHelperUrl: "http://127.0.0.1:17373",
  hotmailAccounts: [],
};

describe("CodexOAuthPanel", () => {
  it("does not fall back to all accounts when no invalid evidence exists", () => {
    render(
      <CodexOAuthPanel
        items={[
          makeAccount({
            email: "normal@outlook.com",
            auth_index: "idx-normal",
            status: "healthy",
            disabled: true,
            has_refresh_token: false,
            expired: "2026-05-05T00:00:00Z",
          }),
        ]}
        settings={emptySettings}
        ready
        onSettingsChange={vi.fn()}
        onStartOAuth={vi.fn()}
        onSubmitOAuthCallback={vi.fn()}
        onPollOAuthStatus={vi.fn()}
        onFetchHotmailCode={vi.fn()}
        onCheckLoginQuota={vi.fn()}
      />,
    );

    const reloginAccounts = screen.getByRole("region", { name: "失效账号" });
    expect(within(reloginAccounts).queryByText("normal@outlook.com")).not.toBeInTheDocument();
    expect(within(reloginAccounts).getByText("暂无符合条件的失效账号。")).toBeInTheDocument();
  });

  it("only lists queried quota errors and keeper refresh failures as invalid accounts", () => {
    render(
      <CodexOAuthPanel
        items={[
          makeAccount({
            email: "normal-disabled@outlook.com",
            auth_index: "idx-normal-disabled",
            status: "healthy",
            disabled: true,
            has_refresh_token: false,
            expired: "2026-05-05T00:00:00Z",
          }),
          makeAccount({
            email: "quota-error@outlook.com",
            auth_index: "idx-quota-error",
            status: "error",
            error: "额度接口失败",
            last_query_at: "2026-05-06T00:00:00Z",
          }),
          makeAccount({
            email: "keeper-refresh-failed@outlook.com",
            auth_index: "idx-keeper-refresh-failed",
            status: "healthy",
          }),
        ]}
        keeperRefreshFailureAuthIndexes={["idx-keeper-refresh-failed"]}
        settings={emptySettings}
        ready
        onSettingsChange={vi.fn()}
        onStartOAuth={vi.fn()}
        onSubmitOAuthCallback={vi.fn()}
        onPollOAuthStatus={vi.fn()}
        onFetchHotmailCode={vi.fn()}
        onCheckLoginQuota={vi.fn()}
      />,
    );

    const reloginAccounts = screen.getByRole("region", { name: "失效账号" });
    expect(within(reloginAccounts).getByText("quota-error@outlook.com")).toBeInTheDocument();
    expect(within(reloginAccounts).getByText("Keeper 刷新失败 · free")).toBeInTheDocument();
    expect(within(reloginAccounts).getByText("keeper-refresh-failed@outlook.com")).toBeInTheDocument();
    expect(within(reloginAccounts).queryByText("normal-disabled@outlook.com")).not.toBeInTheDocument();
  });

  it("imports hotmail accounts in reference format and saves them into settings", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();

    render(
      <CodexOAuthPanel
        items={[makeAccount()]}
        settings={emptySettings}
        ready
        onSettingsChange={onSettingsChange}
        onStartOAuth={vi.fn()}
        onSubmitOAuthCallback={vi.fn()}
        onPollOAuthStatus={vi.fn()}
        onFetchHotmailCode={vi.fn()}
        onCheckLoginQuota={vi.fn()}
      />,
    );

    await user.type(
      screen.getByLabelText("Hotmail 批量导入"),
      "账号----密码----ID----Token\nalice@hotmail.com----pass----client-id----refresh-token",
    );
    await user.click(screen.getByRole("button", { name: "导入 Hotmail 账号" }));

    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({
      hotmailAccounts: [
        expect.objectContaining({
          email: "alice@hotmail.com",
          password: "pass",
          clientId: "client-id",
          refreshToken: "refresh-token",
        }),
      ],
    }));
  });

  it("starts OAuth, fetches hotmail code, and checks CPA status", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    const onStartOAuth = vi.fn().mockResolvedValue({
      authUrl: "https://auth.openai.com/oauth?state=oauth-state",
      state: "oauth-state",
      raw: {},
    });
    const onFetchHotmailCode = vi.fn().mockResolvedValue({
      code: "123456",
      nextRefreshToken: "next-refresh-token",
      transport: "graph",
      raw: {},
    });
    const onPollOAuthStatus = vi.fn().mockResolvedValue({
      state: "oauth-state",
      status: "success",
      email: "a@hotmail.com",
      message: "认证成功",
      raw: {},
    });
    const onSubmitOAuthCallback = vi.fn().mockResolvedValue({
      state: "oauth-state",
      status: "success",
      message: "回调 URL 已提交",
      raw: {},
    });
    const onCheckLoginQuota = vi.fn().mockResolvedValue(undefined);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <CodexOAuthPanel
        items={[makeAccount()]}
        settings={{
          hotmailHelperUrl: "http://127.0.0.1:17373",
          hotmailAccounts: [
            {
              id: "alice@hotmail.com::client-id",
              email: "a@hotmail.com",
              password: "pass",
              clientId: "client-id",
              refreshToken: "refresh-token",
              status: "authorized",
            },
          ],
        }}
        ready
        onSettingsChange={onSettingsChange}
        onStartOAuth={onStartOAuth}
        onSubmitOAuthCallback={onSubmitOAuthCallback}
        onPollOAuthStatus={onPollOAuthStatus}
        onFetchHotmailCode={onFetchHotmailCode}
        onCheckLoginQuota={onCheckLoginQuota}
      />,
    );

    const reloginAccounts = screen.getByRole("region", { name: "失效账号" });
    await user.click(within(reloginAccounts).getByRole("radio", { name: /a@hotmail.com/ }));
    await user.click(screen.getByRole("button", { name: "发起 OAuth登录" }));

    expect(openSpy).toHaveBeenCalledWith("https://auth.openai.com/oauth?state=oauth-state", "_blank", "noopener,noreferrer");
    expect(await screen.findByText("oauth-state")).toBeInTheDocument();

    await user.type(
      screen.getByLabelText("OAuth 回调 URL"),
      "http://localhost:1455/auth/callback?code=oauth-code&state=oauth-state",
    );
    await user.click(screen.getByRole("button", { name: "提交回调 URL" }));

    expect(onSubmitOAuthCallback).toHaveBeenCalledWith(
      "oauth-state",
      "http://localhost:1455/auth/callback?code=oauth-code&state=oauth-state",
    );
    expect(await screen.findByText("回调 URL 已提交")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "获取 Hotmail 验证码" }));

    expect(onFetchHotmailCode).toHaveBeenCalledWith(
      expect.objectContaining({ email: "a@hotmail.com", refreshToken: "refresh-token" }),
      expect.objectContaining({ excludeCodes: [] }),
    );
    expect(await screen.findByText("123456")).toBeInTheDocument();
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({
      hotmailAccounts: [
        expect.objectContaining({
          email: "a@hotmail.com",
          refreshToken: "next-refresh-token",
          status: "authorized",
          lastCode: "123456",
        }),
      ],
    }));

    await user.click(screen.getByRole("button", { name: "检查登录状态" }));

    await waitFor(() => {
      expect(onCheckLoginQuota).toHaveBeenCalledWith(expect.objectContaining({ auth_index: "idx-a" }));
    });
    const statusRegion = screen.getByRole("region", { name: "OAuth 状态" });
    expect(within(statusRegion).getByText("认证成功")).toBeInTheDocument();
  });

  it("filters and selects the Hotmail account that matches the selected CPA account email", async () => {
    const user = userEvent.setup();
    const onFetchHotmailCode = vi.fn().mockResolvedValue({
      code: "654321",
      nextRefreshToken: "target-next-refresh-token",
      transport: "graph",
      raw: {},
    });

    render(
      <CodexOAuthPanel
        items={[
          makeAccount({ email: "first@outlook.com", auth_index: "idx-first" }),
          makeAccount({ email: "target@outlook.com", auth_index: "idx-target" }),
        ]}
        settings={{
          hotmailHelperUrl: "http://127.0.0.1:17373",
          hotmailAccounts: [
            {
              id: "first@outlook.com::client-first",
              email: "first@outlook.com",
              password: "pass",
              clientId: "client-first",
              refreshToken: "first-refresh-token",
              status: "authorized",
            },
            {
              id: "target@outlook.com::client-target",
              email: "target@outlook.com",
              password: "pass",
              clientId: "client-target",
              refreshToken: "target-refresh-token",
              status: "authorized",
            },
          ],
        }}
        ready
        onSettingsChange={vi.fn()}
        onStartOAuth={vi.fn()}
        onSubmitOAuthCallback={vi.fn()}
        onPollOAuthStatus={vi.fn()}
        onFetchHotmailCode={onFetchHotmailCode}
        onCheckLoginQuota={vi.fn()}
      />,
    );

    const hotmailPool = screen.getByRole("region", { name: "Hotmail 账号池" });
    expect(within(hotmailPool).getByText("first@outlook.com")).toBeInTheDocument();
    expect(within(hotmailPool).queryByText("target@outlook.com")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /target@outlook.com/ }));

    expect(within(hotmailPool).getByText("target@outlook.com")).toBeInTheDocument();
    expect(within(hotmailPool).queryByText("first@outlook.com")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "获取 Hotmail 验证码" }));

    expect(onFetchHotmailCode).toHaveBeenCalledWith(
      expect.objectContaining({ email: "target@outlook.com", refreshToken: "target-refresh-token" }),
      expect.any(Object),
    );
  });

  it("filters OAuth account and Hotmail lists from their search boxes", async () => {
    const user = userEvent.setup();

    render(
      <CodexOAuthPanel
        items={[
          makeAccount({ email: "first@outlook.com", auth_index: "idx-first" }),
          makeAccount({ email: "target@outlook.com", auth_index: "idx-target" }),
        ]}
        settings={{
          hotmailHelperUrl: "http://127.0.0.1:17373",
          hotmailAccounts: [
            {
              id: "target@outlook.com::client-main",
              email: "target@outlook.com",
              password: "pass",
              clientId: "client-main",
              refreshToken: "target-refresh-token",
              status: "authorized",
            },
            {
              id: "target@outlook.com::client-backup",
              email: "target@outlook.com",
              password: "pass",
              clientId: "client-backup",
              refreshToken: "backup-refresh-token",
              status: "pending",
            },
          ],
        }}
        ready
        onSettingsChange={vi.fn()}
        onStartOAuth={vi.fn()}
        onSubmitOAuthCallback={vi.fn()}
        onPollOAuthStatus={vi.fn()}
        onFetchHotmailCode={vi.fn()}
        onCheckLoginQuota={vi.fn()}
      />,
    );

    const reloginAccounts = screen.getByRole("region", { name: "失效账号" });
    await user.type(within(reloginAccounts).getByLabelText("检索失效账号"), "target");

    expect(within(reloginAccounts).getByText("target@outlook.com")).toBeInTheDocument();
    expect(within(reloginAccounts).queryByText("first@outlook.com")).not.toBeInTheDocument();

    const hotmailPool = screen.getByRole("region", { name: "Hotmail 账号池" });
    expect(within(hotmailPool).getByText(/client-main/)).toBeInTheDocument();
    expect(within(hotmailPool).getByText(/client-backup/)).toBeInTheDocument();

    await user.type(within(hotmailPool).getByLabelText("检索 Hotmail 账号"), "backup");

    expect(within(hotmailPool).queryByText(/client-main/)).not.toBeInTheDocument();
    expect(within(hotmailPool).getByText(/client-backup/)).toBeInTheDocument();
  });
});
