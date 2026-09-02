'use strict';

// ── State ──
const state = {
  token: localStorage.getItem('nmt_token') || '',
  activeTab: 'status',
  activeSubtab: 'env',
  statusTimer: null,
  ws: null,
  logs: [],
  errors: [],
};

// ── Helper: API Request ──
async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    showLoginModal();
    throw new Error('認証が必要です');
  }
  return res.json();
}

// ── Auth Handling ──
async function checkAuth() {
  try {
    const data = await api('/api/auth/me');
    if (!data.authenticated && data.requiresPassword) {
      showLoginModal();
    } else {
      hideLoginModal();
      document.getElementById('logout-btn').classList.toggle('hidden', !data.requiresPassword);
      init();
    }
  } catch (_) {
    showLoginModal();
  }
}

function showLoginModal() {
  document.getElementById('login-modal').classList.remove('hidden');
}

function hideLoginModal() {
  document.getElementById('login-modal').classList.add('hidden');
}

document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');

  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    if (res.success && res.token) {
      state.token = res.token;
      localStorage.setItem('nmt_token', res.token);
      hideLoginModal();
      init();
    } else {
      errEl.textContent = res.error || 'ログインに失敗しました';
      errEl.classList.remove('hidden');
    }
  } catch (err) {
    errEl.textContent = err.message || 'ログインに失敗しました';
    errEl.classList.remove('hidden');
  }
});

document.getElementById('logout-btn')?.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (_) {}
  state.token = '';
  localStorage.removeItem('nmt_token');
  showLoginModal();
});

// ── Tab Switching ──
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));

    btn.classList.add('active');
    const tabName = btn.dataset.tab;
    state.activeTab = tabName;
    document.getElementById(`tab-${tabName}`).classList.add('active');

    if (tabName === 'status') loadStatus();
    if (tabName === 'logs') loadLogs();
    if (tabName === 'errors') loadErrors();
    if (tabName === 'settings') loadSettings();
  });
});

// ── Settings Subtab Switching ──
document.querySelectorAll('.subtab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.subtab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.subtab-content').forEach((c) => c.classList.remove('active'));

    btn.classList.add('active');
    const subtab = btn.dataset.subtab;
    state.activeSubtab = subtab;
    document.getElementById(`subtab-${subtab}`).classList.add('active');
  });
});

// ── 1. Status Tab Logic ──
async function loadStatus() {
  try {
    const data = await api('/api/status');
    const serverOnline = Boolean(data.server?.online);

    const pill = document.getElementById('server-status-pill');
    if (serverOnline) {
      pill.textContent = 'サーバー稼働中';
      pill.className = 'status-pill status-online';
    } else {
      pill.textContent = 'サーバー停止中';
      pill.className = 'status-pill status-offline';
    }

    const sBadge = document.getElementById('server-badge');
    sBadge.textContent = serverOnline ? 'Online' : 'Offline';
    sBadge.className = `badge ${serverOnline ? 'badge-online' : 'badge-offline'}`;

    document.getElementById('server-process-status').textContent = serverOnline ? '正常稼働中' : '停止中';
    document.getElementById('server-pid').textContent = data.server?.pid || '-';
    document.getElementById('server-port').textContent = data.server?.port || 3000;

    document.getElementById('nmt-pid').textContent = data.nmt?.pid || '-';
    document.getElementById('nmt-uptime').textContent = formatUptime(data.nmt?.uptime || 0);
    document.getElementById('nmt-port').textContent = data.nmt?.port || 4040;

    const dbBadge = document.getElementById('db-badge');
    const dbConnected = data.database?.status === 'connected';
    dbBadge.textContent = dbConnected ? 'Connected' : (data.database?.status || '-');
    dbBadge.className = `badge ${dbConnected ? 'badge-online' : 'badge-offline'}`;
    document.getElementById('db-status').textContent = dbConnected ? '接続完了' : (data.database?.status || '未接続');
    document.getElementById('db-error').textContent = data.database?.error || 'なし';

    document.getElementById('sys-memory').textContent = `${data.nmt?.memoryMb || 0} MB`;
    document.getElementById('sys-cpu').textContent = `${data.nmt?.cpuPercent || 0} %`;
    document.getElementById('sys-node').textContent = data.system?.nodeVersion || '-';
  } catch (_) {}
}

