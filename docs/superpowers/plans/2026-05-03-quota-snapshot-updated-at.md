# Quota Snapshot Persistence And Updated At Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist successful quota results locally and show a dedicated quota updated time in the Web account list.

**Architecture:** Keep runtime config in `localStorage`, keep the large payload cache in IndexedDB, and add a per-account IndexedDB `quota-snapshots` store keyed by `auth_index`. Web list loading should merge any existing quota snapshots into fresh CPA auth-file rows, and Web query success should update snapshots only when quota windows are successfully obtained. UI consumes a new `quota_updated_at` field while old payloads remain compatible.

**Tech Stack:** React 18, TypeScript, Vite 8, Vitest, Testing Library, browser IndexedDB.

---

## File Ownership

Backend/Data Subagent owns:

- `desktop/src/types.ts`
- `desktop/src/lib/api.ts`
- `desktop/src/lib/web-cache.ts`
- `desktop/src/lib/api-web.test.ts`
- data-layer-only tests in `desktop/src/lib/*.test.ts`

Frontend/UI Subagent owns:

- `desktop/src/lib/view-model.ts`
- `desktop/src/lib/view-model.test.ts`
- `desktop/src/components/AccountTable.tsx`
- `desktop/src/components/AccountTable.test.tsx`
- `desktop/src/App.test.tsx` only for UI expectations if needed
- `desktop/src/styles.css`

Coordinator owns:

- `docs/superpowers/plans/2026-05-03-quota-snapshot-updated-at.md`
- final integration and verification.

## Shared Requirements

- Add `quota_updated_at: string | null` to `AccountItem`.
- `last_query_at` means latest query attempt time.
- `quota_updated_at` mirrors the 5h quota window reset label shown under the quota meter, for example `05-03 18:53`.
- Failed or timed-out account queries must update `last_query_at` but must not overwrite an existing successful 5h reset label.
- Existing payloads and IndexedDB records without `quota_updated_at` must normalize to `null`, not crash.
- `clearLocalCache` must clear payload cache and quota snapshots.

## Task 1: Backend/Data Layer Quota Snapshot Persistence

**Files:**

- Modify: `desktop/src/types.ts`
- Modify: `desktop/src/lib/web-cache.ts`
- Modify: `desktop/src/lib/api.ts`
- Modify: `desktop/src/lib/api-web.test.ts`

- [ ] Write failing tests in `api-web.test.ts`:
  - successful Web `queryCachedAccounts` writes a quota snapshot with `quota_updated_at`;
  - failed Web query preserves an existing `quota_updated_at` when merged through a later list load;
  - fresh `fetchAccountList` merges quota snapshots into unknown list rows;
  - `clearLocalCache` clears quota snapshots;
  - old payloads without `quota_updated_at` normalize to `null`.
- [ ] Implement `QuotaSnapshotRecord` support in `web-cache.ts`.
  - Create/upgrade IndexedDB database to version 2.
  - Keep existing `payload-cache` store.
  - Add `quota-snapshots` store keyed by `auth_index`.
  - Export load/save/clear helpers.
- [ ] Extend `AccountItem` and `normalizeItem`.
- [ ] During Web successful quota parsing, set `quota_updated_at` from the `code-5h` window `reset_label` when it is available and there is no account-level error.
- [ ] Save quota snapshots after Web query results are built.
- [ ] Merge snapshots into Web list payloads after CPA auth-file rows are normalized.
- [ ] Run `npm test -- --run src/lib/api-web.test.ts`.

## Task 2: Frontend/UI Quota Updated At Column

**Files:**

- Modify: `desktop/src/lib/view-model.ts`
- Modify: `desktop/src/lib/view-model.test.ts`
- Modify: `desktop/src/components/AccountTable.tsx`
- Modify: `desktop/src/components/AccountTable.test.tsx`
- Modify: `desktop/src/App.test.tsx` if existing table header assertions need updates
- Modify: `desktop/src/styles.css`

- [ ] Write failing tests:
  - desktop table includes `额度更新时间` column and displays short timestamp;
  - mobile card displays quota updated time;
  - `sortItems` supports `quotaUpdatedAt` with nulls at the bottom.
- [ ] Add `quotaUpdatedAt` to `SortKey` and sorting logic.
- [ ] Add the new sort key to `AccountTableProps.onRequestSort`.
- [ ] Insert `额度更新时间` column after `7d 额度` and before existing `更新时间`.
- [ ] Keep desktop virtualization spacer `colSpan` correct after adding a column.
- [ ] Add mobile card metadata label for quota updated time.
- [ ] Adjust CSS column widths and mobile styling so text does not overlap.
- [ ] Run `npm test -- --run src/components/AccountTable.test.tsx src/lib/view-model.test.ts`.

## Task 3: Coordinator Integration And Verification

**Files:**

- Review all changed files from both Subagents.

- [ ] Resolve any overlap in `AccountTable.tsx` and tests.
- [ ] Run `npm test -- --run`.
- [ ] Run `npm run web:build`.
- [ ] Run `npm run test:node`.
- [ ] Run `python3 -m pytest test_codex_quota_checker.py`.
- [ ] Run `docker compose --profile preview --profile cli config`.
- [ ] Restart `docker compose up -d web` if Docker daemon is available.
