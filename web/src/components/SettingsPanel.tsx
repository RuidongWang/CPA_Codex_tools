import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import type { KeeperSettings, RuntimeConfig, ThemeMode, UiSettings } from "../types";

interface SettingsPanelProps {
  open: boolean;
  config: RuntimeConfig;
  saving: boolean;
  clearingCache: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (settings: { queryConcurrency: number; keeperSettings: KeeperSettings; uiSettings: UiSettings }) => void;
  onClearCache: () => void;
  onExportSensitiveConfig: () => void;
}

const DEFAULT_PANEL_UI_SETTINGS: UiSettings = {
  themeMode: "system",
  language: "zh",
};

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
  const { t } = useI18n();
  const [queryConcurrency, setQueryConcurrency] = useState("6");
  const [keeperQuotaThreshold, setKeeperQuotaThreshold] = useState("100");
  const [keeperExpiryThresholdDays, setKeeperExpiryThresholdDays] = useState("3");
  const [keeperWorkerThreads, setKeeperWorkerThreads] = useState("6");
  const [keeperEnableRefresh, setKeeperEnableRefresh] = useState(true);
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [language, setLanguage] = useState<UiSettings["language"]>("zh");

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const uiSettings = props.config.uiSettings ?? DEFAULT_PANEL_UI_SETTINGS;
    setQueryConcurrency(String(props.config.queryConcurrency));
    setKeeperQuotaThreshold(String(props.config.keeperSettings.quotaThreshold));
    setKeeperExpiryThresholdDays(String(props.config.keeperSettings.expiryThresholdDays));
    setKeeperWorkerThreads(String(props.config.keeperSettings.workerThreads));
    setKeeperEnableRefresh(props.config.keeperSettings.enableRefresh);
    setThemeMode(uiSettings.themeMode);
    setLanguage(uiSettings.language);
  }, [props.config.keeperSettings, props.config.queryConcurrency, props.config.uiSettings, props.open]);

  if (!props.open) {
    return null;
  }
  const cacheHint = t("settings.cacheHint");

  return (
    <div className="settings-dialog__backdrop" role="presentation">
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-label={t("settings.title")}>
        <header className="settings-dialog__header">
          <div>
            <h2>{t("settings.title")}</h2>
          </div>
          <button type="button" className="settings-dialog__ghost" onClick={props.onClose} disabled={props.saving}>
            {t("settings.close")}
          </button>
        </header>
        <div className="settings-dialog__body">
          <p className="settings-dialog__hint">{t("settings.hint")}</p>
          <section className="settings-dialog__section">
            <p className="settings-dialog__section-title">{t("settings.uiSection")}</p>
            <div className="settings-field-grid settings-field-grid--two">
              <label className="settings-field">
                <span>{t("settings.themeMode")}</span>
                <select value={themeMode} onChange={(event) => setThemeMode(event.target.value as ThemeMode)}>
                  <option value="system">{t("settings.themeSystem")}</option>
                  <option value="light">{t("settings.themeLight")}</option>
                  <option value="dark">{t("settings.themeDark")}</option>
                </select>
              </label>
              <label className="settings-field">
                <span>{t("settings.language")}</span>
                <select value={language} onChange={(event) => setLanguage(event.target.value as UiSettings["language"])}>
                  <option value="zh">{t("settings.languageZh")}</option>
                  <option value="en">{t("settings.languageEn")}</option>
                </select>
              </label>
            </div>
          </section>
          <label className="settings-field">
            <span>{t("settings.concurrency")}</span>
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
            <p className="settings-dialog__section-title">{t("settings.keeperSection")}</p>
            <div className="settings-field-grid">
              <label className="settings-field">
                <span>{t("settings.quotaThreshold")}</span>
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
                <span>{t("settings.expiryThresholdDays")}</span>
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
                <span>{t("settings.workerThreads")}</span>
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
              <span>{t("settings.enableRefresh")}</span>
            </label>
          </section>
          <section className="settings-dialog__section">
            <p className="settings-dialog__section-title">{t("settings.localData")}</p>
            <p className="settings-dialog__hint">{cacheHint}</p>
            <button
              type="button"
              className="command-button"
              onClick={props.onExportSensitiveConfig}
              disabled={props.saving || props.clearingCache || props.busy}
            >
              {t("settings.exportSensitive")}
            </button>
            <button
              type="button"
              className="command-button command-button--danger"
              onClick={props.onClearCache}
              disabled={props.saving || props.clearingCache || props.busy}
            >
              {props.clearingCache ? t("settings.clearing") : t("settings.clearCache")}
            </button>
          </section>
        </div>
        <footer className="settings-dialog__footer">
          <button type="button" className="command-button" onClick={props.onClose} disabled={props.saving || props.clearingCache}>
            {t("settings.cancel")}
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
                uiSettings: {
                  themeMode,
                  language,
                },
              })
            }
            disabled={props.saving || props.clearingCache}
          >
            {props.saving ? t("settings.saving") : t("settings.save")}
          </button>
        </footer>
      </section>
    </div>
  );
}
