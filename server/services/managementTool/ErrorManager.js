'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const MAX_ERROR_RECORDS = 500;
const DATA_DIR = path.resolve(__dirname, '../../data');
const ERRORS_FILE = path.join(DATA_DIR, 'nmt-errors.json');
const PROJECT_ROOT = path.resolve(__dirname, '../../../');

function execGit(args, cwd = PROJECT_ROOT) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      resolve(stdout.trim());
    });
  });
}

class ErrorManager {
  constructor({ aiService, config = {} } = {}) {
    this.aiService = aiService;
    this.autoAnalysis = config.autoAnalysis ?? false;
    this.autoFix = config.autoFix ?? false;
    this.autoIssue = config.autoIssue ?? false;
    this.autoPr = config.autoPr ?? false;
    this.githubToken = config.githubToken || '';
    this.githubRepo = config.githubRepo || 'Nyaitter/Server';
    this.errors = [];
    this._load();
  }

  updateConfig(config = {}) {
    if (config.autoAnalysis !== undefined) this.autoAnalysis = Boolean(config.autoAnalysis);
    if (config.autoFix !== undefined) this.autoFix = Boolean(config.autoFix);
    if (config.autoIssue !== undefined) this.autoIssue = Boolean(config.autoIssue);
    if (config.autoPr !== undefined) this.autoPr = Boolean(config.autoPr);
    if (config.githubToken !== undefined) this.githubToken = config.githubToken;
    if (config.githubRepo !== undefined) this.githubRepo = config.githubRepo;
  }

