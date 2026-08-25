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
      
      // 認証成功後にリアルタイム接続とタブデータを安全に起動
      initUnifiedLogsWS();
      initNotificationsSSE();
      checkPendingApprovals();
      setInterval(checkPendingApprovals, 15000);
      loadActiveTabData();
      return;
    }
  } catch (err) {
    console.warn('[NMT] Auth check error:', err.message);
  }

  // 3. 未認証時は NyaitterAuth へリダイレクト
  window.location.href = '/auth/login';
}

document.getElementById('logout-btn')?.addEventListener('click', () => {
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

async function loadActiveTabData() {
  const activeTab = document.querySelector('.tab-pane.active')?.id;
  try {
    if (activeTab === 'errors-tab') await loadErrors();
    else if (activeTab === 'logs-tab') await loadUnifiedLogs();
    else if (activeTab === 'admins-tab') { await loadAdmins(); await loadAuditLogs(); }
    else if (activeTab === 'security-tab') { await loadSecurityEvents(); await loadRecentAccessLogs(); }
    else if (activeTab === 'server-tab') await loadServerTab();
    else if (activeTab === 'settings-tab') await loadSettings();
  } catch (err) {
    console.error('[NMT] Failed to load tab data for', activeTab, err);
  }
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
    document.getElementById('setting-allow-bash').checked = Boolean(s.allowBash);
    document.getElementById('setting-approval-edit').checked = Boolean(s.requireApprovalForEdit);
    document.getElementById('setting-approval-bash').checked = Boolean(s.requireApprovalForBash);
    document.getElementById('setting-auto-issue').checked = Boolean(s.autoIssue);
    document.getElementById('setting-auto-pr').checked = Boolean(s.autoPr);

    // Guardrails 設定の反映
    const g = s.guardrails || {};
    document.getElementById('guard-git-tracked').checked = g.restrictToGitTracked !== false;
    document.getElementById('guard-syntax-validation').checked = g.syntaxValidation !== false;
    document.getElementById('guard-block-env').checked = g.blockEnvModification !== false;
    document.getElementById('guard-block-commands').checked = g.blockSuspiciousCommands !== false;

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

document.getElementById('settings-guardrails-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/settings', {
      method: 'POST',
      body: JSON.stringify({
        guardrails: {
          restrictToGitTracked: document.getElementById('guard-git-tracked').checked,
          syntaxValidation: document.getElementById('guard-syntax-validation').checked,
          blockEnvModification: document.getElementById('guard-block-env').checked,
          blockSuspiciousCommands: document.getElementById('guard-block-commands').checked,
        },
      }),
    });
    alert('Safety Guardrails settings saved.');
  } catch (err) {
    alert(`Save error: ${err.message}`);
  }
});

