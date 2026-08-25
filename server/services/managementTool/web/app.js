'use strict';

let currentAdmin = null;

// ── API Helper ───────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = localStorage.getItem('nmt_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem('nmt_token');
    window.location.href = '/auth/login';
    throw new Error('Unauthorized');
  }
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ── Auth & Init ──────────────────────────────────────────────────────────
async function checkAuth() {
  // 1. URL ハッシュからトークンまたはエラーを取得
  const hash = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  const token = params.get('token');
  const error = params.get('error');

  if (error) {
    alert(`Authentication Error: ${error}`);
    history.replaceState(null, '', window.location.pathname);
  }

  if (token) {
    localStorage.setItem('nmt_token', token);
    history.replaceState(null, '', window.location.pathname);
  }

  // 2. 認証状態を確認
  try {
    const res = await api('/me');
    if (res.user && res.user.admin) {
      currentAdmin = res.user;
      document.getElementById('current-admin-name').textContent = currentAdmin?.name || `#${currentAdmin?.id}`;
      loadActiveTabData();
      return;
    }
  } catch (_) {}

  // 3. 未認証時は NyaitterAuth へリダイレクト
  window.location.href = '/auth/login';
}

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('nmt_token');
  window.location.href = '/auth/login';
});

// ── Tabs Navigation ──────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));

    btn.classList.add('active');
    const tabId = btn.dataset.tab;
    document.getElementById(tabId)?.classList.add('active');
    loadActiveTabData();
  });
});

function loadActiveTabData() {
  const activeTab = document.querySelector('.tab-pane.active')?.id;
  if (activeTab === 'errors-tab') loadErrors();
  if (activeTab === 'admins-tab') { loadAdmins(); loadAuditLogs(); }
  if (activeTab === 'security-tab') { loadSecurityEvents(); loadRecentAccessLogs(); }
  if (activeTab === 'server-tab') loadServerTab();
  if (activeTab === 'settings-tab') loadSettings();
}

