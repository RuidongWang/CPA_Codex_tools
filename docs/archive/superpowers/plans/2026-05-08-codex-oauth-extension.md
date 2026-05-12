# Codex OAuth Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Chrome/Edge extension that assists the selected invalid account through Codex OAuth relogin using the app's OAuth page.

**Architecture:** The app exposes a small message bridge from `CodexOAuthPanel`; the extension popup starts a background orchestration loop; content scripts bridge to the local app and automate recognizable OpenAI OAuth DOM states. The extension never stores secrets and pauses on unrecognized security checks.

**Tech Stack:** React, TypeScript, Vitest, Chrome Manifest V3, vanilla JavaScript, Node built-in test runner.

---

### Task 1: App OAuth Bridge

**Files:**
- Modify: `web/src/components/CodexOAuthPanel.tsx`
- Modify: `web/src/components/CodexOAuthPanel.test.tsx`

- [ ] **Step 1: Write failing tests**
  - Add a component test that sends `GET_STATE` through `window.postMessage` and expects the selected CPA/Hotmail/session bridge response.
  - Add a component test that sends `START_OAUTH` and verifies it returns an auth URL without relying on popup DOM scraping.

- [ ] **Step 2: Run targeted tests and verify failure**
  - Run: `npm run test:run -- src/components/CodexOAuthPanel.test.tsx`
  - Expected: FAIL because bridge does not exist.

- [ ] **Step 3: Implement bridge**
  - Add request/response constants and a `postBridgeResponse` helper.
  - Extract shared `startOAuthSession({ openAuthUrl })`, `fetchHotmailCode()`, `submitCallbackUrl(redirectUrl)`, and `checkStatus()` helpers.
  - Add a `useEffect` message listener for `GET_STATE`, `START_OAUTH`, `FETCH_CODE`, `SUBMIT_CALLBACK`, and `CHECK_STATUS`.

- [ ] **Step 4: Run targeted tests**
  - Run: `npm run test:run -- src/components/CodexOAuthPanel.test.tsx`
  - Expected: PASS.

### Task 2: Extension Core

**Files:**
- Create: `browser-extension/codex-oauth-auto-login/manifest.json`
- Create: `browser-extension/codex-oauth-auto-login/background-core.js`
- Create: `browser-extension/codex-oauth-auto-login/background.js`
- Create: `browser-extension/codex-oauth-auto-login/tests/background-core.test.js`
- Create: `browser-extension/codex-oauth-auto-login/tests/manifest.test.js`

- [ ] **Step 1: Write failing tests**
  - Test callback URL detection for `localhost` and `127.0.0.1`.
  - Test non-local callback rejection.
  - Test manifest has only local app and OpenAI auth host permissions.

- [ ] **Step 2: Run tests and verify failure**
  - Run: `node --test browser-extension/codex-oauth-auto-login/tests/*.test.js`
  - Expected: FAIL because files do not exist.

- [ ] **Step 3: Implement extension core**
  - Add MV3 manifest.
  - Add pure helpers for URL classification, status formatting, and sleep.
  - Add background orchestration loop with manual start/stop/status messages.

- [ ] **Step 4: Run tests**
  - Run: `node --test browser-extension/codex-oauth-auto-login/tests/*.test.js`
  - Expected: PASS.

### Task 3: Content Scripts and Popup

**Files:**
- Create: `browser-extension/codex-oauth-auto-login/content-cpa.js`
- Create: `browser-extension/codex-oauth-auto-login/content-openai.js`
- Create: `browser-extension/codex-oauth-auto-login/popup.html`
- Create: `browser-extension/codex-oauth-auto-login/popup.css`
- Create: `browser-extension/codex-oauth-auto-login/popup.js`
- Create: `browser-extension/codex-oauth-auto-login/tests/content-openai.test.js`

- [ ] **Step 1: Write failing tests**
  - Test OpenAI content helper can classify email, verification, consent, and manual-required states from simple DOM fixtures.

- [ ] **Step 2: Run tests and verify failure**
  - Run: `node --test browser-extension/codex-oauth-auto-login/tests/*.test.js`
  - Expected: FAIL until scripts exist.

- [ ] **Step 3: Implement content scripts and popup**
  - `content-cpa.js` sends bridge requests to the app page.
  - `content-openai.js` fills email/code and clicks likely continuation controls.
  - Popup exposes start/stop/refresh status.

- [ ] **Step 4: Run tests**
  - Run: `node --test browser-extension/codex-oauth-auto-login/tests/*.test.js`
  - Expected: PASS.

### Task 4: Docs and Full Verification

**Files:**
- Create: `browser-extension/codex-oauth-auto-login/README.md`
- Modify: `README.md`

- [ ] **Step 1: Document install/use**
  - Add extension-specific README with Chrome/Edge load-unpacked instructions.
  - Add main README pointer under Codex OAuth login.

- [ ] **Step 2: Run full verification**
  - Run: `node --test browser-extension/codex-oauth-auto-login/tests/*.test.js`
  - Run: `npm run test:run`
  - Run: `npm run typecheck`
  - Run: `npm run build`
