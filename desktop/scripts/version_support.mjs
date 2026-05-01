import path from "node:path";

const CARGO_VERSION_PATTERN = /^version\s*=\s*"([^"]+)"/m;
const TAURI_VERSION_PATTERN = /"version"\s*:\s*"([^"]+)"/;

export function collectVersionState({
  packageJsonText,
  cargoTomlText,
  tauriConfigText,
  changelogText,
}) {
  const packageVersion = JSON.parse(packageJsonText).version;
  const cargoVersion = cargoTomlText.match(CARGO_VERSION_PATTERN)?.[1] ?? "";
  const tauriVersion = tauriConfigText.match(TAURI_VERSION_PATTERN)?.[1] ?? "";
  const changelogHasCurrentVersion =
    changelogText.includes(`## [${packageVersion}]`) || changelogText.includes(`## ${packageVersion}`);

  return {
    packageVersion,
    cargoVersion,
    tauriVersion,
    changelogHasCurrentVersion,
  };
}

export function replaceCargoVersion(cargoTomlText, nextVersion) {
  if (!CARGO_VERSION_PATTERN.test(cargoTomlText)) {
    throw new Error("未在 Cargo.toml 中找到可替换的 version 字段");
  }
  // Cargo.toml 只替换 [package] 里的版本号，其他依赖声明保持不动。
  return cargoTomlText.replace(CARGO_VERSION_PATTERN, `version = "${nextVersion}"`);
}

export function replaceTauriVersion(tauriConfigText, nextVersion) {
  if (!TAURI_VERSION_PATTERN.test(tauriConfigText)) {
    throw new Error("未在 tauri.conf.json 中找到可替换的 version 字段");
  }
  // Tauri 配置中的产品版本必须与前端展示版本一致，避免打包产物和界面号不同步。
  return tauriConfigText.replace(TAURI_VERSION_PATTERN, `"version": "${nextVersion}"`);
}

export function buildVersionCheckSummary({
  packageVersion,
  cargoVersion,
  tauriVersion,
  changelogHasCurrentVersion,
}) {
  const issues = [];
  if (!packageVersion) {
    issues.push("desktop/package.json 缺少 version 字段。");
  }
  if (cargoVersion !== packageVersion) {
    issues.push(`Cargo.toml 版本为 ${cargoVersion || "空"}，应与 package.json 的 ${packageVersion} 一致。`);
  }
  if (tauriVersion !== packageVersion) {
    issues.push(`tauri.conf.json 版本为 ${tauriVersion || "空"}，应与 package.json 的 ${packageVersion} 一致。`);
  }
  if (!changelogHasCurrentVersion) {
    issues.push(`CHANGELOG.md 缺少 ${packageVersion} 的发布记录。`);
  }
  if (!issues.length) {
    return `版本校验通过：${packageVersion}`;
  }
  return issues.join("\n");
}

export function resolveVersionFiles(projectRoot) {
  return {
    packageJsonPath: path.join(projectRoot, "package.json"),
    cargoTomlPath: path.join(projectRoot, "src-tauri", "Cargo.toml"),
    tauriConfigPath: path.join(projectRoot, "src-tauri", "tauri.conf.json"),
    changelogPath: path.resolve(projectRoot, "..", "CHANGELOG.md"),
  };
}
