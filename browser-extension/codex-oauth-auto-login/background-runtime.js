(function attachCpaCodexOAuthBackgroundRuntime(root, factory) {
  const api = factory(root.CpaCodexOAuthBackgroundCore);
  root.CpaCodexOAuthBackgroundRuntime = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createBackgroundRuntime(core = {}) {
  function getChrome() {
    return typeof chrome !== 'undefined' ? chrome : null;
  }

  function chromeCallback(call) {
    return new Promise((resolve, reject) => {
      try {
        call((result) => {
          const lastError = getChrome()?.runtime?.lastError;
          if (lastError) {
            reject(new Error(lastError.message));
            return;
          }
          resolve(result);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function createRuntimeError(errorType, code, message) {
    const error = new Error(message || code || errorType || 'runtime_error');
    error.errorType = errorType;
    error.code = code || errorType || 'runtime_error';
    return error;
  }

  function queryTabs(queryInfo) {
    return chromeCallback((done) => chrome.tabs.query(queryInfo, done));
  }

  function getTab(tabId) {
    return chromeCallback((done) => chrome.tabs.get(tabId, done));
  }

  function createTab(createProperties) {
    return chromeCallback((done) => chrome.tabs.create(createProperties, done));
  }

  function removeTab(tabId) {
    if (!tabId) {
      return Promise.resolve();
    }
    return chromeCallback((done) => chrome.tabs.remove(tabId, done)).catch(() => null);
  }

  function sendTabMessage(tabId, message, options = {}) {
    return chromeCallback((done) => chrome.tabs.sendMessage(tabId, message, options, done));
  }

  function getAllFrames(tabId) {
    return chromeCallback((done) => chrome.webNavigation.getAllFrames({ tabId }, done));
  }

  async function ensureScript(tabId, file, frameId = 0) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: [file] });
    } catch {
      // The script may already be injected or the page may be temporarily unavailable.
    }
  }

  async function sendMessageWithInjectedScript(tabId, file, message, options = {}) {
    const frameId = Number.isInteger(options.frameId) ? options.frameId : 0;
    try {
      return await sendTabMessage(tabId, message, { frameId });
    } catch {
      await ensureScript(tabId, file, frameId);
      return sendTabMessage(tabId, message, { frameId });
    }
  }

  function getDebuggerTarget(tabId) {
    return { tabId };
  }

  function attachDebugger(tabId) {
    if (!chrome.debugger?.attach) {
      throw createRuntimeError('retryable', 'debugger_unavailable', 'Chrome debugger API is not available for trusted OpenAI clicks.');
    }
    const target = getDebuggerTarget(tabId);
    return chromeCallback((done) => chrome.debugger.attach(target, '1.3', done));
  }

  function detachDebugger(tabId) {
    if (!chrome.debugger?.detach) {
      return Promise.resolve();
    }
    return chromeCallback((done) => chrome.debugger.detach(getDebuggerTarget(tabId), done));
  }

  function sendDebuggerCommand(tabId, method, params = {}) {
    if (!chrome.debugger?.sendCommand) {
      throw createRuntimeError('retryable', 'debugger_unavailable', 'Chrome debugger API is not available for trusted OpenAI clicks.');
    }
    return chromeCallback((done) => chrome.debugger.sendCommand(getDebuggerTarget(tabId), method, params, done));
  }

  async function dispatchTrustedClick(tabId, rect) {
    await attachDebugger(tabId);
    try {
      for (const event of core.buildTrustedClickMouseEvents(rect)) {
        await sendDebuggerCommand(tabId, event.method, event.params);
      }
    } finally {
      await detachDebugger(tabId).catch(() => null);
    }
  }

  async function clearOpenAICookiesFallback() {
    if (!chrome.cookies?.getAll || !chrome.cookies?.remove) {
      return { removed: 0 };
    }

    let removed = 0;
    for (const origin of core.OPENAI_CLEAR_ORIGINS) {
      const cookies = await chromeCallback((done) => chrome.cookies.getAll({ url: origin }, done)).catch(() => []);
      for (const cookie of cookies || []) {
        const path = String(cookie.path || '/').startsWith('/') ? cookie.path : `/${cookie.path}`;
        const details = {
          url: `${origin}${path}`,
          name: cookie.name,
        };
        if (cookie.storeId) {
          details.storeId = cookie.storeId;
        }
        await chromeCallback((done) => chrome.cookies.remove(details, done)).catch(() => null);
        removed += 1;
      }
    }
    return { removed };
  }

  async function clearOpenAISession() {
    const removalOptions = core.buildOpenAISessionRemovalOptions();
    if (chrome.browsingData?.remove) {
      await chromeCallback((done) => chrome.browsingData.remove(
        removalOptions.options,
        removalOptions.dataToRemove,
        done
      ));
      return { mode: 'browsingData' };
    }

    const fallback = await clearOpenAICookiesFallback();
    return { mode: 'cookies', ...fallback };
  }

  return {
    attachDebugger,
    chromeCallback,
    clearOpenAICookiesFallback,
    clearOpenAISession,
    createTab,
    detachDebugger,
    dispatchTrustedClick,
    ensureScript,
    getAllFrames,
    getTab,
    queryTabs,
    removeTab,
    sendDebuggerCommand,
    sendMessageWithInjectedScript,
    sendTabMessage,
  };
});
