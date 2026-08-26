'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../../../'); // /workspaces/codespaces-blank/Server

class AiAnalysisService {
  constructor(config = {}) {
    this.geminiApiKey = config.geminiApiKey || process.env.NMT_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
    this.openaiApiKey = config.openaiApiKey || process.env.NMT_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
    this.preferredModel = config.aiModel || process.env.NMT_AI_MODEL || 'auto';
    this.allowBash = config.allowBash ?? false;
    this.requireApprovalForEdit = config.requireApprovalForEdit ?? false;
    this.requireApprovalForBash = config.requireApprovalForBash ?? true;
    this.approvalManager = null;
    this.zenModelsCache = null;
    this.zenModelsLastFetched = 0;
    this.opencodeAvailable = null;
  }

  _isOpencodeAvailable() {
    return this.opencodeAvailable !== false;
  }

  setApprovalManager(approvalManager) {
    this.approvalManager = approvalManager;
  }

  updateConfig(config = {}) {
    if (config.geminiApiKey !== undefined) this.geminiApiKey = config.geminiApiKey;
    if (config.openaiApiKey !== undefined) this.openaiApiKey = config.openaiApiKey;
    if (config.aiModel !== undefined) this.preferredModel = config.aiModel;
    if (config.allowBash !== undefined) this.allowBash = Boolean(config.allowBash);
    if (config.requireApprovalForEdit !== undefined) this.requireApprovalForEdit = Boolean(config.requireApprovalForEdit);
    if (config.requireApprovalForBash !== undefined) this.requireApprovalForBash = Boolean(config.requireApprovalForBash);
  }

