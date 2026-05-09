(function initSidePanel() {
  const startButton = document.getElementById('start');
  const stopButton = document.getElementById('stop');
  const readPoolsButton = document.getElementById('read-pools');
  const phase = document.getElementById('phase');
  const message = document.getElementById('message');
  const updated = document.getElementById('updated');
  const dot = document.getElementById('state-dot');
  const invalidCount = document.getElementById('invalid-count');
  const hotmailCount = document.getElementById('hotmail-count');
  const invalidList = document.getElementById('invalid-list');
  const hotmailList = document.getElementById('hotmail-list');

  function send(action) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'CPA_OAUTH_PANEL', action }, (response) => {
        resolve(response || { ok: false, error: chrome.runtime?.lastError?.message || 'No response.' });
      });
    });
  }

  function statusClass(status) {
    if (!status) return 'idle';
    if (status.phase === 'done') return 'done';
    if (status.phase === 'error') return 'error';
    if (status.phase === 'manual_required') return 'manual_required';
    if (status.running) return 'running';
    return 'idle';
  }

  function renderStatus(status, fallbackError = '') {
    const current = status || {};
    const phaseLabel = current.phase || 'idle';
    phase.textContent = phaseLabel.replace(/_/g, ' ');
    message.textContent = current.message || fallbackError || 'Ready.';
    updated.textContent = current.updatedAt
      ? new Date(current.updatedAt).toLocaleTimeString()
      : '';
    dot.className = `dot ${statusClass(current)}`;
    startButton.disabled = Boolean(current.running);
    stopButton.disabled = !current.running;
  }

  function clearList(container, emptyText) {
    container.replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyText;
    container.appendChild(empty);
  }

  function appendMeta(parent, text, className = 'meta') {
    const meta = document.createElement('span');
    meta.className = className;
    meta.textContent = text;
    parent.appendChild(meta);
  }

  function renderInvalidAccounts(accounts) {
    invalidList.replaceChildren();
    if (!accounts.length) {
      clearList(invalidList, '暂无失效账号');
      return;
    }
    for (const account of accounts) {
      const row = document.createElement('article');
      row.className = 'row';
      const title = document.createElement('strong');
      title.textContent = account.email || account.name || account.authIndex || '-';
      row.appendChild(title);
      appendMeta(row, `${account.reason || account.status || 'unknown'} · ${account.planType || 'unknown'} · ${account.authIndex || '-'}`);
      invalidList.appendChild(row);
    }
  }

  function renderHotmailAccounts(accounts) {
    hotmailList.replaceChildren();
    if (!accounts.length) {
      clearList(hotmailList, '暂无 Hotmail 账号');
      return;
    }
    for (const account of accounts) {
      const row = document.createElement('article');
      row.className = 'row';
      const title = document.createElement('strong');
      title.textContent = account.email || '-';
      row.appendChild(title);
      appendMeta(row, `密码：${account.password || '-'}`, 'meta password');
      appendMeta(row, `Client ID：${account.clientId || '-'} · ${account.status || 'pending'} · Token ${account.hasRefreshToken ? '有' : '无'}`);
      hotmailList.appendChild(row);
    }
  }

  function renderPools(result) {
    const pools = result?.pools || {};
    const invalidAccounts = Array.isArray(pools.invalidAccounts) ? pools.invalidAccounts : [];
    const hotmailAccounts = Array.isArray(pools.hotmailAccounts) ? pools.hotmailAccounts : [];
    invalidCount.textContent = String(pools.counts?.invalidAccounts ?? invalidAccounts.length);
    hotmailCount.textContent = String(pools.counts?.hotmailAccounts ?? hotmailAccounts.length);
    renderInvalidAccounts(invalidAccounts);
    renderHotmailAccounts(hotmailAccounts);
  }

  async function refreshStatus() {
    const response = await send('GET_STATUS');
    renderStatus(response.status, response.error);
  }

  async function readPools() {
    readPoolsButton.disabled = true;
    const response = await send('READ_ACCOUNT_POOLS');
    readPoolsButton.disabled = false;
    renderStatus(response.status, response.error);
    if (!response.ok) {
      return;
    }
    renderPools(response.result);
  }

  startButton.addEventListener('click', async () => {
    renderStatus({ phase: 'starting', message: 'Starting...', running: true, updatedAt: Date.now() });
    const response = await send('START_AUTO_LOGIN');
    renderStatus(response.status, response.error);
  });

  stopButton.addEventListener('click', async () => {
    const response = await send('STOP_AUTO_LOGIN');
    renderStatus(response.status, response.error);
  });

  readPoolsButton.addEventListener('click', readPools);

  refreshStatus();
  readPools();
  setInterval(refreshStatus, 1500);
})();
