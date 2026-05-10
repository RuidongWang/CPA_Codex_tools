import { describe, expect, it } from "vitest";
import { buildKeeperDuplicateGroups } from "./keeper-duplicates";
import type { AccountItem } from "../types";

function item(overrides: Partial<AccountItem>): AccountItem {
  return {
    name: "codex.json",
    email: "demo@example.com",
    plan_type: "free",
    account_id: "acct",
    auth_index: "idx",
    priority: null,
    status: "healthy",
    windows: [],
    additional_windows: [],
    error: "",
    last_query_at: null,
    quota_updated_at: null,
    ...overrides,
  };
}

describe("keeper duplicate auth files", () => {
  it("groups duplicated accounts by case-insensitive email before falling back to file name", () => {
    const groups = buildKeeperDuplicateGroups([
      item({
        name: "codex-brady-free.json",
        email: "BradyBroughman59320@outlook.com",
        auth_index: "idx-keep",
        status: "healthy",
        expired: "2026-05-20T00:00:00Z",
      }),
      item({
        name: "codex-brady-unknown.json",
        email: "bradybroughman59320@outlook.com",
        auth_index: "idx-delete-error",
        status: "error",
        expired: "2026-05-16T00:00:00Z",
      }),
      item({
        name: "codex-unique.json",
        email: "unique@example.com",
        auth_index: "idx-unique",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("bradybroughman59320@outlook.com");
    expect(groups[0].keep.auth_index).toBe("idx-keep");
    expect(groups[0].items.filter((entry) => entry.suggestedDelete).map((entry) => entry.item.auth_index)).toEqual(["idx-delete-error"]);
  });

  it("groups auth files by case-insensitive name and suggests deleting abnormal or earlier-expired duplicates", () => {
    const groups = buildKeeperDuplicateGroups([
      item({
        name: "Codex-Free.JSON",
        email: "healthy-late@example.com",
        auth_index: "idx-keep",
        status: "healthy",
        expired: "2026-05-12T00:00:00Z",
      }),
      item({
        name: "codex-free.json",
        email: "error-late@example.com",
        auth_index: "idx-error",
        status: "error",
        expired: "2026-05-20T00:00:00Z",
      }),
      item({
        name: "CODEX-FREE.json",
        email: "healthy-early@example.com",
        auth_index: "idx-early",
        status: "healthy",
        expired: "2026-05-08T00:00:00Z",
      }),
      item({
        name: "codex-plus.json",
        email: "unique@example.com",
        auth_index: "idx-unique",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("codex-free.json");
    expect(groups[0].keep.auth_index).toBe("idx-keep");
    expect(groups[0].items.map((entry) => entry.item.auth_index)).toEqual(["idx-error", "idx-early", "idx-keep"]);
    expect(groups[0].items.filter((entry) => entry.suggestedDelete).map((entry) => entry.item.auth_index)).toEqual(["idx-error", "idx-early"]);
    expect(groups[0].items.find((entry) => entry.item.auth_index === "idx-error")?.reason).toBe("状态异常");
    expect(groups[0].items.find((entry) => entry.item.auth_index === "idx-early")?.reason).toBe("过期更早");
  });

  it("treats missing or invalid expiration as earlier when choosing duplicate delete candidates", () => {
    const groups = buildKeeperDuplicateGroups([
      item({
        name: "same.json",
        email: "late@example.com",
        auth_index: "idx-late",
        expired: "2026-05-12T00:00:00Z",
      }),
      item({
        name: "SAME.json",
        email: "missing@example.com",
        auth_index: "idx-missing",
        expired: "",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].keep.auth_index).toBe("idx-late");
    expect(groups[0].items.filter((entry) => entry.suggestedDelete).map((entry) => entry.item.auth_index)).toEqual(["idx-missing"]);
  });
});
