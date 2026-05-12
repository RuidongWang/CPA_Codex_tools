const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const manifestPath = path.resolve(__dirname, '..', 'manifest.json');
const backgroundPath = path.resolve(__dirname, '..', 'background.js');
const sidepanelHtmlPath = path.resolve(__dirname, '..', 'sidepanel.html');
const sidepanelCssPath = path.resolve(__dirname, '..', 'sidepanel.css');

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

test('manifest is MV3 with expected scripts and side panel', () => {
  const manifest = readManifest();

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.ok(manifest.content_scripts.some((script) => script.js.includes('content-cpa.js')));
  assert.ok(manifest.content_scripts.some((script) => script.js.includes('content-openai.js')));
});

test('background imports shared helper scripts in startup order', () => {
  const source = fs.readFileSync(backgroundPath, 'utf8');

  assert.match(source, /importScripts\('background-core\.js', 'background-batch-core\.js', 'background-flow-utils\.js', 'background-platform-settings\.js', 'background-runtime\.js'\)/);
});

test('platform password eye icon matches visibility state', () => {
  const html = fs.readFileSync(sidepanelHtmlPath, 'utf8');
  const css = fs.readFileSync(sidepanelCssPath, 'utf8');

  assert.match(html, /id="platform-password" type="password"/);
  assert.match(html, /id="platform-password-toggle"[^>]+aria-pressed="false"/);
  assert.match(css, /\.password-toggle__slash\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /\.password-toggle\[aria-pressed="true"\] \.password-toggle__slash\s*\{\s*display:\s*block;\s*\}/);
});

test('manifest permissions are limited to required extension capabilities', () => {
  const manifest = readManifest();
  assert.deepEqual([...manifest.permissions].sort(), [
    'activeTab',
    'browsingData',
    'cookies',
    'debugger',
    'scripting',
    'sidePanel',
    'storage',
    'tabs',
    'webNavigation',
  ]);
});

test('manifest host permissions are narrow local app and OpenAI auth hosts', () => {
  const manifest = readManifest();
  assert.deepEqual([...manifest.host_permissions].sort(), [
    'http://127.0.0.1/*',
    'http://localhost/*',
    'https://accounts.openai.com/*',
    'https://auth.openai.com/*',
    'https://auth0.openai.com/*',
    'https://chat.openai.com/*',
    'https://chatgpt.com/*',
    'https://openai.com/*',
    'https://platform.openai.com/*',
  ]);
  assert.equal(manifest.host_permissions.includes('<all_urls>'), false);
});

test('manifest requests remote CPA platform hosts only as optional permissions', () => {
  const manifest = readManifest();
  assert.deepEqual([...manifest.optional_host_permissions].sort(), [
    'http://*/*',
    'https://*/*',
  ]);
});

test('manifest content scripts match only local app and OpenAI auth hosts', () => {
  const manifest = readManifest();
  const allMatches = manifest.content_scripts.flatMap((script) => script.matches).sort();

  assert.deepEqual(allMatches, [
    'http://127.0.0.1/*',
    'http://localhost/*',
    'https://accounts.openai.com/*',
    'https://auth.openai.com/*',
    'https://auth0.openai.com/*',
  ]);
});
