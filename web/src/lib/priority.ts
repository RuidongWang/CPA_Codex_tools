import type { AccountItem, PriorityPlanKey, PriorityPlanPreview } from "../types";

export const PRIORITY_PLAN_KEYS: PriorityPlanKey[] = ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"];

const PRIORITY_PLAN_LABELS: Record<PriorityPlanKey, string> = {
  team: "team",
  plus: "plus",
  free: "free",
  "pro 5x": "Pro 5x",
  "pro 20x": "Pro 20x",
  unknown: "未知",
};

const PRIORITY_PLAN_ALIASES: Record<string, PriorityPlanKey> = {
  pro: "pro 20x",
  prolite: "pro 5x",
  "pro-lite": "pro 5x",
  "pro_lite": "pro 5x",
};

function isPriorityPlanKey(value: string): value is PriorityPlanKey {
  return PRIORITY_PLAN_KEYS.includes(value as PriorityPlanKey);
}

export function labelPriorityPlan(key: PriorityPlanKey): string {
  return PRIORITY_PLAN_LABELS[key];
}

export function normalizePriorityPlanKey(input: string | null | undefined): PriorityPlanKey {
  const normalized = input?.trim().toLowerCase() ?? "";
  // 官方管理端就是按 plan_type 别名区分 5x 和 20x，这里保持同一口径。
  if (normalized in PRIORITY_PLAN_ALIASES) {
    return PRIORITY_PLAN_ALIASES[normalized];
  }
  return isPriorityPlanKey(normalized) ? normalized : "unknown";
}

export function normalizePriorityPlanOrder(input: PriorityPlanKey[] | null | undefined): PriorityPlanKey[] {
  const next = Array.isArray(input) ? input.filter((item): item is PriorityPlanKey => isPriorityPlanKey(item)) : [];
  const seen = new Set<PriorityPlanKey>();
  const deduped: PriorityPlanKey[] = [];

  for (const key of next) {
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(key);
  }

  for (const key of PRIORITY_PLAN_KEYS) {
    if (seen.has(key)) {
      continue;
    }
    deduped.push(key);
  }

  return deduped;
}

