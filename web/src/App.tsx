import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import { AccountTable } from "./components/AccountTable";
import { CodexOAuthBridge } from "./components/CodexOAuthBridge";
import { CodexOAuthPanel } from "./components/CodexOAuthPanel";
import { ConnectionConfigPanel } from "./components/ConnectionConfigPanel";
import { OverviewCards } from "./components/OverviewCards";
import { KeeperPanel } from "./components/KeeperPanel";
import { LoginPage } from "./components/LoginPage";
import { PlanFilterBar } from "./components/PlanFilterBar";
import { PriorityBatchPanel } from "./components/PriorityBatchPanel";
import { ProgressPanel } from "./components/ProgressPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SidebarFilters, type SidebarPage } from "./components/SidebarFilters";
import { SyncConfirmDialog } from "./components/SyncConfirmDialog";
import { Toolbar } from "./components/Toolbar";
import { WindowChrome } from "./components/WindowChrome";
import {
  clearLocalCache,
  DEFAULT_KEEPER_SETTINGS,
  DEFAULT_QUERY_CONCURRENCY,
  downloadSelectedAccounts,
  fetchAccountList,
  fetchHotmailVerificationCode,
  loadPayloadCache,
  loadRuntimeConfig,
  pollCodexOAuthStatus,
  queryCachedAccounts,
  runKeeperDirectAction,
  runKeeperMaintenance,
  savePayloadCache,
  saveRuntimeConfig,
  startCodexOAuth,
  submitCodexOAuthCallback,
  syncAccountPriorities,
} from "./lib/api";
import { buildKeeperDuplicateGroups, type KeeperDuplicateGroup } from "./lib/keeper-duplicates";
import { createOAuthJobStore, type OAuthJobStore } from "./lib/oauth-job-store";
import { buildOAuthJobs, summarizeOAuthJobs, type OAuthQueueScope } from "./lib/oauth-jobs";
import { DEFAULT_OAUTH_SETTINGS } from "./lib/oauth";
import {
  applyPriorityDrafts,
  buildAutoPriorityDrafts,
  buildPriorityPlanCounts,
  normalizePriorityPlanKey,
  PRIORITY_PLAN_KEYS,
} from "./lib/priority";
import { buildOverviewStats, buildPlanCounts, cycleSort, filterItems, mergePayload, sortItems, type SortState } from "./lib/view-model";
import { isReadmeDemoMode, README_DEMO_CONFIG, README_DEMO_PAYLOAD } from "./lib/readme-demo";
import type { AccountItem, KeeperDirectAction, KeeperRunResult, KeeperSettings, OAuthJob, OAuthSettings, PayloadEnvelope, RuntimeConfig } from "./types";

const PROGRESS_HOLD_MS = 2000;
const PROGRESS_FADE_MS = 240;
const PROGRESS_OVERLAY_OFFSET = 48;
const PROGRESS_DRAIN_MS = 80;
const MAX_PROGRESS_QUEUE_STEPS = 24;

const EMPTY_CONFIG: RuntimeConfig = {
  cpaBaseUrl: "",
  managementKey: "",
  queryConcurrency: DEFAULT_QUERY_CONCURRENCY,
  keeperSettings: DEFAULT_KEEPER_SETTINGS,
  priorityPlanOrder: PRIORITY_PLAN_KEYS,
  priorityPlanRanges: {},
  oauthSettings: DEFAULT_OAUTH_SETTINGS,
};

function hasManagementConfig(config: RuntimeConfig): boolean {
  // 开源版不再内置默认地址，只有地址和管理密钥都齐全时才允许发请求。
  return Boolean(config.cpaBaseUrl.trim() && config.managementKey.trim());
}

function normalizeAccountKey(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function findOAuthQuotaCheckAccount(items: AccountItem[], account: AccountItem): AccountItem {
  const emailKey = normalizeAccountKey(account.email);
  if (emailKey) {
    const sameEmailItems = items.filter((item) => normalizeAccountKey(item.email) === emailKey);
    const refreshedSameEmail = sameEmailItems.find((item) => item.auth_index !== account.auth_index && item.status !== "error");
    const normalSameEmail = sameEmailItems.find((item) => item.status !== "error");
    if (refreshedSameEmail || normalSameEmail || sameEmailItems[0]) {
      return refreshedSameEmail ?? normalSameEmail ?? sameEmailItems[0];
    }
  }
  return items.find((item) => item.auth_index === account.auth_index) ??
    items.find((item) => item.name === account.name) ??
    account;
}

function mergeKeeperRefreshFailureAuthIndexes(
  current: string[],
  result: KeeperRunResult,
  mode: "direct-refresh" | "maintenance",
): string[] {
  const attemptedAuthIndexes = new Set(
    result.items
      .filter((item) => mode === "direct-refresh" || item.refresh_candidate)
      .map((item) => item.auth_index)
      .filter(Boolean),
  );
  const failedAuthIndexes = result.items
    .filter((item) => attemptedAuthIndexes.has(item.auth_index) && item.outcome === "error" && !item.refreshed)
    .map((item) => item.auth_index)
    .filter(Boolean);
  const retained = current.filter((authIndex) => !attemptedAuthIndexes.has(authIndex));
  return Array.from(new Set([...retained, ...failedAuthIndexes]));
}

function resolveErrorMessage(error: unknown, fallback: string): string {
  // 统一把异常压成可读文案，避免界面上出现空消息或生硬对象字符串。
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === "object") {
    const maybeMessage = Reflect.get(error, "message");
    if (typeof maybeMessage === "string" && maybeMessage.trim()) {
      return maybeMessage.trim();
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // 循环引用对象退回默认文案，避免错误处理自己再抛异常。
    }
  }
  return fallback;
}

function waitForNextPaint(): Promise<void> {
  // 在发起长请求前先让 React 把 busy 态渲染出去，避免用户误以为窗口卡死。
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(), 16);
  });
}

function formatElapsedLabel(durationMs: number): string {
  if (durationMs >= 1000) {
    return `总耗时 ${(durationMs / 1000).toFixed(2)} 秒`;
  }
  return `总耗时 ${Math.round(durationMs)} ms`;
}

async function persistPayloadCache(payload: PayloadEnvelope): Promise<void> {
  try {
    await savePayloadCache(payload);
  } catch {
    // 查询缓存只是体验增强，写盘失败不能影响主流程。
  }
}

interface ProgressState {
  title: string;
  completed: number;
  total: number;
  currentLabel: string;
  elapsedLabel: string;
}

type BusyMode = "idle" | "bootstrap" | "list" | "query-one" | "download" | "sync" | "keeper";
type SessionState = "checking" | "login" | "authenticated";
type RuntimeConfigPersistenceOptions = {
  rememberManagementKey?: boolean;
  rememberHotmailTokens?: boolean;
};
type SaveRuntimeConfigWithOptions = (config: RuntimeConfig, options?: RuntimeConfigPersistenceOptions) => Promise<void>;
type OAuthSettingsWithPersistence = OAuthSettings & {
  rememberHotmailTokens?: boolean;
};

const saveRuntimeConfigWithOptions = saveRuntimeConfig as SaveRuntimeConfigWithOptions;

function readRememberHotmailTokens(oauthSettings: OAuthSettings | undefined): boolean {
  return Boolean(((oauthSettings ?? DEFAULT_OAUTH_SETTINGS) as OAuthSettingsWithPersistence).rememberHotmailTokens);
}

function areSameProgressTask(left: ProgressState, right: ProgressState): boolean {
  return left.title === right.title && left.total === right.total;
}

function compactProgressQueue(queue: ProgressState[]): ProgressState[] {
  if (queue.length <= MAX_PROGRESS_QUEUE_STEPS) {
    return queue;
  }

  const compacted: ProgressState[] = [];
  const lastIndex = queue.length - 1;
  for (let index = 0; index < MAX_PROGRESS_QUEUE_STEPS; index += 1) {
    // 密集事件只保留均匀采样节点，保证能看见中间状态，又不把已完成任务拖太久。
    const sourceIndex = Math.round((index / (MAX_PROGRESS_QUEUE_STEPS - 1)) * lastIndex);
    const next = queue[sourceIndex];
    if (!compacted.length || compacted[compacted.length - 1].completed !== next.completed) {
      compacted.push(next);
    }
  }
  return compacted;
}

