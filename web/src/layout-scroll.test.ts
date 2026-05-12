import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function readRuleBlock(pattern: RegExp): string {
  // 直接从样式源码里提取规则块，用最小成本锁住滚动归属回归。
  const match = styles.match(pattern);
  return match?.[1] ?? "";
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
    expect(settingsBackdropBlock).toMatch(/z-index:\s*12/);
  });

  it("keeps the main content table full width without the account detail sidebar", () => {
    const contentBlock = readRuleBlock(/\.stitch-content\s*\{([\s\S]*?)\}/m);

    expect(contentBlock).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(contentBlock).not.toMatch(/360px/);
  });

  it("lets Keeper page panels fill the available workspace width", () => {
    const keeperPanelBlock = readRuleBlock(/\.keeper-page\s+\.keeper-panel\s*\{([\s\S]*?)\}/m);
    const keeperGridPanelBlock = readRuleBlock(/\.keeper-page\s+\.grid-panel\s*\{([\s\S]*?)\}/m);
    const keeperSelectedActionsBlock = readRuleBlock(/\.keeper-selected-actions\s*\{([\s\S]*?)\}/m);

    expect(keeperPanelBlock).toMatch(/width:\s*100%/);
    expect(keeperGridPanelBlock).toMatch(/width:\s*100%/);
    expect(keeperSelectedActionsBlock).toMatch(/width:\s*100%/);
    expect(keeperPanelBlock).not.toMatch(/max-width:\s*1280px/);
    expect(keeperGridPanelBlock).not.toMatch(/max-width:\s*1280px/);
    expect(keeperSelectedActionsBlock).not.toMatch(/max-width:\s*1280px/);
  });

  it("keeps Keeper summary stat cards on one desktop row", () => {
    const keeperStatsBlock = readRuleBlock(/\.keeper-panel__stats\s*\{([\s\S]*?)\}\s*\.keeper-panel__stats span/m);

    expect(keeperStatsBlock).toMatch(/grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
  });

  it("keeps overview metrics as a compact horizontal strip", () => {
    const metricGridBlock = readRuleBlock(/\.metric-grid\s*\{([\s\S]*?)\}\s*\.metric-card/m);
    const metricCardBlock = readRuleBlock(/\.metric-card\s*\{([\s\S]*?)\}\s*button\.metric-card/m);

    expect(metricGridBlock).toMatch(/display:\s*flex/);
    expect(metricGridBlock).toMatch(/overflow-x:\s*auto/);
    expect(metricCardBlock).toMatch(/grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/);
    expect(metricCardBlock).toMatch(/min-height:\s*48px/);
  });

  it("aligns Keeper selected action icons with button text", () => {
    const actionButtonBlock = readRuleBlock(/\.keeper-selected-actions__buttons\s+\.command-button\s*\{([\s\S]*?)\}/m);
    const actionIconBlock = readRuleBlock(/\.keeper-selected-actions__buttons\s+\.material-symbols-outlined\s*\{([\s\S]*?)\}/m);

    expect(actionButtonBlock).toMatch(/display:\s*inline-flex/);
    expect(actionButtonBlock).toMatch(/align-items:\s*center/);
    expect(actionButtonBlock).toMatch(/justify-content:\s*center/);
    expect(actionIconBlock).toMatch(/line-height:\s*1/);
  });
});
