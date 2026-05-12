import type { AccountItem } from "../types";

export interface KeeperDuplicateEntry {
  item: AccountItem;
  suggestedDelete: boolean;
  reason: string;
}

export interface KeeperDuplicateGroup {
  key: string;
  name: string;
  keep: AccountItem;
  items: KeeperDuplicateEntry[];
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDuplicateKey(value?: string): string {
  return String(value || "").trim().toLowerCase();
}

function readExpirationTime(value?: string): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isAbnormal(item: AccountItem): boolean {
  return item.status === "error";
}

function compareDeletePriority(left: AccountItem, right: AccountItem): number {
  const leftAbnormal = isAbnormal(left);
  const rightAbnormal = isAbnormal(right);
  if (leftAbnormal !== rightAbnormal) {
    return leftAbnormal ? -1 : 1;
  }
  const leftExpiredAt = readExpirationTime(left.expired);
  const rightExpiredAt = readExpirationTime(right.expired);
  if (leftExpiredAt !== rightExpiredAt) {
    return leftExpiredAt - rightExpiredAt;
  }
  return left.auth_index.localeCompare(right.auth_index);
}

function compareKeepPriority(left: AccountItem, right: AccountItem): number {
  const leftAbnormal = isAbnormal(left);
  const rightAbnormal = isAbnormal(right);
  if (leftAbnormal !== rightAbnormal) {
    return leftAbnormal ? 1 : -1;
  }
  const leftExpiredAt = readExpirationTime(left.expired);
  const rightExpiredAt = readExpirationTime(right.expired);
  if (leftExpiredAt !== rightExpiredAt) {
    return rightExpiredAt - leftExpiredAt;
  }
  return left.auth_index.localeCompare(right.auth_index);
}

function buildReason(item: AccountItem, keep: AccountItem): string {
  if (item.auth_index === keep.auth_index) {
    return "保留";
  }
  if (isAbnormal(item)) {
    return "状态异常";
  }
  return "过期更早";
}

function groupByKey(items: AccountItem[], resolveKey: (item: AccountItem) => string): Map<string, AccountItem[]> {
  const grouped = new Map<string, AccountItem[]>();
  for (const item of items) {
    const key = resolveKey(item);
    if (!key) {
      continue;
    }
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function buildGroupsFromMap(grouped: Map<string, AccountItem[]>, keyPrefix: string): KeeperDuplicateGroup[] {
  return Array.from(grouped.entries())
    .filter(([, groupItems]) => groupItems.length > 1)
    .map(([key, groupItems]) => {
      const keep = [...groupItems].sort(compareKeepPriority)[0];
      const entries = [...groupItems].sort(compareDeletePriority).map((item) => ({
        item,
        suggestedDelete: item.auth_index !== keep.auth_index,
        reason: buildReason(item, keep),
      }));
      return {
        key: `${keyPrefix}:${key}`,
        name: key,
        keep,
        items: entries,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function buildKeeperDuplicateGroups(items: AccountItem[]): KeeperDuplicateGroup[] {
  const emailGroups = buildGroupsFromMap(groupByKey(items, (item) => normalizeDuplicateKey(item.email)), "email");
  const emailDuplicateAuthIndexes = new Set(
    emailGroups.flatMap((group) => group.items.map((entry) => entry.item.auth_index)),
  );
  const remainingItems = items.filter((item) => !emailDuplicateAuthIndexes.has(item.auth_index));
  const nameGroups = buildGroupsFromMap(groupByKey(remainingItems, (item) => normalizeName(item.name)), "name");

  return [...emailGroups, ...nameGroups].sort((left, right) => left.name.localeCompare(right.name));
}
