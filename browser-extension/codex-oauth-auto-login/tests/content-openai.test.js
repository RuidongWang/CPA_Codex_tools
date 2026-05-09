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
    },
    dispatchEvent(event) {
      this.lastEvent = event.type;
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

test('classifies OpenAI Chinese welcome page generic text input as email and clicks submit', () => {
  const email = element('input', { type: 'text' });
  const submit = element('button', { type: 'submit' }, '继续');
  const fakeDoc = doc([email, submit], '欢迎回来');

  const state = helpers.classifyAuthState(fakeDoc);
  assert.equal(state.state, 'email');

  const fillResult = helpers.fillEmail(fakeDoc, 'user@example.com');
  assert.equal(fillResult.ok, true);
  assert.equal(email.value, 'user@example.com');

  const clickResult = helpers.clickLikelyAction(fakeDoc);
  assert.equal(clickResult.ok, true);
  assert.equal(clickResult.mode, 'click');
  assert.equal(submit.clicked, true);
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
  const continueButton = element('button', {}, '继续');
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
  assert.equal(clickResult.mode, 'click');
  assert.equal(continueButton.clicked, true);
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

test('classifies consent state and clicks authorize-like action', () => {
  const authorize = element('button', {}, 'Authorize');
  const fakeDoc = doc([authorize], 'Allow Codex to access your OpenAI account');

  const state = helpers.classifyAuthState(fakeDoc);
  assert.equal(state.state, 'consent');

  const result = helpers.clickLikelyAction(fakeDoc, ['authorize', 'allow']);
  assert.equal(result.ok, true);
  assert.equal(authorize.clicked, true);
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

test('unknown state is reported when no known controls are present', () => {
  assert.equal(helpers.classifyAuthState(doc([], 'Welcome')).state, 'unknown');
});
