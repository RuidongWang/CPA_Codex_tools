const assert = require('node:assert/strict');
const test = require('node:test');

const flowUtils = require('../background-flow-utils.js');

test('redacts callback secrets, tokens, passwords, and verification codes from log text', () => {
  const message = flowUtils.redactLogMessage(
    'callback http://localhost/auth/callback?code=abc123&state=ok token=tok password:secret 123456'
  );

  assert.equal(
    message,
    'callback http://localhost/auth/callback?code=[redacted] token=[redacted] password:[redacted] [redacted]'
  );
});

test('extracts OAuth fields from supported bridge payload shapes', () => {
  const payload = {
    startResult: {
      authorizationUrl: 'https://auth.openai.com/oauth',
      state: 'state-a',
    },
    selectedAccount: {
      email: 'person@example.com',
    },
    result: {
      code: '112233',
    },
  };

  assert.equal(flowUtils.extractAuthUrl(payload), 'https://auth.openai.com/oauth');
  assert.equal(flowUtils.extractState(payload), 'state-a');
  assert.equal(flowUtils.extractEmail(payload), 'person@example.com');
  assert.equal(flowUtils.extractCode(payload), '112233');
});

test('builds compact diagnostics and page snapshots from tab state', () => {
  const tab = {
    url: 'https://auth.openai.com/oauth',
    title: 'OpenAI',
    status: 'complete',
  };
  const state = {
    state: 'email',
    reason: 'email_input_visible',
    account: { email: 'person@example.com' },
    frameId: 2,
    frameCount: 3,
    inputCount: 5,
    visibleInputCount: 2,
    genericInputCount: 1,
    activeTag: 'INPUT',
    activeInput: 'email',
    emailPageHint: true,
  };

  const diagnostics = flowUtils.getTabDiagnostics(tab, state);
  assert.deepEqual(diagnostics, {
    url: 'https://auth.openai.com/oauth',
    title: 'OpenAI',
    pageState: 'email',
    reason: 'email_input_visible',
    email: 'person@example.com',
    tabStatus: 'complete',
    frameId: 2,
    frameCount: 3,
    inputCount: 5,
    visibleInputCount: 2,
    genericInputCount: 1,
    activeTag: 'INPUT',
    activeInput: 'email',
    emailPageHint: true,
  });
  assert.equal(
    flowUtils.formatDiagnosticsMessage('Waiting', diagnostics),
    'Waiting (state=email, reason=email_input_visible, email=person@example.com, tab=complete, frame=2/3, inputs=2/5, generic=1, active=INPUT(email), emailHint=true, title="OpenAI").'
  );

  const snapshot = flowUtils.createPageSnapshot(tab, state);
  assert.equal(snapshot.email, 'person@example.com');
  assert.equal(snapshot.frameId, 2);
  assert.match(snapshot.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('creates bridge job payloads and bridge action errors without losing context', () => {
  assert.deepEqual(flowUtils.bridgeJobPayload({
    id: 'extension-a',
  }, {
    jobId: 'job-a',
    authIndex: 'idx-a',
    accountEmail: 'person@example.com',
    hotmailId: 'hm-a',
    hotmailEmail: 'mail@example.com',
    state: 'state-a',
  }, {
    callbackUrl: 'http://localhost/auth/callback?code=a&state=state-a',
  }), {
    extensionId: 'extension-a',
    jobId: 'job-a',
    authIndex: 'idx-a',
    accountEmail: 'person@example.com',
    hotmailId: 'hm-a',
    hotmailEmail: 'mail@example.com',
    state: 'state-a',
    callbackUrl: 'http://localhost/auth/callback?code=a&state=state-a',
  });

  const error = flowUtils.createBridgeActionError('FETCH_CODE', {
    code: 'bridge_failed',
    error: {
      errorType: 'retryable',
      code: 'code_not_found',
      message: 'No code found yet.',
    },
    result: {
      summary: { queued: 1 },
    },
  });

  assert.equal(error.name, 'BridgeActionError');
  assert.equal(error.message, 'No code found yet.');
  assert.equal(error.action, 'FETCH_CODE');
  assert.equal(error.errorType, 'retryable');
  assert.equal(error.code, 'code_not_found');
  assert.deepEqual(error.bridgeResult, { summary: { queued: 1 } });
});
