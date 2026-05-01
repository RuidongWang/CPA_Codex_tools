import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ensureTauriCliEntry } from "./tauri_cli_support.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// Tauri CLI 需要在前端工程根目录启动，才能正确解析 src-tauri 配置和前端资源。
const projectRoot = path.resolve(scriptDir, "..");

let cliEntry;
try {
  cliEntry = ensureTauriCliEntry(projectRoot);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const child = spawn(process.execPath, [cliEntry, ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  console.error(`启动桌面端 Tauri CLI 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
