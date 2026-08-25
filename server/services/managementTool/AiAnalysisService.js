'use strict';

const https = require('https');
const path = require('path');
const { execFile } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../../../'); // /workspaces/codespaces-blank/Server

class AiAnalysisService {
  constructor(config = {}) {
    this.geminiApiKey = config.geminiApiKey || process.env.GEMINI_API_KEY || '';
    this.openaiApiKey = config.openaiApiKey || process.env.OPENAI_API_KEY || '';
    this.preferredModel = config.aiModel || process.env.NMT_AI_MODEL || 'auto';
    this.zenModelsCache = null;
    this.zenModelsLastFetched = 0;
  }

  updateConfig(config = {}) {
    if (config.geminiApiKey !== undefined) this.geminiApiKey = config.geminiApiKey;
    if (config.openaiApiKey !== undefined) this.openaiApiKey = config.openaiApiKey;
    if (config.aiModel !== undefined) this.preferredModel = config.aiModel;
  }

  // ── OpenCode Zen 提供のモデル一覧を動的取得 ───────────────────────────
  async fetchZenModels(force = false) {
    const now = Date.now();
    if (!force && this.zenModelsCache && (now - this.zenModelsLastFetched) < 10 * 60 * 1000) {
      return this.zenModelsCache;
    }

    try {
      const data = await this._httpGetJson('https://opencode.ai/zen/v1/models');
      const models = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : (Array.isArray(data) ? data : []));
      
      const freeModels = models.filter((m) => {
        const id = (typeof m === 'string' ? m : m.id || '').toLowerCase();
        return m.free === true || id.includes('free') || id.includes('flash') || id.includes('mini');
      }).map((m) => typeof m === 'string' ? { id: m, name: m, free: true } : { id: m.id, name: m.name || m.id, free: true });

      this.zenModelsCache = freeModels.length > 0 ? freeModels : [
        { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', free: true },
        { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash (Free)', free: true },
        { id: 'mimo-v2.5-free', name: 'MiMo V2.5 (Free)', free: true },
      ];
      this.zenModelsLastFetched = now;
      return this.zenModelsCache;
    } catch (e) {
      console.warn('[NMT-AI] Failed to fetch dynamic Zen models, using fallback list:', e.message);
      return this.zenModelsCache || [
        { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', free: true },
        { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash (Free)', free: true },
        { id: 'mimo-v2.5-free', name: 'MiMo V2.5 (Free)', free: true },
      ];
    }
  }

  async getAvailableModels() {
    const zenFree = await this.fetchZenModels();
    const list = [
      { id: 'auto', name: 'Auto（Opencode最良モデル自動選択）', provider: 'opencode' },
      ...zenFree.map((m) => ({ id: m.id, name: `[OpenCode Zen Free] ${m.name}`, provider: 'zen' })),
    ];

    if (this.geminiApiKey) {
      list.push(
        { id: 'google/gemini-2.0-flash', name: '[Gemini via Opencode] Gemini 2.0 Flash', provider: 'gemini' },
        { id: 'google/gemini-2.0-flash-thinking-exp', name: '[Gemini via Opencode] Gemini 2.0 Flash Thinking', provider: 'gemini' },
      );
    }
    if (this.openaiApiKey) {
      list.push(
        { id: 'openai/gpt-4o', name: '[OpenAI via Opencode] GPT-4o', provider: 'openai' },
        { id: 'openai/gpt-4o-mini', name: '[OpenAI via Opencode] GPT-4o-mini', provider: 'openai' },
      );
    }

    return list;
  }

  async analyzeError(errorRecord) {
    const prompt = `【重要：調査・解析専用エージェント（編集・変更禁止）】
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

    return this._callAi(prompt, 'error_analysis');
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

  async _callAi(prompt, taskType) {
    // 1. Opencode Agent（CLI経由でマルチターン調査）を実行
    // Gemini API Key や OpenAI API Key も Opencode に渡し、コードを読みつつ調査させる
    try {
      const cliResult = await this._callOpencodeAgent(prompt);
      if (cliResult) {
        return {
          model: `Opencode Agent (${this._resolveOpencodeModelName()})`,
          content: cliResult,
          provider: 'opencode-agent',
        };
      }
    } catch (err) {
      console.warn('[NMT-AI] Opencode agent execution failed, falling back to API:', err.message);
    }

    // 2. フォールバック: OpenCode Zen / 各種 API 直接コール
    if (this.geminiApiKey && (this.preferredModel.includes('gemini') || this.preferredModel.includes('google'))) {
      try {
        const res = await this._callGeminiApi(prompt);
        if (res) return { model: `Gemini Direct (${this.preferredModel})`, content: res, provider: 'gemini' };
      } catch (_) {}
    }

    if (this.openaiApiKey && (this.preferredModel.includes('gpt') || this.preferredModel.includes('openai'))) {
      try {
        const res = await this._callOpenAiApi(prompt);
        if (res) return { model: `OpenAI Direct (${this.preferredModel})`, content: res, provider: 'openai' };
      } catch (_) {}
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

  _resolveOpencodeModelName() {
    if (this.preferredModel && this.preferredModel !== 'auto') {
      return this.preferredModel;
    }
    if (this.geminiApiKey) return 'google/gemini-2.0-flash';
    if (this.openaiApiKey) return 'openai/gpt-4o';
    return 'zen/deepseek-v4-flash-free';
  }

  _callOpencodeAgent(prompt) {
    return new Promise((resolve, reject) => {
      const model = this._resolveOpencodeModelName();
      const readonlyConfigPath = path.resolve(__dirname, 'opencode-readonly-config.json');

      const args = ['run', '--pure', '-m', model, prompt];

      const env = {
        ...process.env,
        OPENCODE_CONFIG: readonlyConfigPath,
        GEMINI_API_KEY: this.geminiApiKey || process.env.GEMINI_API_KEY || '',
        GOOGLE_GENERATIVE_AI_API_KEY: this.geminiApiKey || process.env.GEMINI_API_KEY || '',
        OPENAI_API_KEY: this.openaiApiKey || process.env.OPENAI_API_KEY || '',
      };

      execFile('opencode', args, {
        cwd: PROJECT_ROOT,
        env,
        timeout: 60000,
        maxBuffer: 20 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) return reject(error);
        const output = (stdout || '').trim();
        if (output) return resolve(output);
        reject(new Error('Opencode agent produced empty response'));
      });
    });
  }

  _callGeminiApi(prompt) {
    return new Promise((resolve, reject) => {
      const rawModel = this.preferredModel.replace(/^google\//, '');
      const modelName = rawModel.startsWith('gemini') ? rawModel : 'gemini-2.0-flash';
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
              const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
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
    let targetModel = this.preferredModel;
    if (!targetModel || targetModel === 'auto' || !zenModels.some((m) => m.id === targetModel)) {
      targetModel = zenModels[0]?.id || 'deepseek-v4-flash-free';
    }

    return new Promise((resolve, reject) => {
      const url = 'https://opencode.ai/zen/v1/chat/completions';
      const payload = JSON.stringify({
        model: targetModel,
        messages: [{ role: 'user', content: prompt }],
      });

      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'NyaitterManagementTool/1.0',
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
              const content = parsed.choices?.[0]?.message?.content || parsed.response || parsed.text;
              if (content) return resolve({ model: targetModel, content });
            } catch (_) {}
          }
          reject(new Error(`OpenCode Zen HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('OpenCode Zen timeout')); });
      req.write(payload);
      req.end();
    });
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
