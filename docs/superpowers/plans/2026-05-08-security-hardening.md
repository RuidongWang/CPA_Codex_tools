# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five audit findings around credential persistence, Hotmail token storage, OAuth callback validation, management URL safety, and Docker default exposure.

**Architecture:** Keep browser state usable during the current session, but sanitize what is persisted to localStorage according to explicit user choices. Centralize URL and callback validation in the API layer so UI calls cannot bypass it, and surface management URL risk in login/settings UI without blocking existing HTTP deployments.

**Tech Stack:** React, TypeScript, Vitest, Vite, Docker Compose.

---

## File Structure

- Modify `web/src/lib/api.ts`: add storage sanitization options, management URL inspection/validation, and OAuth callback URL state verification.
- Modify `web/src/lib/oauth.ts`: normalize the new Hotmail token persistence setting.
- Modify `web/src/types.ts`: add `OAuthSettings.rememberHotmailTokens`.
- Modify `web/src/App.tsx`: track whether management key should be remembered and pass persistence options to every runtime config save.
- Modify `web/src/components/LoginPage.tsx`: show management URL safety warning.
- Modify `web/src/components/ConnectionConfigPanel.tsx`: show management URL safety warning.
- Modify `web/src/components/CodexOAuthPanel.tsx`: add an explicit Hotmail token local persistence switch.
- Modify `web/src/styles.css`: style security warning and token persistence control.
- Modify `docker-compose.yml`: make default web service production preview on loopback and keep dev server behind an opt-in profile.
- Test `web/src/lib/api.test.ts` or `web/src/lib/api-web.test.ts`: cover storage sanitization, management URL validation, and callback state verification.
- Test `web/src/lib/oauth.test.ts`: cover default `rememberHotmailTokens`.
- Test `web/src/App.test.tsx` / `web/src/components/*.test.tsx`: cover non-remembered management key and UI warning/toggle behavior where existing harnesses allow it.

---

### Task 1: API Safety Primitives

**Files:**
- Modify: `web/src/lib/api.ts`
- Test: `web/src/lib/api.test.ts`

- [ ] **Step 1: Write failing tests**
  - Assert `saveRuntimeConfig(config, { rememberManagementKey: false })` strips `managementKey`.
  - Assert `saveRuntimeConfig(config, { rememberHotmailTokens: false })` strips Hotmail secrets from stored config.
  - Assert invalid management URL schemes are rejected.
  - Assert non-local HTTP management URLs report a warning.
  - Assert OAuth callback URL must include the expected `state`.

- [ ] **Step 2: Run targeted tests and verify failure**
  - Run: `npm run test:run -- src/lib/api.test.ts`
  - Expected: FAIL because helpers/options do not exist yet.

- [ ] **Step 3: Implement minimal API changes**
  - Add `RuntimeConfigPersistOptions`.
  - Add `prepareRuntimeConfigForStorage`.
  - Add `inspectManagementBaseUrl`.
  - Update `buildManagementUrl` to reject unsafe/invalid URL syntax and schemes.
  - Add `validateCodexOAuthCallbackUrl` and call it inside `submitCodexOAuthCallback`.

- [ ] **Step 4: Run targeted tests and verify pass**
  - Run: `npm run test:run -- src/lib/api.test.ts`
  - Expected: PASS.

### Task 2: OAuth Settings Normalization

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/lib/oauth.ts`
- Test: `web/src/lib/oauth.test.ts`

- [ ] **Step 1: Write failing tests**
  - Assert missing `rememberHotmailTokens` normalizes to `false`.
  - Assert explicit `true` is preserved.

- [ ] **Step 2: Run targeted tests and verify failure**
  - Run: `npm run test:run -- src/lib/oauth.test.ts`
  - Expected: FAIL because the setting is not implemented.

- [ ] **Step 3: Implement minimal type and normalization changes**
  - Extend `OAuthSettings`.
  - Include the boolean in `DEFAULT_OAUTH_SETTINGS` and `normalizeOAuthSettings`.

- [ ] **Step 4: Run targeted tests and verify pass**
  - Run: `npm run test:run -- src/lib/oauth.test.ts`
  - Expected: PASS.

### Task 3: App Persistence Behavior

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

- [ ] **Step 1: Write failing tests**
  - Login with “remember” unchecked, save settings, assert `saveRuntimeConfig` receives `rememberManagementKey: false`.
  - Import Hotmail accounts with token persistence disabled, assert saved config uses `rememberHotmailTokens: false`.

- [ ] **Step 2: Run targeted tests and verify failure**
  - Run: `npm run test:run -- src/App.test.tsx`
  - Expected: FAIL because App does not pass persistence options yet.

- [ ] **Step 3: Implement minimal App changes**
  - Track `rememberManagementKey`.
  - Set it from loaded config and login choice.
  - Add a local `persistRuntimeConfig` helper.
  - Replace runtime config saves with the helper, preserving explicit logout behavior.

- [ ] **Step 4: Run targeted tests and verify pass**
  - Run: `npm run test:run -- src/App.test.tsx`
  - Expected: PASS.

### Task 4: UI Controls and Warnings

**Files:**
- Modify: `web/src/components/LoginPage.tsx`
- Modify: `web/src/components/ConnectionConfigPanel.tsx`
- Modify: `web/src/components/CodexOAuthPanel.tsx`
- Modify: `web/src/styles.css`
- Test: existing component tests where practical.

- [ ] **Step 1: Write failing tests**
  - Assert login/settings show warning for non-local HTTP management URL.
  - Assert OAuth panel exposes and toggles the Hotmail token persistence setting.

- [ ] **Step 2: Run targeted tests and verify failure**
  - Run: `npm run test:run -- src/components/CodexOAuthPanel.test.tsx src/App.test.tsx`
  - Expected: FAIL until UI is implemented.

- [ ] **Step 3: Implement minimal UI changes**
  - Import and use `inspectManagementBaseUrl` in login/settings.
  - Add token persistence checkbox in OAuth panel.
  - Add compact warning/toggle styles.

- [ ] **Step 4: Run targeted tests and verify pass**
  - Run: `npm run test:run -- src/components/CodexOAuthPanel.test.tsx src/App.test.tsx`
  - Expected: PASS.

### Task 5: Docker Default Hardening

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Change default service**
  - Use production build plus Vite preview for `web`.
  - Bind published default web port to `127.0.0.1`.

- [ ] **Step 2: Add opt-in dev service**
  - Add `web-dev` under profile `dev`.
  - Keep Vite dev server there, bound to loopback host port.

- [ ] **Step 3: Validate compose syntax**
  - Run: `docker compose config`
  - Expected: succeeds.

### Task 6: Full Verification

**Files:**
- No direct code changes.

- [ ] **Step 1: Run all tests**
  - Run: `npm run test:run`
  - Expected: PASS.

- [ ] **Step 2: Run typecheck**
  - Run: `npm run typecheck`
  - Expected: PASS.

- [ ] **Step 3: Run build**
  - Run: `npm run build`
  - Expected: PASS.

- [ ] **Step 4: Check git status**
  - Run: `git status --short`
  - Expected: only intended files changed.
