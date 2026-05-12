const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const manifestPath = path.resolve(__dirname, '..', 'manifest.json');

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
