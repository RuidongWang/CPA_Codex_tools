import fs from "node:fs/promises";
import process from "node:process";
import { replaceCargoVersion, replaceTauriVersion, resolveVersionFiles } from "./version_support.mjs";

async function main() {
  const projectRoot = process.cwd();
  const { packageJsonPath, cargoTomlPath, tauriConfigPath } = resolveVersionFiles(projectRoot);

  const packageJsonText = await fs.readFile(packageJsonPath, "utf8");
  const nextVersion = JSON.parse(packageJsonText).version;
  const [cargoTomlText, tauriConfigText] = await Promise.all([
    fs.readFile(cargoTomlPath, "utf8"),
    fs.readFile(tauriConfigPath, "utf8"),
  ]);

  const nextCargoText = replaceCargoVersion(cargoTomlText, nextVersion);
  const nextTauriText = replaceTauriVersion(tauriConfigText, nextVersion);

  await Promise.all([
    fs.writeFile(cargoTomlPath, nextCargoText, "utf8"),
    fs.writeFile(tauriConfigPath, nextTauriText, "utf8"),
  ]);

  // 同步脚本只负责把同一版本号铺到桌面端清单里，变更说明仍由 CHANGELOG 手工维护。
  console.log(`已同步桌面端版本到 ${nextVersion}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
