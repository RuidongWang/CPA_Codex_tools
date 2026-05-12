#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function generateSecret() {
  return randomBytes(32).toString("base64url");
}

async function readOrCreateSecret(sourcePath) {
  try {
    const existing = (await readFile(sourcePath, "utf8")).trim();
    if (existing) {
      return existing;
    }
  } catch {
    // Missing files are created below.
  }

  const secret = generateSecret();
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, `${secret}\n`, { mode: 0o600 });
  await chmod(sourcePath, 0o600).catch(() => undefined);
  return secret;
}

function buildRuntimeScript(secret) {
  return [
    "window.__CPA_CODEX_VAULT_SECRET__ = ",
    JSON.stringify(secret),
    ";\n",
  ].join("");
}

const sourcePath = resolve(readArg("source", process.env.CPA_CODEX_VAULT_SECRET_FILE || ".runtime/vault-secret"));
const outputPath = resolve(readArg("output", process.env.CPA_CODEX_RUNTIME_SECRET_OUTPUT || "dist/runtime-secret.js"));
const secret = await readOrCreateSecret(sourcePath);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, buildRuntimeScript(secret), { mode: 0o644 });
