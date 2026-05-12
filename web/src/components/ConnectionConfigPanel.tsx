import { DEFAULT_CPA_BASE_URL, inspectManagementBaseUrl } from "../lib/api";
import type { RuntimeConfig } from "../types";

interface ConnectionConfigPanelProps {
  config: RuntimeConfig;
  busy: boolean;
  saving: boolean;
  onConfigChange: (field: "cpaBaseUrl" | "managementKey", value: string) => void;
  onSave: () => void;
}

export function ConnectionConfigPanel(props: ConnectionConfigPanelProps) {
  const baseUrlInspection = inspectManagementBaseUrl(props.config.cpaBaseUrl);
  const baseUrlNotice = baseUrlInspection.error || baseUrlInspection.warning;
  const baseUrlNoticeTone = baseUrlInspection.error ? "danger" : "warning";

  return (
    <section className="config-panel" aria-label="连接配置">
      <header className="config-panel__header">
        <p className="panel-heading__eyebrow">配置</p>
        <h2>连接配置</h2>
      </header>
      <div className="config-panel__fields">
        <div className="config-field-stack">
          <label className="command-field config-field">
            <span className="material-symbols-outlined">link</span>
            <input
              className="command-field__input"
              value={props.config.cpaBaseUrl}
              disabled={props.busy || props.saving}
              onChange={(event) => props.onConfigChange("cpaBaseUrl", event.target.value)}
              placeholder={DEFAULT_CPA_BASE_URL}
            />
          </label>
          {baseUrlNotice ? (
            <div className={`config-url-notice config-url-notice--${baseUrlNoticeTone}`} role="status">
              <span className="material-symbols-outlined" aria-hidden="true">
                {baseUrlInspection.error ? "error" : "warning"}
              </span>
              <span>{baseUrlNotice}</span>
            </div>
          ) : null}
        </div>
        <label className="command-field config-field">
          <span className="material-symbols-outlined">key</span>
          <input
            className="command-field__input"
            type="password"
            value={props.config.managementKey}
            disabled={props.busy || props.saving}
            onChange={(event) => props.onConfigChange("managementKey", event.target.value)}
            placeholder="输入管理密钥"
          />
        </label>
      </div>
      <footer className="config-panel__actions">
        <button
          type="button"
          className="command-button command-button--primary"
          onClick={props.onSave}
          disabled={props.busy || props.saving}
        >
          {props.saving ? "保存中" : "保存配置"}
        </button>
      </footer>
    </section>
  );
}
