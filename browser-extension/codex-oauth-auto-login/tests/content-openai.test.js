const assert = require('node:assert/strict');
const test = require('node:test');

const helpers = require('../content-openai.js');

function selectorMatches(node, selector) {
  if (selector.includes(',')) {
    return selector.split(',').some((part) => selectorMatches(node, part.trim()));
  }

  const tagMatch = selector.match(/^[a-z]+/i);
  if (tagMatch && node.tagName !== tagMatch[0].toUpperCase()) {
    return false;
  }

  if (selector === '[role="button"]') {
    return node.attributes.role === 'button';
  }

  const attrs = [...selector.matchAll(/\[([^=\]]+)(?:=(["']?)(.*?)\2)?\]/g)];
  return attrs.every(([, rawName, , rawValue]) => {
    const name = rawName.trim();
    const actual = node.getAttribute(name);
    if (rawValue === undefined) {
      return actual !== null;
    }
    return actual === rawValue;
  });
}

function linkChildren(parent, children) {
  children.forEach((child, index) => {
    child.parentElement = parent;
    child.parentNode = parent;
    child.previousElementSibling = children[index - 1] || null;
    child.nextElementSibling = children[index + 1] || null;
  });
}

function element(tagName, attrs = {}, textContent = '', children = []) {
  const node = {
    tagName: tagName.toUpperCase(),
    attributes: { ...attrs },
    children,
    parentElement: null,
    parentNode: null,
    previousElementSibling: null,
    nextElementSibling: null,
    _textContent: textContent,
    get textContent() {
      return [this._textContent, ...this.children.map((child) => child.textContent)].join('');
    },
    set textContent(value) {
      this._textContent = String(value || '');
    },
    get innerText() {
      return this.textContent;
    },
    value: attrs.value || '',
    disabled: Boolean(attrs.disabled),
    hidden: Boolean(attrs.hidden),
    style: attrs.style || {},
    clicked: false,
    focused: false,
    events: [],
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    matches(selector) {
      return selectorMatches(this, selector);
    },
    closest(selector) {
      if (selector === 'form' && this.form) return this.form;
      let current = this.parentElement;
      while (current) {
        if (selectorMatches(current, selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    focus() {
      this.focused = true;
    },
    click() {
      this.clicked = true;
      const type = String(this.getAttribute('type') || '').toLowerCase();
      if (type === 'submit' && this.form?.requestSubmit) {
        this.form.requestSubmit(this);
      }
    },
    dispatchEvent(event) {
      this.events.push(event.type);
      this.lastEvent = event.type;
      this.onDispatch?.(event);
      return true;
    },
  };
  linkChildren(node, children);
  return node;
}

function doc(nodes, text = '') {
  const allNodes = [];
  const collect = (node) => {
    allNodes.push(node);
    node.children.forEach(collect);
  };
  nodes.forEach(collect);

  return {
    body: { textContent: text },
    querySelectorAll(selector) {
      const selectors = selector.split(',').map((item) => item.trim());
      return allNodes.filter((node) => selectors.some((part) => selectorMatches(node, part)));
    },
  };
}

function form() {
  return {
    submitted: false,
    submitter: null,
    requestSubmit(submitter) {
      this.submitted = true;
      this.submitter = submitter;
    },
  };
}

test('classifies email state and fills email input', () => {
  const email = element('input', { type: 'email', name: 'email' });
  const continueButton = element('button', {}, 'Continue');
  const fakeDoc = doc([email, continueButton], 'Sign in to OpenAI');

  const state = helpers.classifyAuthState(fakeDoc);
  assert.equal(state.state, 'email');

  const result = helpers.fillEmail(fakeDoc, 'user@example.com');
  assert.equal(result.ok, true);
  assert.equal(email.value, 'user@example.com');
  assert.equal(email.focused, true);
  assert.equal(helpers.readEmailValue(fakeDoc), 'user@example.com');
});

test('fills email and submits an unlabeled continue button in one action', async () => {
  const email = element('input', { type: 'email', name: 'email' });
  const submit = element('button', { type: 'submit', 'aria-label': '' }, '');
  const loginForm = form();
  submit.form = loginForm;
  const fakeDoc = doc([email, submit], 'Welcome back Email address');

  const result = await helpers.fillEmailAndContinue(fakeDoc, 'user@example.com');

  assert.equal(result.ok, true);
  assert.equal(email.value, 'user@example.com');
  assert.equal(result.continueClicked, true);
  assert.equal(loginForm.submitted, true);
  assert.equal(loginForm.submitter, submit);
});

test('fills email, waits for delayed Chinese continue button, and clicks it', async () => {
  const email = element('input', { type: 'text', placeholder: '电子邮件地址' });
  const continueButton = element('button', { type: 'submit', disabled: true }, '继续');
  const loginForm = form();
  continueButton.form = loginForm;
  email.onDispatch = (event) => {
    if (event.type === 'input') {
      setTimeout(() => {
        continueButton.disabled = false;
        delete continueButton.attributes.disabled;
      }, 5);
    }
  };
  const fakeDoc = doc([email, continueButton], '欢迎回来');

  const result = await helpers.fillEmailAndContinue(fakeDoc, 'user@example.com', {
    actionSettleMs: 0,
    actionTimeoutMs: 80,
    pollMs: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(email.value, 'user@example.com');
  assert.equal(result.continueClicked, true);
  assert.equal(result.continueResult.mode, 'requestSubmit');
  assert.equal(continueButton.clicked, false);
  assert.equal(loginForm.submitted, true);
});

test('classifies Chinese email page and clicks continue', () => {
  const email = element('input', { type: 'text', placeholder: '电子邮件地址' });
  const continueButton = element('button', {}, '继续');
  const fakeDoc = doc([email, continueButton], '欢迎回来');

  const state = helpers.classifyAuthState(fakeDoc);
  assert.equal(state.state, 'email');

  const fillResult = helpers.fillEmail(fakeDoc, 'user@example.com');
  assert.equal(fillResult.ok, true);
  assert.equal(email.value, 'user@example.com');

  const clickResult = helpers.clickLikelyAction(fakeDoc);
  assert.equal(clickResult.ok, true);
  assert.equal(continueButton.clicked, true);
});

test('treats elements without inline opacity as visible', () => {
  const continueButton = element('button', { style: { opacity: '' } }, '继续');
  const fakeDoc = doc([continueButton], '欢迎回来');

  assert.equal(helpers.isVisibleElement(continueButton, fakeDoc), true);
  assert.equal(helpers.findLikelyAction(fakeDoc, ['继续']), continueButton);
});

test('classifies OpenAI Chinese welcome page generic text input as email and clicks submit', () => {
  const email = element('input', { type: 'text' });
  const submit = element('button', { type: 'submit' }, '继续');
  const loginForm = form();
  submit.form = loginForm;
  const fakeDoc = doc([email, submit], '欢迎回来');

  const state = helpers.classifyAuthState(fakeDoc);
  assert.equal(state.state, 'email');

  const fillResult = helpers.fillEmail(fakeDoc, 'user@example.com');
  assert.equal(fillResult.ok, true);
  assert.equal(email.value, 'user@example.com');

  const clickResult = helpers.clickLikelyAction(fakeDoc);
  assert.equal(clickResult.ok, true);
  assert.equal(clickResult.mode, 'requestSubmit');
  assert.equal(submit.clicked, false);
  assert.equal(loginForm.submitted, true);
  assert.equal(loginForm.submitter, submit);
});

test('classifies focused Chinese OpenAI email input with adjacent label and hidden decoys', () => {
  const label = element('label', {}, '电子邮件地址');
  const email = element('input', { type: 'text' });
  const inputShell = element('div', {}, '', [email]);
  const field = element('div', {}, '', [label, inputShell]);
  const hiddenText = element('input', { type: 'text' });
  const hiddenRegion = element('div', { style: { display: 'none' } }, '', [hiddenText]);
  const hiddenCode = element('input', { type: 'hidden', autocomplete: 'one-time-code' });
  const csrf = element('input', { type: 'hidden', name: 'csrf' });
  const rememberDevice = element('input', { type: 'checkbox', name: 'remember-device' });
  const password = element('input', { type: 'password' });
  const continueButton = element('button', { type: 'submit' }, '继续');
  const loginForm = form();
  continueButton.form = loginForm;
  const fakeDoc = doc(
    [field, hiddenRegion, hiddenCode, csrf, rememberDevice, password, continueButton],
    '欢迎回来 电子邮件地址 继续'
  );
  fakeDoc.activeElement = email;
  email.focused = true;

  const state = helpers.classifyAuthState(fakeDoc);
  assert.equal(state.state, 'email');

  const fillResult = helpers.fillEmail(fakeDoc, 'user@example.com');
  assert.equal(fillResult.ok, true);
  assert.equal(email.value, 'user@example.com');
  assert.equal(hiddenText.value, '');
  assert.equal(csrf.value, '');

  const clickResult = helpers.clickLikelyAction(fakeDoc);
  assert.equal(clickResult.ok, true);
  assert.equal(clickResult.mode, 'requestSubmit');
  assert.equal(continueButton.clicked, false);
  assert.equal(loginForm.submitted, true);
  assert.equal(loginForm.submitter, continueButton);
});

test('classifies focused email input even when browser reports zero layout during hydration', () => {
  const email = element('input', {
    type: 'email',
    name: 'email',
    id: '_r_1_-email',
    autocomplete: 'email',
    placeholder: '电子邮件地址',
    style: { opacity: '0' },
  });
  email.getBoundingClientRect = () => ({ width: 0, height: 0 });
  const continueButton = element('button', {}, '继续');
  const fakeDoc = doc([email, continueButton], '欢迎回来');
  fakeDoc.activeElement = email;

  const state = helpers.classifyAuthState(fakeDoc);
  assert.equal(state.state, 'email');
  assert.equal(state.reason, 'email_input');

  const result = helpers.fillEmail(fakeDoc, 'user@example.com');
  assert.equal(result.ok, true);
  assert.equal(email.value, 'user@example.com');
});

test('classifies username input as email field', () => {
  const username = element('input', { type: 'text', name: 'username' });
  const fakeDoc = doc([username], 'Sign in to OpenAI');

  const state = helpers.classifyAuthState(fakeDoc);
  assert.equal(state.state, 'email');

  const result = helpers.fillEmail(fakeDoc, 'user@example.com');
  assert.equal(result.ok, true);
  assert.equal(username.value, 'user@example.com');
});

test('skips disabled action button and submits enabled form submitter', () => {
  const disabledContinue = element('button', { disabled: true }, 'Continue');
  const submit = element('button', { type: 'submit' }, 'Submit');
  const loginForm = form();
  submit.form = loginForm;
  const fakeDoc = doc([disabledContinue, submit], 'Sign in to OpenAI');

  const result = helpers.clickLikelyAction(fakeDoc);
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'requestSubmit');
  assert.equal(disabledContinue.clicked, false);
  assert.equal(submit.clicked, false);
  assert.equal(loginForm.submitted, true);
  assert.equal(loginForm.submitter, submit);
});

test('classifies verification state and fills one-time code', () => {
  const code = element('input', { autocomplete: 'one-time-code', inputmode: 'numeric' });
  const fakeDoc = doc([code], 'Enter the verification code sent to your email');

  const state = helpers.classifyAuthState(fakeDoc);
  assert.equal(state.state, 'verification');

  const result = helpers.fillVerificationCode(fakeDoc, '123456');
  assert.equal(result.ok, true);
  assert.equal(code.value, '123456');
});

test('fills split verification code inputs one digit at a time', () => {
  const digits = Array.from({ length: 6 }, () => element('input', { maxlength: '1', inputmode: 'numeric' }));
  const fakeDoc = doc(digits, 'Enter the verification code sent to user@example.com');

  const state = helpers.classifyAuthState(fakeDoc);
  assert.equal(state.state, 'verification');
  assert.equal(state.email, 'user@example.com');

  const result = helpers.fillVerificationCode(fakeDoc, '246810');
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'split');
  assert.deepEqual(digits.map((input) => input.value), ['2', '4', '6', '8', '1', '0']);
});

test('classifies Chinese password page as one-time-code choice and clicks it', () => {
  const password = element('input', { type: 'password', name: 'password' });
  const useCode = element('button', {}, '使用一次性验证码登录');
  const fakeDoc = doc(
    [password, useCode],
    '输入密码 电子邮件地址 user@example.com 密码 忘记了密码？ 使用一次性验证码登录'
  );

  assert.deepEqual(helpers.classifyAuthState(fakeDoc), {
    state: 'otp_choice',
    reason: 'one_time_code_action',
    email: 'user@example.com',
  });

  const result = helpers.clickLikelyAction(fakeDoc, helpers.OTP_LOGIN_WORDS);
  assert.equal(result.ok, true);
  assert.equal(useCode.clicked, true);
});

test('classifies password input with one-time-code action as choice when body omits password label', () => {
  const password = element('input', { type: 'password', name: 'password' });
  const useCode = element('button', {}, '使用一次性验证码登录');
  const fakeDoc = doc(
    [password, useCode],
    '电子邮件地址 user@example.com 使用一次性验证码登录'
  );

  assert.deepEqual(helpers.classifyAuthState(fakeDoc), {
    state: 'otp_choice',
    reason: 'one_time_code_action',
    email: 'user@example.com',
  });
});

test('reports action center coordinates for trusted browser clicks', async () => {
  const continueButton = element('button', {}, '继续');
  continueButton.getBoundingClientRect = () => ({
    left: 40,
    top: 80,
    width: 120,
    height: 32,
    right: 160,
    bottom: 112,
  });
  const fakeDoc = doc([continueButton], '欢迎回来');

  const result = await helpers.getLikelyActionRectWhenReady(fakeDoc, ['继续'], {
    actionSettleMs: 0,
    actionTimeoutMs: 10,
  });

  assert.deepEqual(result, {
    ok: true,
    text: '继续',
    rect: {
      left: 40,
      top: 80,
      width: 120,
      height: 32,
      right: 160,
      bottom: 112,
      centerX: 100,
      centerY: 96,
    },
  });
});

test('fills verification code and clicks Chinese continue in one action', async () => {
  const code = element('input', { autocomplete: 'one-time-code', inputmode: 'numeric' });
  const continueButton = element('button', {}, '继续');
  const fakeDoc = doc([code, continueButton], '检查你的收件箱 输入验证码 继续');

  const result = await helpers.fillVerificationCodeAndContinue(fakeDoc, '157526');

  assert.equal(result.ok, true);
  assert.equal(code.value, '157526');
  assert.equal(result.continueClicked, true);
  assert.equal(continueButton.clicked, true);
});

test('classifies consent state and clicks authorize-like action', () => {
  const authorize = element('button', {}, 'Authorize');
  const fakeDoc = doc([authorize], 'Allow Codex to access your OpenAI account for user@example.com');

  const state = helpers.classifyAuthState(fakeDoc);
  assert.equal(state.state, 'consent');
  assert.equal(state.email, 'user@example.com');

  const result = helpers.clickLikelyAction(fakeDoc, ['authorize', 'allow']);
  assert.equal(result.ok, true);
  assert.equal(authorize.clicked, true);
});

test('reads account email from consent page body text', () => {
  const authorize = element('button', {}, 'Authorize');
  const message = element('p', {}, 'Authorize Codex for user@example.com');
  const main = element('main', {}, '', [message, authorize]);
  const fakeDoc = doc([main]);

  assert.equal(helpers.readEmailValue(fakeDoc), 'user@example.com');
  assert.deepEqual(helpers.classifyAuthState(fakeDoc), {
    state: 'consent',
    reason: 'authorize_action',
    email: 'user@example.com',
  });
});

test('classifies continue-as account page and reads account email from action text', () => {
  const continueAs = element('button', {}, 'Continue as other@example.com');
  const fakeDoc = doc([continueAs], 'Choose an account');

  assert.deepEqual(helpers.classifyAuthState(fakeDoc), {
    state: 'account',
    reason: 'continue_as_account',
    email: 'other@example.com',
  });
  assert.equal(helpers.readEmailValue(fakeDoc), 'other@example.com');
});

test('classifies Chinese continue-as account page and reads account email from page text', () => {
  const continueAs = element('button', {}, '继续');
  const fakeDoc = doc([continueAs], '继续使用 other@example.com');

  assert.deepEqual(helpers.classifyAuthState(fakeDoc), {
    state: 'account',
    reason: 'continue_as_account',
    email: 'other@example.com',
  });
});

test('reports missing consent email for strict background verification', () => {
  const authorize = element('button', {}, 'Authorize');
  const fakeDoc = doc([authorize], 'Allow Codex to access your OpenAI account');

  assert.deepEqual(helpers.classifyAuthState(fakeDoc), {
    state: 'consent',
    reason: 'authorize_action',
    email: '',
  });
  assert.equal(helpers.readEmailValue(fakeDoc), '');
});

test('classifies CAPTCHA, MFA, phone, and security pages as manual required', () => {
  for (const text of [
    'Please complete the CAPTCHA challenge',
    'Enter the code from your authenticator app',
    'Verify your phone number',
    'Suspicious login security check',
  ]) {
    assert.equal(helpers.classifyAuthState(doc([], text)).state, 'manual_required');
  }
});

test('classifies account deactivated error pages with a skip reason', () => {
  assert.deepEqual(
    helpers.classifyAuthState(doc([], '糟糕，出错了！验证过程中出错 (account_deactivated)。请重试。')),
    {
      state: 'manual_required',
      reason: 'account_deactivated',
    },
  );
});

test('unknown state is reported when no known controls are present', () => {
  assert.equal(helpers.classifyAuthState(doc([], 'Welcome')).state, 'unknown');
});

test('click action obeys requested words instead of clicking an unmatched submit', () => {
  const submit = element('button', { type: 'submit' }, 'Submit');
  const loginForm = form();
  submit.form = loginForm;
  const fakeDoc = doc([submit], 'Continue as other@example.com');

  const result = helpers.clickLikelyAction(fakeDoc, ['continue', 'next']);
  assert.deepEqual(result, { ok: false, error: 'action_not_found' });
  assert.equal(submit.clicked, false);
  assert.equal(loginForm.submitted, false);
});
