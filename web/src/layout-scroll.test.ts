import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function readRuleBlock(pattern: RegExp): string {
  // 直接从样式源码里提取规则块，用最小成本锁住滚动归属回归。
  const match = styles.match(pattern);
  return match?.[1] ?? "";
}

function readRuleBlocks(pattern: RegExp): string[] {
  return Array.from(styles.matchAll(pattern)).map((match) => match[1] ?? "");
}

describe("layout scroll contract", () => {
  it("keeps page scroll locked and delegates overflow to the account list panel", () => {
    const rootBlock = readRuleBlock(/html,\s*body,\s*#root\s*\{([\s\S]*?)\}/m);
    const shellBlock = readRuleBlock(/\.stitch-shell\s*\{([\s\S]*?)\}/m);
    const mainBlock = readRuleBlock(/\.stitch-main\s*\{([\s\S]*?)\}/m);
    const commandBarBlock = readRuleBlock(/\.command-bar\s*\{([\s\S]*?)\}/m);
    const progressBlock = readRuleBlock(/\.scan-progress\s*\{([\s\S]*?)\}/m);
    const progressClosingBlock = readRuleBlock(/\.scan-progress--closing\s*\{([\s\S]*?)\}/m);
    const progressFillBlock = readRuleBlock(/\.scan-progress__fill\s*\{([\s\S]*?)\}/m);
    const contentBlock = readRuleBlock(/\.stitch-content\s*\{([\s\S]*?)\}/m);
    const gridPanelBlock = readRuleBlock(/\.grid-panel\s*\{([\s\S]*?)\}/m);
    const gridPanelBodyBlock = readRuleBlock(/\.grid-panel__body\s*\{([\s\S]*?)\}/m);
    const detailPanelBlocks = readRuleBlocks(/\.detail-panel\s*\{([\s\S]*?)\}/gm);
    const settingsBackdropBlock = readRuleBlock(/\.settings-dialog__backdrop\s*\{([\s\S]*?)\}/m);

    expect(rootBlock).toMatch(/height:\s*100%/);
    expect(rootBlock).toMatch(/overflow:\s*hidden/);
    expect(shellBlock).toMatch(/height:\s*100vh/);
    expect(shellBlock).toMatch(/overflow:\s*hidden/);
    expect(mainBlock).toMatch(/min-height:\s*0/);
    expect(mainBlock).toMatch(/position:\s*relative/);
    expect(commandBarBlock).toMatch(/position:\s*relative/);
    expect(styles).not.toMatch(/\.command-bar--with-progress\s*\{/);
    expect(styles).not.toMatch(/\.command-bar__progress-slot\s*\{/);
    expect(progressBlock).toMatch(/position:\s*absolute/);
    expect(progressBlock).toMatch(/pointer-events:\s*none/);
    expect(progressBlock).toMatch(/transition:/);
    // 备份和同步会短时间内连续跳步，进度填充条需要独立宽度过渡才看得见变化。
    expect(progressFillBlock).toMatch(/transition:\s*width/);
    expect(progressClosingBlock).toMatch(/opacity:\s*0/);
    expect(contentBlock).toMatch(/overflow:\s*hidden/);
    expect(gridPanelBlock).toMatch(/overflow:\s*hidden/);
    expect(gridPanelBodyBlock).toMatch(/overflow:\s*auto/);
    expect(detailPanelBlocks.some((block) => /overflow:\s*auto/.test(block))).toBe(true);
    expect(settingsBackdropBlock).toMatch(/z-index:\s*12/);
  });

  it("keeps the main content table-first with a narrower fixed detail rail", () => {
    const contentBlock = readRuleBlock(/\.stitch-content\s*\{([\s\S]*?)\}/m);

    expect(contentBlock).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+248px/);
  });
});
