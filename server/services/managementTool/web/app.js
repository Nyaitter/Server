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

// ── Tab Switching Logic (Event Delegation) ──
function switchTab(tabName) {
  if (!tabName) return;
  state.activeTab = tabName;

  // 1. Update navigation button states
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // 2. Update panel contents
  document.querySelectorAll('.tab-content').forEach((content) => {
    content.classList.toggle('active', content.id === `tab-${tabName}`);
  });

  // 3. Load tab specific data
  if (tabName === 'status') loadStatus();
  if (tabName === 'logs') loadLogs();
  if (tabName === 'errors') loadErrors();
  if (tabName === 'settings') loadSettings();
}

function switchSubtab(subtabName) {
  if (!subtabName) return;
  state.activeSubtab = subtabName;

  document.querySelectorAll('.subtab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.subtab === subtabName);
  });

  document.querySelectorAll('.subtab-content').forEach((content) => {
    content.classList.toggle('active', content.id === `subtab-${subtabName}`);
  });
}

// ── Auth Handling ──
async function checkAuth() {
  try {
    const data = await api('/api/auth/me');
    if (!data.authenticated && data.requiresPassword) {
      showLoginModal();
    } else {
      hideLoginModal();
      const logoutBtn = document.getElementById('logout-btn');
      if (logoutBtn) logoutBtn.classList.toggle('hidden', !data.requiresPassword);
    }
  } catch (_) {}
}

function showLoginModal() {
  const modal = document.getElementById('login-modal');
  if (modal) modal.classList.remove('hidden');
}

function hideLoginModal() {
  const modal = document.getElementById('login-modal');
  if (modal) modal.classList.add('hidden');
}

