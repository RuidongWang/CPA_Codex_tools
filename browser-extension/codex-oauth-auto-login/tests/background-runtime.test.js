const assert = require('node:assert/strict');
const test = require('node:test');

globalThis.CpaCodexOAuthBackgroundCore = require('../background-core.js');
const runtime = require('../background-runtime.js');

function installChromeMock(t, mock) {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = mock;
  t.after(() => {
    globalThis.chrome = previousChrome;
  });
}

test('injects a content script when direct tab messaging is not ready', async (t) => {
  const messages = [];
  const injected = [];
  let messageCalls = 0;
  installChromeMock(t, {
    runtime: {},
    tabs: {
      sendMessage(tabId, message, options, done) {
        messageCalls += 1;
        messages.push({ tabId, message, options });
        if (messageCalls === 1) {
          globalThis.chrome.runtime.lastError = { message: 'Receiving end does not exist.' };
          done();
          globalThis.chrome.runtime.lastError = null;
          return;
        }
        done({ ok: true, result: { ready: true } });
      },
    },
    scripting: {
      async executeScript(details) {
        injected.push(details);
        return [{ result: true }];
      },
    },
  });

  const result = await runtime.sendMessageWithInjectedScript(7, 'content-openai.js', {
    type: 'CPA_OPENAI_AUTH',
    action: 'CLASSIFY',
  }, { frameId: 2 });

  assert.deepEqual(result, { ok: true, result: { ready: true } });
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].options, { frameId: 2 });
  assert.deepEqual(injected, [{
    target: { tabId: 7, frameIds: [2] },
    files: ['content-openai.js'],
  }]);
});

test('clears OpenAI session with browsingData when available', async (t) => {
  let removal = null;
  installChromeMock(t, {
    runtime: {},
    browsingData: {
      remove(options, dataToRemove, done) {
        removal = { options, dataToRemove };
        done();
      },
    },
  });

  const result = await runtime.clearOpenAISession();

  assert.deepEqual(result, { mode: 'browsingData' });
  assert.deepEqual(removal.options.origins, globalThis.CpaCodexOAuthBackgroundCore.OPENAI_CLEAR_ORIGINS);
  assert.equal(removal.dataToRemove.cookies, true);
  assert.equal(removal.dataToRemove.localStorage, true);
});

test('falls back to removing OpenAI cookies when browsingData is unavailable', async (t) => {
  const removed = [];
  installChromeMock(t, {
    runtime: {},
    cookies: {
      getAll(details, done) {
        done(details.url === 'https://auth.openai.com'
          ? [{ name: 'sid', path: '/', storeId: '0' }]
          : []);
      },
      remove(details, done) {
        removed.push(details);
        done({});
      },
    },
  });

  const result = await runtime.clearOpenAISession();

  assert.deepEqual(result, { mode: 'cookies', removed: 1 });
  assert.deepEqual(removed, [{
    url: 'https://auth.openai.com/',
    name: 'sid',
    storeId: '0',
  }]);
});

test('dispatches trusted clicks through the Chrome debugger API', async (t) => {
  const calls = [];
  installChromeMock(t, {
    runtime: {},
    debugger: {
      attach(target, version, done) {
        calls.push({ method: 'attach', target, version });
        done();
      },
      sendCommand(target, method, params, done) {
        calls.push({ method, target, params });
        done();
      },
      detach(target, done) {
        calls.push({ method: 'detach', target });
        done();
      },
    },
  });

  await runtime.dispatchTrustedClick(9, { centerX: 12, centerY: 34 });

  assert.equal(calls[0].method, 'attach');
  assert.deepEqual(calls[0].target, { tabId: 9 });
  assert.equal(calls[1].method, 'Input.dispatchMouseEvent');
  assert.equal(calls[2].params.type, 'mousePressed');
  assert.equal(calls[3].params.type, 'mouseReleased');
  assert.equal(calls[4].method, 'detach');
});
