import type { Ref } from "react";
import { DEFAULT_CPA_BASE_URL } from "../lib/api";
import type { RuntimeConfig } from "../types";

interface ToolbarProps {
  config: RuntimeConfig;
  search: string;
  loadingLabel: string;
  lastUpdated: string;
  backupLabel: string;
  canBackupAccounts: boolean;
  canOpenPriorityBatch: boolean;
  canQuerySelected: boolean;
  canDiscardPriorityDrafts: boolean;
  canSyncPriorities: boolean;
  isBusy: boolean;
  busyMode: "idle" | "bootstrap" | "list" | "query-one" | "download" | "sync";
  selectedStatus: string;
  statusCounts: Record<string, number>;
  selectedCount: number;
  rootRef?: Ref<HTMLElement>;
  onConfigChange: (field: "cpaBaseUrl" | "managementKey", value: string) => void;
  onSearchChange: (value: string) => void;
  onOpenPriorityBatch: () => void;
  onBackupAccounts: () => void;
  onLoadAccounts: () => void;
  onQuerySelected: () => void;
  onDiscardPriorityDrafts: () => void;
  onSyncPriorities: () => void;
}

const STATUS_FILTERS = [
  { key: "all", label: "全部" },
  { key: "healthy", label: "正常" },
  { key: "low", label: "偏低" },
  { key: "exhausted", label: "耗尽" },
  { key: "error", label: "异常" },
  { key: "unknown", label: "未查" },
];

function buildBusyCopy(mode: ToolbarProps["busyMode"], label: string): string {
  if (mode === "query-one") {
    return label || "正在查询选中的账号";
  }
  if (mode === "download") {
    return label || "正在备份远端账号";
  }
  if (mode === "sync") {
    return label || "正在同步优先级";
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
      : `当前视图 ${STATUS_FILTERS.find((item) => item.key === props.selectedStatus)?.label ?? props.selectedStatus}`;
  const lastUpdatedLabel = props.lastUpdated ? `最近更新 ${props.lastUpdated}` : "尚未查询";

  return (
    <section ref={props.rootRef} className="command-bar">
      <p className="panel-heading__eyebrow">操作台</p>
      <div className="command-bar__meta">
        <span className={props.isBusy ? "command-bar__status command-bar__status--busy" : "command-bar__status"}>{busyCopy}</span>
        <span>{currentViewLabel}</span>
        <span>{lastUpdatedLabel}</span>
      </div>
      <div className="command-bar__inputs">
        <label className="command-field">
          <span className="material-symbols-outlined">link</span>
          <input
            className="command-field__input"
            value={props.config.cpaBaseUrl}
            disabled={props.isBusy}
            onChange={(event) => props.onConfigChange("cpaBaseUrl", event.target.value)}
            placeholder={DEFAULT_CPA_BASE_URL}
          />
        </label>
        <label className="command-field">
          <span className="material-symbols-outlined">key</span>
          <input
            className="command-field__input"
            type="password"
            value={props.config.managementKey}
            disabled={props.isBusy}
            onChange={(event) => props.onConfigChange("managementKey", event.target.value)}
            placeholder="输入管理密钥"
          />
        </label>
        <label className="command-field command-field--search">
          <span className="material-symbols-outlined">search</span>
          <input
            className="command-field__input"
            value={props.search}
            disabled={props.isBusy}
            onChange={(event) => props.onSearchChange(event.target.value)}
            placeholder="按邮箱搜索"
          />
        </label>
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
            {props.busyMode === "download" ? "备份中" : props.backupLabel}
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
      <div className="command-bar__footer">
        <div className="status-summary" aria-label="状态摘要">
          {STATUS_FILTERS.map((item) => {
            const count =
              item.key === "all"
                ? Object.values(props.statusCounts).reduce((sum, value) => sum + value, 0)
                : (props.statusCounts[item.key] ?? 0);
            return (
              <span
                key={item.key}
                className={props.selectedStatus === item.key ? "status-summary__pill status-summary__pill--active" : "status-summary__pill"}
              >
                <span className={`status-summary__dot status-summary__dot--${item.key}`} aria-hidden="true" />
                <span>{item.label}</span>
                <strong>{count}</strong>
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}
