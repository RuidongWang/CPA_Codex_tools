import type { Ref } from "react";

interface ToolbarProps {
  loadingLabel: string;
  lastUpdated: string;
  backupLabel: string;
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

function buildBusyCopy(mode: ToolbarProps["busyMode"], label: string): string {
  if (mode === "query-one") {
    return label || "正在查询选中的账号";
  }
  if (mode === "download") {
    return label || "正在下载远端账号";
  }
  if (mode === "sync") {
    return label || "正在同步优先级";
  }
  if (mode === "keeper") {
    return label || "正在执行 Keeper 维护";
  }
  if (mode === "list" || mode === "bootstrap") {
    return label || "正在加载账号列表";
  }
  return label || "空闲";
}

// 工具条集中放加载、查询和优先级动作，避免用户在多个区域来回找入口。
export function Toolbar(props: ToolbarProps) {
  const busyCopy = buildBusyCopy(props.busyMode, props.loadingLabel);
  const currentViewLabel =
    props.selectedStatus === "all"
      ? "当前视图 全部状态"
      : `当前视图 ${STATUS_LABELS[props.selectedStatus] ?? props.selectedStatus}`;
  const lastUpdatedLabel = props.lastUpdated ? `最近更新 ${props.lastUpdated}` : "尚未查询";

  return (
    <section ref={props.rootRef} className="command-bar">
      <div className="command-bar__header">
        <p className="panel-heading__eyebrow">操作台</p>
        <div className="command-bar__meta">
          <span className={props.isBusy ? "command-bar__status command-bar__status--busy" : "command-bar__status"}>{busyCopy}</span>
          <span>{currentViewLabel}</span>
          <span>{lastUpdatedLabel}</span>
        </div>
      </div>
      <div className="command-bar__actions">
        <div className="command-bar__action-group">
          <button type="button" className="command-button command-button--primary" onClick={props.onLoadAccounts} disabled={props.isBusy}>
            加载账号
          </button>
          <button
            type="button"
            className="command-button command-button--primary"
            onClick={props.onQuerySelected}
            disabled={!props.canQuerySelected || props.isBusy}
          >
            {props.busyMode === "query-one" ? "查询中" : `查询选中账号 (${props.selectedCount})`}
          </button>
        </div>
        <div className="command-bar__action-group">
          <button
            type="button"
            className="command-button"
            onClick={props.onOpenPriorityBatch}
            disabled={!props.canOpenPriorityBatch || props.isBusy}
          >
            批量设置优先级
          </button>
          <button
            type="button"
            className="command-button"
            onClick={props.onDiscardPriorityDrafts}
            disabled={!props.canDiscardPriorityDrafts || props.isBusy}
          >
            清除本地草稿
          </button>
          <button
            type="button"
            className="command-button command-button--primary"
            onClick={props.onBackupAccounts}
            disabled={!props.canBackupAccounts || props.isBusy}
          >
            {props.busyMode === "download" ? "下载中" : props.backupLabel}
          </button>
          <button
            type="button"
            className="command-button command-button--primary"
            onClick={props.onSyncPriorities}
            disabled={!props.canSyncPriorities || props.isBusy}
          >
            {props.busyMode === "sync" ? "同步中" : "同步到远端"}
          </button>
        </div>
      </div>
    </section>
  );
}