// ── 1. Status Tab Logic ──
async function loadStatus() {
  try {
    const data = await api('/api/status');
    const serverOnline = Boolean(data.server?.online);

    // Pill in navbar
    const pill = document.getElementById('server-status-pill');
    if (pill) {
      pill.textContent = serverOnline ? 'サーバー稼働中' : 'サーバー停止中';
      pill.className = `status-pill ${serverOnline ? 'status-online' : 'status-offline'}`;
    }

    // Card 1: NyaitterServer
    const sBadge = document.getElementById('server-badge');
    if (sBadge) {
      sBadge.textContent = serverOnline ? 'Online' : 'Offline';
      sBadge.className = `badge ${serverOnline ? 'badge-online' : 'badge-offline'}`;
    }

    const sStatus = document.getElementById('server-process-status');
    if (sStatus) sStatus.textContent = serverOnline ? '正常稼働中' : '停止中';

    const sPid = document.getElementById('server-pid');
    if (sPid) sPid.textContent = data.server?.pid || (serverOnline ? '稼働中' : '-');

    const sPort = document.getElementById('server-port');
    if (sPort) sPort.textContent = data.server?.port || 3000;

    // Card 2: NMT
    const nPid = document.getElementById('nmt-pid');
    if (nPid) nPid.textContent = data.nmt?.pid || '-';

    const nUptime = document.getElementById('nmt-uptime');
    if (nUptime) nUptime.textContent = formatUptime(data.nmt?.uptime || 0);

    const nPort = document.getElementById('nmt-port');
    if (nPort) nPort.textContent = data.nmt?.port || 4040;

    // Card 3: Database
    const dbBadge = document.getElementById('db-badge');
    const dbConnected = data.database?.status === 'connected';
    if (dbBadge) {
      dbBadge.textContent = dbConnected ? 'Connected' : (data.database?.status || '-');
      dbBadge.className = `badge ${dbConnected ? 'badge-online' : 'badge-offline'}`;
    }

    const dbStatus = document.getElementById('db-status');
    if (dbStatus) dbStatus.textContent = dbConnected ? '接続完了' : (data.database?.status || '未接続');

    const dbErr = document.getElementById('db-error');
    if (dbErr) dbErr.textContent = data.database?.error || 'なし';

    // Card 4: System
    const sysMem = document.getElementById('sys-memory');
    if (sysMem) sysMem.textContent = `${data.nmt?.memoryMb || 0} MB`;

    const sysCpu = document.getElementById('sys-cpu');
    if (sysCpu) sysCpu.textContent = `${data.nmt?.cpuPercent || 0} %`;

    const sysNode = document.getElementById('sys-node');
    if (sysNode) sysNode.textContent = data.system?.nodeVersion || '-';
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
    if (!msgEl) return;
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
      showMsg(res.message || '再起動中... 4秒後にリロードします', true);
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

// ── 2. Logs Tab Logic ──
function setupWebSocket() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${location.host}/ws`;

  try {
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.onopen = () => {
      const ind = document.getElementById('ws-status');
      if (ind) {
        ind.textContent = 'LIVE';
        ind.className = 'status-indicator live';
      }
    };

    ws.onclose = () => {
      const ind = document.getElementById('ws-status');
      if (ind) {
        ind.textContent = '切断';
        ind.className = 'status-indicator text-muted';
      }
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
  } catch (_) {}
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
  if (!container) return;
  container.innerHTML = '';

  const levelFilter = document.getElementById('log-level-filter')?.value || 'all';
  const searchFilter = document.getElementById('log-search-input')?.value?.toLowerCase() || '';

  const filtered = state.logs.filter((log) => {
    if (levelFilter !== 'all' && log.level !== levelFilter) return false;
    if (searchFilter && !log.message?.toLowerCase().includes(searchFilter)) return false;
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">表示可能なログはありません</div>';
    return;
  }

  for (const log of filtered) {
    appendLogToTerminal(log, false);
  }

  const autoscroll = document.getElementById('log-autoscroll');
  if (!autoscroll || autoscroll.checked) {
    container.scrollTop = container.scrollHeight;
  }
}

function appendLogToTerminal(log, autoScroll = true) {
  const container = document.getElementById('terminal-logs');
  if (!container) return;
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

  const autoscroll = document.getElementById('log-autoscroll');
  if (autoScroll && (!autoscroll || autoscroll.checked)) {
    container.scrollTop = container.scrollHeight;
  }
}

// ── 3. Errors Tab Logic ──
async function loadErrors() {
  const status = document.getElementById('error-status-filter')?.value || 'all';
  const search = document.getElementById('error-search-input')?.value || '';

  try {
    const data = await api(`/api/errors?status=${status}&search=${encodeURIComponent(search)}`);
    state.errors = data.errors || [];

    const badge = document.getElementById('errors-count-badge');
    if (badge) {
      if (data.openCount > 0) {
        badge.textContent = data.openCount;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }

    renderErrors();
  } catch (_) {}
}

function renderErrors() {
  const container = document.getElementById('errors-list');
  if (!container) return;
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
      if (details) details.classList.toggle('hidden');
    });

    container.appendChild(card);
  }
}

// ── 4. Settings Tab Logic ──
async function loadSettings() {
  try {
    const envData = await api('/api/settings/env');
    const envEditor = document.getElementById('env-editor');
    if (envEditor) envEditor.value = envData.content || '';

    const configData = await api('/api/settings/config');
    const cfgEditor = document.getElementById('config-editor');
    if (cfgEditor) cfgEditor.value = JSON.stringify(configData.config || {}, null, 2);
  } catch (_) {}
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Main Setup & Listeners ──
function setupEventListeners() {
  // Navigation Tabs (Event Delegation)
  document.querySelector('.tabs-nav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn && btn.dataset.tab) {
      switchTab(btn.dataset.tab);
    }
  });

  // Settings Subtabs (Event Delegation)
  document.querySelector('.settings-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.subtab-btn');
    if (btn && btn.dataset.subtab) {
      switchSubtab(btn.dataset.subtab);
    }
  });

  // Log filter inputs
  document.getElementById('log-level-filter')?.addEventListener('change', renderLogs);
  document.getElementById('log-search-input')?.addEventListener('input', renderLogs);
  document.getElementById('btn-clear-logs')?.addEventListener('click', async () => {
    await api('/api/logs', { method: 'DELETE' });
    state.logs = [];
    renderLogs();
  });

  // Error filter inputs
  document.getElementById('error-status-filter')?.addEventListener('change', loadErrors);
  document.getElementById('error-search-input')?.addEventListener('input', loadErrors);
  document.getElementById('btn-refresh-errors')?.addEventListener('click', loadErrors);
  document.getElementById('btn-clear-errors')?.addEventListener('click', async () => {
    if (!confirm('すべてのエラー記録を消去しますか？')) return;
    await api('/api/errors', { method: 'DELETE' });
    loadErrors();
  });

  // Settings save button
  document.getElementById('btn-save-settings')?.addEventListener('click', async () => {
    const msgEl = document.getElementById('settings-message');
    const showMsg = (text, isSuccess) => {
      if (!msgEl) return;
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

  // Login form & logout
  document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    if (errEl) errEl.classList.add('hidden');

    try {
      const res = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      if (res.success && res.token) {
        state.token = res.token;
        localStorage.setItem('nmt_token', res.token);
        hideLoginModal();
        loadStatus();
        loadErrors();
      } else if (errEl) {
        errEl.textContent = res.error || 'ログインに失敗しました';
        errEl.classList.remove('hidden');
      }
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message || 'ログインに失敗しました';
        errEl.classList.remove('hidden');
      }
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

  setupControls();
}

// ── Init ──
function init() {
  setupEventListeners();
  setupWebSocket();
  loadStatus();
  loadErrors();
  checkAuth();

  if (state.statusTimer) clearInterval(state.statusTimer);
  state.statusTimer = setInterval(() => {
    if (state.activeTab === 'status') loadStatus();
  }, 3000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
