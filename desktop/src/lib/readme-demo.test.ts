import { describe, expect, it } from "vitest";
import {
  isReadmeDemoMode,
  README_DEMO_CONFIG,
  README_DEMO_PAYLOAD,
} from "./readme-demo";

describe("readme demo fixture", () => {
  it("仅在 demo=readme 时开启 README 演示模式", () => {
    expect(isReadmeDemoMode("?demo=readme")).toBe(true);
    expect(isReadmeDemoMode("?demo=other")).toBe(false);
    expect(isReadmeDemoMode("")).toBe(false);
  });

  it("使用虚构配置和虚构账号数据", () => {
    expect(README_DEMO_CONFIG.cpaBaseUrl).toBe("https://demo-cpa.example/");
    expect(README_DEMO_CONFIG.managementKey).toBe("demo-management-key");
    expect(README_DEMO_PAYLOAD.items).toHaveLength(6);
    expect(README_DEMO_PAYLOAD.items.every((item) => item.email.includes("@example.com"))).toBe(true);
    expect(README_DEMO_PAYLOAD.groups.by_status.error).toBe(1);
  });
});