// ── 1. Errors ────────────────────────────────────────────────────────────
async function loadErrors() {
  const listEl = document.getElementById('errors-list');
  const status = document.getElementById('error-filter-status').value;
  const search = document.getElementById('error-search-input').value.trim();

  try {
    const data = await api(`/errors?status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}`);
    const errors = data.errors || [];

    const openCount = errors.filter((e) => e.status === 'open').length;
    const badge = document.getElementById('open-error-badge');
    if (openCount > 0) {
      badge.textContent = openCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    if (errors.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No errors recorded.</div>';
      return;
    }

    listEl.innerHTML = errors.map((err) => `
      <div class="card" data-error-id="${escapeHTML(err.id)}">
        <div class="card-header">
          <span class="card-title">${escapeHTML(err.message)}</span>
          <span class="tag tag-${err.status}">${err.status.toUpperCase()}</span>
        </div>
        <div class="card-meta">
          <span>${new Date(err.timestamp).toLocaleTimeString()}</span>
          <span>Hits: ${err.occurrences || 1}</span>
          ${err.fixed ? '<span style="color:#3fb950; font-weight:bold;">[Fixed]</span>' : ''}
          ${err.analysis ? '<span style="color:var(--primary-color)">[Analyzed]</span>' : ''}
          ${err.prUrl ? `<a href="${escapeHTML(err.prUrl)}" target="_blank" onclick="event.stopPropagation()" style="color:#58a6ff; font-weight:bold;">PR #${err.prUrl.split('/').pop()}</a>` : ''}
          ${err.issueUrl ? `<a href="${escapeHTML(err.issueUrl)}" target="_blank" onclick="event.stopPropagation()">Issue #${err.issueUrl.split('/').pop()}</a>` : ''}
        </div>
      </div>
    `).join('');

    listEl.querySelectorAll('.card').forEach((card) => {
      card.addEventListener('click', () => openErrorDetail(card.dataset.errorId));
    });
  } catch (err) {
    listEl.innerHTML = `<div class="error-msg">Failed to load errors: ${escapeHTML(err.message)}</div>`;
  }
}

document.getElementById('error-filter-status').addEventListener('change', loadErrors);
document.getElementById('error-search-input').addEventListener('input', debounce(loadErrors, 300));
document.getElementById('refresh-errors-btn').addEventListener('click', loadErrors);

async function openErrorDetail(errorId) {
  const err = await api(`/errors/${encodeURIComponent(errorId)}`);
  if (!err) return;

  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const modalFooter = document.getElementById('modal-footer');

  modalTitle.textContent = `Error: ${err.id}`;
  modalBody.innerHTML = `
    <div style="margin-bottom: 0.8rem;">
      <div style="font-weight:600; color:var(--danger-color); font-size:13px;">${escapeHTML(err.message)}</div>
      <div style="color:var(--secondary-text-color); font-size:11px; margin-top:0.3rem;">
        Time: ${new Date(err.timestamp).toLocaleString()} | Hits: ${err.occurrences || 1}<br>
        Request: ${escapeHTML(err.context?.method || 'GET')} ${escapeHTML(err.context?.url || 'N/A')}<br>
        IP: ${escapeHTML(err.context?.ip || 'N/A')} | UA: ${escapeHTML(err.context?.userAgent || 'N/A')}
      </div>
      ${err.fixed ? `<div style="margin-top:0.4rem; color:#3fb950; font-size:12px;"><strong>Status:</strong> Automatically fixed${err.modifiedFiles?.length ? ` (${err.modifiedFiles.join(', ')})` : ''}</div>` : ''}
      ${err.prUrl ? `<div style="margin-top:0.3rem;"><a href="${escapeHTML(err.prUrl)}" target="_blank" style="color:#58a6ff;">View Pull Request: #${err.prUrl.split('/').pop()}</a></div>` : ''}
    </div>
    ${err.stack ? `<div><div class="code-box">${escapeHTML(err.stack)}</div></div>` : ''}
    <div id="modal-ai-section">
      ${err.analysis ? `
        <div class="ai-panel">
          <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--secondary-text-color);">
            <strong style="color:var(--primary-color);">AI Analysis (${escapeHTML(err.analysis.model)})</strong>
            <span>${new Date(err.analysis.analyzedAt).toLocaleTimeString()}</span>
          </div>
          <div style="margin-top:0.5rem; font-size:12px;">${formatMarkdown(err.analysis.content)}</div>
        </div>
      ` : ''}
    </div>
  `;

  modalFooter.innerHTML = `
    <button class="btn btn-secondary btn-sm" id="modal-fix-btn">Auto Fix</button>
    <button class="btn btn-secondary btn-sm" id="modal-analyze-btn">Analyze</button>
    ${err.fixed && !err.prUrl ? '<button class="btn btn-secondary btn-sm" id="modal-pr-btn">Create PR</button>' : ''}
    ${!err.issueUrl ? '<button class="btn btn-secondary btn-sm" id="modal-issue-btn">Create Issue</button>' : ''}
    ${err.status !== 'resolved' ? '<button class="btn btn-primary btn-sm" id="modal-resolve-btn">Resolve</button>' : '<button class="btn btn-secondary btn-sm" id="modal-reopen-btn">Reopen</button>'}
  `;

  document.getElementById('modal-fix-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('modal-fix-btn');
    btn.disabled = true;
    btn.textContent = 'Fixing...';
    try {
      const res = await api(`/errors/${encodeURIComponent(errorId)}/fix`, { method: 'POST' });
      alert(res.fixed ? `Auto-fix succeeded! Modified: ${res.modifiedFiles?.join(', ')}` : 'Fix completed.');
      openErrorDetail(errorId);
      loadErrors();
    } catch (e) {
      alert(`Auto-fix error: ${e.message}`);
      btn.disabled = false;
      btn.textContent = 'Auto Fix';
    }
  });

  document.getElementById('modal-pr-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('modal-pr-btn');
    btn.disabled = true;
    btn.textContent = 'Creating PR...';
    try {
      const res = await api(`/errors/${encodeURIComponent(errorId)}/pr`, { method: 'POST' });
      alert(`Pull Request created: ${res.prUrl}`);
      openErrorDetail(errorId);
      loadErrors();
    } catch (e) {
      alert(`PR creation error: ${e.message}`);
      btn.disabled = false;
      btn.textContent = 'Create PR';
    }
  });

  document.getElementById('modal-analyze-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('modal-analyze-btn');
    btn.disabled = true;
    btn.textContent = 'Analyzing...';
    try {
      await api(`/errors/${encodeURIComponent(errorId)}/analyze`, { method: 'POST' });
      openErrorDetail(errorId);
    } catch (e) {
      alert(`AI error: ${e.message}`);
      btn.disabled = false;
      btn.textContent = 'Analyze';
    }
  });

  document.getElementById('modal-issue-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('modal-issue-btn');
    btn.disabled = true;
    btn.textContent = 'Creating Issue...';
    try {
      const res = await api(`/errors/${encodeURIComponent(errorId)}/issue`, { method: 'POST' });
      alert(`Issue created: ${res.issueUrl}`);
      openErrorDetail(errorId);
    } catch (e) {
      alert(`Issue error: ${e.message}`);
      btn.disabled = false;
      btn.textContent = 'Create Issue';
    }
  });

  document.getElementById('modal-resolve-btn')?.addEventListener('click', async () => {
    await api(`/errors/${encodeURIComponent(errorId)}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
    closeModal();
    loadErrors();
  });

  document.getElementById('modal-reopen-btn')?.addEventListener('click', async () => {
    await api(`/errors/${encodeURIComponent(errorId)}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'open' }) });
    closeModal();
    loadErrors();
  });

  showModal();
}

// ── 2. Admins ────────────────────────────────────────────────────────────
async function loadAdmins() {
  const container = document.getElementById('admins-list');
  try {
    const data = await api('/admins');
    const admins = data.admins || [];
    if (admins.length === 0) {
      container.innerHTML = '<div class="empty-state">No admins found.</div>';
      return;
    }

    container.innerHTML = admins.map((adm) => `
      <div class="admin-cell">
        <div>
          <div style="font-weight:600;">${escapeHTML(adm.name || 'Unnamed')}</div>
          <div style="font-size:11px; color:var(--secondary-text-color);">#${adm.id} (@${escapeHTML(adm.scid || 'none')})</div>
        </div>
        ${Number(adm.id) !== Number(currentAdmin?.id) ? `
          <button class="btn btn-secondary btn-sm btn-danger-action" data-user-id="${adm.id}">Revoke</button>
        ` : '<span class="tag tag-resolved">You</span>'}
      </div>
    `).join('');

    container.querySelectorAll('.btn-danger-action').forEach((btn) => {
      btn.addEventListener('click', () => updateAdminStatus(btn.dataset.userId, false));
    });
  } catch (err) {
    container.innerHTML = `<div class="error-msg">Failed to load admins: ${escapeHTML(err.message)}</div>`;
  }
}

document.getElementById('user-search-btn').addEventListener('click', async () => {
  const q = document.getElementById('user-search-input').value.trim();
  const resultsEl = document.getElementById('user-search-results');
  if (!q) return;

  resultsEl.innerHTML = '<div class="empty-state">Searching...</div>';
  try {
    const data = await api(`/users/search?q=${encodeURIComponent(q)}`);
    const users = data.users || [];
    if (users.length === 0) {
      resultsEl.innerHTML = '<div class="empty-state">No users found.</div>';
      return;
    }

    resultsEl.innerHTML = users.map((u) => `
      <div class="admin-cell" style="margin-bottom:0.4rem;">
        <div>
          <span style="font-weight:600;">${escapeHTML(u.name || 'Unnamed')}</span>
          <span style="font-size:11px; color:var(--secondary-text-color); margin-left:0.4rem;">#${u.id} (@${escapeHTML(u.scid || 'none')}) - ${u.admin ? 'Admin' : 'User'}</span>
        </div>
        <button class="btn ${u.admin ? 'btn-secondary' : 'btn-primary'} btn-sm" data-user-id="${u.id}" data-set-admin="${!u.admin}">
          ${u.admin ? 'Revoke Admin' : 'Grant Admin'}
        </button>
      </div>
    `).join('');

    resultsEl.querySelectorAll('button[data-set-admin]').forEach((btn) => {
      btn.addEventListener('click', () => updateAdminStatus(btn.dataset.userId, btn.dataset.setAdmin === 'true'));
    });
  } catch (e) {
    resultsEl.innerHTML = `<div class="error-msg">Search error: ${escapeHTML(e.message)}</div>`;
  }
});

async function updateAdminStatus(userId, makeAdmin) {
  const actionText = makeAdmin ? 'grant admin to' : 'revoke admin from';
  if (!confirm(`Are you sure to ${actionText} user #${userId}?`)) return;

  try {
    await api(`/admins/${encodeURIComponent(userId)}`, {
      method: 'POST',
      body: JSON.stringify({ admin: makeAdmin }),
    });
    loadAdmins();
    loadAuditLogs();
    const searchInput = document.getElementById('user-search-input');
    if (searchInput.value.trim()) document.getElementById('user-search-btn').click();
  } catch (err) {
    alert(`Update error: ${err.message}`);
  }
}

async function loadAuditLogs() {
  const el = document.getElementById('admin-audit-logs');
  try {
    const data = await api('/admins/audit-logs');
    const logs = data.logs || [];
    if (logs.length === 0) {
      el.innerHTML = '<div class="empty-state">No audit logs.</div>';
      return;
    }

    el.innerHTML = `
      <table>
        <thead>
          <tr><th>Time</th><th>Operator</th><th>Target</th><th>Action</th></tr>
        </thead>
        <tbody>
          ${logs.map((l) => `
            <tr>
              <td>${new Date(l.timestamp).toLocaleString()}</td>
              <td>${escapeHTML(l.operatorName)} (#${l.operatorId || 'N/A'})</td>
              <td>${escapeHTML(l.targetUserName)} (#${l.targetUserId})</td>
              <td><span class="tag ${l.action === 'grant_admin' ? 'tag-resolved' : 'tag-open'}">${l.action === 'grant_admin' ? 'Grant' : 'Revoke'}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    el.innerHTML = `<div class="error-msg">Audit log error: ${escapeHTML(e.message)}</div>`;
  }
}

// ── 3. Security ──────────────────────────────────────────────────────────
async function loadSecurityEvents() {
  const listEl = document.getElementById('security-events-list');
  const severity = document.getElementById('security-filter-severity').value;

  try {
    const data = await api(`/security/events?severity=${encodeURIComponent(severity)}`);
    const events = data.events || [];

    const badge = document.getElementById('security-alert-badge');
    if (events.length > 0) {
      badge.textContent = events.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    if (events.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No suspicious events recorded.</div>';
      return;
    }

    listEl.innerHTML = events.map((ev) => `
      <div class="card" data-security-id="${ev.id}">
        <div class="card-header">
          <span class="card-title">${escapeHTML(ev.reason)}</span>
          <span class="tag tag-${ev.severity === 'high' ? 'open' : 'ignored'}">${ev.severity.toUpperCase()}</span>
        </div>
        <div class="card-meta">
          <span>${new Date(ev.timestamp).toLocaleString()}</span>
          <span>IP: ${escapeHTML(ev.ip)}</span>
          <span>${escapeHTML(ev.method)} ${escapeHTML(ev.url)} (${ev.statusCode})</span>
          ${ev.analysis ? '<span style="color:var(--primary-color)">[Analyzed]</span>' : ''}
        </div>
      </div>
    `).join('');

    listEl.querySelectorAll('.card').forEach((card) => {
      card.addEventListener('click', () => openSecurityDetail(card.dataset.securityId));
    });
  } catch (e) {
    listEl.innerHTML = `<div class="error-msg">Security log error: ${escapeHTML(e.message)}</div>`;
  }
}

document.getElementById('security-filter-severity').addEventListener('change', loadSecurityEvents);
document.getElementById('refresh-security-btn').addEventListener('click', () => {
  loadSecurityEvents();
  loadRecentAccessLogs();
});

async function openSecurityDetail(eventId) {
  const data = await api(`/security/events`);
  const ev = data.events?.find((e) => e.id === eventId);
  if (!ev) return;

  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const modalFooter = document.getElementById('modal-footer');

  modalTitle.textContent = `Security Event: ${ev.id}`;
  modalBody.innerHTML = `
    <div style="margin-bottom:0.8rem;">
      <div style="color:var(--danger-color); font-weight:600; font-size:13px;">${escapeHTML(ev.reason)}</div>
      <div style="color:var(--secondary-text-color); font-size:11px; margin-top:0.3rem;">
        Time: ${new Date(ev.timestamp).toLocaleString()}<br>
        IP: ${escapeHTML(ev.ip)} | Status: ${ev.statusCode}<br>
        Path: ${escapeHTML(ev.method)} ${escapeHTML(ev.url)}<br>
        UA: ${escapeHTML(ev.userAgent)}
      </div>
    </div>
    ${ev.analysis ? `
      <div class="ai-panel">
        <strong style="color:var(--primary-color); font-size:11px;">AI Threat Analysis (${escapeHTML(ev.analysis.model)})</strong>
        <div style="margin-top:0.5rem; font-size:12px;">${formatMarkdown(ev.analysis.content)}</div>
      </div>
    ` : ''}
  `;

  modalFooter.innerHTML = `
    <button class="btn btn-secondary btn-sm" id="modal-sec-analyze-btn">Analyze</button>
    <button class="btn btn-primary btn-sm" onclick="closeModal()">Close</button>
  `;

  document.getElementById('modal-sec-analyze-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('modal-sec-analyze-btn');
    btn.disabled = true;
    btn.textContent = 'Analyzing...';
    try {
      await api(`/security/events/${encodeURIComponent(eventId)}/analyze`, { method: 'POST' });
      openSecurityDetail(eventId);
    } catch (e) {
      alert(`AI error: ${e.message}`);
      btn.disabled = false;
      btn.textContent = 'Analyze';
    }
  });

  showModal();
}

async function loadRecentAccessLogs() {
  const el = document.getElementById('recent-access-table');
  try {
    const logs = await api('/security/access-logs?limit=50');
    if (!logs || logs.length === 0) {
      el.innerHTML = '<div class="empty-state">No access logs.</div>';
      return;
    }

    el.innerHTML = `
      <table>
        <thead>
          <tr><th>Time</th><th>IP</th><th>Method</th><th>URL</th><th>Status</th><th>Duration</th></tr>
        </thead>
        <tbody>
          ${logs.map((l) => `
            <tr>
              <td>${new Date(l.timestamp).toLocaleTimeString()}</td>
              <td>${escapeHTML(l.ip)}</td>
              <td>${escapeHTML(l.method)}</td>
              <td style="max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHTML(l.url)}</td>
              <td><span class="tag ${l.statusCode >= 500 ? 'tag-open' : l.statusCode >= 400 ? 'tag-ignored' : 'tag-resolved'}">${l.statusCode}</span></td>
              <td>${l.durationMs}ms</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    el.innerHTML = `<div class="error-msg">Failed to load logs: ${escapeHTML(e.message)}</div>`;
  }
}

// ── 4. Settings ──────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const [s, modelsData] = await Promise.all([
      api('/settings'),
      api('/settings/models').catch(() => ({ models: [] })),
    ]);

    document.getElementById('setting-auto-analysis').checked = Boolean(s.autoAnalysis);
    document.getElementById('setting-auto-fix').checked = Boolean(s.autoFix);
    document.getElementById('setting-auto-issue').checked = Boolean(s.autoIssue);
    document.getElementById('setting-auto-pr').checked = Boolean(s.autoPr);

    const modelSelect = document.getElementById('setting-ai-model');
    const availableModels = modelsData.models || [];
    if (availableModels.length > 0) {
      modelSelect.innerHTML = availableModels.map((m) => `
        <option value="${escapeHTML(m.id)}">${escapeHTML(m.name)}</option>
      `).join('');
    }
    modelSelect.value = s.aiModel || 'auto';

    document.getElementById('setting-gemini-key').value = s.geminiApiKey || '';
    document.getElementById('setting-openai-key').value = s.openaiApiKey || '';
    document.getElementById('setting-github-token').value = s.githubToken || '';
    document.getElementById('setting-github-repo').value = s.githubRepo || '';
  } catch (e) {
    console.error('Settings load error:', e);
  }
}

document.getElementById('settings-ai-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/settings', {
      method: 'POST',
      body: JSON.stringify({
        autoAnalysis: document.getElementById('setting-auto-analysis').checked,
        autoFix: document.getElementById('setting-auto-fix').checked,
        aiModel: document.getElementById('setting-ai-model').value,
        geminiApiKey: document.getElementById('setting-gemini-key').value.trim(),
        openaiApiKey: document.getElementById('setting-openai-key').value.trim(),
      }),
    });
    alert('AI settings saved.');
  } catch (err) {
    alert(`Save error: ${err.message}`);
  }
});

