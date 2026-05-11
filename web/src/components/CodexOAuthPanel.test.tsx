import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodexOAuthPanel } from "./CodexOAuthPanel";
import type { AccountItem, OAuthJob, OAuthSettings } from "../types";

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

function makeQueueJob(overrides: Partial<OAuthJob> = {}): OAuthJob {
  return {
    jobId: "job-a",
    authIndex: "idx-a",
    accountEmail: "queue-a@outlook.com",
    accountName: "codex-a.json",
    planType: "free",
    hotmailId: "queue-a@outlook.com::client-id",
    hotmailEmail: "queue-a@outlook.com",
    status: "queued",
    attempt: 0,
    retryCount: 0,
    startedAt: null,
    updatedAt: "2026-05-07T08:00:00Z",
    lockedByExtension: "",
    leaseExpiresAt: null,
    state: "",
    authUrl: "",
    callbackUrl: "",
    callbackSubmittedAt: null,
    oauthStatus: "",
    oauthCheckedAt: null,
    oauthError: "",
    lastError: "",
    lastErrorType: "",
    manualReason: "",
    lastPageSnapshot: null,
    lastCodeAt: null,
    rejectedCodeFingerprints: [],
    ...overrides,
  };
}

const emptySettings: OAuthSettings & { rememberHotmailTokens: boolean } = {
  hotmailHelperUrl: "http://127.0.0.1:17373",
  hotmailAccounts: [],
  rememberHotmailTokens: false,
  importedInvalidAccountEmails: [],
};

