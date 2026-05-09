# CPA Codex OAuth Auto Login Extension

Chrome/Edge Manifest V3 side panel extension for assisting CPA Codex accounts through the OpenAI OAuth relogin flow.

## Load Unpacked

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Choose **Load unpacked**.
4. Select this directory:
   `browser-extension/codex-oauth-auto-login`

## Usage

1. Open the local CPA Codex app at `http://localhost/...` or `http://127.0.0.1/...`.
2. Select the invalid Codex account and matching Hotmail account in the app.
3. Click the extension icon to open the browser side panel.
4. Press **读取账号池** to load all invalid CPA accounts and the Hotmail account pool from the local app.
5. Press **开始登录** when you want to run the single-account OAuth flow.
6. Leave the opened OpenAI auth tab active while the extension fills the email, clicks continue, reads the verification code for the filled email from the local app, fills the code, and confirms consent. English and Chinese OpenAI login pages are supported.

The extension pauses on CAPTCHA, MFA, phone verification, suspicious login, passkey, or other security text. Complete those pages manually, then continue from the browser if needed.

The side panel currently displays Hotmail account emails and passwords for verification. These values are read from the local app bridge on demand and are not written to extension storage.

## Bridge Contract

The local app page must answer `window.postMessage` requests from `content-cpa.js`.

- Request source: `cpa-codex-oauth-extension`
- Request type: `CPA_OAUTH_BRIDGE_REQUEST`
- Response source: `cpa-codex-oauth-page`
- Response type: `CPA_OAUTH_BRIDGE_RESPONSE`
- Actions: `GET_STATE`, `GET_ACCOUNT_POOLS`, `START_OAUTH`, `FETCH_CODE`, `SUBMIT_CALLBACK`, `CHECK_STATUS`

## Safety Notes

- Host permissions are limited to local app URLs and OpenAI auth hosts.
- No CPA management keys, refresh tokens, passwords, or verification codes are written to extension storage.
- Callback URLs are accepted only for `http://localhost/...` or `http://127.0.0.1/...` paths `/auth/callback` and `/codex/callback` with `state` plus `code` or `error`.

## Tests

Run from the repository root:

```bash
node --test browser-extension/codex-oauth-auto-login/tests/*.test.js
```
