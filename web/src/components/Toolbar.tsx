import type { Ref } from "react";
import { useI18n } from "../lib/i18n";

interface ToolbarProps {
  loadingLabel: string;
  lastUpdated: string;
  canBackupAccounts: boolean;
  canOpenPriorityBatch: boolean;
  canQuerySelected: boolean;
  canDiscardPriorityDrafts: boolean;
  canSyncPriorities: boolean;
  isBusy: boolean;
  busyMode: "idle" | "bootstrap" | "list" | "query-one" | "download" | "sync" | "keeper";
  selectedStatus: string;
  selectedCount: number;
  rootRef?: Ref<HTMLElement>;
  onOpenPriorityBatch: () => void;
  onBackupAccounts: () => void;
  onLoadAccounts: () => void;
  onQuerySelected: () => void;
  onDiscardPriorityDrafts: () => void;
  onSyncPriorities: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  all: "全部状态",
  healthy: "正常",
  low: "偏低",
  exhausted: "耗尽",
  error: "异常",
  unknown: "未查",
};

function buildBusyCopy(mode: ToolbarProps["busyMode"], label: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (mode === "query-one") {
    return label || t("toolbar.busyQuery");
  }
  if (mode === "download") {
    return label || t("toolbar.busyDownload");
  }
  if (mode === "sync") {
    return label || t("toolbar.busySync");
  }
  if (mode === "keeper") {
    return label || t("toolbar.busyKeeper");
  }
  if (mode === "list" || mode === "bootstrap") {
    return label || t("toolbar.busyList");
  }
  return label || t("toolbar.idle");
}

// 工具条集中放加载、查询和优先级动作，避免用户在多个区域来回找入口。
export function Toolbar(props: ToolbarProps) {
  const { t } = useI18n();
  const busyCopy = buildBusyCopy(props.busyMode, props.loadingLabel, t);
  const statusLabel = t(`status.${props.selectedStatus}` as Parameters<typeof t>[0]) || STATUS_LABELS[props.selectedStatus] || props.selectedStatus;
  const currentViewLabel =
    props.selectedStatus === "all"
      ? t("toolbar.currentViewAll")
      : t("toolbar.currentView", { status: statusLabel });
  const lastUpdatedLabel = props.lastUpdated ? t("toolbar.lastUpdated", { time: props.lastUpdated }) : t("toolbar.notQueried");
  const backupLabel = props.selectedCount > 0
    ? t("toolbar.downloadSelected", { count: props.selectedCount })
    : t("toolbar.downloadAll");

  return (
    <section ref={props.rootRef} className="command-bar">
      <div className="command-bar__header">
        <p className="panel-heading__eyebrow">{t("toolbar.console")}</p>
        <div className="command-bar__meta">
          <span className={props.isBusy ? "command-bar__status command-bar__status--busy" : "command-bar__status"}>{busyCopy}</span>
          <span>{currentViewLabel}</span>
          <span>{lastUpdatedLabel}</span>
        </div>
      </div>
      <div className="command-bar__actions">
        <div className="command-bar__action-group">
          <button type="button" className="command-button command-button--primary" onClick={props.onLoadAccounts} disabled={props.isBusy}>
            {t("toolbar.loadAccounts")}
          </button>
          <button
            type="button"
            className="command-button command-button--primary"
            onClick={props.onQuerySelected}
            disabled={!props.canQuerySelected || props.isBusy}
          >
            {props.busyMode === "query-one" ? t("toolbar.querying") : t("toolbar.querySelected", { count: props.selectedCount })}
          </button>
        </div>
        <div className="command-bar__action-group">
          <button
            type="button"
            className="command-button"
            onClick={props.onOpenPriorityBatch}
            disabled={!props.canOpenPriorityBatch || props.isBusy}
          >
            {t("toolbar.batchPriority")}
          </button>
          <button
            type="button"
            className="command-button"
            onClick={props.onDiscardPriorityDrafts}
            disabled={!props.canDiscardPriorityDrafts || props.isBusy}
          >
            {t("toolbar.clearDrafts")}
          </button>
          <button
            type="button"
            className="command-button command-button--primary"
            onClick={props.onBackupAccounts}
            disabled={!props.canBackupAccounts || props.isBusy}
          >
            {props.busyMode === "download" ? t("toolbar.downloading") : backupLabel}
          </button>
          <button
            type="button"
            className="command-button command-button--primary"
            onClick={props.onSyncPriorities}
            disabled={!props.canSyncPriorities || props.isBusy}
          >
            {props.busyMode === "sync" ? t("toolbar.syncing") : t("toolbar.sync")}
          </button>
        </div>
      </div>
    </section>
  );
}