function formatUptime(sec) {
  if (!sec) return '0秒';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}日 ${h}時間`;
  if (h > 0) return `${h}時間 ${m}分`;
  if (m > 0) return `${m}分 ${s}秒`;
  return `${s}秒`;
}

// ── Process Control Actions ──
function setupControls() {
  const msgEl = document.getElementById('control-message');
  const showMsg = (text, isSuccess) => {
    msgEl.textContent = text;
    msgEl.className = `alert ${isSuccess ? 'alert-success' : 'alert-danger'}`;
    msgEl.classList.remove('hidden');
    setTimeout(() => msgEl.classList.add('hidden'), 6000);
  };

  document.getElementById('btn-server-restart')?.addEventListener('click', async () => {
    if (!confirm('NyaitterServer を再起動しますか？')) return;
    try {
      const res = await api('/api/server/restart', { method: 'POST' });
      showMsg(res.message || '再起動を開始しました', res.success !== false);
      setTimeout(loadStatus, 1500);
    } catch (e) {
      showMsg(e.message, false);
    }
  });

  document.getElementById('btn-server-stop')?.addEventListener('click', async () => {
    if (!confirm('NyaitterServer を停止しますか？')) return;
    try {
      const res = await api('/api/server/stop', { method: 'POST' });
      showMsg(res.message || '停止しました', res.success !== false);
      setTimeout(loadStatus, 1000);
    } catch (e) {
      showMsg(e.message, false);
    }
  });

  document.getElementById('btn-server-start')?.addEventListener('click', async () => {
    try {
      const res = await api('/api/server/start', { method: 'POST' });
      showMsg(res.message || '起動しました', res.success !== false);
      setTimeout(loadStatus, 1500);
    } catch (e) {
      showMsg(e.message, false);
    }
  });

  document.getElementById('btn-nmt-restart')?.addEventListener('click', async () => {
    if (!confirm('NMT 管理ツールを再起動しますか？')) return;
    try {
      const res = await api('/api/nmt/restart', { method: 'POST' });
      showMsg(res.message || '再起動中... 5秒後にリロードします', true);
      setTimeout(() => location.reload(), 4000);
    } catch (e) {
      showMsg(e.message, false);
    }
  });

  document.getElementById('refresh-all-btn')?.addEventListener('click', () => {
    loadStatus();
    loadErrors();
  });
}

// ── 2. Logs Tab Logic (WebSocket) ──
function setupWebSocket() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${location.host}/ws`;

  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    document.getElementById('ws-status').textContent = 'LIVE';
    document.getElementById('ws-status').className = 'status-indicator live';
  };

  ws.onclose = () => {
    document.getElementById('ws-status').textContent = '切断';
    document.getElementById('ws-status').className = 'status-indicator text-muted';
    setTimeout(setupWebSocket, 3000);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'init' && Array.isArray(data.logs)) {
        state.logs = data.logs;
        renderLogs();
      } else if (data.type === 'log' && data.log) {
        state.logs.push(data.log);
        if (state.logs.length > 2000) state.logs.shift();
        appendLogToTerminal(data.log);
      }
    } catch (_) {}
  };
}

async function loadLogs() {
  try {
    const data = await api('/api/logs?limit=300');
    if (data.logs) {
      state.logs = data.logs;
      renderLogs();
    }
  } catch (_) {}
}