// 根组件只负责状态编排，具体显示交给独立组件，避免继续长成巨型页面文件。
export default function App() {
  const readmeDemoMode = typeof window !== "undefined" && isReadmeDemoMode(window.location.search);
  const [config, setConfig] = useState<RuntimeConfig>(EMPTY_CONFIG);
  const [sessionState, setSessionState] = useState<SessionState>(readmeDemoMode ? "authenticated" : "checking");
  const [payload, setPayload] = useState<PayloadEnvelope | null>(null);
  const [selectedPlan, setSelectedPlan] = useState("all");
  const [activePage, setActivePage] = useState<SidebarPage>("quota");
  const [selectedStatus, setSelectedStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [keeperSearch, setKeeperSearch] = useState("");
  const [selectedAuthIndex, setSelectedAuthIndex] = useState("");
  const [selectedAuthIndexesByPlan, setSelectedAuthIndexesByPlan] = useState<Record<string, string[]>>({});
  const [loadingLabel, setLoadingLabel] = useState("初始化中");
  const [errorMessage, setErrorMessage] = useState("");
  const [loginErrorMessage, setLoginErrorMessage] = useState("");
  const [rememberManagementKey, setRememberManagementKey] = useState(false);
  const [busyMode, setBusyMode] = useState<BusyMode>("bootstrap");
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [pendingProgressCount, setPendingProgressCount] = useState(0);
  const [progressClosing, setProgressClosing] = useState(false);
  const [progressTop, setProgressTop] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsClearingCache, setSettingsClearingCache] = useState(false);
  const [priorityBatchOpen, setPriorityBatchOpen] = useState(false);
  const [priorityBatchSaving, setPriorityBatchSaving] = useState(false);
  const [syncConfirmOpen, setSyncConfirmOpen] = useState(false);
  const [keeperResult, setKeeperResult] = useState<KeeperRunResult | null>(null);
  const [keeperRefreshFailureAuthIndexes, setKeeperRefreshFailureAuthIndexes] = useState<string[]>([]);
  const [keeperDuplicateGroups, setKeeperDuplicateGroups] = useState<KeeperDuplicateGroup[]>([]);
  const [keeperDuplicateSelectedAuthIndexes, setKeeperDuplicateSelectedAuthIndexes] = useState<string[]>([]);
  const [oauthQueueJobs, setOAuthQueueJobs] = useState<OAuthJob[]>([]);
  const [sortState, setSortState] = useState<SortState>({ key: "default", direction: "none" });
  const [priorityDrafts, setPriorityDrafts] = useState<Record<string, number>>({});
  const [lastDraftChangeAt, setLastDraftChangeAt] = useState<number | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(null);
  const deferredSearch = useDeferredValue(search);
  const deferredKeeperSearch = useDeferredValue(keeperSearch);
  const toolbarRef = useRef<HTMLElement | null>(null);
  const oauthJobStoreRef = useRef<OAuthJobStore | null>(null);
  const progressRef = useRef<ProgressState | null>(null);
  const progressQueueRef = useRef<ProgressState[]>([]);
  const progressDrainTimerRef = useRef<number | null>(null);
  if (oauthJobStoreRef.current === null) {
    oauthJobStoreRef.current = createOAuthJobStore();
  }
  const oauthJobStore = oauthJobStoreRef.current;

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    setOAuthQueueJobs(oauthJobStore.load());
  }, [oauthJobStore]);

  useEffect(() => {
    return () => {
      if (progressDrainTimerRef.current !== null) {
        window.clearTimeout(progressDrainTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!progress) {
      setProgressTop(null);
      return;
    }

    function updateProgressTop() {
      if (!toolbarRef.current) {
        return;
      }
      // 进度条单独悬浮，但锚点跟随工具条高度，避免不同窗口尺寸下压住按钮。
      const nextTop = toolbarRef.current.offsetTop + toolbarRef.current.offsetHeight - PROGRESS_OVERLAY_OFFSET;
      setProgressTop(nextTop);
    }

    updateProgressTop();
    window.addEventListener("resize", updateProgressTop);
    return () => {
      window.removeEventListener("resize", updateProgressTop);
    };
  }, [progress]);

  useEffect(() => {
    if (!progress || busyMode !== "idle" || pendingProgressCount > 0) {
      return;
    }

    // 查询结束后保留 2 秒给用户确认结果，再用一个短淡出收尾。
    const closingTimer = window.setTimeout(() => {
      setProgressClosing(true);
    }, PROGRESS_HOLD_MS);
    const clearTimer = window.setTimeout(() => {
      setProgress(null);
      setProgressClosing(false);
    }, PROGRESS_HOLD_MS + PROGRESS_FADE_MS);

    return () => {
      window.clearTimeout(closingTimer);
      window.clearTimeout(clearTimer);
    };
  }, [busyMode, pendingProgressCount, progress]);

  useEffect(() => {
    let disposed = false;
    let cachedPayload: PayloadEnvelope | null = null;

    async function bootstrap() {
      if (readmeDemoMode) {
        if (disposed) {
          return;
        }
        // README 演示模式直接加载虚构数据，避免截图时碰到真实账号或真实 CPA。
        setConfig(README_DEMO_CONFIG);
        setSessionState("authenticated");
        startTransition(() => {
          setPayload(README_DEMO_PAYLOAD);
          setSelectedAuthIndex("");
          setSelectedAuthIndexesByPlan({});
        });
        setErrorMessage("");
        setLoadingLabel("已载入 README 演示数据");
        setBusyMode("idle");
        return;
      }
      try {
        const saved = await loadRuntimeConfig();
        const readyToQuery = hasManagementConfig(saved);
        try {
          cachedPayload = await loadPayloadCache();
        } catch {
          cachedPayload = null;
        }
        if (disposed) {
          return;
        }
        setConfig(saved);
        setRememberManagementKey(Boolean(saved.managementKey?.trim()));
        if (cachedPayload?.items.length && !readyToQuery) {
          // 管理配置缺失时才把本地缓存顶上来，避免远端已有变化却先把旧账号短暂展示出来。
          setPayload(cachedPayload);
          setLoadingLabel("已恢复上次查询缓存");
        }
        if (!readyToQuery) {
          // 未登录时只展示登录页；缓存只留在内存中，避免未认证状态下露出账号列表。
          setLoginErrorMessage("");
          setSessionState("login");
          setLoadingLabel(cachedPayload?.items.length ? "已恢复缓存，等待登录" : "等待登录");
          setBusyMode("idle");
          return;
        }
        setBusyMode("bootstrap");
        setLoadingLabel("正在加载账号列表");
        await waitForNextPaint();
        const initialPayload = await fetchAccountList(saved);
        if (disposed) {
          return;
        }
        startTransition(() => {
          setPayload(initialPayload);
          setSelectedAuthIndex("");
          setSelectedAuthIndexesByPlan({});
        });
        await persistPayloadCache(initialPayload);
        clearProgress();
        setLoginErrorMessage("");
        setSessionState("authenticated");
        setBusyMode("idle");
        setLoadingLabel("账号列表已加载");
      } catch (error) {
        if (disposed) {
          return;
        }
        if (cachedPayload?.items.length) {
          // 远端暂时不可用时退回最近一次缓存，至少保证窗口里还有可操作的账号列表。
          startTransition(() => {
            setPayload(cachedPayload);
            setSelectedAuthIndex("");
            setSelectedAuthIndexesByPlan({});
          });
          setLoadingLabel("远端加载失败，已显示本地缓存");
        } else {
          setLoadingLabel("初始化失败");
        }
        const message = resolveErrorMessage(error, "初始化失败");
        setErrorMessage(message);
        setLoginErrorMessage(`自动登录失败：${message}`);
        setSessionState("login");
        setBusyMode("idle");
      }
    }

    void bootstrap();
    return () => {
      disposed = true;
    };
  }, [readmeDemoMode]);

  useEffect(() => {
    function handleContextMenu(event: MouseEvent) {
      // 管理台没有自定义右键业务，统一拦掉避免误触系统菜单。
      event.preventDefault();
    }

    document.addEventListener("contextmenu", handleContextMenu);
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);

  const allItems = payload?.items ?? [];
  const effectiveConfig: RuntimeConfig = {
    ...config,
    keeperSettings: config.keeperSettings ?? DEFAULT_KEEPER_SETTINGS,
    priorityPlanRanges: config.priorityPlanRanges ?? {},
    oauthSettings: config.oauthSettings ?? DEFAULT_OAUTH_SETTINGS,
  };
  const draftedItems = applyPriorityDrafts(allItems, priorityDrafts);
  const overviewItems = filterItems(draftedItems, {
    plan: selectedPlan,
    status: "all",
    query: deferredSearch,
  });
  const filteredItems = filterItems(overviewItems, {
    plan: "all",
    status: selectedStatus,
    query: "",
  });
  const visibleItems = sortItems(filteredItems, sortState);
  const keeperItems = filterItems(sortItems(draftedItems, sortState), {
    plan: "all",
    status: "all",
    query: deferredKeeperSearch,
  });
  const selectedAuthIndexes = selectedAuthIndexesByPlan[selectedPlan] ?? [];
  const filteredAuthIndexes = visibleItems.map((item) => item.auth_index);
  const oauthQueueSummary = summarizeOAuthJobs(oauthQueueJobs);
  const keeperSelectedAuthIndexes = selectedAuthIndexesByPlan.all ?? [];
  const keeperSelectedItems = keeperItems.filter((item) => keeperSelectedAuthIndexes.includes(item.auth_index));
  const keeperSelectedCount = keeperSelectedItems.length;
  const keeperDuplicateSelectedSet = new Set(keeperDuplicateSelectedAuthIndexes);
  const keeperDuplicateDeleteItems = keeperDuplicateGroups
    .flatMap((group) => group.items.map((entry) => entry.item))
    .filter((item) => keeperDuplicateSelectedSet.has(item.auth_index));
  // 下载动作优先吃当前勾选集合，没勾选时才退回全量下载。
  const selectedBackupItems = selectedAuthIndexes.length
    ? allItems.filter((item) => selectedAuthIndexes.includes(item.auth_index))
    : allItems;
  const planCounts = buildPlanCounts(allItems);
  const overviewStats = buildOverviewStats(overviewItems);
  const priorityCounts = buildPriorityPlanCounts(visibleItems);
  const isBusy = busyMode !== "idle";
  const readyToQuery = hasManagementConfig(config);
  const selectedCount = selectedAuthIndexes.length;
  const dirtyPriorityItems = draftedItems.filter((item) => item.dirty_priority && typeof item.draft_priority === "number");
  // 只有“全量下载时间晚于最后一次草稿变更”才算新备份，局部下载不能替代同步前兜底。
  const hasFreshFullBackup =
    lastDraftChangeAt !== null &&
    lastBackupAt !== null &&
    lastBackupAt >= lastDraftChangeAt;
  const canSyncPriorities = dirtyPriorityItems.length > 0 && readyToQuery;
  const backupButtonLabel = selectedCount > 0
    ? `下载选中 (${selectedCount})`
    : "下载所有账号";

  const selectableItems = activePage === "keeper" ? keeperItems : visibleItems;

  useEffect(() => {
    if (selectedAuthIndex && !selectableItems.some((item) => item.auth_index === selectedAuthIndex)) {
      setSelectedAuthIndex("");
    }
  }, [selectedAuthIndex, selectableItems]);

  function patchConfig(field: "cpaBaseUrl" | "managementKey", value: string) {
    setConfig((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function persistRuntimeConfig(nextConfig: RuntimeConfig, nextRememberManagementKey = rememberManagementKey) {
    await saveRuntimeConfigWithOptions(nextConfig, {
      rememberManagementKey: nextRememberManagementKey,
      rememberHotmailTokens: readRememberHotmailTokens(nextConfig.oauthSettings),
    });
  }

  async function handleLoginSubmit(rememberLogin: boolean) {
    const nextConfig: RuntimeConfig = {
      ...effectiveConfig,
      cpaBaseUrl: effectiveConfig.cpaBaseUrl.trim(),
      managementKey: effectiveConfig.managementKey.trim(),
    };
    if (!nextConfig.cpaBaseUrl || !nextConfig.managementKey) {
      setLoginErrorMessage("请填写 CPA 管理地址和管理密钥");
      return;
    }

    try {
      setLoginErrorMessage("");
      setErrorMessage("");
      clearProgress();
      setBusyMode("bootstrap");
      setLoadingLabel("正在登录");
      await waitForNextPaint();
      startTransition(() => {
        setConfig(nextConfig);
        setSelectedAuthIndex("");
        setSelectedAuthIndexesByPlan({});
      });
      setRememberManagementKey(rememberLogin);
      try {
        await persistRuntimeConfig(nextConfig, rememberLogin);
      } catch (error) {
        setErrorMessage(`登录成功，配置保存失败。${resolveErrorMessage(error, "请稍后重试")}`);
      }
      setSessionState("authenticated");
      setLoadingLabel(payload?.items.length ? "登录成功，已恢复本地缓存" : "登录成功，请手动加载账号");
    } catch (error) {
      const message = resolveErrorMessage(error, "登录失败，请检查地址和管理密钥");
      setLoginErrorMessage(message);
      setLoadingLabel("登录失败");
    } finally {
      setBusyMode("idle");
    }
  }

  async function handleLogout() {
    if (isBusy) {
      return;
    }
    const nextConfig = {
      ...effectiveConfig,
      managementKey: "",
    };
    setRememberManagementKey(false);
    try {
      await persistRuntimeConfig(nextConfig, false);
    } catch {
      // 退出登录时清理本地密钥失败不影响界面先回到登录页。
    }
    resetLocalViewState(nextConfig);
    setLoginErrorMessage("");
    setErrorMessage("");
    setSessionState("login");
    setLoadingLabel("已退出登录");
  }

  function updateSelectionsForPlan(planKey: string, updater: (current: string[]) => string[]) {
    setSelectedAuthIndexesByPlan((current) => ({
      ...current,
      [planKey]: updater(current[planKey] ?? []),
    }));
  }

  function replaceVisibleProgress(next: ProgressState | null) {
    progressRef.current = next;
    setProgress(next);
  }

  function patchVisibleProgress(updater: (current: ProgressState | null) => ProgressState | null) {
    setProgress((current) => {
      const next = updater(current);
      progressRef.current = next;
      return next;
    });
  }

  function stopProgressDrain() {
    if (progressDrainTimerRef.current !== null) {
      window.clearTimeout(progressDrainTimerRef.current);
      progressDrainTimerRef.current = null;
    }
  }

  function flushQueuedProgress() {
    // 下载和同步的真实事件有时会在结束前密集涌入，这里改成逐步追帧，避免 0 直接跳到完成。
    const next = progressQueueRef.current.shift() ?? null;
    setPendingProgressCount(progressQueueRef.current.length);
    if (!next) {
      return;
    }
    replaceVisibleProgress(next);
    if (progressQueueRef.current.length > 0) {
      scheduleProgressDrain();
    }
  }

  function scheduleProgressDrain() {
    if (progressDrainTimerRef.current !== null) {
      return;
    }
    progressDrainTimerRef.current = window.setTimeout(() => {
      progressDrainTimerRef.current = null;
      flushQueuedProgress();
    }, PROGRESS_DRAIN_MS);
  }

  function showProgress(next: ProgressState) {
    setProgressClosing(false);
    const current = progressRef.current;
    const lastQueued = progressQueueRef.current.length ? progressQueueRef.current[progressQueueRef.current.length - 1] : current;
    const isNewTask = !current || !areSameProgressTask(current, next) || next.completed === 0 || (lastQueued ? next.completed < lastQueued.completed : false);
    if (isNewTask) {
      stopProgressDrain();
      progressQueueRef.current = [];
      setPendingProgressCount(0);
      replaceVisibleProgress(next);
      return;
    }
    if (lastQueued && lastQueued.completed === next.completed) {
      // 同一步的更新以后写覆盖前写，确保“3 / 3 + 总耗时”不会被稍早的原始进度文案抢走。
      if (progressQueueRef.current.length > 0) {
        progressQueueRef.current[progressQueueRef.current.length - 1] = next;
        return;
      }
      replaceVisibleProgress(next);
      return;
    }
    progressQueueRef.current = compactProgressQueue([...progressQueueRef.current, next]);
    setPendingProgressCount(progressQueueRef.current.length);
    scheduleProgressDrain();
  }

  function clearProgress() {
    stopProgressDrain();
    progressQueueRef.current = [];
    setPendingProgressCount(0);
    setProgressClosing(false);
    replaceVisibleProgress(null);
  }

  function resetLocalViewState(nextConfig: RuntimeConfig = EMPTY_CONFIG) {
    // 清缓存后前端状态也要同步归零，避免界面还挂着旧账号或旧草稿的残影。
    clearProgress();
    setConfig(nextConfig);
    setPayload(null);
    setSelectedPlan("all");
    setSelectedStatus("all");
    setSearch("");
    setSelectedAuthIndex("");
    setSelectedAuthIndexesByPlan({});
    setPriorityDrafts({});
    setLastDraftChangeAt(null);
    setLastBackupAt(null);
    setKeeperResult(null);
    setKeeperRefreshFailureAuthIndexes([]);
    setKeeperDuplicateGroups([]);
    setKeeperDuplicateSelectedAuthIndexes([]);
    setPriorityBatchOpen(false);
    setSyncConfirmOpen(false);
  }

  function readRemotePriority(authIndex: string): number | null {
    const matched = allItems.find((item) => item.auth_index === authIndex);
    if (!matched) {
      return null;
    }
    if (typeof matched.remote_priority === "number") {
      return matched.remote_priority;
    }
    return typeof matched.priority === "number" ? matched.priority : null;
  }

  function toggleAccountSelection(authIndex: string, checked: boolean) {
    updateSelectionsForPlan(selectedPlan, (current) => {
      if (checked) {
        return current.includes(authIndex) ? current : [...current, authIndex];
      }
      return current.filter((item) => item !== authIndex);
    });
  }

  function toggleKeeperAccountSelection(authIndex: string, checked: boolean) {
    updateSelectionsForPlan("all", (current) => {
      if (checked) {
        return current.includes(authIndex) ? current : [...current, authIndex];
      }
      return current.filter((item) => item !== authIndex);
    });
  }

  function toggleVisibleSelections(checked: boolean) {
    const visibleAuthIndexes = visibleItems.map((item) => item.auth_index);
    updateSelectionsForPlan(selectedPlan, (current) => {
      if (checked) {
        return Array.from(new Set([...current, ...visibleAuthIndexes]));
      }
      return current.filter((item) => !visibleAuthIndexes.includes(item));
    });
  }

  function toggleKeeperVisibleSelections(checked: boolean) {
    const keeperAuthIndexes = keeperItems.map((item) => item.auth_index);
    updateSelectionsForPlan("all", (current) => {
      if (checked) {
        return Array.from(new Set([...current, ...keeperAuthIndexes]));
      }
      return current.filter((item) => !keeperAuthIndexes.includes(item));
    });
  }

  function toggleKeeperDuplicateSelection(authIndex: string, checked: boolean) {
    setKeeperDuplicateSelectedAuthIndexes((current) => {
      if (checked) {
        return current.includes(authIndex) ? current : [...current, authIndex];
      }
      return current.filter((item) => item !== authIndex);
    });
  }

  async function runQueryBatch(
    targetItems: typeof allItems,
    title: string,
    startLabel: string,
    successLabel: string,
    partialFailureLabel: string,
    failureLabel: string,
  ) {
    if (!targetItems.length) {
      return;
    }

    const startedAt = performance.now();

    try {
      setErrorMessage("");
      setBusyMode("query-one");
      setLoadingLabel(startLabel);
      showProgress({
        title,
        completed: 0,
        total: targetItems.length,
        currentLabel: `共 ${targetItems.length} 个账号`,
        elapsedLabel: "",
      });
      await waitForNextPaint();

      const nextPayload = await queryCachedAccounts(config, targetItems, (event) => {
        showProgress({
          title,
          completed: event.completed,
          total: event.total,
          currentLabel: event.currentLabel || `已完成 ${event.completed} / ${event.total}`,
          elapsedLabel: "",
        });
      });
      const hasFailure =
        Boolean(nextPayload.error) ||
        nextPayload.meta.failed > 0 ||
        nextPayload.items.some((item) => item.status === "error");
      const snapshot = mergePayload(payload, nextPayload);
      startTransition(() => {
        setPayload(snapshot);
      });
      await persistPayloadCache(snapshot);
      showProgress({
        title,
        completed: targetItems.length,
        total: targetItems.length,
        currentLabel: "本轮检查已结束",
        elapsedLabel: formatElapsedLabel(performance.now() - startedAt),
      });

      setLoadingLabel(hasFailure ? partialFailureLabel : successLabel);
    } catch (error) {
      setErrorMessage(resolveErrorMessage(error, failureLabel));
      setLoadingLabel(failureLabel);
      patchVisibleProgress((current) =>
        current
          ? {
              ...current,
              elapsedLabel: formatElapsedLabel(performance.now() - startedAt),
            }
          : null,
      );
    } finally {
      setBusyMode("idle");
    }
  }

  async function refreshList() {
    if (!readyToQuery) {
      setLoadingLabel("请先填写 CPA 地址和管理密钥");
      return;
    }
    try {
      setErrorMessage("");
      clearProgress();
      setBusyMode("list");
      setLoadingLabel("正在加载账号列表");
      await waitForNextPaint();
      let saveWarning = "";
      try {
        await persistRuntimeConfig(config);
      } catch (error) {
        // 配置写盘失败不该挡住本次加载，当前输入仍然可以直接用于查询。
        saveWarning = `配置保存失败，本次仍按当前输入加载。${resolveErrorMessage(error, "请稍后重试")}`;
      }
      const nextPayload = await fetchAccountList(config);
      startTransition(() => {
        setPayload(nextPayload);
        setSelectedAuthIndex("");
        setSelectedAuthIndexesByPlan({});
      });
      await persistPayloadCache(nextPayload);
      clearProgress();
      setErrorMessage(saveWarning);
      setLoadingLabel(saveWarning ? "账号列表已刷新，配置未保存" : "账号列表已刷新");
    } catch (error) {
      setErrorMessage(resolveErrorMessage(error, "刷新账号列表失败"));
      setLoadingLabel("刷新失败，请查看错误");
    } finally {
      setBusyMode("idle");
    }
  }

  async function handleOAuthLoginQuotaCheck(account: AccountItem) {
    if (!readyToQuery) {
      setLoadingLabel("请先填写 CPA 地址和管理密钥");
      return;
    }
    const startedAt = performance.now();
    const title = "OAuth 登录额度检测";
    try {
      setErrorMessage("");
      clearProgress();
      setBusyMode("query-one");
      setLoadingLabel("OAuth 登录成功，正在检测额度");
      showProgress({
        title,
        completed: 0,
        total: 1,
        currentLabel: account.email || account.name,
        elapsedLabel: "",
      });
      await waitForNextPaint();
      let basePayload = payload;
      let targetAccount = account;
      try {
        const refreshedPayload = await fetchAccountList(effectiveConfig);
        basePayload = refreshedPayload;
        targetAccount = findOAuthQuotaCheckAccount(refreshedPayload.items, account);
      } catch {
        basePayload = payload;
        targetAccount = account;
      }
      const nextPayload = await queryCachedAccounts(effectiveConfig, [targetAccount], (event) => {
        showProgress({
          title,
          completed: event.completed,
          total: event.total,
          currentLabel: event.currentLabel || targetAccount.email || targetAccount.name,
          elapsedLabel: "",
        });
      });
      const snapshot = mergePayload(basePayload, nextPayload);
      const checkedItem = nextPayload.items.find((item) => item.auth_index === targetAccount.auth_index);
      const recovered = Boolean(checkedItem && checkedItem.status !== "error");
      startTransition(() => {
        setPayload(snapshot);
      });
      if (recovered) {
        setKeeperRefreshFailureAuthIndexes((current) =>
          current.filter((authIndex) => authIndex !== account.auth_index && authIndex !== targetAccount.auth_index),
        );
      }
      await persistPayloadCache(snapshot);
      showProgress({
        title,
        completed: 1,
        total: 1,
        currentLabel: recovered ? "额度检测正常" : "额度检测异常",
        elapsedLabel: formatElapsedLabel(performance.now() - startedAt),
      });
      setLoadingLabel(recovered ? "OAuth 登录成功，额度检测正常" : "OAuth 登录成功，额度检测仍异常");
    } catch (error) {
      setErrorMessage(resolveErrorMessage(error, "OAuth 登录成功，额度检测失败"));
      setLoadingLabel("OAuth 登录成功，额度检测失败");
      patchVisibleProgress((current) =>
        current
          ? {
              ...current,
              elapsedLabel: formatElapsedLabel(performance.now() - startedAt),
            }
          : null,
      );
      throw error;
    } finally {
      setBusyMode("idle");
    }
  }

  async function handleQuerySelected() {
    if (!readyToQuery) {
      setLoadingLabel("请先填写 CPA 地址和管理密钥");
      return;
    }
    const targetItems = allItems.filter((item) => selectedAuthIndexes.includes(item.auth_index));
    await runQueryBatch(
      targetItems,
      "选中账号检查进度",
      "正在查询选中的账号",
      "选中账号查询完成",
      "选中账号查询完成，部分失败",
      "选中账号查询失败",
    );
  }

  async function handleSaveSettings(settings: { queryConcurrency: number; keeperSettings: KeeperSettings }) {
    const nextConfig = {
      ...config,
      ...settings,
    };
    setSettingsSaving(true);
    setConfig(nextConfig);
    try {
      await persistRuntimeConfig(nextConfig);
      setErrorMessage("");
      setLoadingLabel("设置已保存");
      setSettingsOpen(false);
    } catch (error) {
      setErrorMessage(resolveErrorMessage(error, "保存设置失败"));
      setLoadingLabel("设置保存失败");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function handleSaveConnectionConfig() {
    const nextConfig = effectiveConfig;
    setSettingsSaving(true);
    setConfig(nextConfig);
    try {
      await persistRuntimeConfig(nextConfig);
      setErrorMessage("");
      setLoadingLabel("连接配置已保存");
    } catch (error) {
      setErrorMessage(resolveErrorMessage(error, "保存连接配置失败"));
      setLoadingLabel("连接配置保存失败");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function handleSaveKeeperSettings(keeperSettings: KeeperSettings) {
    await handleSaveSettings({
      queryConcurrency: effectiveConfig.queryConcurrency,
      keeperSettings,
    });
  }

  async function handleSaveOAuthSettings(oauthSettings: OAuthSettings) {
    const nextConfig = {
      ...effectiveConfig,
      oauthSettings,
    };
    setConfig(nextConfig);
    try {
      await persistRuntimeConfig(nextConfig);
      setErrorMessage("");
      setLoadingLabel("OAuth 配置已保存");
    } catch (error) {
      setErrorMessage(resolveErrorMessage(error, "保存 OAuth 配置失败"));
      setLoadingLabel("OAuth 配置保存失败");
    }
  }

  async function handleImportedInvalidAccountEmailsChange(importedInvalidAccountEmails: string[]) {
    const nextConfig = {
      ...effectiveConfig,
      oauthSettings: {
        ...effectiveConfig.oauthSettings,
        importedInvalidAccountEmails,
      },
    };
    setConfig(nextConfig);
    try {
      await persistRuntimeConfig(nextConfig);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(resolveErrorMessage(error, "保存失效账号导入列表失败"));
    }
  }

  function replaceOAuthQueueJobs(jobs: OAuthJob[]) {
    setOAuthQueueJobs(jobs);
  }

  function persistOAuthQueueJobs(jobs: OAuthJob[]) {
    oauthJobStore.save(jobs);
    setOAuthQueueJobs(jobs);
  }

  function buildOAuthQueueScope(kind: "all" | "selected" | "filtered"): OAuthQueueScope {
    if (kind === "selected") {
      return { kind, authIndexes: selectedAuthIndexes };
    }
    if (kind === "filtered") {
      return { kind, authIndexes: filteredAuthIndexes };
    }
    return { kind: "all" };
  }

  async function handleBuildOAuthQueue(kind: "all" | "selected" | "filtered") {
    const jobs = buildOAuthJobs({
      accounts: allItems,
      hotmailAccounts: effectiveConfig.oauthSettings.hotmailAccounts,
      keeperRefreshFailureAuthIndexes,
      importedInvalidAccountEmails: effectiveConfig.oauthSettings.importedInvalidAccountEmails,
      scope: buildOAuthQueueScope(kind),
      now: new Date().toISOString(),
    });
    persistOAuthQueueJobs(jobs);
  }

  async function handleClearOAuthQueue() {
    oauthJobStore.clear();
    setOAuthQueueJobs([]);
  }

  function handlePlanChange(plan: string) {
    setSelectedPlan(plan);
    setActivePage("quota");
  }

  function formatKeeperSuccessLabel(result: KeeperRunResult): string {
    const prefix = result.summary.dry_run ? "Keeper 演练完成" : "Keeper 维护完成";
    return `${prefix}：删除 ${result.summary.dead}，禁用 ${result.summary.disabled}，启用 ${result.summary.enabled}，刷新 ${result.summary.refreshed}`;
  }

  function getKeeperDirectActionTitle(action: KeeperDirectAction): string {
    if (action === "disable") {
      return "设置禁用进度";
    }
    if (action === "refresh") {
      return "刷新证书进度";
    }
    return "删除证书进度";
  }

  function getKeeperDirectActionStartLabel(action: KeeperDirectAction): string {
    if (action === "disable") {
      return "正在禁用选中证书";
    }
    if (action === "refresh") {
      return "正在刷新选中证书";
    }
    return "正在删除选中证书";
  }

  function formatKeeperDeleteConfirmMessage(items: AccountItem[]): string {
    const previewItems = items
      .slice(0, 5)
      .map((item) => item.email || item.name || item.auth_index)
      .filter(Boolean);
    const previewLabel = previewItems.length ? `\n\n选中账号示例：\n${previewItems.join("\n")}` : "";
    const remainingLabel = items.length > previewItems.length ? `\n等 ${items.length} 个账号` : "";
    return `确认删除 ${items.length} 个选中账号的证书/账号配置？这是不可逆操作，删除后无法从 Keeper 恢复。${previewLabel}${remainingLabel}`;
  }

  function formatKeeperDuplicateDeleteConfirmMessage(items: AccountItem[]): string {
    const previewItems = items
      .slice(0, 8)
      .map((item) => `${item.email || item.auth_index} (${item.name || "未命名"})`);
    const remainingLabel = items.length > previewItems.length ? `\n等 ${items.length} 个重复授权文件` : "";
    return `确认删除 ${items.length} 个重复授权文件？这是不可逆操作，删除后无法从 Keeper 恢复。\n\n将删除：\n${previewItems.join("\n")}${remainingLabel}`;
  }

  function formatKeeperDirectActionSuccessLabel(action: KeeperDirectAction, result: KeeperRunResult): string {
    const errors = result.summary.errors + result.summary.network_error;
    const count =
      action === "disable"
        ? result.summary.disabled
        : action === "refresh"
          ? result.summary.refreshed
          : result.summary.dead;
    const verb = action === "disable" ? "禁用" : action === "refresh" ? "刷新" : "删除";
    if (errors > 0) {
      return `${verb}证书完成：成功 ${count}，异常 ${errors}`;
    }
    return `已${verb} ${count} 个选中证书`;
  }

  async function handleRunKeeper(dryRun: boolean) {
    if (!readyToQuery) {
      setLoadingLabel("请先填写 CPA 地址和管理密钥");
      return;
    }
    if (!allItems.length) {
      setLoadingLabel("请先加载账号列表");
      return;
    }
    const startedAt = performance.now();
    const title = dryRun ? "Keeper 演练进度" : "Keeper 维护进度";
    try {
      setErrorMessage("");
      clearProgress();
      setBusyMode("keeper");
      setLoadingLabel(dryRun ? "正在演练 Keeper 维护" : "正在执行 Keeper 维护");
      showProgress({
        title,
        completed: 0,
        total: allItems.length,
        currentLabel: `共 ${allItems.length} 个账号`,
        elapsedLabel: "",
      });
      await waitForNextPaint();
      const result = await runKeeperMaintenance(effectiveConfig, allItems, { dryRun }, (event) => {
        showProgress({
          title,
          completed: event.completed,
          total: event.total,
          currentLabel: event.currentLabel || `已检查 ${event.completed} / ${event.total}`,
          elapsedLabel: "",
        });
      });
      setKeeperResult(result);
      if (!dryRun) {
        setKeeperRefreshFailureAuthIndexes((current) => mergeKeeperRefreshFailureAuthIndexes(current, result, "maintenance"));
        try {
          const refreshedPayload = await fetchAccountList(effectiveConfig);
          startTransition(() => {
            setPayload(refreshedPayload);
            setSelectedAuthIndex("");
            setSelectedAuthIndexesByPlan({});
          });
          await persistPayloadCache(refreshedPayload);
        } catch (error) {
          setErrorMessage(`Keeper 已执行，刷新账号列表失败。${resolveErrorMessage(error, "请稍后手动刷新")}`);
        }
      }
      showProgress({
        title,
        completed: allItems.length,
        total: allItems.length,
        currentLabel: "本轮 Keeper 检查已结束",
        elapsedLabel: formatElapsedLabel(performance.now() - startedAt),
      });
      setLoadingLabel(formatKeeperSuccessLabel(result));
    } catch (error) {
      setErrorMessage(resolveErrorMessage(error, dryRun ? "Keeper 演练失败" : "Keeper 维护失败"));
      setLoadingLabel(dryRun ? "Keeper 演练失败" : "Keeper 维护失败");
      patchVisibleProgress((current) =>
        current
          ? {
              ...current,
              elapsedLabel: formatElapsedLabel(performance.now() - startedAt),
            }
          : null,
      );
    } finally {
      setBusyMode("idle");
    }
  }

  async function handleRunKeeperDirectAction(action: KeeperDirectAction) {
    if (!readyToQuery) {
      setLoadingLabel("请先填写 CPA 地址和管理密钥");
      return;
    }
    if (!keeperSelectedItems.length) {
      setLoadingLabel("请先在账号列表中勾选账号");
      return;
    }

    const targetItems = keeperSelectedItems;
    if (action === "delete" && !window.confirm(formatKeeperDeleteConfirmMessage(targetItems))) {
      return;
    }

    const startedAt = performance.now();
    const title = getKeeperDirectActionTitle(action);
    try {
      setErrorMessage("");
      clearProgress();
      setBusyMode("keeper");
      setLoadingLabel(getKeeperDirectActionStartLabel(action));
      showProgress({
        title,
        completed: 0,
        total: targetItems.length,
        currentLabel: `共 ${targetItems.length} 个账号`,
        elapsedLabel: "",
      });
      await waitForNextPaint();
      const result = await runKeeperDirectAction(effectiveConfig, targetItems, action, (event) => {
        showProgress({
          title,
          completed: event.completed,
          total: event.total,
          currentLabel: event.currentLabel || `已处理 ${event.completed} / ${event.total}`,
          elapsedLabel: "",
        });
      });
      setKeeperResult(result);
      if (action === "refresh") {
        setKeeperRefreshFailureAuthIndexes((current) => mergeKeeperRefreshFailureAuthIndexes(current, result, "direct-refresh"));
      }
      try {
        const refreshedPayload = await fetchAccountList(effectiveConfig);
        startTransition(() => {
          setPayload(refreshedPayload);
          setSelectedAuthIndex("");
          setSelectedAuthIndexesByPlan({});
        });
        await persistPayloadCache(refreshedPayload);
      } catch (error) {
        setErrorMessage(`Keeper 动作已执行，刷新账号列表失败。${resolveErrorMessage(error, "请稍后手动刷新")}`);
      }
      showProgress({
        title,
        completed: targetItems.length,
        total: targetItems.length,
        currentLabel: "选中账号操作已结束",
        elapsedLabel: formatElapsedLabel(performance.now() - startedAt),
      });
      setLoadingLabel(formatKeeperDirectActionSuccessLabel(action, result));
    } catch (error) {
      setErrorMessage(resolveErrorMessage(error, "Keeper 选中账号操作失败"));
      setLoadingLabel("Keeper 选中账号操作失败");
      patchVisibleProgress((current) =>
        current
          ? {
              ...current,
              elapsedLabel: formatElapsedLabel(performance.now() - startedAt),
            }
          : null,
      );
    } finally {
      setBusyMode("idle");
    }
  }

  function handleScanKeeperDuplicates() {
    const groups = buildKeeperDuplicateGroups(allItems);
    const suggestedAuthIndexes = groups.flatMap((group) =>
      group.items.filter((entry) => entry.suggestedDelete).map((entry) => entry.item.auth_index),
    );
    setKeeperDuplicateGroups(groups);
    setKeeperDuplicateSelectedAuthIndexes(suggestedAuthIndexes);
    if (!groups.length) {
      setLoadingLabel("未发现重复授权文件");
      return;
    }
    setLoadingLabel(`发现 ${groups.length} 组重复授权文件，建议删除 ${suggestedAuthIndexes.length} 个`);
  }

  async function handleDeleteKeeperDuplicates() {
    if (!readyToQuery) {
      setLoadingLabel("请先填写 CPA 地址和管理密钥");
      return;
    }
    const targetItems = keeperDuplicateDeleteItems;
    if (!targetItems.length) {
      setLoadingLabel("请先勾选需要删除的重复授权文件");
      return;
    }
    if (!window.confirm(formatKeeperDuplicateDeleteConfirmMessage(targetItems))) {
      return;
    }

    const startedAt = performance.now();
    try {
      setErrorMessage("");
      clearProgress();
      setBusyMode("keeper");
      setLoadingLabel("正在删除重复授权文件");
      showProgress({
        title: "重复授权文件删除进度",
        completed: 0,
        total: targetItems.length,
        currentLabel: `共 ${targetItems.length} 个重复授权文件`,
        elapsedLabel: "",
      });
      await waitForNextPaint();
      const result = await runKeeperDirectAction(effectiveConfig, targetItems, "delete", (event) => {
        showProgress({
          title: "重复授权文件删除进度",
          completed: event.completed,
          total: event.total,
          currentLabel: event.currentLabel || `已删除 ${event.completed} / ${event.total}`,
          elapsedLabel: "",
        });
      });
      setKeeperResult(result);
      try {
        const refreshedPayload = await fetchAccountList(effectiveConfig);
        startTransition(() => {
          setPayload(refreshedPayload);
          setSelectedAuthIndex("");
          setSelectedAuthIndexesByPlan({});
          setKeeperDuplicateGroups([]);
          setKeeperDuplicateSelectedAuthIndexes([]);
        });
        await persistPayloadCache(refreshedPayload);
      } catch (error) {
        setErrorMessage(`重复授权文件已删除，刷新账号列表失败。${resolveErrorMessage(error, "请稍后手动刷新")}`);
        setKeeperDuplicateGroups([]);
        setKeeperDuplicateSelectedAuthIndexes([]);
      }
      showProgress({
        title: "重复授权文件删除进度",
        completed: targetItems.length,
        total: targetItems.length,
        currentLabel: "重复授权文件删除已结束",
        elapsedLabel: formatElapsedLabel(performance.now() - startedAt),
      });
      setLoadingLabel(formatKeeperDirectActionSuccessLabel("delete", result));
    } catch (error) {
      setErrorMessage(resolveErrorMessage(error, "重复授权文件删除失败"));
      setLoadingLabel("重复授权文件删除失败");
      patchVisibleProgress((current) =>
        current
          ? {
              ...current,
              elapsedLabel: formatElapsedLabel(performance.now() - startedAt),
            }
          : null,
      );
    } finally {
      setBusyMode("idle");
    }
  }

  async function handleClearLocalCache() {
    if (isBusy || settingsClearingCache) {
      return;
    }
    setSettingsClearingCache(true);
    try {
      await clearLocalCache();
      setRememberManagementKey(false);
      resetLocalViewState();
      setSessionState("login");
      setLoginErrorMessage("");
      setErrorMessage("");
      setLoadingLabel("本地缓存已清空，请重新登录");
      setSettingsOpen(false);
    } catch (error) {
      setErrorMessage(resolveErrorMessage(error, "清空本地缓存失败"));
      setLoadingLabel("清空本地缓存失败");
    } finally {
      setSettingsClearingCache(false);
    }
  }

  async function handleApplyPriorityPlan(settings: {
    selectedGroups: RuntimeConfig["priorityPlanOrder"];
    priorityPlanOrder: RuntimeConfig["priorityPlanOrder"];
    priorityPlanRanges: RuntimeConfig["priorityPlanRanges"];
  }) {
    if (!allItems.length || settings.selectedGroups.length === 0) {
      return;
    }
    const nextConfig = {
      ...config,
      priorityPlanOrder: settings.priorityPlanOrder,
      priorityPlanRanges: settings.priorityPlanRanges,
    };
    const prioritySourceItems = visibleItems;
    const sourceAuthIndexSet = new Set(prioritySourceItems.map((item) => item.auth_index));
    const selectedGroupSet = new Set(settings.selectedGroups);
    const generatedDrafts = buildAutoPriorityDrafts(
      prioritySourceItems,
      settings.priorityPlanOrder,
      settings.selectedGroups,
      settings.priorityPlanRanges,
    );

    // 只重算当前列表里的勾选分组，未勾选分组和当前筛选外账号都保留已有本地草稿。
    const nextDrafts: Record<string, number> = {};
    for (const item of allItems) {
      const groupKey = normalizePriorityPlanKey(item.plan_type);
      if (!sourceAuthIndexSet.has(item.auth_index) || !selectedGroupSet.has(groupKey)) {
        const existingDraft = priorityDrafts[item.auth_index];
        if (typeof existingDraft === "number") {
          nextDrafts[item.auth_index] = existingDraft;
        }
        continue;
      }

      const nextPriority = generatedDrafts[item.auth_index];
      const remotePriority = readRemotePriority(item.auth_index);
      if (typeof nextPriority === "number" && nextPriority !== remotePriority) {
        nextDrafts[item.auth_index] = nextPriority;
      }
    }

    setPriorityBatchSaving(true);
    setConfig(nextConfig);
    try {
      await persistRuntimeConfig(nextConfig);
      setErrorMessage("");
      setLoadingLabel("已生成本地优先级草稿");
    } catch (error) {
      setErrorMessage(`优先级顺序保存失败，本次草稿仍已生成。${resolveErrorMessage(error, "请稍后重试")}`);
      setLoadingLabel("草稿已生成，顺序未保存");
    } finally {
      setPriorityBatchSaving(false);
    }

    setPriorityDrafts(nextDrafts);
    setLastDraftChangeAt(Object.keys(nextDrafts).length > 0 ? Date.now() : null);
    setLastBackupAt(null);
    setPriorityBatchOpen(false);
  }

  function handleDiscardPriorityDrafts() {
    if (!dirtyPriorityItems.length) {
      setLoadingLabel("没有需要清除的本地草稿");
      return;
    }
    // 草稿只存在本地内存里，直接清空即可恢复成当前远端快照。
    setPriorityDrafts({});
    setLastDraftChangeAt(null);
    setLastBackupAt(null);
    setErrorMessage("");
    setLoadingLabel("已清除本地优先级草稿");
  }

  async function runBackupAccounts(
    targetItems: typeof allItems,
    options: {
      markAsFullBackup: boolean;
      successLabel: (count: number) => string;
    },
  ): Promise<boolean> {
    // 手动下载和“同步前先下载”共用同一条链路，避免两套状态机越改越散。
    if (!targetItems.length) {
      return false;
    }
    const startedAt = performance.now();
    try {
      setErrorMessage("");
      clearProgress();
      setBusyMode("download");
      setLoadingLabel("正在下载远端账号");
      showProgress({
        title: "远端账号下载进度",
        completed: 0,
        total: targetItems.length,
        currentLabel: `共 ${targetItems.length} 个账号`,
        elapsedLabel: "",
      });
      await waitForNextPaint();
      const downloaded = await downloadSelectedAccounts(config, targetItems, (event) => {
        showProgress({
          title: "远端账号下载进度",
          completed: event.completed,
          total: event.total,
          currentLabel: event.currentLabel || `已下载 ${event.completed} / ${event.total}`,
          elapsedLabel: "",
        });
      });
      if (options.markAsFullBackup && downloaded.length === targetItems.length) {
        setLastBackupAt(Date.now());
      }
      showProgress({
        title: "远端账号下载进度",
        completed: downloaded.length,
        total: targetItems.length,
        currentLabel: "本轮下载已结束",
        elapsedLabel: formatElapsedLabel(performance.now() - startedAt),
      });
      setLoadingLabel(options.successLabel(downloaded.length));
      return true;
    } catch (error) {
      setErrorMessage(resolveErrorMessage(error, "下载账号配置失败"));
      setLoadingLabel("下载账号配置失败");
      patchVisibleProgress((current) =>
        current
          ? {
              ...current,
              elapsedLabel: formatElapsedLabel(performance.now() - startedAt),
            }
          : null,
      );
      return false;
    } finally {
      setBusyMode("idle");
    }
  }

  async function handleBackupAccounts() {
    if (!readyToQuery) {
      setLoadingLabel("请先填写 CPA 地址和管理密钥");
      return;
    }
    await runBackupAccounts(selectedBackupItems, {
      markAsFullBackup: selectedBackupItems.length === allItems.length,
      successLabel: (count) => (selectedCount > 0 ? `已下载 ${count} 个选中账号配置` : `已下载 ${count} 个账号配置`),
    });
  }

  async function runPrioritySync(): Promise<void> {
    if (!dirtyPriorityItems.length) {
      setLoadingLabel("没有需要同步的优先级草稿");
      return;
    }

    const changes = dirtyPriorityItems
      .map((item) => ({
        name: item.name,
        priority: item.draft_priority as number,
      }));
    if (!changes.length) {
      setLoadingLabel("没有需要同步的优先级草稿");
      return;
    }

    const startedAt = performance.now();
    try {
      setErrorMessage("");
      clearProgress();
      setBusyMode("sync");
      setLoadingLabel("正在同步优先级");
      showProgress({
        title: "优先级同步进度",
        completed: 0,
        total: changes.length,
        currentLabel: `共 ${changes.length} 个账号`,
        elapsedLabel: "",
      });
      await waitForNextPaint();
      await syncAccountPriorities(config, changes, (event) => {
        showProgress({
          title: "优先级同步进度",
          completed: event.completed,
          total: event.total,
          currentLabel: event.currentLabel || `已同步 ${event.completed} / ${event.total}`,
          elapsedLabel: "",
        });
      });

      if (payload) {
        const nextPayload = {
          ...payload,
          items: payload.items.map((item) => {
            const matched = changes.find((change) => change.name === item.name);
            if (!matched) {
              return item;
            }
            return {
              ...item,
              priority: matched.priority,
              remote_priority: matched.priority,
              draft_priority: undefined,
              dirty_priority: false,
            };
          }),
        };
        setPayload(nextPayload);
        await persistPayloadCache(nextPayload);
      }
      setPriorityDrafts({});
      setLastDraftChangeAt(null);
      setLastBackupAt(null);
      showProgress({
        title: "优先级同步进度",
        completed: changes.length,
        total: changes.length,
        currentLabel: "本轮同步已结束",
        elapsedLabel: formatElapsedLabel(performance.now() - startedAt),
      });
      setLoadingLabel("优先级已同步到远端");
    } catch (error) {
      setErrorMessage(resolveErrorMessage(error, "同步优先级失败"));
      setLoadingLabel("同步优先级失败");
      patchVisibleProgress((current) =>
        current
          ? {
              ...current,
              elapsedLabel: formatElapsedLabel(performance.now() - startedAt),
            }
          : null,
      );
    } finally {
      setBusyMode("idle");
    }
  }

  async function handleSyncPriorities() {
    if (!readyToQuery) {
      setLoadingLabel("请先填写 CPA 地址和管理密钥");
      return;
    }
    if (!canSyncPriorities) {
      setLoadingLabel("没有需要同步的优先级草稿");
      return;
    }
    if (!hasFreshFullBackup) {
      setSyncConfirmOpen(true);
      setErrorMessage("");
      setLoadingLabel("同步前建议先下载远端账号备份");
      return;
    }
    await runPrioritySync();
  }

  async function handleBackupThenSync() {
    setSyncConfirmOpen(false);
    const backedUp = await runBackupAccounts(allItems, {
      markAsFullBackup: true,
      successLabel: (count) => `已下载 ${count} 个账号配置，继续同步优先级`,
    });
    if (!backedUp) {
      return;
    }
    await runPrioritySync();
  }

  async function handleSyncWithoutBackup() {
    setSyncConfirmOpen(false);
    await runPrioritySync();
  }

  if (!readmeDemoMode && sessionState !== "authenticated") {
    return (
      <LoginPage
        config={effectiveConfig}
        busy={busyMode === "bootstrap"}
        checking={sessionState === "checking"}
        errorMessage={loginErrorMessage}
        onConfigChange={patchConfig}
        onSubmit={handleLoginSubmit}
      />
    );
  }

  return (
    <div className="stitch-shell">
      <CodexOAuthBridge
        items={allItems}
        settings={effectiveConfig.oauthSettings}
        ready={readyToQuery}
        queueJobs={oauthQueueJobs}
        queueStore={oauthJobStore}
        selectedAuthIndexes={selectedAuthIndexes}
        filteredAuthIndexes={filteredAuthIndexes}
        keeperRefreshFailureAuthIndexes={keeperRefreshFailureAuthIndexes}
        importedInvalidAccountEmails={effectiveConfig.oauthSettings.importedInvalidAccountEmails}
        onQueueJobsChange={replaceOAuthQueueJobs}
        onSettingsChange={handleSaveOAuthSettings}
        onStartOAuth={() => startCodexOAuth(effectiveConfig)}
        onSubmitOAuthCallback={(state, redirectUrl) => submitCodexOAuthCallback(effectiveConfig, state, redirectUrl)}
        onPollOAuthStatus={(state) => pollCodexOAuthStatus(effectiveConfig, state)}
        onFetchHotmailCode={(account, options) =>
          fetchHotmailVerificationCode({
            config: effectiveConfig,
            helperUrl: effectiveConfig.oauthSettings.hotmailHelperUrl,
            account,
            ...options,
          })
        }
      />
      <SidebarFilters
        activePage={activePage}
        onPageChange={setActivePage}
        accountCount={allItems.length}
      />
      <main className="stitch-main">
        <WindowChrome onOpenSettings={() => setSettingsOpen(true)} onLogout={handleLogout} />
        {activePage === "quota" ? (
          <>
            <Toolbar
              rootRef={toolbarRef}
              loadingLabel={loadingLabel}
              lastUpdated={payload?.meta.generated_at ?? ""}
              backupLabel={backupButtonLabel}
              canBackupAccounts={allItems.length > 0 && readyToQuery}
              canOpenPriorityBatch={allItems.length > 0}
              canQuerySelected={selectedCount > 0 && readyToQuery}
              canDiscardPriorityDrafts={dirtyPriorityItems.length > 0}
              canSyncPriorities={canSyncPriorities}
              isBusy={isBusy}
              busyMode={busyMode}
              selectedStatus={selectedStatus}
              selectedCount={selectedCount}
              onOpenPriorityBatch={() => setPriorityBatchOpen(true)}
              onBackupAccounts={handleBackupAccounts}
              onLoadAccounts={refreshList}
              onQuerySelected={handleQuerySelected}
              onDiscardPriorityDrafts={handleDiscardPriorityDrafts}
              onSyncPriorities={handleSyncPriorities}
            />
            <PlanFilterBar
              planCounts={planCounts}
              selectedPlan={selectedPlan}
              search={search}
              busy={isBusy}
              onPlanChange={handlePlanChange}
              onSearchChange={setSearch}
            />
            <OverviewCards stats={overviewStats} selectedStatus={selectedStatus} onSelectStatus={setSelectedStatus} />
          </>
        ) : null}
        <ProgressPanel
          active={Boolean(progress)}
          closing={progressClosing}
          title={progress?.title || ""}
          completed={progress?.completed || 0}
          total={progress?.total || 0}
          currentLabel={progress?.currentLabel || ""}
          elapsedLabel={progress?.elapsedLabel || ""}
          style={progressTop === null ? undefined : { top: `${progressTop}px` }}
        />
        {errorMessage ? (
          <div className="error-banner" role="alert">
            {errorMessage}
          </div>
        ) : null}
        {activePage === "quota" ? (
          <section className="stitch-content">
            <AccountTable
              items={visibleItems}
              sortState={sortState}
              selectedAuthIndex={selectedAuthIndex}
              selectedAuthIndexes={selectedAuthIndexes}
              onRequestSort={(key) => setSortState((current) => cycleSort(current, key))}
              onSelect={setSelectedAuthIndex}
              onToggleSelection={toggleAccountSelection}
              onToggleVisibleSelection={toggleVisibleSelections}
            />
          </section>
        ) : null}
        {activePage === "config" ? (
          <section className="config-page" aria-label="配置页面">
            <ConnectionConfigPanel
              config={effectiveConfig}
              busy={isBusy}
              saving={settingsSaving}
              onConfigChange={patchConfig}
              onSave={handleSaveConnectionConfig}
            />
          </section>
        ) : null}
        {activePage === "keeper" ? (
          <section className="keeper-page" aria-label="Keeper 操作页面">
            <KeeperPanel
              settings={effectiveConfig.keeperSettings}
              result={keeperResult}
              accountCount={allItems.length}
              statusLabel={loadingLabel}
              ready={readyToQuery && allItems.length > 0}
              busy={isBusy}
              saving={settingsSaving}
              onDryRun={() => handleRunKeeper(true)}
              onApply={() => handleRunKeeper(false)}
              onSaveSettings={handleSaveKeeperSettings}
            />
            <section className="keeper-selected-actions" aria-label="Keeper 选中账号操作">
              <div className="keeper-selected-actions__summary">
                <span className="panel-heading__eyebrow">选中账号</span>
                <strong>{keeperSelectedCount}</strong>
              </div>
              <label className="command-field command-field--search keeper-selected-actions__search">
                <span className="material-symbols-outlined" aria-hidden="true">search</span>
                <input
                  className="command-field__input"
                  aria-label="检索 Keeper 账号"
                  value={keeperSearch}
                  disabled={isBusy}
                  onChange={(event) => setKeeperSearch(event.target.value)}
                  placeholder="按邮箱 / 名称检索"
                />
              </label>
              <div className="keeper-selected-actions__buttons">
                <button
                  type="button"
                  className="command-button"
                  onClick={handleScanKeeperDuplicates}
                  disabled={!allItems.length || isBusy}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">difference</span>
                  <span>筛选重复证书</span>
                </button>
                <button
                  type="button"
                  className="command-button"
                  onClick={() => handleRunKeeperDirectAction("disable")}
                  disabled={keeperSelectedCount === 0 || !readyToQuery || isBusy}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">block</span>
                  <span>设置禁用 ({keeperSelectedCount})</span>
                </button>
                <button
                  type="button"
                  className="command-button command-button--primary"
                  onClick={() => handleRunKeeperDirectAction("refresh")}
                  disabled={keeperSelectedCount === 0 || !readyToQuery || isBusy}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">cached</span>
                  <span>刷新证书 ({keeperSelectedCount})</span>
                </button>
                <button
                  type="button"
                  className="command-button command-button--danger"
                  onClick={() => handleRunKeeperDirectAction("delete")}
                  disabled={keeperSelectedCount === 0 || !readyToQuery || isBusy}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">delete</span>
                  <span>删除证书 ({keeperSelectedCount})</span>
                </button>
              </div>
            </section>
            {keeperDuplicateGroups.length ? (
              <section className="keeper-duplicate-review" aria-label="重复授权文件删除筛选">
                <header className="keeper-duplicate-review__header">
                  <div>
                    <span className="panel-heading__eyebrow">重复授权文件</span>
                    <h3>重复证书删除筛选</h3>
                  </div>
                  <div className="keeper-duplicate-review__actions">
                    <span>{keeperDuplicateGroups.length} 组 / 已选 {keeperDuplicateDeleteItems.length}</span>
                    <button type="button" className="command-button" onClick={() => {
                      setKeeperDuplicateGroups([]);
                      setKeeperDuplicateSelectedAuthIndexes([]);
                    }} disabled={isBusy}>
                      取消筛选
                    </button>
                    <button
                      type="button"
                      className="command-button command-button--danger"
                      onClick={handleDeleteKeeperDuplicates}
                      disabled={!keeperDuplicateDeleteItems.length || !readyToQuery || isBusy}
                    >
                      删除选中重复证书 ({keeperDuplicateDeleteItems.length})
                    </button>
                  </div>
                </header>
                <div className="keeper-duplicate-groups">
                  {keeperDuplicateGroups.map((group) => (
                    <article key={group.key} className="keeper-duplicate-group">
                      <div className="keeper-duplicate-group__title">
                        <strong>{group.name}</strong>
                        <span>保留：{group.keep.email || group.keep.name || group.keep.auth_index}</span>
                      </div>
                      <div className="keeper-duplicate-group__items">
                        {group.items.map((entry) => {
                          const label = entry.item.email || entry.item.name || entry.item.auth_index;
                          const checked = keeperDuplicateSelectedSet.has(entry.item.auth_index);
                          return (
                            <label key={entry.item.auth_index} className={entry.suggestedDelete ? "keeper-duplicate-item keeper-duplicate-item--suggested" : "keeper-duplicate-item"}>
                              <input
                                type="checkbox"
                                checked={checked}
                                aria-label={`${entry.suggestedDelete ? "删除" : "保留"} ${label}`}
                                onChange={(event) => toggleKeeperDuplicateSelection(entry.item.auth_index, event.target.checked)}
                                disabled={isBusy}
                              />
                              <span className="keeper-duplicate-item__main">
                                <strong>{label}</strong>
                                <small>{entry.item.name} · {entry.item.status === "error" ? "异常" : "正常"} · 过期 {entry.item.expired || "-"}</small>
                              </span>
                              <span className={entry.suggestedDelete ? "keeper-duplicate-item__reason keeper-duplicate-item__reason--delete" : "keeper-duplicate-item__reason"}>
                                {entry.reason}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
            <AccountTable
              items={keeperItems}
              sortState={sortState}
              selectedAuthIndex={selectedAuthIndex}
              selectedAuthIndexes={keeperSelectedAuthIndexes}
              onRequestSort={(key) => setSortState((current) => cycleSort(current, key))}
              onSelect={setSelectedAuthIndex}
              onToggleSelection={toggleKeeperAccountSelection}
              onToggleVisibleSelection={toggleKeeperVisibleSelections}
            />
          </section>
        ) : null}
        {activePage === "oauth" ? (
          <CodexOAuthPanel
            items={allItems}
            settings={effectiveConfig.oauthSettings}
            ready={readyToQuery}
            onSettingsChange={handleSaveOAuthSettings}
            onStartOAuth={() => startCodexOAuth(effectiveConfig)}
            onSubmitOAuthCallback={(state, redirectUrl) => submitCodexOAuthCallback(effectiveConfig, state, redirectUrl)}
            onPollOAuthStatus={(state) => pollCodexOAuthStatus(effectiveConfig, state)}
            onFetchHotmailCode={(account, options) =>
              fetchHotmailVerificationCode({
                config: effectiveConfig,
                helperUrl: effectiveConfig.oauthSettings.hotmailHelperUrl,
                account,
                ...options,
              })
            }
            onCheckLoginQuota={handleOAuthLoginQuotaCheck}
            keeperRefreshFailureAuthIndexes={keeperRefreshFailureAuthIndexes}
            importedInvalidAccountEmails={effectiveConfig.oauthSettings.importedInvalidAccountEmails}
            onImportedInvalidAccountEmailsChange={handleImportedInvalidAccountEmailsChange}
            queueJobs={oauthQueueJobs}
            queueSummary={oauthQueueSummary}
            onBuildQueue={handleBuildOAuthQueue}
            onClearQueue={handleClearOAuthQueue}
          />
        ) : null}
      </main>
      <SettingsPanel
        open={settingsOpen}
        config={effectiveConfig}
        saving={settingsSaving}
        clearingCache={settingsClearingCache}
        busy={isBusy}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
        onClearCache={handleClearLocalCache}
      />
      <PriorityBatchPanel
        open={priorityBatchOpen}
        priorityCounts={priorityCounts}
        priorityPlanOrder={effectiveConfig.priorityPlanOrder}
        priorityPlanRanges={effectiveConfig.priorityPlanRanges}
        saving={priorityBatchSaving}
        onClose={() => setPriorityBatchOpen(false)}
        onSubmit={handleApplyPriorityPlan}
      />
      <SyncConfirmDialog
        open={syncConfirmOpen}
        onClose={() => setSyncConfirmOpen(false)}
        onBackupThenSync={handleBackupThenSync}
        onSyncWithoutBackup={handleSyncWithoutBackup}
      />
    </div>
  );
}
