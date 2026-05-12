(function attachCpaCodexOAuthBackgroundFlowUtils(root, factory) {
  const api = factory();
  root.CpaCodexOAuthBackgroundFlowUtils = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createBackgroundFlowUtils() {
  function publicJob(job) {
    if (!job) {
      return null;
    }
    return {
      jobId: job.jobId || '',
      authIndex: job.authIndex || '',
      accountEmail: job.accountEmail || '',
      hotmailEmail: job.hotmailEmail || '',
      status: job.status || '',
      attempt: Number(job.attempt || 0),
      leaseExpiresAt: job.leaseExpiresAt || null,
    };
  }

  function redactLogMessage(value) {
    return String(value || '')
      .replace(/([?&](?:code|token)=)[^&\s]+/gi, '$1[redacted]')
      .replace(/\b((?:code|token|secret|pass(?:word)?|authorization|cookie|refresh[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
      .replace(/\b\d{6,8}\b/g, '[redacted]')
      .trim();
  }

  function makeErrorMessage(error) {
    if (!error) return 'Unknown error.';
    if (typeof error === 'string') return error;
    if (error.message) return error.message;
    if (error.error?.message) return error.error.message;
    if (typeof error.error === 'string') return error.error;
    return String(error);
  }

  function createFlowError(errorType, code, message, extra = {}) {
    const error = new Error(message || code || errorType || 'flow_error');
    error.errorType = errorType;
    error.code = code || errorType || 'flow_error';
    Object.assign(error, extra);
    return error;
  }

  function createBridgeActionError(action, response) {
    const rawError = response?.error;
    const bridgeError = rawError && typeof rawError === 'object' ? rawError : {};
    const message = bridgeError.message
      || (typeof rawError === 'string' ? rawError : '')
      || `CPA bridge action failed: ${action}`;
    const error = new Error(message);
    error.name = 'BridgeActionError';
    error.action = action;
    error.errorType = bridgeError.errorType;
    error.code = bridgeError.code || response?.code || '';
    error.bridgeError = rawError;
    error.bridgeResult = response?.result;
    return error;
  }

  function scoreOpenAIState(state) {
    switch (state?.state) {
      case 'manual_required':
        return 50;
      case 'verification':
        return 40;
      case 'email':
        return 35;
      case 'account':
        return 32;
      case 'consent':
        return 30;
      default:
        return 0;
    }
  }

  function readPath(source, path) {
    return path.split('.').reduce((current, key) => {
      if (current && typeof current === 'object' && key in current) {
        return current[key];
      }
      return undefined;
    }, source);
  }

  function pickString(source, paths) {
    for (const path of paths) {
      const value = readPath(source, path);
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return '';
  }

  function extractAuthUrl(payload) {
    return pickString(payload, [
      'authUrl',
      'authorizationUrl',
      'oauthUrl',
      'url',
      'startResult.authUrl',
      'startResult.authorizationUrl',
      'job.authUrl',
      'session.authUrl',
      'session.url',
      'oauth.authUrl',
      'oauth.url',
    ]);
  }

  function extractState(payload) {
    return pickString(payload, [
      'state',
      'authState',
      'oauthState',
      'startResult.state',
      'job.state',
      'session.state',
      'oauth.state',
    ]);
  }

  function extractEmail(payload) {
    return pickString(payload, [
      'accountEmail',
      'account.email',
      'selectedAccount.email',
      'hotmailEmail',
      'selectedHotmail.email',
      'hotmail.email',
      'email',
      'oauth.email',
    ]);
  }

  function extractCode(payload) {
    return pickString(payload, [
      'code',
      'verificationCode',
      'latestCode',
      'hotmailCode.code',
      'hotmailCode',
      'result.code',
    ]);
  }

  function getTabDiagnostics(tab, state = {}, context = {}) {
    return {
      url: tab?.url || '',
      title: tab?.title || '',
      pageState: state?.state || 'unknown',
      reason: state?.reason || '',
      email: extractEmail(state) || context?.accountEmail || context?.email || '',
      tabStatus: tab?.status || '',
      frameId: Number.isInteger(state?.frameId) ? state.frameId : 0,
      frameCount: Number(state?.frameCount || 0),
      inputCount: Number(state?.inputCount || 0),
      visibleInputCount: Number(state?.visibleInputCount || 0),
      genericInputCount: Number(state?.genericInputCount || 0),
      activeTag: state?.activeTag || '',
      activeInput: state?.activeInput || '',
      emailPageHint: Boolean(state?.emailPageHint),
    };
  }

  function formatDiagnosticsMessage(prefix, diagnostics) {
    const details = [
      diagnostics.pageState ? `state=${diagnostics.pageState}` : '',
      diagnostics.reason ? `reason=${diagnostics.reason}` : '',
      diagnostics.email ? `email=${diagnostics.email}` : '',
      diagnostics.tabStatus ? `tab=${diagnostics.tabStatus}` : '',
      diagnostics.frameCount ? `frame=${diagnostics.frameId}/${diagnostics.frameCount}` : '',
      diagnostics.inputCount ? `inputs=${diagnostics.visibleInputCount}/${diagnostics.inputCount}` : '',
      diagnostics.genericInputCount ? `generic=${diagnostics.genericInputCount}` : '',
      diagnostics.activeTag ? `active=${diagnostics.activeTag}${diagnostics.activeInput ? `(${diagnostics.activeInput})` : ''}` : '',
      diagnostics.emailPageHint ? 'emailHint=true' : '',
      diagnostics.title ? `title="${diagnostics.title}"` : '',
    ].filter(Boolean);

    return details.length ? `${prefix} (${details.join(', ')}).` : prefix;
  }

  function createPageSnapshot(tab, state = {}) {
    return {
      url: tab?.url || '',
      title: tab?.title || '',
      state: state.state || 'unknown',
      reason: state.reason || '',
      email: extractEmail(state) || '',
      frameId: Number.isInteger(state.frameId) ? state.frameId : 0,
      frameCount: Number(state.frameCount || 0),
      inputCount: Number(state.inputCount || 0),
      visibleInputCount: Number(state.visibleInputCount || 0),
      updatedAt: new Date().toISOString(),
    };
  }

  function bridgeJobPayload(run, job, extra = {}) {
    return {
      extensionId: run.id,
      jobId: job?.jobId || '',
      authIndex: job?.authIndex || '',
      accountEmail: job?.accountEmail || '',
      hotmailId: job?.hotmailId || '',
      hotmailEmail: job?.hotmailEmail || '',
      state: job?.state || '',
      ...extra,
    };
  }

  function describeJob(job) {
    return job?.accountEmail || job?.authIndex || job?.jobId || 'job';
  }

  function hasQueuedOAuthJobs(summary) {
    if (!summary || typeof summary !== 'object') {
      return true;
    }
    const queued = Number(summary.queued);
    return !Number.isFinite(queued) || queued > 0;
  }

  return {
    bridgeJobPayload,
    createBridgeActionError,
    createFlowError,
    createPageSnapshot,
    describeJob,
    extractAuthUrl,
    extractCode,
    extractEmail,
    extractState,
    formatDiagnosticsMessage,
    getTabDiagnostics,
    hasQueuedOAuthJobs,
    makeErrorMessage,
    pickString,
    publicJob,
    readPath,
    redactLogMessage,
    scoreOpenAIState,
  };
});
