// 这些类型对应 Web 端统一 payload，先把 CPA 响应到界面的契约锁住。
export type PriorityPlanKey = "team" | "plus" | "free" | "pro 5x" | "pro 20x" | "unknown";

export interface PriorityPlanPreview {
  key: PriorityPlanKey;
  count: number;
  maxPriority: number | null;
  minPriority: number | null;
}

export interface RuntimeConfig {
  cpaBaseUrl: string;
  managementKey: string;
  queryConcurrency: number;
  keeperSettings: KeeperSettings;
  priorityPlanOrder: PriorityPlanKey[];
}

export interface KeeperSettings {
  quotaThreshold: number;
  expiryThresholdDays: number;
  enableRefresh: boolean;
  workerThreads: number;
}

export interface MetaSummary {
  generated_at: string;
  total: number;
  success: number;
  failed: number;
}

export interface GroupCounts {
  by_plan: Record<string, number>;
  by_status: Record<string, number>;
}

export interface QuotaWindow {
  id: string;
  label: string;
  used_percent: number | null;
  remaining_percent: number | null;
  reset_at?: string | null;
  reset_label: string;
  exhausted: boolean;
}

export interface AccountItem {
  name: string;
  email: string;
  plan_type: string;
  account_id: string;
  auth_index: string;
  priority: number | null;
  // 远端原值和本地草稿会并存，方便界面显示未同步态。
  remote_priority?: number | null;
  draft_priority?: number | null;
  dirty_priority?: boolean;
  disabled?: boolean;
  expired?: string;
  has_refresh_token?: boolean;
  status: "healthy" | "low" | "exhausted" | "error" | "unknown";
  windows: QuotaWindow[];
  additional_windows: QuotaWindow[];
  error: string;
  timings_ms?: Record<string, number>;
  last_query_at: string | null;
  quota_reset_at?: string | null;
  quota_reset_label?: string | null;
  // Deprecated compatibility field for older browser caches. New code should use quota_reset_*.
  quota_updated_at: string | null;
}

export type KeeperAction = "none" | "delete" | "disable" | "enable" | "refresh" | "refresh-candidate" | "skip" | "error";
export type KeeperDirectAction = "disable" | "refresh" | "delete";
export type KeeperOutcome = "alive" | "dead" | "skipped" | "network_error" | "error";

export interface KeeperItemReport {
  name: string;
  email: string;
  auth_index: string;
  plan_type: string;
  disabled: boolean | null;
  expired: string;
  remaining_label: string;
  has_refresh_token: boolean;
  primary_label: string;
  primary_used_percent: number | null;
  secondary_label: string;
  secondary_used_percent: number | null;
  action: KeeperAction;
  outcome: KeeperOutcome;
  applied: boolean;
  refresh_candidate: boolean;
  refreshed: boolean;
  reason: string;
}

export interface KeeperRunSummary {
  generated_at: string;
  dry_run: boolean;
  total: number;
  alive: number;
  dead: number;
  disabled: number;
  enabled: number;
  refreshed: number;
  refresh_candidates: number;
  skipped: number;
  network_error: number;
  errors: number;
}

export interface KeeperRunResult {
  summary: KeeperRunSummary;
  items: KeeperItemReport[];
}

export interface PayloadEnvelope {
  meta: MetaSummary;
  groups: GroupCounts;
  items: AccountItem[];
  error: string;
}

export interface QueryProgressEvent {
  requestId: string;
  completed: number;
  total: number;
  currentLabel: string;
  authIndex: string;
  status: string;
  timingsMs: Record<string, number>;
}

// 浏览器下载结果只回传前端真正关心的文件名和下载标识。
export interface DownloadedAccountConfig {
  name: string;
  destinationPath: string;
}