describe("CodexOAuthPanel", () => {
  it("renders queue controls and separates callback submitted from OAuth success", () => {
    render(
      <CodexOAuthPanel
        items={[makeAccount()]}
        settings={emptySettings}
        ready
        onSettingsChange={vi.fn()}
        onStartOAuth={vi.fn()}
        onSubmitOAuthCallback={vi.fn()}
        onPollOAuthStatus={vi.fn()}
        onFetchHotmailCode={vi.fn()}
        onCheckLoginQuota={vi.fn()}
        queueJobs={[
          makeQueueJob({ jobId: "queued", accountEmail: "queued@outlook.com", status: "queued" }),
          makeQueueJob({ jobId: "running", accountEmail: "running@outlook.com", status: "oauth_started" }),
          makeQueueJob({
            jobId: "callback-pending",
            accountEmail: "callback-pending@outlook.com",
            status: "callback_submitted",
            callbackSubmittedAt: "2026-05-07T08:01:00Z",
            oauthStatus: "pending",
          }),
          makeQueueJob({
            jobId: "callback-success",
            accountEmail: "callback-success@outlook.com",
            status: "callback_submitted",
            callbackSubmittedAt: "2026-05-07T08:02:00Z",
            oauthStatus: "success",
          }),
          makeQueueJob({ jobId: "manual", accountEmail: "manual@outlook.com", status: "manual_required", manualReason: "CAPTCHA" }),
          makeQueueJob({ jobId: "failed", accountEmail: "failed@outlook.com", status: "failed", lastError: "授权失败", oauthStatus: "error" }),
        ]}
        queueSummary={{
          total: 6,
          queued: 1,
          running: 1,
          callbackSubmitted: 2,
          manualRequired: 1,
          failed: 1,
        }}
        onBuildQueue={vi.fn()}
        onClearQueue={vi.fn()}
      />,
    );

    const queue = screen.getByRole("region", { name: "OAuth 批量队列" });
    expect(within(queue).getByRole("button", { name: "全部失效账号生成队列" })).toBeEnabled();
    expect(within(queue).getByRole("button", { name: "勾选账号生成队列" })).toBeEnabled();
    expect(within(queue).getByRole("button", { name: "当前筛选结果生成队列" })).toBeEnabled();
    expect(within(queue).getByRole("button", { name: "清空队列" })).toBeEnabled();
    expect(within(queue).getByLabelText("callback 已提交 2")).toBeInTheDocument();
    expect(within(queue).getByLabelText("OAuth success 1")).toBeInTheDocument();
    expect(within(queue).getByText("callback-pending@outlook.com")).toBeInTheDocument();
    expect(within(queue).getByText("callback-success@outlook.com")).toBeInTheDocument();
  });

  it("calls queue builders with the expected scopes", async () => {
    const user = userEvent.setup();
    const onBuildQueue = vi.fn();
    const onClearQueue = vi.fn();

    render(
      <CodexOAuthPanel
        items={[makeAccount()]}
        settings={emptySettings}
        ready
        onSettingsChange={vi.fn()}
        onStartOAuth={vi.fn()}
        onSubmitOAuthCallback={vi.fn()}
        onPollOAuthStatus={vi.fn()}
        onFetchHotmailCode={vi.fn()}
        onCheckLoginQuota={vi.fn()}
        queueJobs={[]}
        queueSummary={{
          total: 0,
          queued: 0,
          running: 0,
          callbackSubmitted: 0,
          manualRequired: 0,
          failed: 0,
        }}
        onBuildQueue={onBuildQueue}
        onClearQueue={onClearQueue}
      />,
    );

    const queue = screen.getByRole("region", { name: "OAuth 批量队列" });
    await user.click(within(queue).getByRole("button", { name: "全部失效账号生成队列" }));
    await user.click(within(queue).getByRole("button", { name: "勾选账号生成队列" }));
    await user.click(within(queue).getByRole("button", { name: "当前筛选结果生成队列" }));
    await user.click(within(queue).getByRole("button", { name: "清空队列" }));

    expect(onBuildQueue).toHaveBeenNthCalledWith(1, "all");
    expect(onBuildQueue).toHaveBeenNthCalledWith(2, "selected");
    expect(onBuildQueue).toHaveBeenNthCalledWith(3, "filtered");
    expect(onClearQueue).toHaveBeenCalledTimes(1);
  });

  it("does not render Hotmail password refresh token or verification code in the queue list", () => {
    render(
      <CodexOAuthPanel
        items={[makeAccount()]}
        settings={emptySettings}
        ready
        onSettingsChange={vi.fn()}
        onStartOAuth={vi.fn()}
        onSubmitOAuthCallback={vi.fn()}
        onPollOAuthStatus={vi.fn()}
        onFetchHotmailCode={vi.fn()}
        onCheckLoginQuota={vi.fn()}
        queueJobs={[
          {
            ...makeQueueJob({
              jobId: "secret-job",
              accountEmail: "secret-target@outlook.com",
              hotmailEmail: "secret-target@outlook.com",
              callbackUrl: "http://localhost:1455/auth/callback?code=secret-oauth-code&state=oauth-state",
              authUrl: "https://auth.openai.com/oauth?state=oauth-state",
              status: "callback_submitted",
            }),
            hotmailPassword: "secret-hotmail-password",
            refreshToken: "secret-refresh-token",
            code: "secret-verification-code",
          } as OAuthJob & { hotmailPassword: string; refreshToken: string; code: string },
        ]}
        queueSummary={{
          total: 1,
          queued: 0,
          running: 0,
          callbackSubmitted: 1,
          manualRequired: 0,
          failed: 0,
        }}
        onBuildQueue={vi.fn()}
        onClearQueue={vi.fn()}
      />,
    );

    const queue = screen.getByRole("region", { name: "OAuth 批量队列" });
    expect(within(queue).getAllByText("secret-target@outlook.com").length).toBeGreaterThan(0);
    expect(within(queue).queryByText("secret-hotmail-password")).not.toBeInTheDocument();
    expect(within(queue).queryByText("secret-refresh-token")).not.toBeInTheDocument();
    expect(within(queue).queryByText("secret-verification-code")).not.toBeInTheDocument();
    expect(within(queue).queryByText(/secret-oauth-code/)).not.toBeInTheDocument();
  });

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

  it("imports invalid account emails in bulk and lists matched accounts", async () => {
    const user = userEvent.setup();
    const onImportedInvalidAccountEmailsChange = vi.fn();

    render(
      <CodexOAuthPanel
        items={[
          makeAccount({ email: "normal@outlook.com", auth_index: "idx-normal", status: "healthy", error: "", last_query_at: null }),
          makeAccount({ email: "other@outlook.com", auth_index: "idx-other", status: "healthy", error: "", last_query_at: null }),
        ]}
        importedInvalidAccountEmails={["Normal@Outlook.com", "missing@outlook.com"]}
        onImportedInvalidAccountEmailsChange={onImportedInvalidAccountEmailsChange}
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
    expect(within(reloginAccounts).getByText("normal@outlook.com")).toBeInTheDocument();
    expect(within(reloginAccounts).getByText("失效账号 · free")).toBeInTheDocument();
    expect(within(reloginAccounts).queryByText("other@outlook.com")).not.toBeInTheDocument();
    expect(within(reloginAccounts).getByText("导入 2 个邮箱，匹配 1 个账号")).toBeInTheDocument();

    await user.clear(within(reloginAccounts).getByLabelText("批量导入失效账号邮箱"));
    await user.type(within(reloginAccounts).getByLabelText("批量导入失效账号邮箱"), "other@outlook.com, NORMAL@outlook.com other@outlook.com");

    expect(onImportedInvalidAccountEmailsChange).toHaveBeenLastCalledWith(["other@outlook.com", "normal@outlook.com"]);
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

  it("persists the local Hotmail token checkbox setting", async () => {
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

    await user.click(screen.getByRole("checkbox", { name: "本地持久保存 Hotmail Token" }));

    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({
      hotmailHelperUrl: "http://127.0.0.1:17373",
      rememberHotmailTokens: true,
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
          rememberHotmailTokens: false,
          importedInvalidAccountEmails: [],
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
        }),
      ],
    }));
    expect(JSON.stringify(onSettingsChange.mock.calls.at(-1)?.[0])).not.toContain("123456");

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

    await user.click(screen.getByRole("button", { name: "检查登录状态" }));

    await waitFor(() => {
      expect(onCheckLoginQuota).toHaveBeenCalledWith(expect.objectContaining({ auth_index: "idx-a" }));
    });
    const statusRegion = screen.getByRole("region", { name: "OAuth 状态" });
    expect(within(statusRegion).getByText("认证成功")).toBeInTheDocument();
  });

  it("removes the selected invalid account from the local list after callback submit succeeds", async () => {
    const user = userEvent.setup();
    const onStartOAuth = vi.fn().mockResolvedValue({
      authUrl: "https://auth.openai.com/oauth?state=oauth-state",
      state: "oauth-state",
      raw: {},
    });
    const onSubmitOAuthCallback = vi.fn().mockResolvedValue({
      state: "oauth-state",
      status: "pending",
      message: "回调 URL 已提交",
      raw: {},
    });
    vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <CodexOAuthPanel
        items={[
          makeAccount({ email: "submitted@outlook.com", auth_index: "idx-submitted" }),
          makeAccount({ email: "next@outlook.com", auth_index: "idx-next" }),
        ]}
        settings={emptySettings}
        ready
        onSettingsChange={vi.fn()}
        onStartOAuth={onStartOAuth}
        onSubmitOAuthCallback={onSubmitOAuthCallback}
        onPollOAuthStatus={vi.fn()}
        onFetchHotmailCode={vi.fn()}
        onCheckLoginQuota={vi.fn()}
      />,
    );

    const reloginAccounts = screen.getByRole("region", { name: "失效账号" });
    await user.click(within(reloginAccounts).getByRole("radio", { name: /submitted@outlook.com/ }));
    await user.click(screen.getByRole("button", { name: "发起 OAuth登录" }));
    await user.type(
      await screen.findByLabelText("OAuth 回调 URL"),
      "http://localhost:1455/auth/callback?code=oauth-code&state=oauth-state",
    );
    await user.click(screen.getByRole("button", { name: "提交回调 URL" }));

    await waitFor(() => {
      expect(within(reloginAccounts).queryByText("submitted@outlook.com")).not.toBeInTheDocument();
    });
    expect(within(reloginAccounts).getByText("next@outlook.com")).toBeInTheDocument();
    expect(onSubmitOAuthCallback).toHaveBeenCalledWith(
      "oauth-state",
      "http://localhost:1455/auth/callback?code=oauth-code&state=oauth-state",
    );
  });

  it("copies the target account and latest verification code from the OAuth status panel", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onStartOAuth = vi.fn().mockResolvedValue({
      authUrl: "https://auth.openai.com/oauth?state=oauth-state",
      state: "oauth-state",
      raw: {},
    });
    const onFetchHotmailCode = vi.fn().mockResolvedValue({
      code: "157526",
      nextRefreshToken: "next-refresh-token",
      transport: "graph",
      raw: {},
    });
    vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <CodexOAuthPanel
        items={[makeAccount({ email: "copy-target@outlook.com", auth_index: "idx-copy" })]}
        settings={{
          hotmailHelperUrl: "http://127.0.0.1:17373",
          rememberHotmailTokens: false,
          importedInvalidAccountEmails: [],
          hotmailAccounts: [
            {
              id: "copy-target@outlook.com::client-id",
              email: "copy-target@outlook.com",
              password: "pass",
              clientId: "client-id",
              refreshToken: "refresh-token",
              status: "authorized",
            },
          ],
        }}
        ready
        onSettingsChange={vi.fn()}
        onStartOAuth={onStartOAuth}
        onSubmitOAuthCallback={vi.fn()}
        onPollOAuthStatus={vi.fn()}
        onFetchHotmailCode={onFetchHotmailCode}
        onCheckLoginQuota={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "发起 OAuth登录" }));
    await user.click(screen.getByRole("button", { name: "复制目标账号" }));
    await user.click(screen.getByRole("button", { name: "获取 Hotmail 验证码" }));
    await screen.findByText("157526");
    await user.click(screen.getByRole("button", { name: "复制验证码" }));

    expect(writeText).toHaveBeenCalledWith("copy-target@outlook.com");
    expect(writeText).toHaveBeenCalledWith("157526");
  });

  it("links the invalid account, matching Hotmail account, and OAuth status when switching accounts", async () => {
    const user = userEvent.setup();
    const onStartOAuth = vi.fn().mockResolvedValue({
      authUrl: "https://auth.openai.com/oauth?state=brady-state",
      state: "brady-state",
      raw: {},
    });
    const onFetchHotmailCode = vi.fn().mockResolvedValue({
      code: "744357",
      nextRefreshToken: "brady-next-refresh-token",
      transport: "graph",
      raw: {},
    });
    vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <CodexOAuthPanel
        items={[
          makeAccount({ email: "brady@outlook.com", auth_index: "idx-brady" }),
          makeAccount({ email: "brooke@outlook.com", auth_index: "idx-brooke" }),
        ]}
        settings={{
          hotmailHelperUrl: "http://127.0.0.1:17373",
          rememberHotmailTokens: false,
          importedInvalidAccountEmails: [],
          hotmailAccounts: [
            {
              id: "brady@outlook.com::client-brady",
              email: "brady@outlook.com",
              password: "pass",
              clientId: "client-brady",
              refreshToken: "brady-refresh-token",
              status: "authorized",
            },
            {
              id: "brooke@outlook.com::client-brooke",
              email: "brooke@outlook.com",
              password: "pass",
              clientId: "client-brooke",
              refreshToken: "brooke-refresh-token",
              status: "authorized",
            },
          ],
        }}
        ready
        onSettingsChange={vi.fn()}
        onStartOAuth={onStartOAuth}
        onSubmitOAuthCallback={vi.fn()}
        onPollOAuthStatus={vi.fn()}
        onFetchHotmailCode={onFetchHotmailCode}
        onCheckLoginQuota={vi.fn()}
      />,
    );

    const hotmailPool = screen.getByRole("region", { name: "Hotmail 账号池" });
    const statusRegion = screen.getByRole("region", { name: "OAuth 状态" });

    await user.click(screen.getByRole("button", { name: "发起 OAuth登录" }));
    await user.click(screen.getByRole("button", { name: "获取 Hotmail 验证码" }));
    expect(await within(statusRegion).findByText("744357")).toBeInTheDocument();
    expect(within(statusRegion).getByText("brady@outlook.com")).toBeInTheDocument();
    expect(within(hotmailPool).getByText("brady@outlook.com")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /brooke@outlook.com/ }));

    expect(within(hotmailPool).getByText("brooke@outlook.com")).toBeInTheDocument();
    expect(within(hotmailPool).queryByText("brady@outlook.com")).not.toBeInTheDocument();
    expect(within(statusRegion).getByText("brooke@outlook.com")).toBeInTheDocument();
    expect(within(statusRegion).queryByText("brady@outlook.com")).not.toBeInTheDocument();
    expect(within(statusRegion).getByText("未发起")).toBeInTheDocument();
    expect(within(statusRegion).queryByText("744357")).not.toBeInTheDocument();
    expect(within(statusRegion).getByRole("button", { name: "检查登录状态" })).toBeDisabled();
    expect(screen.queryByLabelText("OAuth 回调 URL")).not.toBeInTheDocument();
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
          rememberHotmailTokens: false,
          importedInvalidAccountEmails: [],
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
          rememberHotmailTokens: false,
          importedInvalidAccountEmails: [],
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