function renderLogs() {
  const container = document.getElementById('terminal-logs');
  container.innerHTML = '';

  const levelFilter = document.getElementById('log-level-filter').value;
  const searchFilter = document.getElementById('log-search-input').value.toLowerCase();

  const filtered = state.logs.filter((log) => {
    if (levelFilter !== 'all' && log.level !== levelFilter) return false;
    if (searchFilter && !log.message.toLowerCase().includes(searchFilter)) return false;
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">表示可能なログはありません</div>';
    return;
  }

  for (const log of filtered) {
    appendLogToTerminal(log, false);
  }

  if (document.getElementById('log-autoscroll').checked) {
    container.scrollTop = container.scrollHeight;
  }
}

function appendLogToTerminal(log, autoScroll = true) {
  const container = document.getElementById('terminal-logs');
  const empty = container.querySelector('.empty-state');
  if (empty) container.innerHTML = '';

  const line = document.createElement('div');
  line.className = 'log-line';

  const timeStr = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '';
  const level = log.level || 'info';

  line.innerHTML = `
    <span class="log-time">${timeStr}</span>
    <span class="log-badge log-badge-${level}">${level.toUpperCase()}</span>
    <span class="log-msg">${escapeHtml(log.message)}</span>
  `;

  container.appendChild(line);

  if (autoScroll && document.getElementById('log-autoscroll').checked) {
    container.scrollTop = container.scrollHeight;
  }
}

document.getElementById('log-level-filter')?.addEventListener('change', renderLogs);
document.getElementById('log-search-input')?.addEventListener('input', renderLogs);
document.getElementById('btn-clear-logs')?.addEventListener('click', async () => {
  await api('/api/logs', { method: 'DELETE' });
  state.logs = [];
  renderLogs();
});

// ── 3. Errors Tab Logic ──
async function loadErrors() {
  const status = document.getElementById('error-status-filter').value;
  const search = document.getElementById('error-search-input').value;

  try {
    const data = await api(`/api/errors?status=${status}&search=${encodeURIComponent(search)}`);
    state.errors = data.errors || [];

    const badge = document.getElementById('errors-count-badge');
    if (data.openCount > 0) {
      badge.textContent = data.openCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    renderErrors();
  } catch (_) {}
}

function renderErrors() {
  const container = document.getElementById('errors-list');
  container.innerHTML = '';

  if (state.errors.length === 0) {
    container.innerHTML = '<div class="empty-state">該当するエラーはありません</div>';
    return;
  }

  for (const err of state.errors) {
    const card = document.createElement('div');
    card.className = 'error-card';

    const timeStr = err.lastOccurredAt ? new Date(err.lastOccurredAt).toLocaleString() : '';
    const countBadge = err.count > 1 ? `<span class="badge badge-danger">×${err.count}回</span>` : '';

    card.innerHTML = `
      <div class="error-card-header">
        <div class="error-msg">${escapeHtml(err.message)}</div>
        <div>${countBadge}</div>
      </div>
      <div class="error-meta">
        <span>発生元: ${escapeHtml(err.source || 'server')}</span>
        <span>最終発生: ${timeStr}</span>
        <span>状態: <strong>${err.status}</strong></span>
      </div>
      <div class="error-details hidden">
        ${err.stack ? escapeHtml(err.stack) : 'スタックトレースなし'}
      </div>
    `;

    card.addEventListener('click', () => {
      const details = card.querySelector('.error-details');
      details.classList.toggle('hidden');
    });

    container.appendChild(card);
  }
}

document.getElementById('error-status-filter')?.addEventListener('change', loadErrors);
document.getElementById('error-search-input')?.addEventListener('input', loadErrors);
document.getElementById('btn-refresh-errors')?.addEventListener('click', loadErrors);
document.getElementById('btn-clear-errors')?.addEventListener('click', async () => {
  if (!confirm('すべてのエラー記録を消去しますか？')) return;
  await api('/api/errors', { method: 'DELETE' });
  loadErrors();
});

// ── 4. Settings Tab Logic ──
async function loadSettings() {
  try {
    const envData = await api('/api/settings/env');
    document.getElementById('env-editor').value = envData.content || '';

    const configData = await api('/api/settings/config');
    document.getElementById('config-editor').value = JSON.stringify(configData.config || {}, null, 2);
  } catch (_) {}
}

document.getElementById('btn-save-settings')?.addEventListener('click', async () => {
  const msgEl = document.getElementById('settings-message');
  const showMsg = (text, isSuccess) => {
    msgEl.textContent = text;
    msgEl.className = `alert ${isSuccess ? 'alert-success' : 'alert-danger'}`;
    msgEl.classList.remove('hidden');
    setTimeout(() => msgEl.classList.add('hidden'), 6000);
  };

  try {
    if (state.activeSubtab === 'env') {
      const content = document.getElementById('env-editor').value;
      const res = await api('/api/settings/env', {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
      showMsg(res.message || '.env を保存しました', true);
    } else {
      const raw = document.getElementById('config-editor').value;
      const parsed = JSON.parse(raw);
      const res = await api('/api/settings/config', {
        method: 'POST',
        body: JSON.stringify({ config: parsed }),
      });
      showMsg(res.message || 'config.json を保存しました', true);
    }
  } catch (err) {
    showMsg(err.message || '保存に失敗しました', false);
  }
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──
function init() {
  setupControls();
  setupWebSocket();
  loadStatus();
  loadErrors();

  if (state.statusTimer) clearInterval(state.statusTimer);
  state.statusTimer = setInterval(() => {
    if (state.activeTab === 'status') loadStatus();
  }, 3000);
}

// Start
checkAuth();