document.getElementById('settings-github-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/settings', {
      method: 'POST',
      body: JSON.stringify({
        autoIssue: document.getElementById('setting-auto-issue').checked,
        autoPr: document.getElementById('setting-auto-pr').checked,
        githubToken: document.getElementById('setting-github-token').value.trim(),
        githubRepo: document.getElementById('setting-github-repo').value.trim(),
      }),
    });
    alert('GitHub settings saved.');
  } catch (err) {
    alert(`Save error: ${err.message}`);
  }
});

// ── 5. Server Management ────────────────────────────────────────────────
async function loadServerTab() {
  await Promise.all([
    loadServerStatus(),
    loadServerLogs(),
    loadServerEnv(),
    loadServerConfigJson(),
  ]);
}

async function loadServerStatus() {
  const container = document.getElementById('server-status-grid');
  try {
    const s = await api('/server/status');
    const uptimeHours = (s.uptime / 3600).toFixed(1);

    container.innerHTML = `
      <div class="card">
        <div style="font-size:11px; color:var(--secondary-text-color);">Process Status</div>
        <div style="font-size:16px; font-weight:600; color:#3fb950; margin-top:0.2rem;">ONLINE</div>
        <div style="font-size:11px; margin-top:0.3rem;">PID: ${s.pid} ${s.isPm2 ? `(PM2 #${s.pm2Id})` : ''}</div>
      </div>
      <div class="card">
        <div style="font-size:11px; color:var(--secondary-text-color);">Uptime & Start</div>
        <div style="font-size:16px; font-weight:600; color:var(--text-color); margin-top:0.2rem;">${uptimeHours} hours</div>
        <div style="font-size:11px; margin-top:0.3rem;">Since: ${new Date(s.startedAt).toLocaleTimeString()}</div>
      </div>
      <div class="card">
        <div style="font-size:11px; color:var(--secondary-text-color);">Memory Usage (RSS)</div>
        <div style="font-size:16px; font-weight:600; color:var(--primary-color); margin-top:0.2rem;">${s.memory?.rss || 0} MB</div>
        <div style="font-size:11px; margin-top:0.3rem;">Heap: ${s.memory?.heapUsed || 0} / ${s.memory?.heapTotal || 0} MB</div>
      </div>
      <div class="card">
        <div style="font-size:11px; color:var(--secondary-text-color);">Environment & Storage</div>
        <div style="font-size:13px; font-weight:600; color:var(--text-color); margin-top:0.2rem;">DB: ${escapeHTML(s.databaseAdapter || 'N/A')}</div>
        <div style="font-size:11px; margin-top:0.3rem;">Storage: ${escapeHTML(s.storageAdapter || 'local')} | Node: ${s.nodeVersion}</div>
      </div>
    `;
  } catch (e) {
    container.innerHTML = `<div class="error-msg">Failed to load server status: ${escapeHTML(e.message)}</div>`;
  }
}

async function loadServerLogs() {
  const container = document.getElementById('server-logs-container');
  const level = document.getElementById('server-log-level').value;
  const search = document.getElementById('server-log-search').value.trim();

  try {
    const data = await api(`/server/logs?limit=300&level=${encodeURIComponent(level)}&search=${encodeURIComponent(search)}`);
    const logs = data.logs || [];

    if (logs.length === 0) {
      container.textContent = 'No logs available.';
      return;
    }

    container.innerHTML = logs.map((l) => {
      const color = l.level === 'error' ? 'color:#f85149;' : 'color:var(--text-color);';
      return `<div style="${color} line-height:1.4;">[${new Date(l.timestamp).toLocaleTimeString()}] ${escapeHTML(l.message)}</div>`;
    }).join('');

    container.scrollTop = container.scrollHeight;
  } catch (e) {
    container.textContent = `Failed to load logs: ${e.message}`;
  }
}

document.getElementById('refresh-server-logs-btn').addEventListener('click', loadServerLogs);
document.getElementById('server-log-level').addEventListener('change', loadServerLogs);
document.getElementById('server-log-search').addEventListener('input', debounce(loadServerLogs, 300));

document.getElementById('server-restart-btn').addEventListener('click', async () => {
  if (!confirm('NyaitterServer を再起動しますか？')) return;
  const btn = document.getElementById('server-restart-btn');
  btn.disabled = true;
  btn.textContent = 'Restarting...';

  try {
    const res = await api('/server/restart', { method: 'POST' });
    alert(res.message || '再起動シグナルを送信しました。');
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = 'Restart Server';
      loadServerStatus();
      loadServerLogs();
    }, 2000);
  } catch (e) {
    alert(`Restart error: ${e.message}`);
    btn.disabled = false;
    btn.textContent = 'Restart Server';
  }
});

document.getElementById('server-stop-btn').addEventListener('click', async () => {
  if (!confirm('NyaitterServer を停止しますか？（※プロセスが終了します）')) return;
  const btn = document.getElementById('server-stop-btn');
  btn.disabled = true;
  btn.textContent = 'Stopping...';

  try {
    const res = await api('/server/stop', { method: 'POST' });
    alert(res.message || '停止シグナルを送信しました。');
  } catch (e) {
    alert(`Stop error: ${e.message}`);
    btn.disabled = false;
    btn.textContent = 'Stop Server';
  }
});

// .env 読み込み & 保存
async function loadServerEnv() {
  try {
    const data = await api('/server/env');
    document.getElementById('server-env-editor').value = data.content || '';
  } catch (e) {
    console.error('Failed to load .env:', e);
  }
}

document.getElementById('save-env-btn').addEventListener('click', async () => {
  const content = document.getElementById('server-env-editor').value;
  const btn = document.getElementById('save-env-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const res = await api('/server/env', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
    alert(res.message || '.env を保存しました。');
  } catch (e) {
    alert(`Save error: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save .env';
  }
});

