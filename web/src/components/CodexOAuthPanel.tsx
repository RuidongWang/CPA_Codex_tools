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
  OAuthJob,
  OAuthQueueSummary,
  OAuthSettings,
} from "../types";
import type {
  CodexOAuthCallbackResult,
  CodexOAuthStartResult,
  CodexOAuthStatusResult,
  HotmailVerificationCodeResult,
} from "../lib/api";

type OAuthSettingsWithHotmailTokenPersistence = OAuthSettings & {
  rememberHotmailTokens?: boolean;
};

type PersistedOAuthSettings = OAuthSettings & {
  rememberHotmailTokens: boolean;
};

interface CodexOAuthPanelProps {
  items: AccountItem[];
  settings: OAuthSettingsWithHotmailTokenPersistence;
  ready: boolean;
  onSettingsChange: (settings: PersistedOAuthSettings) => void | Promise<void>;
  onStartOAuth: () => Promise<CodexOAuthStartResult>;
  onSubmitOAuthCallback: (state: string, redirectUrl: string) => Promise<CodexOAuthCallbackResult>;
  onPollOAuthStatus: (state: string) => Promise<CodexOAuthStatusResult>;
  onFetchHotmailCode: (
    account: HotmailAccount,
    options: { authIndex: string; excludeCodes: string[]; filterAfterTimestamp: number },
  ) => Promise<HotmailVerificationCodeResult>;
  onCheckLoginQuota: (account: AccountItem) => Promise<void>;
  keeperRefreshFailureAuthIndexes?: string[];
  queueJobs?: OAuthJob[];
  queueSummary?: OAuthQueueSummary;
  onBuildQueue?: (scope: "all" | "selected" | "filtered") => void | Promise<void>;
  onClearQueue?: () => void | Promise<void>;
}

interface OAuthSessionState {
  authUrl: string;
  state: string;
  targetEmail: string;
  targetAccount: AccountItem;
  status: CodexOAuthStatusResult["status"];
  message: string;
  startedAt: number;
}

const OAUTH_QUEUE_RUNNING_STATUSES = new Set<OAuthJob["status"]>([
  "session_clearing",
  "oauth_started",
  "email_submitting",
  "code_polling",
  "code_submitting",
  "consent_submitting",
]);

const OAUTH_JOB_STATUS_LABELS: Record<OAuthJob["status"], string> = {
  queued: "待处理",
  session_clearing: "清理会话",
  oauth_started: "OAuth 已打开",
  email_submitting: "提交邮箱",
  code_polling: "等待验证码",
  code_submitting: "提交验证码",
  consent_submitting: "提交授权",
  callback_submitted: "callback 已提交",
  manual_required: "需人工",
  failed: "failed",
};

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

function summarizeQueueJobs(jobs: readonly OAuthJob[]): OAuthQueueSummary {
  return jobs.reduce<OAuthQueueSummary>(
    (summary, job) => ({
      total: summary.total + 1,
      queued: summary.queued + (job.status === "queued" ? 1 : 0),
      running: summary.running + (OAUTH_QUEUE_RUNNING_STATUSES.has(job.status) ? 1 : 0),
      callbackSubmitted: summary.callbackSubmitted + (job.status === "callback_submitted" ? 1 : 0),
      manualRequired: summary.manualRequired + (job.status === "manual_required" ? 1 : 0),
      failed: summary.failed + (job.status === "failed" ? 1 : 0),
    }),
    {
      total: 0,
      queued: 0,
      running: 0,
      callbackSubmitted: 0,
      manualRequired: 0,
      failed: 0,
    },
  );
}

function formatOAuthJobStatus(status: OAuthJob["status"]): string {
  return OAUTH_JOB_STATUS_LABELS[status] ?? status;
}

function formatOAuthPostStatus(status: OAuthJob["oauthStatus"]): string {
  if (!status) {
    return "-";
  }
  return status;
}

function formatOAuthJobAttempt(job: OAuthJob): string {
  return `第 ${job.attempt + 1} 次 · 重试 ${job.retryCount}`;
}

function redactSensitiveOAuthText(value: string): string {
  return value
    .replace(/\b(password|passwd|refresh[_-]?token|code)(\s*[:=]\s*)([^&\s]+)/gi, "$1$2[redacted]")
    .replace(/\b\d{6}\b/g, "[redacted]");
}

function formatOAuthJobError(job: OAuthJob): string {
  const message = job.lastError || job.manualReason || "-";
  return redactSensitiveOAuthText(message);
}

