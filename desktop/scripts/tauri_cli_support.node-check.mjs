// 这里先锁定桌面端 CLI 的安装边界，避免根目录脚本再误依赖 Web 侧 node_modules。
import test from "node:test";
import assert from "node:assert/strict";
import { resolveTauriCliEntry, buildTauriCliInstallHint } from "./tauri_cli_support.mjs";

test("resolveTauriCliEntry 返回 src-tauri 下的本地 CLI 入口", () => {
  const projectRoot = "D:\\work\\cpa\\desktop";
  const entryPath = resolveTauriCliEntry(projectRoot);

  assert.equal(
    entryPath,
    "D:\\work\\cpa\\desktop\\src-tauri\\node_modules\\@tauri-apps\\cli\\tauri.js",
  );
});

test("buildTauriCliInstallHint 提示用户安装 src-tauri 的依赖", () => {
  const projectRoot = "D:\\work\\cpa\\desktop";
  const hint = buildTauriCliInstallHint(projectRoot);

  assert.match(hint, /src-tauri/);
  assert.match(hint, /npm install --prefix/);
});
