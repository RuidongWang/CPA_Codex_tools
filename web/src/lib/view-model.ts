import type { AccountItem, PayloadEnvelope } from "../types";

export interface FilterState {
  plan: string;
  status: string;
  query: string;
}

export interface OverviewStat {
  key: string;
  label: string;
  value: number;
  tone: "neutral" | "healthy" | "warning" | "danger";
  icon: string;
  statusFilter: string;
}

export interface PlanNavItem {
  key: string;
  label: string;
  icon: string;
}

export type SortKey = "default" | "email" | "plan" | "status" | "priority" | "quota5h" | "quota7d" | "quotaUpdatedAt" | "expiredAt" | "updatedAt";
export type SortDirection = "none" | "asc" | "desc";

export interface SortState {
  key: SortKey;
  direction: SortDirection;
}

// Stitch 重搭后的左侧导航只保留真实计划分组，避免把演示稿里的无关入口接进业务筛选。
export const PLAN_NAV_ITEMS: PlanNavItem[] = [
  { key: "all", label: "全部", icon: "apps" },
  { key: "free", label: "free", icon: "person" },
  { key: "plus", label: "plus", icon: "add_circle" },
  { key: "team", label: "team", icon: "groups" },
  { key: "pro 5x", label: "Pro 5x", icon: "bolt" },
  { key: "pro 20x", label: "Pro 20x", icon: "rocket_launch" },
  { key: "unknown", label: "未知", icon: "help" },
];

function countBy(items: AccountItem[], pick: (item: AccountItem) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((result, item) => {
    const key = pick(item) || "unknown";
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
}

// 过滤逻辑收在纯函数里，组件层只处理交互和显示。
export function filterItems(items: AccountItem[], filters: FilterState): AccountItem[] {
  const keyword = filters.query.trim().toLowerCase();
  return items.filter((item) => {
    const matchesPlan = filters.plan === "all" || item.plan_type === filters.plan;
    const matchesStatus = filters.status === "all" || item.status === filters.status;
    const matchesQuery =
      !keyword ||
      item.name.toLowerCase().includes(keyword) ||
      item.email.toLowerCase().includes(keyword) ||
      item.auth_index.toLowerCase().includes(keyword);
    return matchesPlan && matchesStatus && matchesQuery;
  });
}

export function buildOverviewStats(items: AccountItem[]): OverviewStat[] {
  const healthy = items.filter((item) => item.status === "healthy").length;
  const low = items.filter((item) => item.status === "low").length;
  const exhausted = items.filter((item) => item.status === "exhausted").length;
  const errors = items.filter((item) => item.status === "error").length;
  return [
    { key: "all", label: "账号总数", value: items.length, tone: "neutral", icon: "database", statusFilter: "all" },
    { key: "healthy", label: "状态正常", value: healthy, tone: "healthy", icon: "check_circle", statusFilter: "healthy" },
    { key: "low", label: "额度偏低", value: low, tone: "warning", icon: "warning", statusFilter: "low" },
    { key: "exhausted", label: "额度耗尽", value: exhausted, tone: "danger", icon: "hourglass_disabled", statusFilter: "exhausted" },
    { key: "error", label: "查询异常", value: errors, tone: "danger", icon: "error", statusFilter: "error" },
  ];
}

export function buildPlanCounts(items: AccountItem[]): Record<string, number> {
  return countBy(items, (item) => item.plan_type);
}

export function buildStatusCounts(items: AccountItem[]): Record<string, number> {
  return countBy(items, (item) => item.status);
}

export function cycleSort(current: SortState, key: Exclude<SortKey, "default">): SortState {
  if (current.key !== key) {
    return { key, direction: "asc" };
  }
  if (current.direction === "asc") {
    return { key, direction: "desc" };
  }
  return { key: "default", direction: "none" };
}

function compareText(left: string, right: string, direction: SortDirection): number {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  const result = normalizedLeft.localeCompare(normalizedRight, "zh-CN");
  return direction === "asc" ? result : -result;
}

function readStatusRank(status: AccountItem["status"]): number {
  if (status === "healthy") {
    return 0;
  }
  if (status === "low") {
    return 1;
  }
  if (status === "exhausted") {
    return 2;
  }
  if (status === "error") {
    return 3;
  }
  return 4;
}

function readQuotaRemaining(item: AccountItem, id: string): number | null {
  const matched = item.windows.find((window) => window.id === id);
  return matched?.remaining_percent ?? null;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function readUpdatedAt(item: AccountItem): number | null {
  return parseTimestamp(item.last_query_at);
}

function readQuotaUpdatedAt(item: AccountItem): number | null {
  return parseTimestamp(item.quota_updated_at ?? null);
}

function readExpiredAt(item: AccountItem): number | null {
  return parseTimestamp(item.expired ?? null);
}

function compareNullableNumber(left: number | null, right: number | null, direction: SortDirection): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return direction === "asc" ? left - right : right - left;
}

export function sortItems(items: AccountItem[], sort: SortState): AccountItem[] {
  if (sort.direction === "none" || sort.key === "default") {
    return items;
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      let result = 0;
      if (sort.key === "email") {
        result = compareText(left.item.email, right.item.email, sort.direction);
      } else if (sort.key === "plan") {
        result = compareText(left.item.plan_type, right.item.plan_type, sort.direction);
      } else if (sort.key === "status") {
        result = compareNullableNumber(readStatusRank(left.item.status), readStatusRank(right.item.status), sort.direction);
      } else if (sort.key === "priority") {
        result = compareNullableNumber(left.item.priority, right.item.priority, sort.direction);
      } else if (sort.key === "quota5h") {
        result = compareNullableNumber(readQuotaRemaining(left.item, "code-5h"), readQuotaRemaining(right.item, "code-5h"), sort.direction);
      } else if (sort.key === "quota7d") {
        result = compareNullableNumber(readQuotaRemaining(left.item, "code-7d"), readQuotaRemaining(right.item, "code-7d"), sort.direction);
      } else if (sort.key === "quotaUpdatedAt") {
        result = compareNullableNumber(readQuotaUpdatedAt(left.item), readQuotaUpdatedAt(right.item), sort.direction);
      } else if (sort.key === "expiredAt") {
        result = compareNullableNumber(readExpiredAt(left.item), readExpiredAt(right.item), sort.direction);
      } else if (sort.key === "updatedAt") {
        result = compareNullableNumber(readUpdatedAt(left.item), readUpdatedAt(right.item), sort.direction);
      }
      // 主排序相等时回退到原始顺序，避免筛选后的列表在同值场景里跳动。
      return result || left.index - right.index;
    })
    .map(({ item }) => item);
}

export function mergePayload(current: PayloadEnvelope | null, patch: PayloadEnvelope): PayloadEnvelope {
  if (!current) {
    return patch;
  }
  const merged = [...current.items];
  for (const item of patch.items) {
    const index = merged.findIndex((candidate) => candidate.auth_index === item.auth_index);
    if (index >= 0) {
      merged[index] = item;
    } else {
      merged.push(item);
    }
  }
  const failed = merged.filter((item) => item.status === "error").length;
  const success = merged.filter((item) => item.status !== "unknown" && item.status !== "error").length;
  return {
    meta: {
      generated_at: patch.meta.generated_at,
      total: merged.length,
      success,
      failed,
    },
    groups: {
      by_plan: buildPlanCounts(merged),
      by_status: buildStatusCounts(merged),
    },
    items: merged,
    error: patch.error,
  };
}