// config.json 読み込み & 保存
async function loadServerConfigJson() {
  try {
    const data = await api('/server/config-file');
    document.getElementById('server-config-json-editor').value = data.content || '{}';
  } catch (e) {
    console.error('Failed to load config.json:', e);
  }
}

document.getElementById('save-config-json-btn').addEventListener('click', async () => {
  const content = document.getElementById('server-config-json-editor').value;
  const btn = document.getElementById('save-config-json-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const res = await api('/server/config-file', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
    alert(res.message || 'config.json を保存しました。');
  } catch (e) {
    alert(`Save error: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save config.json';
  }
});

// ── Modal & Utilities ────────────────────────────────────────────────────
function showModal() {
  document.getElementById('detail-modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('detail-modal').classList.add('hidden');
}

document.getElementById('modal-close-btn').addEventListener('click', closeModal);
document.getElementById('detail-modal').addEventListener('click', (e) => {
  if (e.target.id === 'detail-modal') closeModal();
});

function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatMarkdown(text) {
  if (!text) return '';
  return escapeHTML(text)
    .replace(/### (.*?)\n/g, '<h4 style="margin-top:0.5rem; color:var(--primary-color); font-size:12px;">$1</h4>')
    .replace(/## (.*?)\n/g, '<h3 style="margin-top:0.6rem; color:var(--text-color); font-size:13px;">$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="background:#000; padding:1px 3px; border-radius:2px;">$1</code>')
    .replace(/\n/g, '<br>');
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

checkAuth();
