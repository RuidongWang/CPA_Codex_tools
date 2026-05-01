// 版本同步和校验脚本需要有独立回归，避免 package、Tauri 和 Cargo 三处版本再跑偏。
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildVersionCheckSummary,
  collectVersionState,
  replaceCargoVersion,
  replaceTauriVersion,
} from "./version_support.mjs";

test("replaceCargoVersion 会只替换 Cargo.toml 的版本号", () => {
  const source = `[package]
name = "cpa-quota-desk"
version = "0.1.0"
edition = "2021"
`;

  const updated = replaceCargoVersion(source, "0.2.0");

  assert.match(updated, /version = "0.2.0"/);
  assert.doesNotMatch(updated, /version = "0.1.0"/);
});

test("replaceTauriVersion 会只替换 tauri.conf.json 的版本字段", () => {
  const source = `{
  "productName": "Codex Quota Desk",
  "version": "0.1.0"
}
`;

  const updated = replaceTauriVersion(source, "0.2.0");

  assert.match(updated, /"version": "0.2.0"/);
  assert.doesNotMatch(updated, /"version": "0.1.0"/);
});

test("collectVersionState 会汇总 package、Cargo、Tauri 和 CHANGELOG 的版本状态", () => {
  const state = collectVersionState({
    packageJsonText: `{"version":"0.2.0"}`,
    cargoTomlText: `[package]\nversion = "0.2.0"\n`,
    tauriConfigText: `{"version":"0.2.0"}`,
    changelogText: "# Changelog\n\n## [0.2.0] - 2026-05-01\n",
  });

  assert.equal(state.packageVersion, "0.2.0");
  assert.equal(state.cargoVersion, "0.2.0");
  assert.equal(state.tauriVersion, "0.2.0");
  assert.equal(state.changelogHasCurrentVersion, true);
});

test("buildVersionCheckSummary 会在版本不一致时给出清晰提示", () => {
  const summary = buildVersionCheckSummary({
    packageVersion: "0.2.0",
    cargoVersion: "0.1.0",
    tauriVersion: "0.2.0",
    changelogHasCurrentVersion: false,
  });

  assert.match(summary, /Cargo\.toml/);
  assert.match(summary, /CHANGELOG/);
  assert.match(summary, /0.2.0/);
});
