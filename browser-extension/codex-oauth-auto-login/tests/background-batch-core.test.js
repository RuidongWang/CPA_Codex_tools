const assert = require('node:assert/strict');
const test = require('node:test');

const batchCore = require('../background-batch-core.js');

test('classifies only supported bridge error types', () => {
  assert.deepEqual(batchCore.classifyBridgeError({
    errorType: 'retryable',
    code: 'code_not_found',
    message: 'No code yet',
  }), {
    errorType: 'retryable',
    code: 'code_not_found',
    message: 'No code yet',
  });

  assert.deepEqual(batchCore.classifyBridgeError({
    errorType: 'manual',
    code: 'mfa_required',
    message: 'MFA required',
  }), {
    errorType: 'manual',
    code: 'mfa_required',
    message: 'MFA required',
  });

  assert.deepEqual(batchCore.classifyBridgeError({
    errorType: 'fatal',
    code: 'state_mismatch',
    message: 'State mismatch',
  }), {
    errorType: 'fatal',
    code: 'state_mismatch',
    message: 'State mismatch',
  });

  assert.deepEqual(batchCore.classifyBridgeError({
    errorType: 'weird',
    code: 'bad_type',
    message: 'Bad type',
  }), {
    errorType: 'fatal',
    code: 'bad_type',
    message: 'Bad type',
  });
});

test('classifies missing bridge error details as fatal', () => {
  assert.deepEqual(batchCore.classifyBridgeError(), {
    errorType: 'fatal',
    code: 'fatal',
    message: 'fatal',
  });
  assert.deepEqual(batchCore.classifyBridgeError('boom'), {
    errorType: 'fatal',
    code: 'fatal',
    message: 'fatal',
  });
});

test('retries account email mismatch once and then fails with lastError', () => {
  assert.deepEqual(batchCore.nextFailureAction({
    attempt: 0,
    errorType: 'account_email_mismatch',
  }), {
    action: 'retry_job',
  });
  assert.deepEqual(batchCore.nextFailureAction({
    attempt: 1,
    errorType: 'account_email_mismatch',
  }), {
    action: 'mark_failed',
    lastError: 'account_email_mismatch',
  });
});

test('uses local retry metadata when the bridge leaves retry attempt stale', () => {
  const staleJob = {
    jobId: 'oauth-job:idx-a',
    attempt: 0,
    retryCount: 0,
  };
  const retryAttempts = {};

  assert.deepEqual(batchCore.nextJobFailureAction({
    job: staleJob,
    errorType: 'account_email_mismatch',
    retryAttempts,
  }), {
    action: 'retry_job',
  });

  const retryPatch = batchCore.buildRetryJobPatch(staleJob, {
    errorType: 'retryable',
    code: 'account_email_mismatch',
    message: 'OpenAI account email mismatch.',
  });
  assert.deepEqual(retryPatch, {
    attempt: 1,
    retryCount: 1,
    lastError: 'account_email_mismatch',
    lastErrorType: 'retryable',
    oauthError: 'OpenAI account email mismatch.',
  });

  batchCore.rememberRetryAttempt(retryAttempts, staleJob, retryPatch.attempt);

  assert.equal(batchCore.getEffectiveJobAttempt(staleJob, retryAttempts), 1);
  assert.deepEqual(batchCore.nextJobFailureAction({
    job: staleJob,
    errorType: 'account_email_mismatch',
    retryAttempts,
  }), {
    action: 'mark_failed',
    lastError: 'account_email_mismatch',
  });
});

test('fails fatal errors immediately', () => {
  assert.deepEqual(batchCore.nextFailureAction({ attempt: 0, errorType: 'fatal' }), {
    action: 'mark_failed',
  });
  assert.deepEqual(batchCore.nextFailureAction({ attempt: 1, errorType: 'fatal' }), {
    action: 'mark_failed',
  });
});

test('retries manual errors once and then marks manual required', () => {
  assert.deepEqual(batchCore.nextFailureAction({ attempt: 0, errorType: 'manual' }), {
    action: 'retry_job',
  });
  assert.deepEqual(batchCore.nextFailureAction({ attempt: 1, errorType: 'manual' }), {
    action: 'mark_manual_required',
  });
});

test('retries retryable and unknown errors once and then fails', () => {
  assert.deepEqual(batchCore.nextFailureAction({ attempt: 0, errorType: 'retryable' }), {
    action: 'retry_job',
  });
  assert.deepEqual(batchCore.nextFailureAction({ attempt: 1, errorType: 'retryable' }), {
    action: 'mark_failed',
  });
  assert.deepEqual(batchCore.nextFailureAction({ attempt: 0, errorType: 'other' }), {
    action: 'retry_job',
  });
  assert.deepEqual(batchCore.nextFailureAction({ attempt: 1, errorType: 'other' }), {
    action: 'mark_failed',
  });
});