  // ── Gemini 公式 API 提供の実在モデル一覧を動的取得 ───────────────────
  async fetchGeminiModels(force = false) {
    const key = this.geminiApiKey;
    if (!key) return [];
    const now = Date.now();
    if (!force && this.geminiModelsCache && (now - this.geminiModelsLastFetched) < 10 * 60 * 1000) {
      return this.geminiModelsCache;
    }

    try {
      const data = await this._httpGetJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
      const models = Array.isArray(data?.models) ? data.models : [];
      const validModels = models
        .filter((m) => Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods.includes('generateContent') : true)
        .map((m) => (m.name || '').replace(/^models\//, ''))
        .filter(Boolean);
      this.geminiModelsCache = validModels;
      this.geminiModelsLastFetched = now;
      return this.geminiModelsCache;
    } catch (_) {
      return this.geminiModelsCache || [];
    }
  }

  // ── OpenCode Zen 提供の実在モデル一覧を動的取得 ───────────────────────────
  async fetchZenModels(force = false) {
    const now = Date.now();
    if (!force && this.zenModelsCache && (now - this.zenModelsLastFetched) < 10 * 60 * 1000) {
      return this.zenModelsCache;
    }

    try {
      const data = await this._httpGetJson('https://opencode.ai/zen/v1/models');
      const models = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);
      
      const realModels = models
        .map((m) => {
          const id = typeof m === 'string' ? m : m.id;
          if (!id) return null;
          return { id, name: id, free: id.includes('free') };
        })
        .filter(Boolean);

      this.zenModelsCache = realModels;
      this.zenModelsLastFetched = now;
      return this.zenModelsCache;
    } catch (_) {
      return this.zenModelsCache || [];
    }
  }

  async getAvailableModels() {
    const [zenModels, geminiModels] = await Promise.all([
      this.fetchZenModels(),
      this.fetchGeminiModels(),
    ]);

    const list = [
      { id: 'auto', name: 'Auto（最新利用可能モデルを自動選択）', provider: 'auto' },
    ];

    if (geminiModels.length > 0) {
      for (const modelName of geminiModels) {
        list.push({
          id: `google/${modelName}`,
          name: `[Gemini API] ${modelName}`,
          provider: 'gemini',
        });
      }
    }

    if (zenModels.length > 0) {
      for (const m of zenModels) {
        list.push({
          id: m.id,
          name: `[OpenCode Zen] ${m.name}`,
          provider: 'zen',
        });
      }
    }

    if (this.openaiApiKey) {
      list.push(
        { id: 'openai/gpt-4o', name: '[OpenAI] GPT-4o', provider: 'openai' },
        { id: 'openai/gpt-4o-mini', name: '[OpenAI] GPT-4o-mini', provider: 'openai' },
      );
    }

    return list;
  }

  async analyzeError(errorRecord, { autoFix = false } = {}) {
    const isAutoFix = autoFix === true;
    const prompt = isAutoFix
      ? `【重要：自動修正（Auto-Fix）エージェント】
あなたはNyaitterサーバーの開発者向け自動修復専門エージェントです。
スタックトレースおよびプロジェクト内のコードを確認し、エラーの根本原因を特定した上で、**Git追跡対象の関連ファイルを直接編集・修正してください**。

【厳格な安全規則】
- 修正対象はGit追跡対象の既存ファイルのみです。.envやnode_modules、未追跡の機密ファイルは変更禁止です。
- 不要なファイルの新規作成や削除は行わず、エラー解消に必要な最小限かつクリーンなコード修正を行ってください。
- 修正完了後、何を変更したのかのサマリーを報告してください。

【エラー情報】
- エラー種別/メッセージ: ${errorRecord.message || '不明'}
- 発生日時: ${errorRecord.timestamp || new Date().toISOString()}
- リクエストパス: ${errorRecord.context?.method || 'N/A'} ${errorRecord.context?.url || errorRecord.context?.path || 'N/A'}
- ユーザーID: ${errorRecord.context?.userId ?? 'ゲスト/未認証'}
- スタックトレース:
\`\`\`
${errorRecord.stack || '(スタックトレースなし)'}
\`\`\`

【出力形式】
Markdown形式で回答してください:
### 1. 原因の分析
### 2. 実施した修正内容
### 3. 修正したファイル一覧`
      : `【重要：調査・解析専用エージェント（編集・変更禁止）】
あなたはNyaitterサーバー（Node.js / Express / PostgreSQL / D1 / SPA）の開発者向けエラー解析専門エージェントです。
現在のプロジェクト内のコードや設定ファイル、関連モジュールを自律的に確認・読み取り・調査してください。

【厳格な制限事項】
- ファイルの編集、書き換え、作成、削除などの変更操作は一切禁止されています。
- リードオンリーでコードを検索・確認するのみに留めてください。

【エラー情報】
- エラー種別/メッセージ: ${errorRecord.message || '不明'}
- 発生日時: ${errorRecord.timestamp || new Date().toISOString()}
- リクエストパス: ${errorRecord.context?.method || 'N/A'} ${errorRecord.context?.url || errorRecord.context?.path || 'N/A'}
- ユーザーID: ${errorRecord.context?.userId ?? 'ゲスト/未認証'}
- スタックトレース:
\`\`\`
${errorRecord.stack || '(スタックトレースなし)'}
\`\`\`

【調査手順】
1. スタックトレースに記載された該当ファイルや行番号、関連関数をプロジェクト内から読み取って確認してください。
2. なぜそのエラーが発生したのか（プロパティ未定義、型不一致、API不整合など）の根本原因を特定してください。
3. 修正に必要なコード変更案を作成してください。

【出力形式】
以下の見出しを含んだMarkdown形式で回答してください:
### 1. 原因の分析
### 2. 影響範囲
### 3. 具体的な対応・修正手順
### 4. 修正コード例（該当する場合）`;

    return this._callAi(prompt, 'error_analysis', { allowEdit: isAutoFix });
  }

  async analyzeSecurityLog(securityEvent) {
    const prompt = `【重要：調査・解析専用エージェント（編集・変更禁止）】
あなたはWebセキュリティとアクセスログ解析の専門エージェントです。
サーバーのルーティング設定やミドルウェア設定を読み取って確認し、攻撃の意図と対策を提示してください。

【厳格な制限事項】
- ファイルの編集、書き換え、変更操作は一切禁止されています。調査・読み取りのみ行ってください。

【不審なアクセス情報】
- 検知理由: ${securityEvent.reason || '不審なアクセス'}
- 発生日時: ${securityEvent.timestamp || new Date().toISOString()}
- クライアントIP: ${securityEvent.ip || '不明'}
- User-Agent: ${securityEvent.userAgent || '不明'}
- リクエストメソッド & URL: ${securityEvent.method || 'GET'} ${securityEvent.url || '/'}
- ステータスコード: ${securityEvent.statusCode || 0}
- 詳細メタデータ:
\`\`\`json
${JSON.stringify(securityEvent.details || {}, null, 2)}
\`\`\`

【出力形式】
以下の見出しを含んだMarkdown形式で簡潔かつ具体的に回答してください:
### 1. 攻撃/アクセスの意図と手法
### 2. 危険度評価（高/中/低）
### 3. 推奨される防御・対処手順（Cloudflare WAFルールやIPブロック等）`;

    return this._callAi(prompt, 'security_analysis');
  }

  async _callAi(prompt, taskType, options = {}) {
    const { allowEdit = false } = options;

    // 自動修正（allowEdit = true）の場合は Opencode CLI エージェントを優先実行
    if (allowEdit && this._isOpencodeAvailable()) {
      try {
        const cliResult = await this._callOpencodeAgent(prompt, { allowEdit: true });
        if (cliResult) {
          const resolvedName = await this._resolveOpencodeModelName();
          return {
            model: `Opencode Agent (${resolvedName})`,
            content: cliResult,
            provider: 'opencode-agent',
          };
        }
      } catch (err) {
        if (err.code === 'ENOENT') {
          this.opencodeAvailable = false;
        } else {
          console.warn('[NMT-AI] Opencode agent execution failed, falling back to API:', err.message);
        }
      }
    }

    // エラー解析・セキュリティ調査（リードオンリー）は Direct API を優先して高速処理
    const isAutoOrGemini = !this.preferredModel || this.preferredModel === 'auto' || this.preferredModel.includes('gemini') || this.preferredModel.includes('google');
    if (this.geminiApiKey && isAutoOrGemini) {
      try {
        const res = await this._callGeminiApi(prompt);
        if (res) return { model: `Gemini (${this.preferredModel === 'auto' ? 'gemini-3.5-flash-lite' : this.preferredModel})`, content: res, provider: 'gemini' };
      } catch (e) {
        console.warn('[NMT-AI] Gemini direct call failed:', e.message);
      }
    }

    const isAutoOrOpenAi = !this.preferredModel || this.preferredModel === 'auto' || this.preferredModel.includes('gpt') || this.preferredModel.includes('openai');
    if (this.openaiApiKey && isAutoOrOpenAi) {
      try {
        const res = await this._callOpenAiApi(prompt);
        if (res) return { model: `OpenAI (${this.preferredModel === 'auto' ? 'gpt-4o' : this.preferredModel})`, content: res, provider: 'openai' };
      } catch (e) {
        console.warn('[NMT-AI] OpenAI direct call failed:', e.message);
      }
    }

    // 3. OpenCode Zen 動的無料モデル API
    try {
      const zenResult = await this._callOpencodeZenFreeModel(prompt);
      if (zenResult?.content) {
        return {
          model: `OpenCode Zen (${zenResult.model})`,
          content: zenResult.content,
          provider: 'opencode-zen',
        };
      }
    } catch (_) {}

    // 4. 内蔵 Heuristic Analyzer
    return {
      model: 'Built-in Heuristic Analyzer',
      content: this._generateHeuristicAdvice(prompt, taskType),
      provider: 'builtin',
    };
  }

  async _resolveOpencodeModelName() {
    if (this.preferredModel && this.preferredModel !== 'auto') {
      return this.preferredModel;
    }
    if (this.geminiApiKey) return 'google/gemini-3.5-flash-lite';
    if (this.openaiApiKey) return 'openai/gpt-4o';

    const zenModels = await this.fetchZenModels();
    const freeModels = (Array.isArray(zenModels) ? zenModels : []).filter((m) => m.free === true || (m.id && m.id.includes('free')));
    if (freeModels.length > 0) {
      const target = freeModels[0]?.id || '';
      return target.includes('/') ? target : `opencode/${target}`;
    }
    return 'opencode/nemotron-3.5-lightning-free';
  }

  async _callOpencodeAgent(prompt, { allowEdit = false, allowBash = this.allowBash } = {}) {
    const model = await this._resolveOpencodeModelName();
    
    // パーミッション構成の決定
    let configName = 'opencode-readonly-config.json';
    if (allowEdit && allowBash) {
      configName = 'opencode-full-config.json';
    } else if (allowEdit) {
      configName = 'opencode-autofix-config.json';
    } else if (allowBash) {
      configName = 'opencode-bashonly-config.json';
    }
    const configPath = path.resolve(__dirname, configName);

    const opencodeArgs = ['run', '--pure', '-m', model, prompt];

    const env = {
      ...process.env,
      OPENCODE_CONFIG: configPath,
      GEMINI_API_KEY: this.geminiApiKey || process.env.NMT_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.AUTOMOD_API_KEY || '',
      GOOGLE_GENERATIVE_AI_API_KEY: this.geminiApiKey || process.env.NMT_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.AUTOMOD_API_KEY || '',
      OPENAI_API_KEY: this.openaiApiKey || process.env.NMT_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '',
    };

    const localBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'opencode');
    const initialBin = fs.existsSync(localBin) ? localBin : 'opencode';

    return new Promise((resolve, reject) => {

      const runWithCommand = (bin, args) => {
        execFile(bin, args, {
          cwd: PROJECT_ROOT,
          env,
          timeout: 90000,
          maxBuffer: 20 * 1024 * 1024,
        }, (error, stdout, stderr) => {
          if (error) {
            // opencode / localBin が直接見つからなかった場合は npx で自動実行
            if (error.code === 'ENOENT' && bin !== 'npx') {
              return runWithCommand('npx', ['--yes', 'opencode-ai', ...opencodeArgs]);
            }
            return reject(error);
          }
          const output = (stdout || '').trim();
          if (output) return resolve(output);
          reject(new Error('Opencode agent produced empty response'));
        });
      };

      runWithCommand(initialBin, opencodeArgs);
    });
  }

