import { useState } from "react";
import { DEFAULT_CPA_BASE_URL } from "../lib/api";
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
  const [showKey, setShowKey] = useState(false);
  const [rememberLogin, setRememberLogin] = useState(true);

  const submitLabel = props.checking ? "恢复登录中" : props.busy ? "连接中" : "登录";
  const disabled = props.busy || props.checking;

  return (
    <div className="login-shell" aria-label="登录页面">
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
          aria-label="登录表单"
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
            <h1>登录 Codex 额度监控台</h1>
          </header>

          <label className="login-field">
            <span>CPA 管理地址</span>
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
          </label>

          <label className="login-field">
            <span>管理密钥</span>
            <span className="command-field login-field__control">
              <span className="material-symbols-outlined" aria-hidden="true">key</span>
              <input
                className="command-field__input"
                type={showKey ? "text" : "password"}
                value={props.config.managementKey}
                disabled={disabled}
                onChange={(event) => props.onConfigChange("managementKey", event.target.value)}
                placeholder="输入管理密钥"
                autoComplete="current-password"
                autoFocus
              />
              <button
                type="button"
                className="login-field__icon-button"
                onClick={() => setShowKey((current) => !current)}
                disabled={disabled}
                aria-label={showKey ? "隐藏管理密钥" : "显示管理密钥"}
                title={showKey ? "隐藏管理密钥" : "显示管理密钥"}
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
            <span>记住本次登录</span>
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
