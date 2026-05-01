import path from "node:path";
import fs from "node:fs";

// Tauri CLI 只属于桌面端壳层，这里统一维护它在仓库中的固定位置。
const TAURI_CLI_RELATIVE_ENTRY = path.join(
  "src-tauri",
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);

export function resolveTauriCliEntry(projectRoot) {
  return path.join(projectRoot, TAURI_CLI_RELATIVE_ENTRY);
}

export function buildTauriCliInstallHint(projectRoot) {
  const tauriRoot = path.join(projectRoot, "src-tauri");
  return `未找到桌面端 Tauri CLI。请先执行 npm install --prefix .\\src-tauri，或进入 ${tauriRoot} 后执行 npm install。`;
}

export function ensureTauriCliEntry(projectRoot) {
  const entryPath = resolveTauriCliEntry(projectRoot);
  if (!fs.existsSync(entryPath)) {
    throw new Error(buildTauriCliInstallHint(projectRoot));
  }
  return entryPath;
}