  _callGeminiApi(prompt) {
    return new Promise((resolve, reject) => {
      const rawModel = this.preferredModel.replace(/^google\//, '').trim();
      let modelName = rawModel && rawModel !== 'auto' ? rawModel : 'gemini-3.6-flash';
      if (modelName === 'gemini-2.0-flash' || modelName === 'gemini-1.5-flash' || modelName === 'gemini-2.5-flash') {
        modelName = 'gemini-3.6-flash';
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(this.geminiApiKey)}`;
      const payload = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });

      const req = https.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 25000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              const parts = parsed.candidates?.[0]?.content?.parts || [];
              const text = parts.map((p) => p.text || '').filter(Boolean).join('\n').trim();
              if (text) return resolve(text);
            } catch (_) {}
          }
          reject(new Error(`Gemini API HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Gemini API timeout')); });
      req.write(payload);
      req.end();
    });
  }

  _callOpenAiApi(prompt) {
    return new Promise((resolve, reject) => {
      const rawModel = this.preferredModel.replace(/^openai\//, '');
      const modelName = rawModel.startsWith('gpt') ? rawModel : 'gpt-4o';
      const url = 'https://api.openai.com/v1/chat/completions';
      const payload = JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
      });

      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openaiApiKey}`,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 25000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              const text = parsed.choices?.[0]?.message?.content;
              if (text) return resolve(text);
            } catch (_) {}
          }
          reject(new Error(`OpenAI API HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI API timeout')); });
      req.write(payload);
      req.end();
    });
  }

  async _callOpencodeZenFreeModel(prompt) {
    const zenModels = await this.fetchZenModels();
    const freeModels = (Array.isArray(zenModels) ? zenModels : []).filter((m) => m.free === true || (m.id && m.id.includes('free')));
    
    // 試行するモデル候補の順序を決定
    const candidates = [];
    if (this.preferredModel && this.preferredModel !== 'auto' && freeModels.some((m) => m.id === this.preferredModel)) {
      candidates.push(this.preferredModel);
    }
    for (const m of freeModels) {
      if (!candidates.includes(m.id)) candidates.push(m.id);
    }
    if (candidates.length === 0) candidates.push('nemotron-3.5-lightning-free', 'hy3-free', 'mimo-v2.5-free');

    const maxAttemptsPerModel = 2;
    let lastError = null;

    for (const modelName of candidates) {
      for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
        try {
          const result = await this._callSingleZenModel(modelName, prompt);
          if (result?.content) return result;
        } catch (err) {
          lastError = err;
          console.warn(`[NMT-AI] Zen model ${modelName} (attempt ${attempt}) failed: ${err.message}`);
          if (err.code === 'MODEL_UNAVAILABLE' || !this._isTransientZenError(err)) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    throw lastError || new Error('All OpenCode Zen free models failed after multiple retries');
  }

  _callSingleZenModel(modelName, prompt) {
    return new Promise((resolve, reject) => {
      const url = 'https://opencode.ai/zen/v1/chat/completions';
      const payload = JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
      });

      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'NyaitterManagementTool/1.0',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                return reject(new Error(parsed.error.message || 'Provider error'));
              }
              const content = parsed.choices?.[0]?.message?.content || parsed.response || parsed.text;
              if (content) return resolve({ model: modelName, content });
            } catch (_) {}
          }
          const error = new Error(`OpenCode Zen HTTP ${res.statusCode}: ${data.slice(0, 150)}`);
          error.statusCode = res.statusCode;
          if (res.statusCode === 400 && /model is unavailable/i.test(data)) {
            error.code = 'MODEL_UNAVAILABLE';
          }
          reject(error);
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  _isTransientZenError(error) {
    return !error.statusCode || error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500;
  }

  _httpGetJson(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'NyaitterManagementTool/1.0', 'Accept': 'application/json' },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              return resolve(JSON.parse(data));
            } catch (e) {
              return reject(e);
            }
          }
          reject(new Error(`HTTP ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  _generateHeuristicAdvice(prompt, taskType) {
    if (taskType === 'error_analysis') {
      return `### 1. 原因の分析
エラーのスタックトレースおよびコンテキストから、プロパティ参照エラー（TypeError）またはAPIパラメータの欠落の可能性が高いです。

### 2. 影響範囲
対象エンドポイントへのリクエストが500エラーとなり、該当機能の利用が一時的に失敗します。

### 3. 具体的な対応・修正手順
1. エラーが発生したモジュールで未定義オブジェクトのオプショナルチェーン（\`?.\`）またはnull/undefinedチェックを実施してください。
2. DBアダプターメソッドの引数・戻り値型と呼び出し側のプロパティ名（キャメルケース/スネークケース）が一致しているか確認してください。
3. 修正後に \`node --check\` および該当テストを実行して安全を確認してください。`;
    }

    return `### 1. 攻撃/アクセスの意図と手法
単一または分散IPからの自動スキャンツールによる脆弱性探索（.env, adminパス, SQLiスキャン等）が検知されました。

### 2. 危険度評価
**中（自動スキャン）** - システムが適切に404/403を返している限り直接の侵害リスクは低いです。

### 3. 推奨される防御・対処手順
1. Cloudflare WAFで該当IPアドレスまたは怪しいUser-AgentをBlockリストへ追加してください。
2. レートリミット（Express rate-limiter）の閾値を超えたクライアントへの一時的IP遮断ルールを検討してください。`;
  }
}

module.exports = AiAnalysisService;
