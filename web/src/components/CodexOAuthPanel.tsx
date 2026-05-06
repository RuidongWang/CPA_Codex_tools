import { useEffect, useMemo, useState } from "react";
import {
  createHotmailAccount,
  isOAuthReloginCandidate,
  isQuotaQueryError,
  normalizeHotmailHelperUrl,
  parseHotmailImportText,
  upsertHotmailAccounts,
} from "../lib/oauth";
import type {
  AccountItem,
  HotmailAccount,
  OAuthSettings,
} from "../types";
import type {
  CodexOAuthCallbackResult,
  CodexOAuthStartResult,
  CodexOAuthStatusResult,
  HotmailVerificationCodeResult,
} from "../lib/api";

interface CodexOAuthPanelProps {
  items: AccountItem[];
  settings: OAuthSettings;
  ready: boolean;
  onSettingsChange: (settings: OAuthSettings) => void | Promise<void>;
  onStartOAuth: () => Promise<CodexOAuthStartResult>;
  onSubmitOAuthCallback: (state: string, redirectUrl: string) => Promise<CodexOAuthCallbackResult>;
  onPollOAuthStatus: (state: string) => Promise<CodexOAuthStatusResult>;
  onFetchHotmailCode: (
    account: HotmailAccount,
    options: { authIndex: string; excludeCodes: string[]; filterAfterTimestamp: number },
  ) => Promise<HotmailVerificationCodeResult>;
  onCheckLoginQuota: (account: AccountItem) => Promise<void>;
  keeperRefreshFailureAuthIndexes?: string[];
}

interface OAuthSessionState {
  authUrl: string;
  state: string;
  targetEmail: string;
  status: CodexOAuthStatusResult["status"];
  message: string;
  startedAt: number;
}