export function movePriorityPlanOrder(order: PriorityPlanKey[], index: number, offset: -1 | 1): PriorityPlanKey[] {
  const normalized = normalizePriorityPlanOrder(order);
  const targetIndex = index + offset;
  if (index < 0 || index >= normalized.length || targetIndex < 0 || targetIndex >= normalized.length) {
    return normalized;
  }

  const next = [...normalized];
  [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
  return next;
}

export function normalizePriorityPlanSelection(input: Iterable<PriorityPlanKey> | null | undefined): PriorityPlanKey[] {
  if (!input) {
    return [];
  }
  const seen = new Set<PriorityPlanKey>();
  const selected: PriorityPlanKey[] = [];
  for (const key of input) {
    if (!isPriorityPlanKey(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(key);
  }
  return selected;
}

export function buildPriorityPlanCounts(items: AccountItem[]): Array<{ key: PriorityPlanKey; count: number }> {
  const counts = new Map<PriorityPlanKey, number>();
  for (const key of PRIORITY_PLAN_KEYS) {
    counts.set(key, 0);
  }
  for (const item of items) {
    const key = normalizePriorityPlanKey(item.plan_type);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return PRIORITY_PLAN_KEYS.map((key) => ({ key, count: counts.get(key) ?? 0 }));
}

export function buildPriorityPlanPreview(
  counts: Array<{ key: PriorityPlanKey; count: number }>,
  order: PriorityPlanKey[],
  selectedGroups?: Iterable<PriorityPlanKey>,
): PriorityPlanPreview[] {
  const normalizedOrder = normalizePriorityPlanOrder(order);
  const countMap = new Map(
    counts.map((entry) => [entry.key, Math.max(0, Math.trunc(entry.count))] as const),
  );
  const normalizedSelection = selectedGroups === undefined ? null : new Set(normalizePriorityPlanSelection(selectedGroups));
  // 预览区间只按当前勾选分组重算，避免只选一个组时还沿用全量账号区间。
  let cursor = normalizedOrder.reduce((sum, key) => {
    if (normalizedSelection && !normalizedSelection.has(key)) {
      return sum;
    }
    return sum + (countMap.get(key) ?? 0);
  }, 0);

  return normalizedOrder.map((key) => {
    const count = countMap.get(key) ?? 0;
    if (count <= 0 || (normalizedSelection && !normalizedSelection.has(key))) {
      return { key, count, maxPriority: null, minPriority: null };
    }
    const maxPriority = cursor;
    const minPriority = cursor - count + 1;
    cursor -= count;
    return { key, count, maxPriority, minPriority };
  });
}

function readEarliestResetTimestamp(item: AccountItem): number | null {
  const timestamps = item.windows
    .map((window) => Date.parse(window.reset_at ?? ""))
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) {
    return null;
  }
  return Math.min(...timestamps);
}

function readWorstRemaining(item: AccountItem): number | null {
  const remaining = item.windows
    .map((window) => window.remaining_percent)
    .filter((value): value is number => typeof value === "number");
  if (!remaining.length) {
    return null;
  }
  return Math.min(...remaining);
}

function compareAutoPriorityOrder(left: AccountItem, right: AccountItem): number {
  const leftReset = readEarliestResetTimestamp(left);
  const rightReset = readEarliestResetTimestamp(right);
  if (leftReset === null && rightReset !== null) {
    return 1;
  }
  if (leftReset !== null && rightReset === null) {
    return -1;
  }
  if (leftReset !== null && rightReset !== null && leftReset !== rightReset) {
    return leftReset - rightReset;
  }

  const leftRemaining = readWorstRemaining(left);
  const rightRemaining = readWorstRemaining(right);
  if (leftRemaining === null && rightRemaining !== null) {
    return 1;
  }
  if (leftRemaining !== null && rightRemaining === null) {
    return -1;
  }
  if (leftRemaining !== null && rightRemaining !== null && leftRemaining !== rightRemaining) {
    return leftRemaining - rightRemaining;
  }

  return left.email.localeCompare(right.email, "zh-CN");
}

export function buildAutoPriorityDrafts(
  items: AccountItem[],
  order: PriorityPlanKey[],
  selectedGroups: Iterable<PriorityPlanKey> = PRIORITY_PLAN_KEYS,
): Record<string, number> {
  const normalizedSelection = normalizePriorityPlanSelection(selectedGroups);
  const preview = buildPriorityPlanPreview(buildPriorityPlanCounts(items), order, normalizedSelection);
  const draft: Record<string, number> = {};
  const selectedGroupSet = new Set(normalizedSelection);

  for (const range of preview) {
    const maxPriority = range.maxPriority;
    if (maxPriority === null || !selectedGroupSet.has(range.key)) {
      continue;
    }
    const groupItems = items
      .filter((item) => normalizePriorityPlanKey(item.plan_type) === range.key)
      .sort(compareAutoPriorityOrder);
    groupItems.forEach((item, index) => {
      draft[item.auth_index] = maxPriority - index;
    });
  }

  return draft;
}

export function applyPriorityDrafts(items: AccountItem[], drafts: Record<string, number>): AccountItem[] {
  return items.map((item) => {
    const remotePriority = typeof item.remote_priority === "number" ? item.remote_priority : item.priority;
    const nextDraft = drafts[item.auth_index];
    const hasDraft = typeof nextDraft === "number" && Number.isFinite(nextDraft);
    const dirtyPriority = hasDraft && nextDraft !== remotePriority;

    return {
      ...item,
      priority: dirtyPriority ? nextDraft : remotePriority,
      remote_priority: remotePriority,
      draft_priority: dirtyPriority ? nextDraft : undefined,
      dirty_priority: dirtyPriority,
    };
  });
}
