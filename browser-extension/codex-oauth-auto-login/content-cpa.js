(function attachCpaCodexOAuthPageBridge(root, factory) {
  const api = factory(root);
  root.CpaCodexOAuthPageBridge = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createPageBridge(root) {
  const REQUEST_SOURCE = 'cpa-codex-oauth-extension';
  const RESPONSE_SOURCE = 'cpa-codex-oauth-page';
  const REQUEST_TYPE = 'CPA_OAUTH_BRIDGE_REQUEST';
  const RESPONSE_TYPE = 'CPA_OAUTH_BRIDGE_RESPONSE';
  const DEFAULT_TIMEOUT_MS = 20000;

  function createRequestId() {
    const random = Math.random().toString(36).slice(2);
    return `cpa-oauth-${Date.now()}-${random}`;
  }

  function requestPageBridge(action, payload = {}, options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    const requestId = options.requestId || createRequestId();

    return new Promise((resolve) => {
      let settled = false;
      const timer = root.setTimeout(() => {
        finish({ ok: false, error: `CPA OAuth bridge timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      function finish(response) {
        if (settled) return;
        settled = true;
        root.clearTimeout(timer);
        root.removeEventListener('message', onMessage);
        resolve(response);
      }

      function onMessage(event) {
        if (event.source !== root) return;
        const data = event.data || {};
        if (
          data.source !== RESPONSE_SOURCE
          || data.type !== RESPONSE_TYPE
          || data.requestId !== requestId
        ) {
          return;
        }
        finish({
          ok: Boolean(data.ok),
          result: data.result,
          error: data.error || '',
        });
      }

      root.addEventListener('message', onMessage);
      root.postMessage({
        source: REQUEST_SOURCE,
        type: REQUEST_TYPE,
        requestId,
        action,
        payload,
      }, '*');
    });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.type !== 'CPA_OAUTH_BRIDGE') {
        return false;
      }
      requestPageBridge(message.action, message.payload, { timeoutMs: message.timeoutMs })
        .then(sendResponse)
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message || String(error) });
        });
      return true;
    });
  }

  return {
    DEFAULT_TIMEOUT_MS,
    REQUEST_SOURCE,
    REQUEST_TYPE,
    RESPONSE_SOURCE,
    RESPONSE_TYPE,
    createRequestId,
    requestPageBridge,
  };
});
