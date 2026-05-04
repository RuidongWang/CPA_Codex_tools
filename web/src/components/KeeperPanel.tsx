import { useEffect, useState } from "react";
import type { KeeperAction, KeeperRunResult, KeeperSettings } from "../types";

interface KeeperPanelProps {
  settings: KeeperSettings;
  result: KeeperRunResult | null;
  accountCount: number;
  statusLabel: string;
  ready: boolean;
  busy: boolean;
  saving: boolean;
  onDryRun: () => void;
  onApply: () => void;
  onSaveSettings: (settings: KeeperSettings) => void;
}

const ACTION_LABELS: Record<KeeperAction, string> = {
  none: "保留",
  delete: "删除",
  disable: "禁用",
  enable: "启用",
  refresh: "刷新",
  "refresh-candidate": "刷新候选",
  skip: "跳过",
  error: "异常",
};

function formatPercent(value: number | null): string {
  return value === null ? "-" : `${Math.round(value)}%`;
}

function formatRunTime(value: string | undefined): string {
  if (!value) {
    return "未运行";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

function actionTone(action: KeeperAction): string {
  if (action === "delete" || action === "error") {
    return "danger";
  }
  if (action === "disable" || action === "refresh" || action === "refresh-candidate") {
    return "warning";
  }
  if (action === "enable" || action === "none") {
    return "healthy";
  }
  return "neutral";
}

function normalizeConcurrency(input: string, fallback: number): number {
  const parsed = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function normalizePercent(input: string, fallback: number): number {
  const parsed = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, parsed));
}

function normalizeNonNegativeInteger(input: string, fallback: number): number {
  const parsed = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, parsed);
}

export function KeeperPanel(props: KeeperPanelProps) {
  const [quotaThreshold, setQuotaThreshold] = useState(String(props.settings.quotaThreshold));
  const [expiryThresholdDays, setExpiryThresholdDays] = useState(String(props.settings.expiryThresholdDays));
  const [workerThreads, setWorkerThreads] = useState(String(props.settings.workerThreads));
  const [enableRefresh, setEnableRefresh] = useState(props.settings.enableRefresh);
  const summary = props.result?.summary;
  const rows = props.result?.items ?? [];
  const disabled = props.busy || !props.ready;

  useEffect(() => {
    setQuotaThreshold(String(props.settings.quotaThreshold));
    setExpiryThresholdDays(String(props.settings.expiryThresholdDays));
    setWorkerThreads(String(props.settings.workerThreads));
    setEnableRefresh(props.settings.enableRefresh);
  }, [props.settings]);

  function handleSaveSettings() {
    props.onSaveSettings({
      quotaThreshold: normalizePercent(quotaThreshold, props.settings.quotaThreshold),
      expiryThresholdDays: normalizeNonNegativeInteger(expiryThresholdDays, props.settings.expiryThresholdDays),
      enableRefresh,
      workerThreads: normalizeConcurrency(workerThreads, props.settings.workerThreads),
    });
  }

  return (
    <section className="keeper-panel" aria-label="Keeper 监控">
      <header className="keeper-panel__header">
        <div>
          <p className="panel-heading__eyebrow">Keeper</p>
          <h2>账号维护监控</h2>
        </div>
        <div className="keeper-panel__actions">
          <button type="button" className="command-button" onClick={props.onDryRun} disabled={disabled}>
            演练扫描
          </button>
          <button type="button" className="command-button command-button--primary" onClick={props.onApply} disabled={disabled}>
            执行维护
          </button>
        </div>
      </header>
      <div className="keeper-panel__meta">
        <span>账号 {props.accountCount}</span>
        <span>阈值 {props.settings.quotaThreshold}%</span>
        <span>过期 {props.settings.expiryThresholdDays} 天</span>
        <span>并发 {props.settings.workerThreads}</span>
        <span>{props.settings.enableRefresh ? "维护刷新 开" : "维护刷新 关"}</span>
        <span>{summary?.dry_run ? "演练结果" : "执行结果"}</span>
        <span>{formatRunTime(summary?.generated_at)}</span>
        {props.statusLabel ? <span>{props.statusLabel}</span> : null}
      </div>
      <section className="keeper-panel__config" aria-label="Keeper 配置">
        <header className="keeper-panel__config-header">
          <h3>刷新配置</h3>
          <button
            type="button"
            className="command-button"
            onClick={handleSaveSettings}
            disabled={props.saving || props.busy}
          >
            {props.saving ? "保存中" : "保存 Keeper 配置"}
          </button>
        </header>
        <div className="keeper-panel__config-grid">
          <label className="settings-field">
            <span>刷新阈值天数</span>
            <input
              type="number"
              min={0}
              step={1}
              value={expiryThresholdDays}
              onChange={(event) => setExpiryThresholdDays(event.target.value)}
              placeholder="3"
            />
          </label>
          <label className="settings-field">
            <span>维护并发数</span>
            <input
              type="number"
              min={1}
              step={1}
              value={workerThreads}
              onChange={(event) => setWorkerThreads(event.target.value)}
              placeholder="6"
            />
          </label>
          <label className="settings-field">
            <span>禁用阈值</span>
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={quotaThreshold}
              onChange={(event) => setQuotaThreshold(event.target.value)}
              placeholder="100"
            />
          </label>
        </div>
        <label className="settings-toggle keeper-panel__toggle">
          <input
            type="checkbox"
            checked={enableRefresh}
            onChange={(event) => setEnableRefresh(event.target.checked)}
          />
          <span>维护时自动刷新临期证书</span>
        </label>
      </section>
      <div className="keeper-panel__stats">
        <span>
          <strong>{summary?.total ?? 0}</strong>
          总计
        </span>
        <span>
          <strong>{summary?.dead ?? 0}</strong>
          删除
        </span>
        <span>
          <strong>{summary?.disabled ?? 0}</strong>
          禁用
        </span>
        <span>
          <strong>{summary?.enabled ?? 0}</strong>
          启用
        </span>
        <span>
          <strong>{summary?.refreshed ?? 0}</strong>
          刷新
        </span>
        <span>
          <strong>{summary?.refresh_candidates ?? 0}</strong>
          刷新候选
        </span>
        <span>
          <strong>{(summary?.skipped ?? 0) + (summary?.errors ?? 0)}</strong>
          跳过/异常
        </span>
      </div>
      {rows.length ? (
        <div className="keeper-panel__table-wrap">
          <table className="keeper-table">
            <thead>
              <tr>
                <th>账号</th>
                <th>动作</th>
                <th>额度</th>
                <th>状态</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.auth_index || row.name}>
                  <td>
                    <span className="keeper-table__email">{row.email || row.name}</span>
                    <span className="keeper-table__sub">{row.remaining_label}</span>
                  </td>
                  <td>
                    <span className={`keeper-action keeper-action--${actionTone(row.action)}`}>{ACTION_LABELS[row.action]}</span>
                  </td>
                  <td>
                    <span>{row.primary_label || "quota"} {formatPercent(row.primary_used_percent)}</span>
                    {row.secondary_label ? <span className="keeper-table__sub">{row.secondary_label} {formatPercent(row.secondary_used_percent)}</span> : null}
                  </td>
                  <td>
                    <span>{row.disabled === null ? "-" : row.disabled ? "已禁用" : "启用"}</span>
                    <span className="keeper-table__sub">{row.refreshed ? "已刷新" : row.applied ? "已执行" : row.refresh_candidate ? "候选" : "未执行"}</span>
                  </td>
                  <td>{row.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
