# Web Large List And Mobile Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize the local-only Web runtime for large account sets and add a usable mobile layout without introducing a separate production backend.

**Architecture:** Keep the current React/Vite/Tauri-shared UI boundary. Add a browser-only IndexedDB cache adapter behind the existing `loadPayloadCache` / `savePayloadCache` API, and keep small runtime config in `localStorage`. Add list virtualization and a mobile card layout while preserving the existing desktop table workflow.

**Tech Stack:** React 18, TypeScript, Vite 8, Vitest, Testing Library, browser `IndexedDB`, optional `@tanstack/react-virtual` for list virtualization.

---

## File Ownership

Frontend Subagent owns:

- `desktop/package.json`
- `desktop/package-lock.json`
- `desktop/src/components/AccountTable.tsx`
- `desktop/src/components/AccountTable.test.tsx` if created
- `desktop/src/components/AccountCardList.tsx` if created
- `desktop/src/App.tsx` only for wiring a mobile list component if needed
- `desktop/src/styles.css`
- UI-focused tests in `desktop/src/App.test.tsx` if needed

Backend/Data Subagent owns:

- `desktop/src/lib/web-cache.ts` if created
- `desktop/src/lib/api.ts`
- `desktop/src/lib/api-web.test.ts`
- data-layer tests in `desktop/src/lib/*.test.ts`

Coordinator owns:

- `docs/superpowers/plans/2026-05-02-web-large-list-mobile.md`
- final integration, conflict resolution, verification, and follow-up docs.

## Task 1: Frontend Large List Rendering And Mobile Layout

**Files:**

- Modify: `desktop/package.json`
- Modify: `desktop/package-lock.json`
- Modify: `desktop/src/components/AccountTable.tsx`
- Modify: `desktop/src/styles.css`
- Test: `desktop/src/App.test.tsx` and/or `desktop/src/components/AccountTable.test.tsx`

- [ ] Add `@tanstack/react-virtual` or implement equivalent internal row virtualization.
- [ ] Preserve the existing desktop table columns, sorting controls, checkbox selection, row selection, and quota meter display.
- [ ] Render only visible rows plus overscan in large account sets.
- [ ] Add a mobile card-list presentation under small viewport widths instead of forcing the desktop table.
- [ ] Remove or override the global `body min-width: 1240px` on mobile widths.
- [ ] Ensure mobile cards expose email/name, plan, status, priority, 5h/7d quota, last query time, and selection.
- [ ] Add/adjust tests proving large lists do not render every row and mobile-specific markup is available.
- [ ] Run `npm test -- --run` from `desktop/`.

## Task 2: Browser Data Layer Cache For Large Payloads

**Files:**

- Create: `desktop/src/lib/web-cache.ts`
- Modify: `desktop/src/lib/api.ts`
- Modify: `desktop/src/lib/api-web.test.ts`

- [ ] Add a small IndexedDB wrapper using native browser APIs, no service worker and no separate backend service.
- [ ] Keep runtime config in `localStorage`, including CPA URL, management key, query concurrency, and priority order.
- [ ] Move Web payload cache reads/writes from `localStorage` to IndexedDB.
- [ ] Keep backward compatibility by reading legacy payload cache from `localStorage` once and migrating it to IndexedDB.
- [ ] Keep `clearLocalCache` clearing both `localStorage` config keys and IndexedDB payload data.
- [ ] Ensure cache failures do not block loading, querying, or saving config.
- [ ] Avoid large full-payload writes during progress events; write after completed list/query snapshots only, matching current public API behavior.
- [ ] Add Vitest coverage for save/load/migration/clear fallback behavior.
- [ ] Run `npm test -- --run src/lib/api-web.test.ts`.

## Task 3: Coordinator Integration And Verification

**Files:**

- Review all modified files from both subagents.

- [ ] Merge worker changes and resolve conflicts.
- [ ] Run `npm install` if package metadata changed and dependencies are missing.
- [ ] Run `npm test -- --run`.
- [ ] Run `npm run web:build`.
- [ ] Run `python3 -m pytest test_codex_quota_checker.py`.
- [ ] Run `docker compose --profile preview --profile cli config`.
- [ ] If a dev server is practical, start `docker compose up web` or `npm run web:dev` and report the local URL.
