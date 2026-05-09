(function attachCpaCodexOAuthOpenAI(root, factory) {
  const api = factory(root);
  root.CpaCodexOAuthOpenAI = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createOpenAIHelpers(root) {
  const ACTION_WORDS = [
    'continue',
    'next',
    'submit',
    'verify',
    'authorize',
    'authorise',
    'allow',
    'confirm',
    'sign in',
    'log in',
    '继续',
    '下一步',
    '登录',
    '登入',
    '提交',
    '验证',
    '授权',
    '允许',
    '确认',
  ];
  const MANUAL_REQUIRED_PATTERN = /captcha|cloudflare|mfa|multi[-\s]?factor|authenticator|security\s+check|suspicious|passkey|we need to verify|verify\s+(?:your\s+)?phone|phone\s+(?:number\s+)?verification|安全检查|身份验证器|可疑|通行密钥|多重验证|双重验证|验证.*(?:手机|电话)|(?:手机|电话).*验证/i;
  const VERIFICATION_PATTERN = /verification\s+code|one[-\s]?time\s+code|enter\s+the\s+code|check\s+your\s+email|sent\s+to\s+your\s+email|验证码|一次性代码|输入代码|检查你的邮箱|发送到你的邮箱|发送至你的电子邮件/i;
  const CONSENT_PATTERN = /authorize|authorise|allow|grant|consent|access\s+your\s+openai\s+account|codex|授权|允许|同意|确认|访问你的\s*openai\s*账户/i;

  function getDocument(doc) {
    return doc || (typeof document !== 'undefined' ? document : null);
  }

  function getElementText(element) {
    return String(
      element?.innerText
      || element?.textContent
      || element?.getAttribute?.('aria-label')
      || element?.getAttribute?.('title')
      || element?.value
      || ''
    ).trim();
  }

  function getPageText(doc) {
    const currentDoc = getDocument(doc);
    return String(currentDoc?.body?.innerText || currentDoc?.body?.textContent || '');
  }

  function queryAll(doc, selector) {
    const currentDoc = getDocument(doc);
    if (!currentDoc?.querySelectorAll) {
      return [];
    }
    const results = [];
    const roots = [currentDoc];
    const visitedRoots = new Set();

    while (roots.length) {
      const currentRoot = roots.shift();
      if (!currentRoot || visitedRoots.has(currentRoot) || !currentRoot.querySelectorAll) {
        continue;
      }
      visitedRoots.add(currentRoot);

      try {
        results.push(...Array.from(currentRoot.querySelectorAll(selector)));
      } catch {
        return [];
      }

      try {
        for (const element of Array.from(currentRoot.querySelectorAll('*'))) {
          if (element?.shadowRoot && !visitedRoots.has(element.shadowRoot)) {
            roots.push(element.shadowRoot);
          }
        }
      } catch {
        // Some DOM-like test doubles do not support broad traversal; selector results above are still useful.
      }
    }

    return Array.from(new Set(results));
  }

  function getActiveElement(doc) {
    const currentDoc = getDocument(doc);
    let active = currentDoc?.activeElement || root.document?.activeElement || null;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  function isActiveElement(element, doc) {
    return Boolean(element && element === getActiveElement(doc));
  }

  function isVisibleElement(element, doc) {
    if (!element || element.hidden) {
      return false;
    }
    if (element.getAttribute?.('aria-hidden') === 'true') {
      return false;
    }
    const active = isActiveElement(element, doc);
    if (typeof root.getComputedStyle === 'function') {
      const computedStyle = root.getComputedStyle(element);
      if (
        computedStyle
        && (
          computedStyle.display === 'none'
          || computedStyle.visibility === 'hidden'
          || (!active && Number(computedStyle.opacity) === 0)
        )
      ) {
        return false;
      }
    }
    if (typeof element.getBoundingClientRect === 'function') {
      const rect = element.getBoundingClientRect();
      if (!active && rect && rect.width <= 0 && rect.height <= 0) {
        return false;
      }
    }
    const style = element.style || {};
    if (style.display === 'none' || style.visibility === 'hidden' || (!active && Number(style.opacity) === 0)) {
      return false;
    }
    return true;
  }

  function cssEscape(value) {
    const nextValue = String(value || '');
    const escape = root.CSS?.escape;
    if (typeof escape === 'function') {
      return escape(nextValue);
    }
    return nextValue.replace(/["\\]/g, '\\$&');
  }

  function getAssociatedLabelText(input, doc) {
    const currentDoc = getDocument(doc);
    const labels = [];
    const id = input?.getAttribute?.('id') || '';
    const ariaLabelledBy = input?.getAttribute?.('aria-labelledby') || '';
    if (id && currentDoc?.querySelector) {
      const explicitLabel = currentDoc.querySelector(`label[for="${cssEscape(id)}"]`);
      if (explicitLabel) {
        labels.push(getElementText(explicitLabel));
      }
    }
    if (ariaLabelledBy && currentDoc?.getElementById) {
      for (const labelId of ariaLabelledBy.split(/\s+/).filter(Boolean)) {
        const labelledBy = currentDoc.getElementById(labelId);
        if (labelledBy) {
          labels.push(getElementText(labelledBy));
        }
      }
    }
    const parentLabel = input?.closest?.('label');
    if (parentLabel) {
      labels.push(getElementText(parentLabel));
    }
    const nearby = input?.closest?.('fieldset, form, div, section');
    if (nearby) {
      labels.push(getElementText(nearby).slice(0, 160));
    }
    return labels.filter(Boolean).join(' ').toLowerCase();
  }

  function getInputName(input) {
    return [
      input?.getAttribute?.('type'),
      input?.getAttribute?.('name'),
      input?.getAttribute?.('id'),
      input?.getAttribute?.('autocomplete'),
      input?.getAttribute?.('placeholder'),
      input?.getAttribute?.('aria-label'),
      input?.getAttribute?.('inputmode'),
      input?.getAttribute?.('data-testid'),
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function isGenericTextInput(input) {
    const type = String(input?.getAttribute?.('type') || input?.type || 'text').trim().toLowerCase();
    const maxLength = Number(input?.maxLength || input?.getAttribute?.('maxlength') || 0);
    if (['hidden', 'password', 'tel', 'checkbox', 'radio', 'button', 'submit'].includes(type)) {
      return false;
    }
    if (maxLength === 1 || (maxLength >= 4 && maxLength <= 12 && /numeric|otp|code/i.test(getInputName(input)))) {
      return false;
    }
    return ['email', 'text', 'search', ''].includes(type) || type === 'undefined';
  }

  function isHiddenInput(input) {
    return String(input?.getAttribute?.('type') || input?.type || '').trim().toLowerCase() === 'hidden';
  }

  function hasEmailPageHint(pageText) {
    return /电子邮件地址|邮箱|邮件地址|email\s+address|welcome\s+back|欢迎回来/i.test(String(pageText || ''));
  }

  function scoreEmailInput(input, doc, pageText = getPageText(doc)) {
    if (!isVisibleElement(input, doc) || !isGenericTextInput(input)) {
      return -100;
    }

    const name = getInputName(input);
    const labelText = getAssociatedLabelText(input, doc);
    const type = String(input?.getAttribute?.('type') || input?.type || '').toLowerCase();
    const active = getActiveElement(doc);
    let score = 0;

    if (input === active) score += 8;
    if (String(input?.value || '').includes('@')) score += 8;
    if (type === 'email') score += 12;
    if (/\bemail\b|电子邮件|邮箱|邮件地址/.test(name)) score += 8;
    if (/\busername\b/.test(name)) score += 5;
    if (/email|电子邮件|邮箱|邮件地址/.test(labelText)) score += 8;
    if (hasEmailPageHint(pageText)) score += 3;
    if (type === 'search') score -= 4;

    return score;
  }

  function pickPreferredInput(inputs) {
    return inputs.find((input) => !input.disabled) || inputs[0] || null;
  }

  function findEmailInput(doc) {
    const direct = pickPreferredInput(queryAll(doc, [
      'input[type="email"]',
      'input[autocomplete="email"]',
      'input[autocomplete="username"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[id*="email" i]',
      'input[placeholder*="email" i]',
      'input[placeholder*="电子邮件"]',
      'input[placeholder*="邮箱"]',
      'input[aria-label*="email" i]',
      'input[aria-label*="电子邮件"]',
      'input[aria-label*="邮箱"]',
      'input[inputmode="email"]',
    ].join(', ')).filter((input) => isVisibleElement(input, doc)));
    if (direct) {
      return direct;
    }

    const labelled = queryAll(doc, 'input').find((input) => {
      if (!isVisibleElement(input, doc)) return false;
      const name = getInputName(input);
      const labelText = getAssociatedLabelText(input, doc);
      return /\bemail\b/.test(name)
        || name.includes('email')
        || name.includes('username')
        || name.includes('电子邮件')
        || name.includes('邮箱')
        || name.includes('邮件地址')
        || /email|电子邮件|邮箱|邮件地址/.test(labelText);
    });
    if (labelled) {
      return labelled;
    }

    const pageText = getPageText(doc);
    if (!hasEmailPageHint(pageText)) {
      return null;
    }

    const genericInputs = queryAll(doc, 'input')
      .filter((input) => isVisibleElement(input, doc) && isGenericTextInput(input));
    const focusedInput = genericInputs.find((input) => input === getActiveElement(doc));
    if (focusedInput) {
      return focusedInput;
    }

    const [candidate] = genericInputs
      .map((input) => ({ input, score: scoreEmailInput(input, doc, pageText) }))
      .filter((candidateInfo) => candidateInfo.score > 0)
      .sort((left, right) => right.score - left.score);
    return candidate?.input || null;
  }

  function findCodeInput(doc) {
    return queryAll(doc, 'input').find((input) => {
      if (!isVisibleElement(input, doc) || isHiddenInput(input)) return false;
      const name = getInputName(input);
      const maxLength = Number(input.maxLength || input.getAttribute?.('maxlength') || 0);
      return name.includes('one-time-code')
        || name.includes('otp')
        || name.includes('code')
        || name.includes('numeric')
        || (maxLength >= 4 && maxLength <= 12);
    }) || null;
  }

  function findSplitCodeInputs(doc) {
    const inputs = queryAll(doc, 'input').filter((input) => {
      if (!isVisibleElement(input, doc) || isHiddenInput(input)) return false;
      const name = getInputName(input);
      const maxLength = Number(input.maxLength || input.getAttribute?.('maxlength') || 0);
      const size = Number(input.size || input.getAttribute?.('size') || 0);
      return name.includes('otp')
        || name.includes('code')
        || name.includes('numeric')
        || maxLength === 1
        || size === 1;
    });
    return inputs.length >= 4 ? inputs : [];
  }

  function findLikelyAction(doc, words = ACTION_WORDS) {
    const directSubmit = queryAll(doc, 'button[type="submit"], input[type="submit"]').find((element) => (
      isVisibleElement(element, doc) && isActionEnabled(element)
    ));
    if (directSubmit) {
      return directSubmit;
    }

    const normalizedWords = words.map((word) => String(word).toLowerCase());
    return queryAll(doc, 'button, [role="button"], a').find((element) => {
      if (!isVisibleElement(element, doc) || !isActionEnabled(element)) return false;
      const text = getElementText(element).toLowerCase();
      return normalizedWords.some((word) => text.includes(word));
    }) || null;
  }

  function isActionEnabled(element) {
    return Boolean(element)
      && !element.disabled
      && element.getAttribute?.('aria-disabled') !== 'true';
  }

  function classifyAuthState(doc) {
    const pageText = getPageText(doc);
    if (MANUAL_REQUIRED_PATTERN.test(pageText)) {
      return { state: 'manual_required', reason: 'security_or_extra_verification' };
    }

    const codeInput = findCodeInput(doc);
    if (codeInput || VERIFICATION_PATTERN.test(pageText)) {
      return { state: 'verification', reason: codeInput ? 'code_input' : 'verification_text', email: readEmailValue(doc) };
    }

    const emailInput = findEmailInput(doc);
    if (emailInput) {
      return { state: 'email', reason: 'email_input', email: readEmailValue(doc) };
    }

    const action = findLikelyAction(doc, ['authorize', 'authorise', 'allow', 'continue', 'confirm', '授权', '允许', '同意', '继续', '确认']);
    if (action && CONSENT_PATTERN.test(`${pageText} ${getElementText(action)}`)) {
      return { state: 'consent', reason: 'authorize_action' };
    }

    return { state: 'unknown', reason: 'no_known_controls' };
  }

  function readEmailValue(doc) {
    const input = findEmailInput(doc);
    const value = String(input?.value || '').trim();
    if (value && value.includes('@')) {
      return value;
    }
    const text = getPageText(doc);
    const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0] : '';
  }

  function setInputValue(input, value) {
    if (!input) {
      return false;
    }
    input.focus?.();
    const nextValue = String(value || '');
    const descriptor = Object.getOwnPropertyDescriptor(input.constructor?.prototype || HTMLInputElement.prototype, 'value');
    if (descriptor?.set) {
      descriptor.set.call(input, nextValue);
    } else {
      input.value = nextValue;
    }
    const EventCtor = root.Event || function Event(type) { this.type = type; };
    const InputEventCtor = root.InputEvent || EventCtor;
    input.dispatchEvent?.(new InputEventCtor('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
    input.dispatchEvent?.(new EventCtor('input', { bubbles: true }));
    input.dispatchEvent?.(new EventCtor('change', { bubbles: true }));
    return true;
  }

  function fillEmail(doc, email) {
    const input = findEmailInput(doc);
    if (!input) {
      return { ok: false, error: 'email_input_not_found' };
    }
    setInputValue(input, email);
    return { ok: true, email: String(email || '') };
  }

  function fillVerificationCode(doc, code) {
    const value = String(code || '').trim();
    const splitInputs = findSplitCodeInputs(doc);
    if (splitInputs.length > 1 && value.length >= splitInputs.length) {
      value.slice(0, splitInputs.length).split('').forEach((character, index) => {
        setInputValue(splitInputs[index], character);
      });
      return { ok: true, mode: 'split' };
    }

    const input = findCodeInput(doc);
    if (!input) {
      return { ok: false, error: 'code_input_not_found' };
    }
    setInputValue(input, value);
    return { ok: true, mode: 'single' };
  }

  function clickLikelyAction(doc, words = ACTION_WORDS) {
    const action = findLikelyAction(doc, words);
    if (!action) {
      return { ok: false, error: 'action_not_found' };
    }
    const form = action.form || action.closest?.('form') || null;
    if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit(action.form === form ? action : undefined);
      return { ok: true, text: getElementText(action), mode: 'requestSubmit' };
    }
    action.click?.();
    return { ok: true, text: getElementText(action), mode: 'click' };
  }

  function publicState(state) {
    const diagnostics = getOpenAIDiagnostics();
    return {
      state: state.state,
      reason: state.reason,
      email: state.email || readEmailValue(),
      url: typeof location !== 'undefined' ? location.href : '',
      title: typeof document !== 'undefined' ? document.title : '',
      ...diagnostics,
    };
  }

  function getOpenAIDiagnostics(doc) {
    const currentDoc = getDocument(doc);
    const inputs = queryAll(currentDoc, 'input');
    const visibleInputs = inputs.filter((input) => isVisibleElement(input, currentDoc));
    const genericInputs = visibleInputs.filter((input) => isGenericTextInput(input));
    const active = getActiveElement(currentDoc);
    return {
      inputCount: inputs.length,
      visibleInputCount: visibleInputs.length,
      genericInputCount: genericInputs.length,
      activeTag: active?.tagName || '',
      activeInput: active ? getInputName(active).slice(0, 80) : '',
      emailPageHint: hasEmailPageHint(getPageText(currentDoc)),
    };
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && !root.__CpaCodexOAuthOpenAIListenerAttached) {
    root.__CpaCodexOAuthOpenAIListenerAttached = true;
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.type !== 'CPA_OPENAI_AUTH') {
        return false;
      }

      try {
        if (message.action === 'CLASSIFY') {
          sendResponse({ ok: true, result: publicState(classifyAuthState()) });
          return false;
        }
        if (message.action === 'FILL_EMAIL') {
          sendResponse(fillEmail(null, message.email));
          return false;
        }
        if (message.action === 'READ_EMAIL') {
          sendResponse({ ok: true, result: { email: readEmailValue() } });
          return false;
        }
        if (message.action === 'FILL_CODE') {
          sendResponse(fillVerificationCode(null, message.code));
          return false;
        }
        if (message.action === 'CLICK_ACTION') {
          sendResponse(clickLikelyAction(null, message.words));
          return false;
        }
        sendResponse({ ok: false, error: 'unknown_action' });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
      return false;
    });
  }

  return {
    ACTION_WORDS,
    classifyAuthState,
    clickLikelyAction,
    fillEmail,
    fillVerificationCode,
    findCodeInput,
    findEmailInput,
    findSplitCodeInputs,
    findLikelyAction,
    getPageText,
    getOpenAIDiagnostics,
    isVisibleElement,
    readEmailValue,
  };
});