document.getElementById('settings-ai-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/settings', {
      method: 'POST',
      body: JSON.stringify({
        autoAnalysis: document.getElementById('setting-auto-analysis').checked,
        autoFix: document.getElementById('setting-auto-fix').checked,
        allowBash: document.getElementById('setting-allow-bash').checked,
        requireApprovalForEdit: document.getElementById('setting-approval-edit').checked,
        requireApprovalForBash: document.getElementById('setting-approval-bash').checked,
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
  await Promise.allSettled([
    loadServerStatus(),
    loadServerEnv(),
    loadServerConfigJson(),
  ]);
}

function renderServerStatus(s) {
  const container = document.getElementById('server-status-grid');
  if (!container || !s) return;

  const uptimeHours = (s.uptime / 3600).toFixed(1);
  const isOnline = s.serverOnline !== false;

  container.innerHTML = `
    <div class="card">
      <div style="font-size:11px; color:var(--secondary-text-color);">Process Status</div>
      <div style="font-size:16px; font-weight:600; color:${isOnline ? '#3fb950' : '#f85149'}; margin-top:0.2rem;">
        ${isOnline ? 'ONLINE' : 'STOPPED'}
      </div>
      <div style="font-size:11px; margin-top:0.3rem;">Server PID: ${s.serverPid || s.pid} ${s.nmtPid ? `(NMT: ${s.nmtPid})` : ''}</div>
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
      <div style="font-size:11px; margin-top:0.3rem;">Storage: ${escapeHTML(s.storageAdapter || 'local')} | Node: ${s.nodeVersion || ''}</div>
    </div>
  `;
}

async function loadServerStatus() {
  const container = document.getElementById('server-status-grid');
  try {
    const s = await api('/server/status');
    renderServerStatus(s);
  } catch (e) {
    if (container) container.innerHTML = `<div class="error-msg">Failed to load server status: ${escapeHTML(e.message)}</div>`;
  }
}

document.getElementById('server-restart-btn')?.addEventListener('click', async () => {
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

document.getElementById('nmt-restart-btn')?.addEventListener('click', async () => {
  if (!confirm('NMT Console を再起動しますか？（※新プロセスの正常起動が確認できるまで現在のプロセスが維持されます）')) return;
  const btn = document.getElementById('nmt-restart-btn');
  btn.disabled = true;
  btn.textContent = 'Restarting NMT...';

  try {
    const res = await api('/server/restart-nmt', { method: 'POST' });
    alert(res.message || 'NMT 再起動完了。');
    setTimeout(() => {
      window.location.reload();
    }, 1500);
  } catch (e) {
    alert(`NMT Restart error: ${e.message}`);
    btn.disabled = false;
    btn.textContent = 'Restart NMT';
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

// ── 5.5. Unified Real-time Live Logs (WebSocket) ─────────────────────────
let unifiedLogWS = null;
let unifiedLogData = [];

function getSelectedLogTypes() {
  const types = [];
  if (document.getElementById('filter-log-system')?.checked) types.push('system');
  if (document.getElementById('filter-log-error')?.checked) types.push('error');
  if (document.getElementById('filter-log-security')?.checked) types.push('security');
  if (document.getElementById('filter-log-ai')?.checked) types.push('ai');
  return types;
}

function initUnifiedLogsWS() {
  const token = localStorage.getItem('nmt_token');
  if (!token) return;

  if (unifiedLogWS) {
    try { unifiedLogWS.close(); } catch (_) {}
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${window.location.host}/ws/logs?token=${encodeURIComponent(token)}`;

  const statusBadge = document.getElementById('ws-status-badge');
  if (statusBadge) {
    statusBadge.textContent = 'CONNECTING';
    statusBadge.className = 'tag tag-open';
  }

  try {
    unifiedLogWS = new WebSocket(wsUrl);

    unifiedLogWS.onopen = () => {
      if (statusBadge) {
        statusBadge.textContent = 'LIVE';
        statusBadge.className = 'tag tag-resolved';
      }
      sendWSFilter();
    };

    unifiedLogWS.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.event === 'init' || data.event === 'filtered') {
          unifiedLogData = data.logs || [];
          renderUnifiedLogs();
        } else if (data.event === 'log') {
          handleIncomingLiveLog(data.log);
        } else if (data.event === 'server_status') {
          renderServerStatus(data.status);
        }
      } catch (_) {}
    };

    unifiedLogWS.onclose = () => {
      if (statusBadge) {
        statusBadge.textContent = 'OFFLINE';
        statusBadge.className = 'tag tag-ignored';
      }
    };

    unifiedLogWS.onerror = () => {
      if (statusBadge) {
        statusBadge.textContent = 'ERROR';
        statusBadge.className = 'tag tag-ignored';
      }
    };
  } catch (e) {
    console.warn('WS log connection error:', e);
  }
}

function sendWSFilter() {
  if (unifiedLogWS && unifiedLogWS.readyState === WebSocket.OPEN) {
    const types = getSelectedLogTypes();
    const search = document.getElementById('unified-log-search')?.value.trim() || '';
    const level = document.getElementById('unified-log-level')?.value || 'all';
    unifiedLogWS.send(JSON.stringify({
      action: 'filter',
      types,
      search,
      level,
      limit: 200,
    }));
  }
}

function handleIncomingLiveLog(logItem) {
  unifiedLogData.push(logItem);
  if (unifiedLogData.length > 500) unifiedLogData.shift();

  // 現在のフィルター条件にマッチするか判定
  const selectedTypes = getSelectedLogTypes();
  const search = document.getElementById('unified-log-search')?.value.trim().toLowerCase() || '';
  const level = document.getElementById('unified-log-level')?.value || 'all';

  if (!selectedTypes.includes(logItem.type)) return;
  if (level !== 'all' && logItem.level !== level) return;
  if (search && !logItem.message.toLowerCase().includes(search) && !logItem.type.toLowerCase().includes(search)) return;

  const container = document.getElementById('unified-logs-container');
  if (!container) return;

  const lineEl = document.createElement('div');
  lineEl.innerHTML = formatLogLineHTML(logItem);
  container.appendChild(lineEl);
  container.scrollTop = container.scrollHeight;
}

function renderUnifiedLogs() {
  const container = document.getElementById('unified-logs-container');
  if (!container) return;

  const selectedTypes = getSelectedLogTypes();
  const search = document.getElementById('unified-log-search')?.value.trim().toLowerCase() || '';
  const level = document.getElementById('unified-log-level')?.value || 'all';

  const filtered = unifiedLogData.filter((l) => {
    if (!selectedTypes.includes(l.type)) return false;
    if (level !== 'all' && l.level !== level) return false;
    if (search && !l.message.toLowerCase().includes(search) && !l.type.toLowerCase().includes(search)) return false;
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">No matching logs.</div>';
    return;
  }

  container.innerHTML = filtered.map(formatLogLineHTML).join('');
  container.scrollTop = container.scrollHeight;
}

function formatLogLineHTML(l) {
  const time = new Date(l.timestamp).toLocaleTimeString();
  let typeTag = '';
  let color = 'color:var(--text-color);';

  if (l.type === 'error') {
    typeTag = '<span style="color:#f85149; font-weight:bold;">[ERROR]</span>';
    color = 'color:#f85149;';
  } else if (l.type === 'security') {
    typeTag = '<span style="color:#e3b341; font-weight:bold;">[SECURITY]</span>';
    color = 'color:#e3b341;';
  } else if (l.type === 'ai') {
    typeTag = '<span style="color:#58a6ff; font-weight:bold;">[AI]</span>';
    color = 'color:#58a6ff;';
  } else {
    typeTag = '<span style="color:#8b949e;">[SYSTEM]</span>';
    color = 'color:#8b949e;';
  }

  return `<div style="${color} line-height:1.3; padding:1px 0; word-break:break-all; white-space:pre-wrap;"><span style="color:#484f58;">[${time}]</span> ${typeTag} <span style="color:#7ee787;">[${escapeHTML(l.source || 'app')}]</span> ${escapeHTML(l.message)}</div>`;
}

async function loadUnifiedLogs() {
  // 1. 即座に HTTP API から最新ログを fetch して描画
  try {
    const types = getSelectedLogTypes();
    const search = document.getElementById('unified-log-search')?.value.trim() || '';
    const level = document.getElementById('unified-log-level')?.value || 'all';
    const params = new URLSearchParams({
      types: types.join(','),
      search,
      level,
      limit: '200',
    });
    const res = await api(`/logs?${params.toString()}`);
    if (res.logs && Array.isArray(res.logs)) {
      unifiedLogData = res.logs;
      renderUnifiedLogs();
    }
  } catch (err) {
    console.warn('[NMT] HTTP log fetch warning:', err.message);
  }

  // 2. WebSocket 接続の確認・初期化
  if (!unifiedLogWS || unifiedLogWS.readyState !== WebSocket.OPEN) {
    initUnifiedLogsWS();
  } else {
    sendWSFilter();
  }
}

// フィルターイベントリスナー
['filter-log-system', 'filter-log-error', 'filter-log-security', 'filter-log-ai'].forEach((id) => {
  document.getElementById(id)?.addEventListener('change', () => {
    renderUnifiedLogs();
    sendWSFilter();
  });
});

document.getElementById('unified-log-search')?.addEventListener('input', debounce(() => {
  renderUnifiedLogs();
  sendWSFilter();
}, 300));

document.getElementById('unified-log-level')?.addEventListener('change', () => {
  renderUnifiedLogs();
  sendWSFilter();
});

document.getElementById('reconnect-ws-btn')?.addEventListener('click', initUnifiedLogsWS);
document.getElementById('clear-unified-logs-btn')?.addEventListener('click', async () => {
  await api('/logs/clear', { method: 'POST' });
  unifiedLogData = [];
  renderUnifiedLogs();
});

// ── 6. Real-time Notifications & Approvals ──────────────────────────────
let notificationEventSource = null;

function initNotificationsSSE() {
  const token = localStorage.getItem('nmt_token');
  if (!token) return;

  if (notificationEventSource) {
    notificationEventSource.close();
  }

  try {
    notificationEventSource = new EventSource(`/api/notifications/stream?token=${encodeURIComponent(token)}`);

    notificationEventSource.onmessage = (event) => {
      try {
        const item = JSON.parse(event.data);
        handleIncomingNotification(item);
      } catch (_) {}
    };

    notificationEventSource.onerror = () => {
      // 再接続はブラウザが自動実行
    };
  } catch (e) {
    console.warn('SSE connection failed:', e);
  }

  // 初期通知 & 承認リクエスト取得
  loadUnreadNotificationCount();
  checkPendingApprovals();
}

function handleIncomingNotification(item) {
  // バッジ更新
  loadUnreadNotificationCount();

  // 承認リクエスト通知の場合
  if (item.type === 'approval_request') {
    checkPendingApprovals();
  }

  // ブラウザ通知が許可されていれば表示
  if (window.Notification && Notification.permission === 'granted') {
    try {
      new Notification(item.title, {
        body: item.message,
        icon: '/favicon.ico',
      });
    } catch (_) {}
  }
}

async function loadUnreadNotificationCount() {
  try {
    const data = await api('/notifications');
    const list = data.notifications || [];
    const unread = list.filter((n) => !n.read).length;
    const badge = document.getElementById('unread-notifications-badge');
    if (unread > 0) {
      badge.textContent = unread;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (_) {}
}

async function checkPendingApprovals() {
  try {
    const data = await api('/approvals/pending');
    const requests = data.requests || [];
    const btn = document.getElementById('nav-approvals-btn');
    const badge = document.getElementById('pending-approvals-badge');

    if (requests.length > 0) {
      badge.textContent = requests.length;
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  } catch (_) {}
}

// 承認リクエストモーダル
async function openApprovalsModal() {
  const data = await api('/approvals/pending');
  const requests = data.requests || [];

  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const modalFooter = document.getElementById('modal-footer');

  modalTitle.textContent = 'Pending Access Approvals';
  if (requests.length === 0) {
    modalBody.innerHTML = '<div class="empty-state">No pending approval requests.</div>';
    modalFooter.innerHTML = '';
  } else {
    modalBody.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:0.8rem;">
        ${requests.map((r) => `
          <div class="card" style="border-left: 3px solid #e3b341;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong style="color:#e3b341;">[${r.type.toUpperCase()}] ${escapeHTML(r.reason)}</strong>
              <span style="font-size:10px; color:var(--secondary-text-color);">${new Date(r.requestedAt).toLocaleTimeString()}</span>
            </div>
            ${r.target ? `<div style="font-size:12px; margin-top:0.3rem;">Target: <code>${escapeHTML(r.target)}</code></div>` : ''}
            ${r.command ? `<div style="font-size:12px; margin-top:0.3rem;"><pre class="code-box" style="margin:0.2rem 0;">${escapeHTML(r.command)}</pre></div>` : ''}
            <div style="display:flex; gap:0.4rem; margin-top:0.6rem;">
              <button class="btn btn-primary btn-sm btn-approve-session" data-id="${escapeHTML(r.id)}">Approve for Session</button>
              <button class="btn btn-secondary btn-sm btn-approve-once" data-id="${escapeHTML(r.id)}">Approve Once</button>
              <button class="btn btn-secondary btn-sm btn-deny" data-id="${escapeHTML(r.id)}" style="color:#f85149; border-color:#f85149;">Deny</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    modalFooter.innerHTML = '<button class="btn btn-secondary btn-sm" onclick="closeModal()">Close</button>';

    modalBody.querySelectorAll('.btn-approve-session').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/approvals/${encodeURIComponent(btn.dataset.id)}/approve`, { method: 'POST', body: JSON.stringify({ scope: 'session' }) });
        openApprovalsModal();
        checkPendingApprovals();
      });
    });

    modalBody.querySelectorAll('.btn-approve-once').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/approvals/${encodeURIComponent(btn.dataset.id)}/approve`, { method: 'POST', body: JSON.stringify({ scope: 'once' }) });
        openApprovalsModal();
        checkPendingApprovals();
      });
    });

    modalBody.querySelectorAll('.btn-deny').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/approvals/${encodeURIComponent(btn.dataset.id)}/deny`, { method: 'POST' });
        openApprovalsModal();
        checkPendingApprovals();
      });
    });
  }

  showModal();
}

// 通知一覧モーダル
async function openNotificationsModal() {
  const data = await api('/notifications');
  const list = data.notifications || [];

  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const modalFooter = document.getElementById('modal-footer');

  modalTitle.textContent = 'Notifications & Alerts';
  if (list.length === 0) {
    modalBody.innerHTML = '<div class="empty-state">No notifications.</div>';
  } else {
    modalBody.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:0.5rem; max-height:400px; overflow-y:auto;">
        ${list.map((n) => {
          const borderColor = n.type === 'error' ? '#f85149' : n.type === 'approval_request' ? '#e3b341' : n.type === 'security_alert' ? '#da3633' : '#58a6ff';
          return `
            <div class="card" style="border-left: 3px solid ${borderColor}; padding:0.6rem;">
              <div style="display:flex; justify-content:space-between; font-size:11px;">
                <strong>${escapeHTML(n.title)}</strong>
                <span style="color:var(--secondary-text-color);">${new Date(n.timestamp).toLocaleTimeString()}</span>
              </div>
              <div style="font-size:12px; margin-top:0.2rem;">${escapeHTML(n.message)}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  modalFooter.innerHTML = `
    <button class="btn btn-secondary btn-sm" id="modal-mark-read-btn">Mark All as Read</button>
    <button class="btn btn-secondary btn-sm" onclick="closeModal()">Close</button>
  `;

  document.getElementById('modal-mark-read-btn')?.addEventListener('click', async () => {
    await api('/notifications/read-all', { method: 'POST' });
    loadUnreadNotificationCount();
    closeModal();
  });

  showModal();
}

document.getElementById('nav-approvals-btn').addEventListener('click', openApprovalsModal);
document.getElementById('nav-notifications-btn').addEventListener('click', openNotificationsModal);

document.getElementById('enable-browser-notifications-btn')?.addEventListener('click', async () => {
  if (!('Notification' in window)) {
    alert('This browser does not support desktop notifications.');
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    await api('/notifications/subscribe', { method: 'POST', body: JSON.stringify({ enabled: true }) });
    alert('Browser notifications enabled!');
  } else {
    alert(`Notification permission: ${permission}`);
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
