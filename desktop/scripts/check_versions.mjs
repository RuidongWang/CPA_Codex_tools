import fs from "node:fs/promises";
import process from "node:process";
import { buildVersionCheckSummary, collectVersionState, resolveVersionFiles } from "./version_support.mjs";

async function main() {
  const projectRoot = process.cwd();
  const { packageJsonPath, cargoTomlPath, tauriConfigPath, changelogPath } = resolveVersionFiles(projectRoot);

  const [packageJsonText, cargoTomlText, tauriConfigText, changelogText] = await Promise.all([
    fs.readFile(packageJsonPath, "utf8"),
    fs.readFile(cargoTomlPath, "utf8"),
    fs.readFile(tauriConfigPath, "utf8"),
    fs.readFile(changelogPath, "utf8"),
  ]);

  const summary = buildVersionCheckSummary(
    collectVersionState({
      packageJsonText,
      cargoTomlText,
      tauriConfigText,
      changelogText,
    }),
  );

  const passed = summary.startsWith("版本校验通过");
  const logMethod = passed ? console.log : console.error;
  logMethod(summary);
  if (!passed) {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