function formatDateTime(value?: string): string {
  if (!value) {
    return "-";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
}

function accountReason(item: AccountItem, keeperRefreshFailureAuthIndexes: ReadonlySet<string>): string {
  if (isQuotaQueryError(item)) {
    return item.error || "查询异常";
  }
  if (keeperRefreshFailureAuthIndexes.has(item.auth_index)) {
    return "Keeper 刷新失败";
  }
  return "正常";
}

function normalizeEmailKey(value?: string | null): string {
  return String(value || "").trim().toLowerCase();
}

function searchableText(parts: Array<string | undefined | null>): string {
  return parts.map((part) => String(part || "").trim().toLowerCase()).join(" ");
}

export function CodexOAuthPanel(props: CodexOAuthPanelProps) {
  const [helperUrl, setHelperUrl] = useState(props.settings.hotmailHelperUrl);
  const [importText, setImportText] = useState("");
  const [accountSearch, setAccountSearch] = useState("");
  const [hotmailSearch, setHotmailSearch] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedHotmailId, setSelectedHotmailId] = useState("");
  const [session, setSession] = useState<OAuthSessionState | null>(null);
  const [latestCode, setLatestCode] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [actionLabel, setActionLabel] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [logs, setLogs] = useState<string[]>([]);

  const keeperRefreshFailureAuthIndexes = useMemo(
    () => new Set(props.keeperRefreshFailureAuthIndexes ?? []),
    [props.keeperRefreshFailureAuthIndexes],
  );

  const candidates = useMemo(() => {
    return props.items.filter((item) => isOAuthReloginCandidate(item, keeperRefreshFailureAuthIndexes));
  }, [keeperRefreshFailureAuthIndexes, props.items]);

  const filteredCandidates = useMemo(() => {
    const keyword = accountSearch.trim().toLowerCase();
    if (!keyword) {
      return candidates;
    }
    return candidates.filter((item) =>
      searchableText([item.email, item.name, item.account_id, item.auth_index, item.plan_type, item.error]).includes(keyword),
    );
  }, [accountSearch, candidates]);

  const selectedAccount = filteredCandidates.find((item) => item.auth_index === selectedAccountId) ?? filteredCandidates[0] ?? null;
  const selectedAccountEmailKey = normalizeEmailKey(selectedAccount?.email);
  const linkedHotmailAccounts = useMemo(() => {
    if (!selectedAccount) {
      return [];
    }
    if (!selectedAccountEmailKey) {
      return props.settings.hotmailAccounts;
    }
    return props.settings.hotmailAccounts.filter((account) => normalizeEmailKey(account.email) === selectedAccountEmailKey);
  }, [props.settings.hotmailAccounts, selectedAccount, selectedAccountEmailKey]);
  const filteredHotmailAccounts = useMemo(() => {
    const keyword = hotmailSearch.trim().toLowerCase();
    if (!keyword) {
      return linkedHotmailAccounts;
    }
    return linkedHotmailAccounts.filter((account) =>
      searchableText([account.email, account.clientId, account.status, account.lastCode, account.lastError]).includes(keyword),
    );
  }, [hotmailSearch, linkedHotmailAccounts]);
  const selectedHotmail = filteredHotmailAccounts.find((account) => account.id === selectedHotmailId) ?? filteredHotmailAccounts[0] ?? null;
  const busy = Boolean(actionLabel);

  useEffect(() => {
    setHelperUrl(props.settings.hotmailHelperUrl);
  }, [props.settings.hotmailHelperUrl]);

  useEffect(() => {
    if (!filteredCandidates.length) {
      if (selectedAccountId) {
        setSelectedAccountId("");
      }
      return;
    }
    if (!filteredCandidates.some((item) => item.auth_index === selectedAccountId)) {
      setSelectedAccountId(filteredCandidates[0].auth_index);
    }
  }, [filteredCandidates, selectedAccountId]);

  useEffect(() => {
    if (!filteredHotmailAccounts.length) {
      if (selectedHotmailId) {
        setSelectedHotmailId("");
      }
      return;
    }
    if (!filteredHotmailAccounts.some((account) => account.id === selectedHotmailId)) {
      setSelectedHotmailId(filteredHotmailAccounts[0].id);
    }
  }, [filteredHotmailAccounts, selectedHotmailId]);

  function appendLog(message: string) {
    setLogs((current) => [`${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${message}`, ...current].slice(0, 8));
  }

  async function persistSettings(nextSettings: OAuthSettings) {
    await props.onSettingsChange({
      ...nextSettings,
      hotmailHelperUrl: normalizeHotmailHelperUrl(nextSettings.hotmailHelperUrl),
    });
  }

  async function handleSaveHelperUrl() {
    setActionLabel("保存助手地址");
    setErrorMessage("");
    try {
      await persistSettings({
        ...props.settings,
        hotmailHelperUrl: helperUrl,
      });
      appendLog("已保存 Hotmail helper 地址");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActionLabel("");
    }
  }

  async function handleImportHotmailAccounts() {
    const parsed = parseHotmailImportText(importText)
      .map((account) => createHotmailAccount(account))
      .filter((account): account is HotmailAccount => Boolean(account));
    if (!parsed.length) {
      setErrorMessage("没有解析到有效账号，请检查格式是否为 账号----密码----ID----Token");
      return;
    }
    setActionLabel("导入 Hotmail 账号");
    setErrorMessage("");
    try {
      const matchedImportedAccount = selectedAccountEmailKey
        ? parsed.find((account) => normalizeEmailKey(account.email) === selectedAccountEmailKey)
        : parsed[0];
      await persistSettings({
        hotmailHelperUrl: helperUrl,
        hotmailAccounts: upsertHotmailAccounts(props.settings.hotmailAccounts, parsed),
      });
      setSelectedHotmailId((matchedImportedAccount ?? parsed[0]).id);
      setImportText("");
      appendLog(`已导入 ${parsed.length} 个 Hotmail 账号`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActionLabel("");
    }
  }

  async function handleStartOAuth() {
    if (!selectedAccount) {
      return;
    }
    setActionLabel("发起 OAuth登录");
    setErrorMessage("");
    try {
      const result = await props.onStartOAuth();
      const startedAt = Date.now();
      setSession({
        authUrl: result.authUrl,
        state: result.state,
        targetEmail: selectedAccount.email,
        status: "pending",
        message: "等待 OpenAI 登录完成",
        startedAt,
      });
      setLatestCode("");
      setCallbackUrl("");
      window.open(result.authUrl, "_blank", "noopener,noreferrer");
      appendLog(`已为 ${selectedAccount.email} 发起 OAuth 登录`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActionLabel("");
    }
  }

  async function handleFetchHotmailCode() {
    if (!selectedHotmail) {
      setErrorMessage("请先导入并选择 Hotmail 账号");
      return;
    }
    setActionLabel("获取 Hotmail 验证码");
    setErrorMessage("");
    try {
      const result = await props.onFetchHotmailCode(selectedHotmail, {
        authIndex: selectedAccount?.auth_index || "",
        excludeCodes: latestCode ? [latestCode] : [],
        filterAfterTimestamp: Math.max(0, (session?.startedAt ?? Date.now()) - 15_000),
      });
      const now = new Date().toISOString();
      const nextAccount: HotmailAccount = {
        ...selectedHotmail,
        refreshToken: result.nextRefreshToken || selectedHotmail.refreshToken,
        status: "authorized",
        lastCode: result.code,
        lastCodeAt: now,
        lastError: undefined,
        updatedAt: now,
      };
      await persistSettings({
        hotmailHelperUrl: helperUrl,
        hotmailAccounts: upsertHotmailAccounts(props.settings.hotmailAccounts, [nextAccount]),
      });
      setLatestCode(result.code);
      appendLog(`已获取验证码 ${result.code}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      if (selectedHotmail) {
        const nextAccount: HotmailAccount = {
          ...selectedHotmail,
          status: "error",
          lastError: message,
          updatedAt: new Date().toISOString(),
        };
        await persistSettings({
          hotmailHelperUrl: helperUrl,
          hotmailAccounts: upsertHotmailAccounts(props.settings.hotmailAccounts, [nextAccount]),
        });
      }
    } finally {
      setActionLabel("");
    }
  }

  async function handleSubmitCallbackUrl() {
    if (!session?.state) {
      setErrorMessage("请先发起 OAuth 登录");
      return;
    }
    if (!callbackUrl.trim()) {
      setErrorMessage("请粘贴 OAuth 回调 URL");
      return;
    }
    setActionLabel("提交回调 URL");
    setErrorMessage("");
    try {
      const result = await props.onSubmitOAuthCallback(session.state, callbackUrl);
      const message = result.message || "回调 URL 已提交";
      setSession((current) =>
        current
          ? {
              ...current,
              status: result.status,
              message,
            }
          : current,
      );
      appendLog(message);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActionLabel("");
    }
  }

  async function handleCheckStatus() {
    if (!session?.state) {
      setErrorMessage("请先发起 OAuth 登录");
      return;
    }
    setActionLabel("检查登录状态");
    setErrorMessage("");
    try {
      const result = await props.onPollOAuthStatus(session.state);
      setSession((current) =>
        current
          ? {
              ...current,
              status: result.status,
              message: result.message || (result.status === "success" ? "认证成功" : result.status === "error" ? "认证失败" : "等待认证"),
            }
          : current,
      );
      appendLog(result.message || `CPA 状态：${result.status}`);
      if (result.status === "success" && selectedAccount) {
        await props.onCheckLoginQuota(selectedAccount);
        appendLog(`已检测 ${selectedAccount.email || selectedAccount.name} 额度`);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActionLabel("");
    }
  }

  return (
    <section className="oauth-page" aria-label="Codex OAuth登录页面">
      <div className="oauth-page__header">
        <div>
          <p className="eyebrow">CODEX OAUTH</p>
          <h1>Codex OAuth登录</h1>
        </div>
        <div className="oauth-page__actions">
          <button type="button" className="command-button" onClick={handleFetchHotmailCode} disabled={busy || !selectedHotmail}>
            获取 Hotmail 验证码
          </button>
          <button type="button" className="command-button command-button--primary" onClick={handleStartOAuth} disabled={busy || !props.ready || !selectedAccount}>
            发起 OAuth登录
          </button>
        </div>
      </div>

      {errorMessage ? <div className="inline-alert" role="alert">{errorMessage}</div> : null}

      <div className="oauth-layout">
        <section className="settings-section oauth-card" aria-label="失效账号">
          <div className="settings-section__header">
            <h3>失效账号</h3>
            <span>{filteredCandidates.length} / {candidates.length} 个候选</span>
          </div>
          <label className="oauth-search-field">
            <span>检索</span>
            <input
              aria-label="检索失效账号"
              value={accountSearch}
              onChange={(event) => setAccountSearch(event.target.value)}
              placeholder="邮箱 / 名称"
            />
          </label>
          <div className="oauth-account-list">
            {filteredCandidates.map((item) => (
              <label key={item.auth_index} className="oauth-account-row">
                <input
                  type="radio"
                  name="oauth-account"
                  checked={selectedAccount?.auth_index === item.auth_index}
                  onChange={() => setSelectedAccountId(item.auth_index)}
                />
                <span>
                  <strong>{item.email || item.name}</strong>
                  <small>{accountReason(item, keeperRefreshFailureAuthIndexes)} · {item.plan_type || "unknown"}</small>
                </span>
              </label>
            ))}
            {!props.items.length ? <div className="empty-state">请先加载账号列表。</div> : null}
            {props.items.length && !candidates.length ? <div className="empty-state">暂无符合条件的失效账号。</div> : null}
            {candidates.length && !filteredCandidates.length ? <div className="empty-state">没有匹配的失效账号。</div> : null}
          </div>
        </section>

        <section className="settings-section oauth-card" aria-label="Hotmail 账号池">
          <div className="settings-section__header">
            <h3>Hotmail 账号池</h3>
            <span>{filteredHotmailAccounts.length} / {linkedHotmailAccounts.length} / {props.settings.hotmailAccounts.length} 个账号</span>
          </div>
          <div className="oauth-api-mode">
            <span>验证码接口</span>
            <strong>API对接</strong>
          </div>
          <label className="field-stack">
            <span>批量导入</span>
            <textarea
              aria-label="Hotmail 批量导入"
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              placeholder="账号----密码----ID----Token"
              rows={4}
            />
          </label>
          <button type="button" className="command-button" onClick={handleImportHotmailAccounts} disabled={busy}>
            导入 Hotmail 账号
          </button>
          <label className="oauth-search-field">
            <span>检索</span>
            <input
              aria-label="检索 Hotmail 账号"
              value={hotmailSearch}
              onChange={(event) => setHotmailSearch(event.target.value)}
              placeholder="邮箱 / Client ID"
            />
          </label>
          <div className="oauth-hotmail-list">
            {filteredHotmailAccounts.map((account) => (
              <label key={account.id} className="oauth-account-row">
                <input
                  type="radio"
                  name="hotmail-account"
                  checked={selectedHotmail?.id === account.id}
                  onChange={() => setSelectedHotmailId(account.id)}
                />
                <span>
                  <strong>{account.email}</strong>
                  <small>{account.status} · {account.clientId} · 上次验证码 {account.lastCode || "-"} · {formatDateTime(account.lastCodeAt)}</small>
                </span>
              </label>
            ))}
            {!props.settings.hotmailAccounts.length ? <div className="empty-state">还没有 Hotmail 账号。</div> : null}
            {props.settings.hotmailAccounts.length && !linkedHotmailAccounts.length ? (
              <div className="empty-state">
                未找到与 {selectedAccount?.email || "当前账号"} 对应的 Hotmail 账号，请先导入同邮箱账号。
              </div>
            ) : null}
            {linkedHotmailAccounts.length && !filteredHotmailAccounts.length ? <div className="empty-state">没有匹配的 Hotmail 账号。</div> : null}
          </div>
        </section>

        <section className="settings-section oauth-card" aria-label="OAuth 状态">
          <div className="settings-section__header">
            <h3>OAuth 状态</h3>
            <button type="button" className="command-button" onClick={handleCheckStatus} disabled={busy || !session?.state}>
              检查登录状态
            </button>
          </div>
          <div className="oauth-status-grid">
            <span>目标账号</span>
            <strong>{session?.targetEmail || selectedAccount?.email || "-"}</strong>
            <span>state</span>
            <strong>{session?.state || "-"}</strong>
            <span>状态</span>
            <strong>{session?.message || "未发起"}</strong>
            <span>验证码</span>
            <strong className="oauth-code">{latestCode || "-"}</strong>
          </div>
          {session?.authUrl ? (
            <>
              <div className="oauth-auth-url">
                <input readOnly value={session.authUrl} aria-label="OAuth 登录链接" />
                <button type="button" className="command-button" onClick={() => window.open(session.authUrl, "_blank", "noopener,noreferrer")}>
                  打开链接
                </button>
              </div>
              <label className="field-stack">
                <span>OAuth 回调 URL</span>
                <div className="oauth-auth-url">
                  <input
                    aria-label="OAuth 回调 URL"
                    value={callbackUrl}
                    onChange={(event) => setCallbackUrl(event.target.value)}
                    placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                  />
                  <button type="button" className="command-button" onClick={handleSubmitCallbackUrl} disabled={busy || !callbackUrl.trim()}>
                    提交回调 URL
                  </button>
                </div>
              </label>
            </>
          ) : null}
          <div className="oauth-log">
            {logs.length ? logs.map((log) => <span key={log}>{log}</span>) : <span>等待操作</span>}
          </div>
        </section>
      </div>

      {actionLabel ? <div className="loading-label">{actionLabel}...</div> : null}
    </section>
  );
}
