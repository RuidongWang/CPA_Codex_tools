# Codex OAuth Chrome Extension Design

## Goal

Build a Chrome/Edge Manifest V3 extension that works with the existing `Codex OAuth登录` page to assist one selected invalid account through Codex OAuth relogin.

## Reference

The implementation references the structure of `QLHazyCoder/codex-oauth-automation-extension`: a Manifest V3 extension with a background service worker, OpenAI auth content script, page/control content scripts, runtime message routing, and callback URL detection. This project keeps the scope smaller and does not copy the full multi-step signup/payment flow.

## Scope

First version supports a single selected account:

1. The user selects an invalid account and matching Hotmail account in this app.
2. The user clicks the extension popup start button.
3. The extension asks this app for current OAuth state through a page bridge.
4. If needed, this app starts CPA Codex OAuth and returns `authUrl` and `state`.
5. The extension opens the OpenAI OAuth URL, fills the email, waits for the verification step, asks this app to fetch the Hotmail code, fills the code, and clicks continuation/consent controls when recognizable.
6. The extension detects `localhost` / `127.0.0.1` OAuth callback URLs, returns the URL to this app, submits the callback, and triggers login status/quota check.

The first version intentionally excludes batch queues, CAPTCHA solving, MFA bypass, and proxy/account rotation.

## Safety

- User must start the extension manually from the local app page.
- The extension stores no CPA management key, Hotmail refresh token, password, or verification code.
- Host permissions are limited to local app pages and OpenAI auth hosts.
- CAPTCHA, Cloudflare, phone verification, MFA, suspicious login, or unrecognized security checks pause the flow and require manual handling.
- Callback submission still goes through the app/API validation that checks the OAuth `state`.

## App Bridge

`CodexOAuthPanel` exposes a `window.postMessage` bridge for the extension content script:

- Request source: `cpa-codex-oauth-extension`
- Response source: `cpa-codex-oauth-page`
- Request type: `CPA_OAUTH_BRIDGE_REQUEST`
- Response type: `CPA_OAUTH_BRIDGE_RESPONSE`

Supported actions:

- `GET_STATE`
- `START_OAUTH`
- `FETCH_CODE`
- `SUBMIT_CALLBACK`
- `CHECK_STATUS`

The bridge returns only the data needed for automation: selected account identity, selected Hotmail email/status, visible session URL/state/message, latest verification code, and action availability flags.

## Extension Structure

Directory: `browser-extension/codex-oauth-auto-login/`

- `manifest.json`: MV3 config and host permissions.
- `background-core.js`: pure helpers for URL classification, status objects, and callback detection.
- `background.js`: runtime orchestration and popup message handling.
- `content-cpa.js`: bridge between extension runtime and app page `window.postMessage`.
- `content-openai.js`: OpenAI auth page inspection and safe DOM automation helpers.
- `popup.html`, `popup.css`, `popup.js`: manual start/stop/status UI.
- `README.md`: install and usage instructions.
- `tests/*.test.js`: Node tests for pure helpers and script contracts.

## Testing

- App component tests cover page bridge request/response behavior.
- Extension Node tests cover manifest permissions, callback detection, CPA bridge timeout behavior, and OpenAI DOM helper behavior where practical.
- Existing app verification remains: `npm run test:run`, `npm run typecheck`, `npm run build`.
