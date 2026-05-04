import { useEffect, useState } from "react";
import type { KeeperSettings, RuntimeConfig } from "../types";

interface SettingsPanelProps {
  open: boolean;
  config: RuntimeConfig;
  saving: boolean;
  clearingCache: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (settings: { queryConcurrency: number; keeperSettings: KeeperSettings }) => void;
  onClearCache: () => void;
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

// 设置面板只承载 Web 运行时配置，把查询并发和缓存清理收在一个轻量弹层里。
export function SettingsPanel(props: SettingsPanelProps) {
  const [queryConcurrency, setQueryConcurrency] = useState("6");
  const [keeperQuotaThreshold, setKeeperQuotaThreshold] = useState("100");
  const [keeperExpiryThresholdDays, setKeeperExpiryThresholdDays] = useState("3");
  const [keeperWorkerThreads, setKeeperWorkerThreads] = useState("6");
  const [keeperEnableRefresh, setKeeperEnableRefresh] = useState(true);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setQueryConcurrency(String(props.config.queryConcurrency));
    setKeeperQuotaThreshold(String(props.config.keeperSettings.quotaThreshold));
    setKeeperExpiryThresholdDays(String(props.config.keeperSettings.expiryThresholdDays));
    setKeeperWorkerThreads(String(props.config.keeperSettings.workerThreads));
    setKeeperEnableRefresh(props.config.keeperSettings.enableRefresh);
  }, [props.config.keeperSettings, props.config.queryConcurrency, props.open]);

  if (!props.open) {
    return null;
  }
  const cacheHint = "会删除浏览器里保存的 CPA 地址、管理密钥、账号列表缓存和额度快照。";

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
          <p className="settings-dialog__hint">账号配置备份会通过浏览器直接下载 JSON 文件，不需要配置本地路径。</p>
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
            <p className="settings-dialog__section-title">Keeper 策略</p>
            <div className="settings-field-grid">
              <label className="settings-field">
                <span>禁用阈值</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={keeperQuotaThreshold}
                  onChange={(event) => setKeeperQuotaThreshold(event.target.value)}
                  placeholder="100"
                />
              </label>
              <label className="settings-field">
                <span>过期阈值天数</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={keeperExpiryThresholdDays}
                  onChange={(event) => setKeeperExpiryThresholdDays(event.target.value)}
                  placeholder="3"
                />
              </label>
              <label className="settings-field">
                <span>维护并发数</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={keeperWorkerThreads}
                  onChange={(event) => setKeeperWorkerThreads(event.target.value)}
                  placeholder="6"
                />
              </label>
            </div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={keeperEnableRefresh}
                onChange={(event) => setKeeperEnableRefresh(event.target.checked)}
              />
              <span>维护时自动刷新临期证书</span>
            </label>
          </section>
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
                queryConcurrency: normalizeConcurrency(queryConcurrency, props.config.queryConcurrency),
                keeperSettings: {
                  quotaThreshold: normalizePercent(keeperQuotaThreshold, props.config.keeperSettings.quotaThreshold),
                  expiryThresholdDays: normalizeNonNegativeInteger(keeperExpiryThresholdDays, props.config.keeperSettings.expiryThresholdDays),
                  enableRefresh: keeperEnableRefresh,
                  workerThreads: normalizeConcurrency(keeperWorkerThreads, props.config.keeperSettings.workerThreads),
                },
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
