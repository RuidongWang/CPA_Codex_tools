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
  priorityPlanOrder: PriorityPlanKey[];
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
  status: "healthy" | "low" | "exhausted" | "error" | "unknown";
  windows: QuotaWindow[];
  additional_windows: QuotaWindow[];
  error: string;
  timings_ms?: Record<string, number>;
  last_query_at: string | null;
  quota_updated_at: string | null;
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
