import { useEffect, useState } from "react";
import type { RuntimeConfig } from "../types";

interface SettingsPanelProps {
  open: boolean;
  config: RuntimeConfig;
  saving: boolean;
  clearingCache: boolean;
  busy: boolean;
  usesBrowserDownload?: boolean;
  onClose: () => void;
  onSave: (settings: { backupPath: string; queryConcurrency: number }) => void;
  onClearCache: () => void;
}

function normalizeConcurrency(input: string, fallback: number): number {
  const parsed = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

// 设置面板只承载本地运行时配置，先把备份路径和并发设置收在一个轻量弹层里。
export function SettingsPanel(props: SettingsPanelProps) {
  const [backupPath, setBackupPath] = useState("");
  const [queryConcurrency, setQueryConcurrency] = useState("6");

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setBackupPath(props.config.backupPath);
    setQueryConcurrency(String(props.config.queryConcurrency));
  }, [props.config.backupPath, props.config.queryConcurrency, props.open]);

  if (!props.open) {
    return null;
  }
  const showBackupPath = !props.usesBrowserDownload;
  const cacheHint = props.usesBrowserDownload
    ? "会删除浏览器里保存的 CPA 地址、管理密钥和账号缓存。"
    : "会删除 cpa_codex_quota_cache 里的地址、管理密钥、账号缓存和 sidecar 缓存。";

  return (
    <div className="settings-dialog__backdrop" role="presentation">
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="查询设置">
        <header className="settings-dialog__header">
          <div>
            <h2>查询设置</h2>
          </div>
          <button type="button" className="settings-dialog__ghost" onClick={props.onClose} disabled={props.saving}>
            关闭
          </button>
        </header>
        <div className="settings-dialog__body">
          {showBackupPath ? (
            <label className="settings-field">
              <span>账号备份路径</span>
              <input value={backupPath} onChange={(event) => setBackupPath(event.target.value)} placeholder="例如 D:\\backup\\codex" />
            </label>
          ) : (
            <p className="settings-dialog__hint">浏览器模式会直接触发账号 JSON 下载，不需要配置本地备份路径。</p>
          )}
          <label className="settings-field">
            <span>并发数</span>
            <input
              type="number"
              min={1}
              step={1}
              value={queryConcurrency}
              onChange={(event) => setQueryConcurrency(event.target.value)}
              placeholder="6"
            />
          </label>
          <section className="settings-dialog__section">
            <p className="settings-dialog__section-title">本地数据</p>
            <p className="settings-dialog__hint">{cacheHint}</p>
            <button
              type="button"
              className="command-button command-button--danger"
              onClick={props.onClearCache}
              disabled={props.saving || props.clearingCache || props.busy}
            >
              {props.clearingCache ? "清理中" : "清空本地缓存"}
            </button>
          </section>
        </div>
        <footer className="settings-dialog__footer">
          <button type="button" className="command-button" onClick={props.onClose} disabled={props.saving || props.clearingCache}>
            取消
          </button>
          <button
            type="button"
            className="command-button command-button--primary"
            onClick={() =>
              props.onSave({
                backupPath: showBackupPath ? backupPath.trim() : props.config.backupPath,
                queryConcurrency: normalizeConcurrency(queryConcurrency, props.config.queryConcurrency),
              })
            }
            disabled={props.saving || props.clearingCache}
          >
            {props.saving ? "保存中" : "保存设置"}
          </button>
        </footer>
      </section>
    </div>
  );
}