  _load() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (fs.existsSync(ERRORS_FILE)) {
        const raw = fs.readFileSync(ERRORS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.errors = parsed.slice(-MAX_ERROR_RECORDS);
      }
    } catch (e) {
      console.warn('[NMT-Errors] Failed to load persisted error logs:', e.message);
      this.errors = [];
    }
  }

  _save() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ERRORS_FILE, JSON.stringify(this.errors.slice(-MAX_ERROR_RECORDS), null, 2), 'utf8');
    } catch (e) {
      console.warn('[NMT-Errors] Failed to save error logs:', e.message);
    }
  }

  async recordError(err, context = {}) {
    if (!err) return null;

    const message = typeof err === 'string' ? err : err.message || 'Unknown Error';
    const stack = typeof err === 'string' ? '' : err.stack || '';

    // 重複エラー（直近5分以内の同一メッセージ）は発生回数をインクリメント
    const now = Date.now();
    const existing = this.errors.find(
      (e) => e.message === message && e.status === 'open' && (now - new Date(e.timestamp).getTime()) < 5 * 60 * 1000
    );

    if (existing) {
      existing.occurrences = (existing.occurrences || 1) + 1;
      existing.lastOccurredAt = new Date().toISOString();
      existing.context = { ...existing.context, ...context };
      this._save();
      return existing;
    }

    const id = `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const errorRecord = {
      id,
      timestamp: new Date().toISOString(),
      lastOccurredAt: new Date().toISOString(),
      occurrences: 1,
      message,
      stack,
      context: {
        method: context.method || null,
        url: context.url || context.path || null,
        userId: context.userId ?? null,
        ip: context.ip || null,
        userAgent: context.userAgent || null,
        requestId: context.requestId || null,
      },
      status: 'open', // 'open' | 'resolved' | 'ignored'
      analysis: null,
      issueUrl: null,
      prUrl: null,
      fixed: false,
      modifiedFiles: [],
    };

    this.errors.unshift(errorRecord);
    if (this.errors.length > MAX_ERROR_RECORDS) this.errors.pop();
    this._save();

    // 自動修正または自動AI解析が有効な場合
    if (this.autoFix) {
      this.triggerAutoFix(id).catch((e) => console.warn('[NMT-Errors] Auto fix error:', e.message));
    } else if (this.autoAnalysis && this.aiService) {
      this.triggerAnalysis(id).catch((e) => console.warn('[NMT-Errors] Auto AI analysis error:', e.message));
    }

    return errorRecord;
  }

  async triggerAnalysis(errorId) {
    const record = this.errors.find((e) => e.id === errorId);
    if (!record || !this.aiService) return null;

    try {
      record.analyzing = true;
      const result = await this.aiService.analyzeError(record, { autoFix: false });
      record.analysis = {
        model: result.model,
        content: result.content,
        provider: result.provider,
        analyzedAt: new Date().toISOString(),
      };
      this._save();

      // 自動Issue作成が有効な場合
      if (this.autoIssue && this.githubToken && !record.issueUrl) {
        this.createGitHubIssue(errorId).catch((e) => console.warn('[NMT-Errors] Auto issue creation error:', e.message));
      }

      return record.analysis;
    } finally {
      record.analyzing = false;
      this._save();
    }
  }

  async triggerAutoFix(errorId) {
    const record = this.errors.find((e) => e.id === errorId);
    if (!record || !this.aiService) return null;

    try {
      record.fixing = true;
      this._save();

      // 修正前の変更ファイルを記録
      const beforeDiff = await execGit(['diff', '--name-only']).catch(() => '');

      // Opencode エージェントに Git 追跡ファイルの直接修正を実行させる
      const result = await this.aiService.analyzeError(record, { autoFix: true });

      record.analysis = {
        model: result.model,
        content: result.content,
        provider: result.provider,
        analyzedAt: new Date().toISOString(),
      };

      // 修正後の変更ファイル一覧を取得
      const afterDiff = await execGit(['diff', '--name-only']).catch(() => '');
      const modifiedFiles = afterDiff.split('\n').map((s) => s.trim()).filter(Boolean);

      if (modifiedFiles.length > 0) {
        // 構文チェック（Syntax Validation）
        let syntaxOk = true;
        for (const file of modifiedFiles) {
          if (file.endsWith('.js') || file.endsWith('.mjs')) {
            try {
              await new Promise((resolve, reject) => {
                execFile('node', ['--check', path.resolve(PROJECT_ROOT, file)], (err) => (err ? reject(err) : resolve()));
              });
            } catch (err) {
              console.error(`[NMT-AutoFix] Syntax error in ${file}, rolling back:`, err.message);
              syntaxOk = false;
              break;
            }
          }
        }

        if (!syntaxOk) {
          // 構文エラー発生時は変更をロールバック
          await execGit(['checkout', '--', ...modifiedFiles]).catch(() => {});
          record.fixError = '自動修正コードに構文エラーが検出されたためロールバックしました。';
        } else {
          record.fixed = true;
          record.modifiedFiles = modifiedFiles;
          record.status = 'resolved';

          // 自動 PR 作成が有効な場合
          if (this.autoPr && this.githubToken && !record.prUrl) {
            this.createGitHubPullRequest(errorId).catch((e) => console.warn('[NMT-Errors] Auto PR creation error:', e.message));
          }
        }
      }

      this._save();
      return { analysis: record.analysis, fixed: record.fixed, modifiedFiles: record.modifiedFiles };
    } catch (err) {
      console.error('[NMT-AutoFix] Failed to execute auto fix:', err);
      record.fixError = err.message;
      this._save();
      throw err;
    } finally {
      record.fixing = false;
      this._save();
    }
  }

  async createGitHubPullRequest(errorId) {
    const record = this.errors.find((e) => e.id === errorId);
    if (!record || !this.githubToken) throw new Error('GitHub token is missing or error not found');
    if (record.prUrl) return record.prUrl;
    if (!record.modifiedFiles || record.modifiedFiles.length === 0) {
      throw new Error('No modified files found for pull request');
    }

    const branchName = `fix/nmt-autofix-${record.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const currentBranch = await execGit(['branch', '--show-current']).catch(() => 'main');

    try {
      // 1. 新しいブランチを作成してチェックアウト
      await execGit(['checkout', '-B', branchName]);

      // 2. 変更ファイルをステージング
      await execGit(['add', ...record.modifiedFiles]);

      // 3. コミット
      const commitMsg = `Fix(autofix): ${record.message.slice(0, 70)}\n\nAuto-fixed by NyaitterManagementTool for error ID ${record.id}`;
      await execGit(['commit', '--author=nyantorusabu <nyantorusabu@outlook.jp>', '-m', commitMsg]);

      // 4. リモートへ Push
      await execGit(['push', '-u', 'origin', branchName, '--force']);

      // 5. GitHub REST API で Pull Request 作成
      const prTitle = `[AutoFix] ${record.message.slice(0, 80)}`;
      const prBody = `## 🤖 NyaitterManagementTool 自動修復 Pull Request

### 🚨 対象エラー情報
- **エラーID**: \`${record.id}\`
- **発生日時**: ${record.timestamp}
- **リクエスト**: \`${record.context?.method || 'N/A'} ${record.context?.url || 'N/A'}\`

### 🛠️ 変更ファイル
${record.modifiedFiles.map((f) => `- \`${f}\``).join('\n')}

### 📝 AI解析・修正サマリー
${record.analysis?.content || '(詳細なし)'}

---
*Generated automatically by NyaitterManagementTool*`;

      const prUrl = await this._sendGitHubPullRequest(branchName, currentBranch || 'main', prTitle, prBody);
      if (prUrl) {
        record.prUrl = prUrl;
        this._save();
      }

      return prUrl;
    } finally {
      // 元のブランチに戻る
      await execGit(['checkout', currentBranch]).catch(() => {});
    }
  }

  _sendGitHubPullRequest(head, base, title, body) {
    return new Promise((resolve, reject) => {
      const repo = this.githubRepo || 'Nyaitter/Server';
      const [owner, repoName] = repo.split('/');
      if (!owner || !repoName) return reject(new Error('Invalid github repo format (owner/repo)'));

      const postData = JSON.stringify({
        title,
        body,
        head,
        base,
      });

      const options = {
        hostname: 'api.github.com',
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls`,
        method: 'POST',
        headers: {
          'User-Agent': 'NyaitterManagementTool/1.0',
          'Authorization': `Bearer ${this.githubToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 20000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              return resolve(parsed.html_url);
            } catch (_) {}
          }
          reject(new Error(`GitHub API HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API timeout')); });
      req.write(postData);
      req.end();
    });
  }

  async createGitHubIssue(errorId) {
    const record = this.errors.find((e) => e.id === errorId);
    if (!record || !this.githubToken) throw new Error('GitHub token is missing or error not found');
    if (record.issueUrl) return record.issueUrl;

    const title = `[AutoError] ${record.message.slice(0, 100)}`;
    const body = `## 🚨 自動検知エラーレポート (NyaitterManagementTool)

- **エラーID**: \`${record.id}\`
- **発生日時**: ${record.timestamp}
- **リクエスト**: \`${record.context?.method || 'N/A'} ${record.context?.url || 'N/A'}\`
- **発生回数**: ${record.occurrences || 1}

### スタックトレース
\`\`\`
${record.stack || '(スタックトレースなし)'}
\`\`\`

${record.analysis ? `### 🤖 AI解析・対応助言 (${record.analysis.model})
${record.analysis.content}` : ''}

---
*Generated automatically by NyaitterManagementTool*`;

    const issueUrl = await this._sendGitHubIssue(title, body);
    if (issueUrl) {
      record.issueUrl = issueUrl;
      this._save();
    }
    return issueUrl;
  }

  _sendGitHubIssue(title, body) {
    return new Promise((resolve, reject) => {
      const repo = this.githubRepo || 'Nyaitter/Server';
      const [owner, repoName] = repo.split('/');
      if (!owner || !repoName) return reject(new Error('Invalid github repo format (owner/repo)'));

      const postData = JSON.stringify({
        title,
        body,
        labels: ['bug', 'automated-report'],
      });

      const options = {
        hostname: 'api.github.com',
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/issues`,
        method: 'POST',
        headers: {
          'User-Agent': 'NyaitterManagementTool/1.0',
          'Authorization': `Bearer ${this.githubToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 15000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              return resolve(parsed.html_url);
            } catch (_) {}
          }
          reject(new Error(`GitHub API HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API timeout')); });
      req.write(postData);
      req.end();
    });
  }

  updateStatus(errorId, status) {
    const record = this.errors.find((e) => e.id === errorId);
    if (!record) return null;
    if (['open', 'resolved', 'ignored'].includes(status)) {
      record.status = status;
      this._save();
    }
    return record;
  }

  getErrors({ status, search, limit = 50, offset = 0 } = {}) {
    let list = this.errors;
    if (status && status !== 'all') {
      list = list.filter((e) => e.status === status);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((e) => (e.message || '').toLowerCase().includes(q) || (e.context?.url || '').toLowerCase().includes(q));
    }
    const total = list.length;
    const paginated = list.slice(offset, offset + limit);
    return { errors: paginated, total, limit, offset };
  }

  getErrorById(id) {
    return this.errors.find((e) => e.id === id) || null;
  }

  clearErrors() {
    this.errors = [];
    this._save();
  }
}

module.exports = ErrorManager;
