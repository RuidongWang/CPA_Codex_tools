import { buildOverviewStats } from "./view-model";

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
      },
    ]);

    expect(stats.find((item) => item.label === "额度耗尽")?.value).toBe(1);
    expect(stats.find((item) => item.label === "查询异常")?.value).toBe(1);
  });
});
