import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import { AccountTable } from "./components/AccountTable";
import { ConnectionConfigPanel } from "./components/ConnectionConfigPanel";
import { OverviewCards } from "./components/OverviewCards";
import { KeeperPanel } from "./components/KeeperPanel";
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
  loadPayloadCache,
  loadRuntimeConfig,
  queryCachedAccounts,
  runKeeperDirectAction,
  runKeeperMaintenance,
  savePayloadCache,
  saveRuntimeConfig,
  syncAccountPriorities,
} from "./lib/api";
import {
  applyPriorityDrafts,
  buildAutoPriorityDrafts,
  buildPriorityPlanCounts,
  normalizePriorityPlanKey,
  PRIORITY_PLAN_KEYS,
} from "./lib/priority";
import { buildOverviewStats, buildPlanCounts, cycleSort, filterItems, mergePayload, sortItems, type SortState } from "./lib/view-model";
import { isReadmeDemoMode, README_DEMO_CONFIG, README_DEMO_PAYLOAD } from "./lib/readme-demo";
import type { KeeperDirectAction, KeeperRunResult, KeeperSettings, PayloadEnvelope, RuntimeConfig } from "./types";

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
};

function hasManagementConfig(config: RuntimeConfig): boolean {
  // 开源版不再内置默认地址，只有地址和管理密钥都齐全时才允许发请求。
  return Boolean(config.cpaBaseUrl.trim() && config.managementKey.trim());
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
  const [payload, setPayload] = useState<PayloadEnvelope | null>(null);
  const [selectedPlan, setSelectedPlan] = useState("all");
  const [activePage, setActivePage] = useState<SidebarPage>("quota");
  const [selectedStatus, setSelectedStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedAuthIndex, setSelectedAuthIndex] = useState("");
  const [selectedAuthIndexesByPlan, setSelectedAuthIndexesByPlan] = useState<Record<string, string[]>>({});
  const [loadingLabel, setLoadingLabel] = useState("初始化中");
  const [errorMessage, setErrorMessage] = useState("");
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
  const [sortState, setSortState] = useState<SortState>({ key: "default", direction: "none" });
  const [priorityDrafts, setPriorityDrafts] = useState<Record<string, number>>({});
  const [lastDraftChangeAt, setLastDraftChangeAt] = useState<number | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(null);
  const deferredSearch = useDeferredValue(search);
  const toolbarRef = useRef<HTMLElement | null>(null);
  const progressRef = useRef<ProgressState | null>(null);
  const progressQueueRef = useRef<ProgressState[]>([]);
  const progressDrainTimerRef = useRef<number | null>(null);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

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
        if (cachedPayload?.items.length && !readyToQuery) {
          // 管理配置缺失时才把本地缓存顶上来，避免远端已有变化却先把旧账号短暂展示出来。
          setPayload(cachedPayload);
          setLoadingLabel("已恢复上次查询缓存");
        }
        if (!readyToQuery) {
          // 账号缓存允许只读浏览，但真正发请求前必须把地址和管理密钥补齐。
          setLoadingLabel(cachedPayload?.items.length ? "已恢复缓存，等待输入管理配置" : "等待输入管理配置");
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
        setErrorMessage(resolveErrorMessage(error, "初始化失败"));
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
  };
  const draftedItems = applyPriorityDrafts(allItems, priorityDrafts);
  const filteredItems = filterItems(draftedItems, {
    plan: selectedPlan,
    status: selectedStatus,
    query: deferredSearch,
  });
  const visibleItems = sortItems(filteredItems, sortState);
  const keeperItems = sortItems(draftedItems, sortState);
  const selectedAuthIndexes = selectedAuthIndexesByPlan[selectedPlan] ?? [];
  const keeperSelectedAuthIndexes = selectedAuthIndexesByPlan.all ?? [];
  const keeperSelectedItems = keeperItems.filter((item) => keeperSelectedAuthIndexes.includes(item.auth_index));
  const keeperSelectedCount = keeperSelectedItems.length;
  // 下载动作优先吃当前勾选集合，没勾选时才退回全量下载。
  const selectedBackupItems = selectedAuthIndexes.length
    ? allItems.filter((item) => selectedAuthIndexes.includes(item.auth_index))
    : allItems;
  const planCounts = buildPlanCounts(allItems);
  const overviewStats = buildOverviewStats(visibleItems);
  const priorityCounts = buildPriorityPlanCounts(allItems);
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
        await saveRuntimeConfig(config);
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
      await saveRuntimeConfig(nextConfig);
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
      await saveRuntimeConfig(nextConfig);
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

  async function handleClearLocalCache() {
    if (isBusy || settingsClearingCache) {
      return;
    }
    setSettingsClearingCache(true);
    try {
      await clearLocalCache();
      resetLocalViewState();
      setErrorMessage("");
      setLoadingLabel("本地缓存已清空，等待输入管理配置");
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
  }) {
    if (!allItems.length || settings.selectedGroups.length === 0) {
      return;
    }
    const nextConfig = {
      ...config,
      priorityPlanOrder: settings.priorityPlanOrder,
    };
    const selectedGroupSet = new Set(settings.selectedGroups);
    const generatedDrafts = buildAutoPriorityDrafts(allItems, settings.priorityPlanOrder, settings.selectedGroups);

    // 只重算勾选分组，未勾选分组保留本地草稿，避免批量动作覆盖用户还没同步的手工调整。
    const nextDrafts: Record<string, number> = {};
    for (const item of allItems) {
      const groupKey = normalizePriorityPlanKey(item.plan_type);
      if (!selectedGroupSet.has(groupKey)) {
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
      await saveRuntimeConfig(nextConfig);
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

  return (
    <div className="stitch-shell">
      <SidebarFilters
        activePage={activePage}
        onPageChange={setActivePage}
        accountCount={allItems.length}
      />
      <main className="stitch-main">
        <WindowChrome onOpenSettings={() => setSettingsOpen(true)} />
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
              <div className="keeper-selected-actions__buttons">
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