test('skips blocked automatic failures without retrying the same job', () => {
  assert.deepEqual(batchCore.nextBlockedFailureAction({ errorType: 'manual' }), {
    action: 'mark_manual_required',
  });
  assert.deepEqual(batchCore.nextBlockedFailureAction({ errorType: 'account_email_mismatch' }), {
    action: 'mark_failed',
    lastError: 'account_email_mismatch',
  });
  assert.deepEqual(batchCore.nextBlockedFailureAction({ errorType: 'retryable' }), {
    action: 'mark_failed',
  });
  assert.deepEqual(batchCore.nextBlockedFailureAction({ errorType: 'fatal' }), {
    action: 'mark_failed',
  });
});

test('detects terminal jobs already updated by bridge error responses', () => {
  const failedJob = {
    jobId: 'oauth-job:idx-callback',
    status: 'failed',
    lockedByExtension: '',
    leaseExpiresAt: null,
  };
  assert.equal(batchCore.getTerminalBridgeErrorJob({
    bridgeError: {
      code: 'callback_submit_failed',
      job: failedJob,
    },
  }), failedJob);

  assert.equal(batchCore.getTerminalBridgeErrorJob({
    bridgeError: {
      code: 'still_running',
      job: {
        jobId: 'oauth-job:idx-running',
        status: 'code_polling',
        lockedByExtension: 'extension-a',
      },
    },
  }), null);

  assert.equal(batchCore.getTerminalBridgeErrorJob({
    bridgeResult: {
      job: {
        jobId: 'oauth-job:idx-manual',
        status: 'manual_required',
      },
    },
  })?.jobId, 'oauth-job:idx-manual');
});

test('retryable fetch-code bridge errors enter the retry failure policy', () => {
  const classified = batchCore.classifyBridgeError({
    errorType: 'retryable',
    code: 'code_not_found',
    message: 'No verification code yet.',
  });
  const job = {
    jobId: 'oauth-job:idx-code',
    attempt: 0,
    retryCount: 0,
  };

  assert.deepEqual(batchCore.nextJobFailureAction({
    job,
    errorType: classified.errorType,
  }), {
    action: 'retry_job',
  });
  assert.deepEqual(batchCore.buildRetryJobPatch(job, classified), {
    attempt: 1,
    retryCount: 1,
    lastError: 'code_not_found',
    lastErrorType: 'retryable',
    oauthError: 'No verification code yet.',
  });
});

test('strict page email verification rejects missing or mismatched consent emails', () => {
  assert.deepEqual(batchCore.verifyPageEmail({
    observedEmail: 'USER@example.com',
    expectedEmail: 'user@example.com',
    requireObserved: true,
    context: 'OpenAI consent page',
  }), {
    ok: true,
    observedEmail: 'USER@example.com',
    expectedEmail: 'user@example.com',
  });

  assert.deepEqual(batchCore.verifyPageEmail({
    observedEmail: '',
    expectedEmail: 'user@example.com',
    requireObserved: true,
    context: 'OpenAI consent page',
  }), {
    ok: false,
    errorType: 'manual',
    code: 'account_email_unverified',
    message: 'OpenAI consent page did not expose a signed-in account email for user@example.com.',
    observedEmail: '',
    expectedEmail: 'user@example.com',
  });

  assert.deepEqual(batchCore.verifyPageEmail({
    observedEmail: 'other@example.com',
    expectedEmail: 'user@example.com',
    requireObserved: true,
    context: 'OpenAI consent page',
  }), {
    ok: false,
    errorType: 'account_email_mismatch',
    code: 'account_email_mismatch',
    message: 'OpenAI consent page is signed in as other@example.com, expected user@example.com.',
    observedEmail: 'other@example.com',
    expectedEmail: 'user@example.com',
  });
});

test('strict page email verification rejects missing or mismatched account emails', () => {
  assert.deepEqual(batchCore.verifyPageEmail({
    observedEmail: 'user@example.com',
    expectedEmail: 'USER@example.com',
    requireObserved: true,
    context: 'OpenAI account page',
  }), {
    ok: true,
    observedEmail: 'user@example.com',
    expectedEmail: 'USER@example.com',
  });

  assert.deepEqual(batchCore.verifyPageEmail({
    observedEmail: '',
    expectedEmail: 'user@example.com',
    requireObserved: true,
    context: 'OpenAI account page',
  }), {
    ok: false,
    errorType: 'manual',
    code: 'account_email_unverified',
    message: 'OpenAI account page did not expose a signed-in account email for user@example.com.',
    observedEmail: '',
    expectedEmail: 'user@example.com',
  });

  assert.deepEqual(batchCore.verifyPageEmail({
    observedEmail: 'other@example.com',
    expectedEmail: 'user@example.com',
    requireObserved: true,
    context: 'OpenAI account page',
  }), {
    ok: false,
    errorType: 'account_email_mismatch',
    code: 'account_email_mismatch',
    message: 'OpenAI account page is signed in as other@example.com, expected user@example.com.',
    observedEmail: 'other@example.com',
    expectedEmail: 'user@example.com',
  });
});
