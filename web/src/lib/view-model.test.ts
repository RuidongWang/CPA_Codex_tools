import type { AccountItem } from "../types";
import { buildOverviewStats, cycleSort, sortItems, type SortState } from "./view-model";

function makeAccount(authIndex: string, quotaResetAt: string | null, expired: string | null = null): AccountItem {
  return {
    name: `${authIndex}.json`,
    email: `${authIndex}@example.com`,
    plan_type: "free",
    account_id: `acct-${authIndex}`,
    auth_index: authIndex,
    priority: 99,
    status: "healthy",
    windows: [],
    additional_windows: [],
    error: "",
    last_query_at: null,
    quota_reset_at: quotaResetAt,
    quota_reset_label: quotaResetAt ? quotaResetAt.slice(5, 16).replace("T", " ") : null,
    quota_updated_at: quotaResetAt ? quotaResetAt.slice(5, 16).replace("T", " ") : null,
    expired: expired ?? undefined,
  };
}

describe("buildOverviewStats", () => {
  it("splits exhausted and error into separate buckets", () => {
    const stats = buildOverviewStats([
      {
        name: "a.json",
        email: "a@example.com",
        plan_type: "free",
        account_id: "acct-a",
        auth_index: "idx-a",
        priority: 99,
        status: "healthy",
        windows: [],
        additional_windows: [],
        error: "",
        last_query_at: null,
        quota_updated_at: null,
      },
      {
        name: "b.json",
        email: "b@example.com",
        plan_type: "free",
        account_id: "acct-b",
        auth_index: "idx-b",
        priority: 98,
        status: "exhausted",
        windows: [],
        additional_windows: [],
        error: "",
        last_query_at: null,
        quota_updated_at: null,
      },
      {
        name: "c.json",
        email: "c@example.com",
        plan_type: "free",
        account_id: "acct-c",
        auth_index: "idx-c",
        priority: 97,
        status: "error",
        windows: [],
        additional_windows: [],
        error: "bad request",
        last_query_at: null,
        quota_updated_at: null,
      },
      {
        name: "d.json",
        email: "d@example.com",
        plan_type: "free",
        account_id: "acct-d",
        auth_index: "idx-d",
        priority: 96,
        status: "unknown",
        windows: [],
        additional_windows: [],
        error: "",
        last_query_at: null,
        quota_updated_at: null,
      },
    ]);

    expect(stats.find((item) => item.label === "额度耗尽")?.value).toBe(1);
    expect(stats.find((item) => item.label === "查询异常")?.value).toBe(1);
    expect(stats.find((item) => item.label === "未查询账号")?.value).toBe(1);
  });
});

describe("sortItems", () => {
  it("sorts by quota updated time with empty values at the bottom", () => {
    const items = [
      makeAccount("missing", null),
      makeAccount("later", "2026-05-03T15:30:00+08:00"),
      makeAccount("earlier", "2026-05-03T08:15:00+08:00"),
    ];

    const asc = sortItems(items, { key: "quotaUpdatedAt", direction: "asc" });
    const desc = sortItems(items, { key: "quotaUpdatedAt", direction: "desc" });

    expect(asc.map((item) => item.auth_index)).toEqual(["earlier", "later", "missing"]);
    expect(desc.map((item) => item.auth_index)).toEqual(["later", "earlier", "missing"]);
  });

  it("sorts by certificate expiration time with empty values at the bottom", () => {
    const items = [
      makeAccount("missing", null, null),
      makeAccount("later", null, "2026-05-08T16:45:00+08:00"),
      makeAccount("earlier", null, "2026-05-04T09:15:00+08:00"),
    ];

    const asc = sortItems(items, { key: "expiredAt", direction: "asc" });
    const desc = sortItems(items, { key: "expiredAt", direction: "desc" });

    expect(asc.map((item) => item.auth_index)).toEqual(["earlier", "later", "missing"]);
    expect(desc.map((item) => item.auth_index)).toEqual(["later", "earlier", "missing"]);
  });
});

describe("cycleSort", () => {
  it("cycles quota updated time sorting back to the default state", () => {
    const key: Exclude<SortState["key"], "default"> = "quotaUpdatedAt";

    expect(cycleSort({ key: "default", direction: "none" }, key)).toEqual({ key, direction: "asc" });
    expect(cycleSort({ key, direction: "asc" }, key)).toEqual({ key, direction: "desc" });
    expect(cycleSort({ key, direction: "desc" }, key)).toEqual({ key: "default", direction: "none" });
  });

  it("cycles certificate expiration sorting back to the default state", () => {
    const key: Exclude<SortState["key"], "default"> = "expiredAt";

    expect(cycleSort({ key: "default", direction: "none" }, key)).toEqual({ key, direction: "asc" });
    expect(cycleSort({ key, direction: "asc" }, key)).toEqual({ key, direction: "desc" });
    expect(cycleSort({ key, direction: "desc" }, key)).toEqual({ key: "default", direction: "none" });
  });
});
