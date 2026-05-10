(function attachCpaCodexOAuthBackgroundBatchCore(root, factory) {
  const api = factory();
  root.CpaCodexOAuthBackgroundBatchCore = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createBackgroundBatchCore() {
  const BRIDGE_ERROR_TYPES = new Set(['retryable', 'manual', 'fatal']);
  const TERMINAL_JOB_STATUSES = new Set(['callback_submitted', 'manual_required', 'failed']);

  function asString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function toNonNegativeInteger(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return 0;
    }
    return Math.max(0, Math.trunc(number));
  }

  function normalizeEmail(value) {
    return asString(value).toLowerCase();
  }

  function emailsMatch(left, right) {
    const leftEmail = normalizeEmail(left);
    const rightEmail = normalizeEmail(right);
    return Boolean(leftEmail && rightEmail && leftEmail === rightEmail);
  }

  function classifyBridgeError(error = {}) {
    const input = error && typeof error === 'object' ? error : {};
    const errorType = BRIDGE_ERROR_TYPES.has(input.errorType) ? input.errorType : 'fatal';
    const code = asString(input.code) || asString(input.error) || errorType;
    const message = asString(input.message) || asString(input.error) || code;

    return {
      errorType,
      code,
      message,
    };
  }

  function getJobAttempt(job) {
    return Math.min(1, toNonNegativeInteger(job?.attempt));
  }

  function getRetryCount(job) {
    return toNonNegativeInteger(job?.retryCount);
  }

  function getLocalRetryAttempt(job, retryAttempts) {
    const jobId = asString(job?.jobId);
    if (!jobId || !retryAttempts || typeof retryAttempts !== 'object') {
      return 0;
    }
    return Math.min(1, toNonNegativeInteger(retryAttempts[jobId]));
  }

  function getEffectiveJobAttempt(job, retryAttempts) {
    return Math.max(getJobAttempt(job), getLocalRetryAttempt(job, retryAttempts));
  }

  function nextFailureAction({ attempt, errorType } = {}) {
    const currentAttempt = Number(attempt) || 0;

    if (errorType === 'account_email_mismatch') {
      if (currentAttempt === 0) {
        return { action: 'retry_job' };
      }
      return { action: 'mark_failed', lastError: 'account_email_mismatch' };
    }

    if (errorType === 'fatal') {
      return { action: 'mark_failed' };
    }

    if (errorType === 'manual') {
      if (currentAttempt === 0) {
        return { action: 'retry_job' };
      }
      return { action: 'mark_manual_required' };
    }

    if (currentAttempt === 0) {
      return { action: 'retry_job' };
    }
    return { action: 'mark_failed' };
  }

  function nextJobFailureAction({ job, errorType, retryAttempts } = {}) {
    return nextFailureAction({
      attempt: getEffectiveJobAttempt(job, retryAttempts),
      errorType,
    });
  }

  function nextBlockedFailureAction({ errorType } = {}) {
    if (errorType === 'manual') {
      return { action: 'mark_manual_required' };
    }

    if (errorType === 'account_email_mismatch') {
      return { action: 'mark_failed', lastError: 'account_email_mismatch' };
    }

    return { action: 'mark_failed' };
  }

  function getTerminalBridgeErrorJob(error = {}) {
    const candidates = [
      error?.bridgeError?.job,
      error?.bridgeResult?.job,
      error?.job,
    ];
    const job = candidates.find((candidate) => (
      isPlainObject(candidate)
      && asString(candidate.jobId)
      && TERMINAL_JOB_STATUSES.has(asString(candidate.status))
    ));
    return job || null;
  }

  function buildRetryJobPatch(job, classified = {}) {
    const errorType = BRIDGE_ERROR_TYPES.has(classified.errorType) ? classified.errorType : 'retryable';
    const code = asString(classified.code) || asString(classified.error) || 'job_retry';
    const message = asString(classified.message) || code;
    const patch = {
      attempt: Math.min(1, getJobAttempt(job) + 1),
      retryCount: getRetryCount(job) + 1,
      lastError: code,
      lastErrorType: errorType,
    };

    if (errorType === 'manual') {
      patch.manualReason = message;
    }
    if (errorType === 'retryable' || errorType === 'fatal') {
      patch.oauthError = message;
    }

    return patch;
  }

  function rememberRetryAttempt(retryAttempts, job, attempt) {
    const jobId = asString(job?.jobId);
    if (!jobId || !retryAttempts || typeof retryAttempts !== 'object') {
      return;
    }
    retryAttempts[jobId] = Math.max(getLocalRetryAttempt(job, retryAttempts), Math.min(1, toNonNegativeInteger(attempt)));
  }

  function forgetRetryAttempt(retryAttempts, job) {
    const jobId = asString(job?.jobId);
    if (!jobId || !retryAttempts || typeof retryAttempts !== 'object') {
      return;
    }
    delete retryAttempts[jobId];
  }

  function verifyPageEmail({ observedEmail, expectedEmail, requireObserved = false, context = 'OpenAI page' } = {}) {
    const observed = asString(observedEmail);
    const expected = asString(expectedEmail);
    const pageContext = asString(context) || 'OpenAI page';

    if (!expected) {
      if (!requireObserved) {
        return { ok: true };
      }
      return {
        ok: false,
        errorType: 'manual',
        code: 'missing_account_email',
        message: `${pageContext} requires an expected account email, but the job did not provide one.`,
        observedEmail: observed,
        expectedEmail: expected,
      };
    }

    if (!observed) {
      if (!requireObserved) {
        return { ok: true };
      }
      return {
        ok: false,
        errorType: 'manual',
        code: 'account_email_unverified',
        message: `${pageContext} did not expose a signed-in account email for ${expected}.`,
        observedEmail: observed,
        expectedEmail: expected,
      };
    }

    if (emailsMatch(observed, expected)) {
      return {
        ok: true,
        observedEmail: observed,
        expectedEmail: expected,
      };
    }

    return {
      ok: false,
      errorType: 'account_email_mismatch',
      code: 'account_email_mismatch',
      message: `${pageContext} is signed in as ${observed}, expected ${expected}.`,
      observedEmail: observed,
      expectedEmail: expected,
    };
  }

  return {
    buildRetryJobPatch,
    classifyBridgeError,
    emailsMatch,
    forgetRetryAttempt,
    getEffectiveJobAttempt,
    getJobAttempt,
    getRetryCount,
    getTerminalBridgeErrorJob,
    nextBlockedFailureAction,
    nextFailureAction,
    nextJobFailureAction,
    rememberRetryAttempt,
    verifyPageEmail,
  };
});
