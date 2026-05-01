import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const releaseRoot = path.join(desktopRoot, "src-tauri", "target", "release");
const portableRoot = path.join(desktopRoot, "build", "portable");

async function assertFile(filePath, label) {
  // 发布脚本先校验输入文件，避免产出一个缺关键资源的半成品目录。
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    throw new Error(`缺少${label}: ${filePath}`);
  }
}

async function main() {
  const releaseExe = path.join(releaseRoot, "cpa-quota-desk.exe");
  const targetExe = path.join(portableRoot, "Codex Quota Desk.exe");

  await assertFile(releaseExe, "Tauri release exe");

  // portableRoot 位于 desktop/build 下，属于可再生产物，可安全重建。
  await rm(portableRoot, { recursive: true, force: true });
  await mkdir(portableRoot, { recursive: true });

  await cp(releaseExe, targetExe);

  console.log(`已生成 portable 目录: ${portableRoot}`);
  console.log(`直接运行: ${targetExe}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
