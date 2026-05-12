import { useState } from "react";
import { DEFAULT_CPA_BASE_URL, inspectManagementBaseUrl } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { RuntimeConfig } from "../types";

interface LoginPageProps {
  config: RuntimeConfig;
  busy: boolean;
  checking: boolean;
  errorMessage: string;
  onConfigChange: (field: "cpaBaseUrl" | "managementKey", value: string) => void;
  onSubmit: (rememberLogin: boolean) => void;
}

export function LoginPage(props: LoginPageProps) {
  const { t } = useI18n();
  const [showKey, setShowKey] = useState(false);
  const [rememberLogin, setRememberLogin] = useState(true);
  const baseUrlInspection = inspectManagementBaseUrl(props.config.cpaBaseUrl);
  const baseUrlNotice = baseUrlInspection.error || baseUrlInspection.warning;
  const baseUrlNoticeTone = baseUrlInspection.error ? "danger" : "warning";

  const submitLabel = props.checking ? t("login.checking") : props.busy ? t("login.connecting") : t("login.submit");
  const disabled = props.busy || props.checking;

  return (
    <div className="login-shell" aria-label={t("login.page")}>
      <section className="login-brand-panel" aria-hidden="true">
        <div className="login-brand-copy">
          <span>CODEX</span>
          <span>QUOTA</span>
          <span>KEEPER</span>
        </div>
      </section>
      <main className="login-form-panel">
        <form
          className="login-card"
          aria-label={t("login.form")}
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled) {
              props.onSubmit(rememberLogin);
            }
          }}
        >
          <div className="login-card__mark">
            <span className="material-symbols-outlined">monitoring</span>
          </div>
          <header className="login-card__header">
            <p className="panel-heading__eyebrow">CPA Codex Tools</p>
            <h1>{t("login.title")}</h1>
          </header>

          <label className="login-field">
            <span>{t("login.baseUrl")}</span>
            <span className="command-field login-field__control">
              <span className="material-symbols-outlined" aria-hidden="true">link</span>
              <input
                className="command-field__input"
                value={props.config.cpaBaseUrl}
                disabled={disabled}
                onChange={(event) => props.onConfigChange("cpaBaseUrl", event.target.value)}
                placeholder={DEFAULT_CPA_BASE_URL}
                autoComplete="url"
              />
            </span>
            {baseUrlNotice ? (
              <span className={`config-url-notice config-url-notice--${baseUrlNoticeTone}`} role="status">
                <span className="material-symbols-outlined" aria-hidden="true">
                  {baseUrlInspection.error ? "error" : "warning"}
                </span>
                <span>{baseUrlNotice}</span>
              </span>
            ) : null}
          </label>

          <label className="login-field">
            <span>{t("login.key")}</span>
            <span className="command-field login-field__control">
              <span className="material-symbols-outlined" aria-hidden="true">key</span>
              <input
                className="command-field__input"
                type={showKey ? "text" : "password"}
                value={props.config.managementKey}
                disabled={disabled}
                onChange={(event) => props.onConfigChange("managementKey", event.target.value)}
                placeholder={t("login.keyPlaceholder")}
                autoComplete="current-password"
                autoFocus
              />
              <button
                type="button"
                className="login-field__icon-button"
                onClick={() => setShowKey((current) => !current)}
                disabled={disabled}
                aria-label={showKey ? t("login.hideKey") : t("login.showKey")}
                title={showKey ? t("login.hideKey") : t("login.showKey")}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  {showKey ? "visibility_off" : "visibility"}
                </span>
              </button>
            </span>
          </label>

          <label className="login-check">
            <input
              type="checkbox"
              checked={rememberLogin}
              disabled={disabled}
              onChange={(event) => setRememberLogin(event.target.checked)}
            />
            <span>{t("login.remember")}</span>
          </label>

          <button type="submit" className="command-button command-button--primary login-submit" disabled={disabled}>
            {props.busy || props.checking ? (
              <span className="login-submit__spinner" aria-hidden="true" />
            ) : null}
            <span>{submitLabel}</span>
          </button>

          {props.errorMessage ? (
            <div className="login-error" role="alert">
              {props.errorMessage}
            </div>
          ) : null}
        </form>
      </main>
    </div>
  );
}
