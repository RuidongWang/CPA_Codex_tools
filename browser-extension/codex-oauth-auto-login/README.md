# CPA Codex OAuth Auto Login Extension

Chrome/Edge Manifest V3 side panel extension for assisting CPA Codex accounts through the OpenAI OAuth relogin flow.

## Load Unpacked

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Choose **Load unpacked**.
4. Select this directory:
   `browser-extension/codex-oauth-auto-login`

## Usage

1. Open the CPA Codex Web app first, and keep that tab open. By default the extension looks for `http://localhost/...` or `http://127.0.0.1/...`; for a remote deployment, set **平台绑定 / Web 地址** in the side panel, for example `http://192.168.1.10:5173`.
2. Click the extension icon to open the browser side panel.
3. Press **读取账号池** to load invalid CPA accounts and the Hotmail account pool from the local app.
4. Build the OAuth queue either from the local CPA Codex Web OAuth page or from the extension side panel with **生成/刷新队列**. Both paths use the same local bridge queue.
5. Press **开始全部** to start the batch login worker. Use **暂停** to finish the current job and stop claiming new jobs, **继续** to resume claiming, and **停止** to stop the active batch and release the current job.
6. Leave the opened OpenAI auth tab active while the extension fills the email, clicks continue, reads the verification code from the local app bridge, fills the code, and confirms consent. English and Chinese OpenAI login pages are supported.

The side panel platform binding and automation settings are stored in extension local storage. The optional platform access password is encrypted before it is stored. It is only saved when **保存密码** is checked; leaving the password field blank while checked keeps the saved value, and unchecking it before saving removes the saved password. `任务间隔(秒)` waits before the next queued OAuth job after a job finishes; use it to slow down back-to-back OAuth state creation without changing per-step waits.

The extension pauses on CAPTCHA, MFA, phone verification, suspicious login, passkey, or other security text. OpenAI `account_deactivated` error pages are treated as failed jobs and skipped so the next queued account can continue.

The side panel shows queue stats, the current job, recent errors, invalid CPA accounts, and safe Hotmail metadata. It must not display Hotmail passwords, refresh tokens, or verification code values.

## Batch Status

- `phase`: the current worker step, such as `queue_built`, `starting`, `job_started`, `paused`, `done`, `stopped`, or `error`.
- `running`: whether the background worker is actively running or finishing a current job.
- `queueSummary`: compact counts for total, queued, running, callback submitted, manual required, and failed jobs.
- `currentJob`: the active job identity and state: `jobId`, `accountEmail`, `status`, `attempt`, and `lastError`.
- `recentErrors`: recent safe error summaries from the batch status or queue jobs.

## Bridge Contract

The local app page must answer `window.postMessage` requests from `content-cpa.js`.

- Request source: `cpa-codex-oauth-extension`
- Request type: `CPA_OAUTH_BRIDGE_REQUEST`
- Response source: `cpa-codex-oauth-page`
- Response type: `CPA_OAUTH_BRIDGE_RESPONSE`
- Actions: `GET_STATE`, `GET_ACCOUNT_POOLS`, `GET_CAPABILITIES`, `BUILD_QUEUE`, `GET_QUEUE`, `CLAIM_JOB`, `UPDATE_JOB`, `START_JOB_OAUTH`, `FETCH_CODE`, `SUBMIT_CALLBACK`, `CHECK_OAUTH_STATUS`, `RELEASE_JOB`, `CHECK_STATUS`

## Safety Notes

- Default host permissions are limited to local app URLs and OpenAI auth hosts. Remote CPA Web hosts are requested as optional host permissions only after saving a platform binding URL.
- The `cookies` and `browsingData` permissions, plus OpenAI-related host permissions such as `auth.openai.com`, `accounts.openai.com`, `chatgpt.com`, `chat.openai.com`, `platform.openai.com`, and `openai.com`, are used to clear OpenAI session data between batch jobs so one account does not leak into the next OAuth flow.
- CPA management keys, Hotmail refresh tokens, Hotmail passwords, and verification codes are not written to extension storage. The side-panel platform access password is the only password-like value persisted by the extension, and it is stored encrypted with an extension-local secret.
- The side panel renders only safe account metadata and redacted error text.
- Callback URLs are accepted for the configured CPA Web origin, or for local `http://localhost/...` and `http://127.0.0.1/...` when no platform URL is configured. Supported paths are `/auth/callback` and `/codex/callback`, plus the same paths under a configured base path, with `state` plus `code` or `error`.

## Tests

Run from the repository root:

```bash
node --test browser-extension/codex-oauth-auto-login/tests/*.test.js
```