function searchableText(parts: Array<string | undefined | null>): string {
  return parts.map((part) => String(part || "").trim().toLowerCase()).join(" ");
}

function includeHotmailTokenPersistence(settings: OAuthSettingsWithHotmailTokenPersistence): PersistedOAuthSettings {
  return {
    ...settings,
    rememberHotmailTokens: Boolean(settings.rememberHotmailTokens),
  };
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

export function CodexOAuthPanel(props: CodexOAuthPanelProps) {
  const [helperUrl, setHelperUrl] = useState(props.settings.hotmailHelperUrl);
  const [importText, setImportText] = useState("");
  const [accountSearch, setAccountSearch] = useState("");
  const [hotmailSearch, setHotmailSearch] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedHotmailId, setSelectedHotmailId] = useState("");
  const [hiddenCandidateAuthIndexes, setHiddenCandidateAuthIndexes] = useState<Set<string>>(() => new Set());
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
    return props.items.filter((item) => isOAuthReloginCandidate(item, keeperRefreshFailureAuthIndexes) && !hiddenCandidateAuthIndexes.has(item.auth_index));
  }, [hiddenCandidateAuthIndexes, keeperRefreshFailureAuthIndexes, props.items]);

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
  const sessionTargetAccount = session?.targetAccount ?? null;
  const selectedAccountAuthIndex = selectedAccount?.auth_index || "";
  const sessionTargetAuthIndex = sessionTargetAccount?.auth_index || "";
  const visibleSession =
    session && (!selectedAccountAuthIndex || !sessionTargetAuthIndex || selectedAccountAuthIndex === sessionTargetAuthIndex)
      ? session
      : null;
  const statusTargetEmail = visibleSession?.targetEmail || selectedAccount?.email || "";
  const statusState = visibleSession?.state || "";
  const statusCode = visibleSession ? latestCode : "";
  const rememberHotmailTokens = includeHotmailTokenPersistence(props.settings).rememberHotmailTokens;
  const queueJobs = props.queueJobs ?? [];
  const queueSummary = props.queueSummary ?? summarizeQueueJobs(queueJobs);
  const queueOAuthSuccessCount = queueJobs.filter((job) => job.oauthStatus === "success").length;
  const queueStats = [
    { label: "待处理", value: queueSummary.queued },
    { label: "运行中", value: queueSummary.running },
    { label: "callback 已提交", value: queueSummary.callbackSubmitted },
    { label: "OAuth success", value: queueOAuthSuccessCount },
    { label: "需人工", value: queueSummary.manualRequired },
    { label: "failed", value: queueSummary.failed },
  ];

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

  useEffect(() => {
    if (!selectedAccountAuthIndex || !sessionTargetAuthIndex || selectedAccountAuthIndex === sessionTargetAuthIndex) {
      return;
    }
    setSession(null);
    setLatestCode("");
    setCallbackUrl("");
    setErrorMessage("");
  }, [selectedAccountAuthIndex, sessionTargetAuthIndex]);

  function appendLog(message: string) {
    setLogs((current) => [`${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${message}`, ...current].slice(0, 8));
  }

  async function persistSettings(nextSettings: OAuthSettingsWithHotmailTokenPersistence) {
    await props.onSettingsChange({
      ...includeHotmailTokenPersistence(props.settings),
      ...includeHotmailTokenPersistence(nextSettings),
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
        rememberHotmailTokens,
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

  async function startOAuthSession(options: { openAuthUrl: boolean } = { openAuthUrl: true }) {
    if (!selectedAccount) {
      throw new Error("请先选择失效账号");
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
        targetAccount: selectedAccount,
        status: "pending",
        message: "等待 OpenAI 登录完成",
        startedAt,
      });
      setLatestCode("");
      setCallbackUrl("");
      if (options.openAuthUrl) {
        window.open(result.authUrl, "_blank", "noopener,noreferrer");
      }
      appendLog(`已为 ${selectedAccount.email} 发起 OAuth 登录`);
      return {
        authUrl: result.authUrl,
        state: result.state,
        targetEmail: selectedAccount.email,
        targetAccount: selectedAccount,
        status: "pending" as const,
        message: "等待 OpenAI 登录完成",
        startedAt,
      };
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setActionLabel("");
    }
  }

  async function handleStartOAuth() {
    try {
      await startOAuthSession({ openAuthUrl: true });
    } catch {
      // Error state is already surfaced inside startOAuthSession.
    }
  }

  async function fetchHotmailCode(hotmailAccount: HotmailAccount | null = selectedHotmail, targetAccount: AccountItem | null = selectedAccount) {
    if (!hotmailAccount) {
      setErrorMessage("请先导入并选择 Hotmail 账号");
      throw new Error("请先导入并选择 Hotmail 账号");
    }
    setActionLabel("获取 Hotmail 验证码");
    setErrorMessage("");
    try {
      const result = await props.onFetchHotmailCode(hotmailAccount, {
        authIndex: targetAccount?.auth_index || "",
        excludeCodes: statusCode ? [statusCode] : [],
        filterAfterTimestamp: Math.max(0, (visibleSession?.startedAt ?? Date.now()) - 15_000),
      });
      const now = new Date().toISOString();
      const nextAccount: HotmailAccount = {
        ...hotmailAccount,
        refreshToken: result.nextRefreshToken || hotmailAccount.refreshToken,
        status: "authorized",
        lastCode: result.code,
        lastCodeAt: now,
        lastError: undefined,
        updatedAt: now,
      };
      await persistSettings({
        hotmailHelperUrl: helperUrl,
        hotmailAccounts: upsertHotmailAccounts(props.settings.hotmailAccounts, [nextAccount]),
        rememberHotmailTokens,
      });
      setSelectedHotmailId(hotmailAccount.id);
      setLatestCode(result.code);
      appendLog(`已获取验证码 ${result.code}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      if (hotmailAccount) {
        const nextAccount: HotmailAccount = {
          ...hotmailAccount,
          status: "error",
          lastError: message,
          updatedAt: new Date().toISOString(),
        };
        await persistSettings({
          hotmailHelperUrl: helperUrl,
          hotmailAccounts: upsertHotmailAccounts(props.settings.hotmailAccounts, [nextAccount]),
          rememberHotmailTokens,
        });
      }
      throw error;
    } finally {
      setActionLabel("");
    }
  }

  async function handleFetchHotmailCode() {
    try {
      await fetchHotmailCode();
    } catch {
      // Error state is already surfaced inside fetchHotmailCode.
    }
  }

  async function submitOAuthCallbackUrl(redirectUrl: string) {
    if (!visibleSession?.state) {
      setErrorMessage("请先发起 OAuth 登录");
      throw new Error("请先发起 OAuth 登录");
    }
    if (!redirectUrl.trim()) {
      setErrorMessage("请粘贴 OAuth 回调 URL");
      throw new Error("请粘贴 OAuth 回调 URL");
    }
    setActionLabel("提交回调 URL");
    setErrorMessage("");
    try {
      const result = await props.onSubmitOAuthCallback(visibleSession.state, redirectUrl);
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
      const submittedAuthIndex = visibleSession.targetAccount.auth_index || selectedAccount?.auth_index;
      if (result.status !== "error" && submittedAuthIndex) {
        setHiddenCandidateAuthIndexes((current) => {
          const next = new Set(current);
          next.add(submittedAuthIndex);
          return next;
        });
      }
      return result;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setActionLabel("");
    }
  }

  async function handleSubmitCallbackUrl() {
    try {
      await submitOAuthCallbackUrl(callbackUrl);
    } catch {
      // Error state is already surfaced inside submitOAuthCallbackUrl.
    }
  }

  async function handleCopyValue(value: string, label: string) {
    if (!value.trim()) {
      return;
    }
    setErrorMessage("");
    try {
      await copyTextToClipboard(value);
      appendLog(`已复制${label}`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function checkOAuthStatus() {
    if (!visibleSession?.state) {
      setErrorMessage("请先发起 OAuth 登录");
      throw new Error("请先发起 OAuth 登录");
    }
    setActionLabel("检查登录状态");
    setErrorMessage("");
    try {
      const result = await props.onPollOAuthStatus(visibleSession.state);
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
      const quotaTarget = visibleSession.targetAccount ?? selectedAccount;
      if (result.status === "success" && quotaTarget) {
        await props.onCheckLoginQuota(quotaTarget);
        appendLog(`已检测 ${quotaTarget.email || quotaTarget.name} 额度`);
      }
      return result;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setActionLabel("");
    }
  }

  async function handleCheckStatus() {
    try {
      await checkOAuthStatus();
    } catch {
      // Error state is already surfaced inside checkOAuthStatus.
    }
  }

  async function handleBuildQueue(scope: "all" | "selected" | "filtered") {
    if (!props.onBuildQueue) {
      return;
    }
    setActionLabel("生成 OAuth 队列");
    setErrorMessage("");
    try {
      await props.onBuildQueue(scope);
      appendLog("已生成 OAuth 批量队列");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActionLabel("");
    }
  }

  async function handleClearQueue() {
    if (!props.onClearQueue) {
      return;
    }
    setActionLabel("清空 OAuth 队列");
    setErrorMessage("");
    try {
      await props.onClearQueue();
      appendLog("已清空 OAuth 批量队列");
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

      <section className="settings-section oauth-card oauth-queue" aria-label="OAuth 批量队列">
        <div className="settings-section__header oauth-queue__header">
          <div>
            <h3>OAuth 批量队列</h3>
            <span>{queueSummary.total} 个任务</span>
          </div>
          <div className="oauth-queue__actions">
            <button type="button" className="command-button" onClick={() => handleBuildQueue("all")} disabled={busy || !props.onBuildQueue}>
              全部失效账号生成队列
            </button>
            <button type="button" className="command-button" onClick={() => handleBuildQueue("selected")} disabled={busy || !props.onBuildQueue}>
              勾选账号生成队列
            </button>
            <button type="button" className="command-button" onClick={() => handleBuildQueue("filtered")} disabled={busy || !props.onBuildQueue}>
              当前筛选结果生成队列
            </button>
            <button type="button" className="command-button command-button--danger" onClick={handleClearQueue} disabled={busy || !props.onClearQueue}>
              清空队列
            </button>
          </div>
        </div>
        <div className="oauth-queue__summary" aria-label="OAuth 队列统计">
          {queueStats.map((stat) => (
            <div key={stat.label} className="oauth-queue-stat" aria-label={`${stat.label} ${stat.value}`}>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
            </div>
          ))}
        </div>
        <div className="oauth-queue-table-wrap">
          <table className="oauth-queue-table">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>Hotmail 匹配</th>
                <th>状态</th>
                <th>尝试</th>
                <th>最近错误</th>
                <th>OAuth 后验状态</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {queueJobs.length ? (
                queueJobs.map((job) => (
                  <tr key={job.jobId || job.authIndex}>
                    <td>{job.accountEmail || job.accountName || "-"}</td>
                    <td>{job.hotmailEmail || "未匹配"}</td>
                    <td>{formatOAuthJobStatus(job.status)}</td>
                    <td>{formatOAuthJobAttempt(job)}</td>
                    <td>{formatOAuthJobError(job)}</td>
                    <td>{formatOAuthPostStatus(job.oauthStatus)}</td>
                    <td>{formatDateTime(job.updatedAt)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">队列为空。可按全部失效账号、勾选账号或当前筛选结果生成。</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

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
          <label className="oauth-token-toggle">
            <input
              type="checkbox"
              checked={rememberHotmailTokens}
              onChange={(event) =>
                persistSettings({
                  ...props.settings,
                  hotmailHelperUrl: helperUrl,
                  rememberHotmailTokens: event.target.checked,
                })
              }
            />
            <span>本地持久保存 Hotmail Token</span>
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
            <button type="button" className="command-button" onClick={handleCheckStatus} disabled={busy || !visibleSession?.state}>
              检查登录状态
            </button>
          </div>
          <div className="oauth-status-grid">
            <span>目标账号</span>
            <div className="oauth-status-value">
              <strong>{statusTargetEmail || "-"}</strong>
              {statusTargetEmail ? (
                <button type="button" className="oauth-copy-button" aria-label="复制目标账号" title="复制目标账号" onClick={() => handleCopyValue(statusTargetEmail, "目标账号")}>
                  <span className="material-symbols-outlined" aria-hidden="true">content_copy</span>
                </button>
              ) : null}
            </div>
            <span>state</span>
            <strong>{statusState || "-"}</strong>
            <span>状态</span>
            <strong>{visibleSession?.message || "未发起"}</strong>
            <span>验证码</span>
            <div className="oauth-status-value">
              <strong className="oauth-code">{statusCode || "-"}</strong>
              {statusCode ? (
                <button type="button" className="oauth-copy-button" aria-label="复制验证码" title="复制验证码" onClick={() => handleCopyValue(statusCode, "验证码")}>
                  <span className="material-symbols-outlined" aria-hidden="true">content_copy</span>
                </button>
              ) : null}
            </div>
          </div>
          {visibleSession?.authUrl ? (
            <>
              <div className="oauth-auth-url">
                <input readOnly value={visibleSession.authUrl} aria-label="OAuth 登录链接" />
                <button type="button" className="command-button" onClick={() => window.open(visibleSession.authUrl, "_blank", "noopener,noreferrer")}>
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
