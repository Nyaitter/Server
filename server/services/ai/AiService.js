const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cliModels, cliGenerate } = require('./cli');

function baseUrl(provider) {
  return (provider.url || (provider.type === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.openai.com/v1'))
    .replace(/\/(?:chat\/completions|responses)$/, '');
}

async function requestJson(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      let code = '';
      try {
        const detail = (await response.json())?.error;
        code = detail?.code || '';
        if (response.status === 400 && (detail?.param === 'model' || /(?:model.*(?:not supported|not found|unavailable)|unknown model)/i.test(detail?.message || ''))) {
          code = 'AI_MODEL_UNAVAILABLE';
        }
      } catch {}
      const error = new Error(`AI API request failed (${response.status})`);
      error.statusCode = response.status;
      error.code = String(code);
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('AI API timed out'), { code: 'AI_TIMEOUT' });
    if (error.statusCode) throw error;
    throw Object.assign(new Error('AI API could not be reached'), { code: error.code || 'AI_NETWORK' });
  } finally {
    clearTimeout(timeout);
  }
}

function headers(provider) {
  const value = { 'content-type': 'application/json' };
  if (provider.apikey) {
    if (provider.type === 'gemini') value['x-goog-api-key'] = provider.apikey;
    else value.authorization = `Bearer ${provider.apikey}`;
  }
  return value;
}

function modelSupportsGeneration(model, type) {
  if (type === 'gemini') return model.supportedGenerationMethods?.includes('generateContent');
  return !/(?:embedding|whisper|tts|dall-e|moderation|image|realtime|transcribe|audio|sora)/i.test(model.id || '');
}

function isModelDb(database) {
  return database?.version === 1 && Array.isArray(database.providers)
    && database.providers.every(entry => entry && typeof entry.id === 'string' && Array.isArray(entry.models)
      && entry.models.every(model => typeof model === 'string' && model.length > 0));
}

class AiService {
  constructor({ providers = [], modelDbPath = path.resolve(__dirname, '../../data/models.json'), workDir = path.resolve(__dirname, '../../data/ai/requests') } = {}) {
    this.providers = providers;
    this.modelDbPath = modelDbPath;
    this.workDir = workDir;
    this.fingerprint = crypto.createHash('sha256').update(JSON.stringify(providers)).digest('hex');
    this.database = null;
    this.updatePromise = null;
  }

  async _discover(provider) {
    if (!['openai', 'gemini'].includes(provider.type)) return cliModels(provider);
    let models = [];
    let pageToken = '';
    const seen = new Set();
    const deadline = Date.now() + 15000;
    do {
      const url = new URL(`${baseUrl(provider)}/models`);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('AI model discovery timed out');
      const result = await requestJson(url, { headers: headers(provider) }, remaining);
      const list = provider.type === 'gemini' ? result.models : result.data;
      if (!Array.isArray(list)) throw new Error('AI model list has an invalid format');
      models.push(...list.filter(model => modelSupportsGeneration(model, provider.type))
        .map(model => String(model.id || model.name || '').replace(/^models\//, '')).filter(Boolean));
      pageToken = provider.type === 'gemini' ? result.nextPageToken || '' : '';
      if (seen.has(pageToken) || seen.size >= 20) break;
      seen.add(pageToken);
    } while (pageToken);
    return [...new Set(models)];
  }

  async ensureModelDb() {
    if (this.database) return this.database;
    try {
      const database = JSON.parse(await fs.promises.readFile(this.modelDbPath, 'utf8'));
      if (isModelDb(database) && database.fingerprint === this.fingerprint) {
        this.database = database;
        return database;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) console.warn('[ai] ModelDB could not be read; rebuilding it');
    }
    return this.updateModelDb();
  }

  async updateModelDb() {
    if (this.updatePromise) return this.updatePromise;
    this.updatePromise = this._updateModelDb().finally(() => { this.updatePromise = null; });
    return this.updatePromise;
  }

  async _updateModelDb() {
    let previous = this.database;
    if (!previous) {
      try { previous = JSON.parse(await fs.promises.readFile(this.modelDbPath, 'utf8')); } catch {}
    }
    const entries = await Promise.all(this.providers.map(async provider => {
      let discovered = [];
      let discoveryFailed = false;
      if (provider.roumodels === null) {
        try { discovered = await this._discover(provider); }
        catch {
          discoveryFailed = true;
          if (isModelDb(previous) && previous.fingerprint === this.fingerprint) discovered = previous.providers.find(entry => entry.id === provider.id)?.models || [];
          console.warn(`[ai] Model discovery failed for ${provider.id}; configured models remain usable`);
        }
      }
      return {
        id: provider.id, type: provider.type, defmodel: provider.defmodel,
        models: [...new Set([provider.defmodel, ...(provider.roumodels || discovered)].filter(Boolean))],
        discoveryFailed,
      };
    }));
    const database = { version: 1, fingerprint: this.fingerprint, updatedAt: new Date().toISOString(), providers: entries };
    this.database = database;
    const temporary = `${this.modelDbPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(this.modelDbPath), { recursive: true });
      await fs.promises.writeFile(temporary, JSON.stringify(database, null, 2) + '\n', { mode: 0o600 });
      await fs.promises.rename(temporary, this.modelDbPath);
    } catch {
      console.warn('[ai] ModelDB could not be saved; using the in-memory model list');
    } finally {
      await fs.promises.unlink(temporary).catch(() => {});
    }
    return database;
  }

  async generate(request = {}) {
    const selection = String(request.provider || 'auto').toLowerCase();
    const providers = this.providers.filter(provider => selection === 'auto' || provider.type === selection || provider.id.toLowerCase() === selection);
    if (!providers.length) throw new Error('No configured AI provider matches the requested provider');
    const database = await this.ensureModelDb();
    const deadline = Date.now() + (request.routingTimeoutMs || 90000);
    let lastError;
    for (const provider of providers) {
      const entry = database.providers.find(value => value.id === provider.id);
      const explicitModel = request.model && request.model !== 'auto' ? request.model : '';
      const nativeDefault = !provider.defmodel && !['openai', 'gemini'].includes(provider.type);
      const models = [...new Set([explicitModel, provider.defmodel, ...(entry?.models || [])].filter(Boolean))];
      if (!explicitModel && nativeDefault) models.unshift(null);
      if (!models.length) { lastError = new Error(`No model is available for AI provider ${provider.id}; set defmodel or a feature model`); continue; }
      for (const model of models) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw lastError || Object.assign(new Error('AI routing timed out'), { code: 'AI_TIMEOUT' });
        const attempt = { ...request, workDir: this.workDir, timeoutMs: Math.min(request.timeoutMs || 45000, remaining) };
        try {
          if (!['openai', 'gemini'].includes(provider.type)) return await cliGenerate(provider, model, attempt);
          return await this._generateApi(provider, model, attempt);
        } catch (error) {
          lastError = error;
          if ([401, 403].includes(error.statusCode) || ['ENOENT', 'AI_AUTH', 'AI_CLI_FAILED', 'AI_CLI_UNAVAILABLE', 'AI_CLI_PERMISSIONS', 'AI_CAPABILITY'].includes(error.code)) break;
          const retryable = [404, 408, 429, 500, 502, 503, 504].includes(error.statusCode)
            || /model.*(?:not_found|not_available|unsupported)|unsupported.model|AI_(?:TIMEOUT|NETWORK|MODEL_UNAVAILABLE|MODEL_CAPABILITY)/i.test(error.code || '');
          if (!retryable) {
            if (selection !== 'auto') throw error;
            break;
          }
        }
      }
    }
    throw lastError || new Error('No AI model is available');
  }

  async _generateApi(provider, model, request) {
    if (provider.type === 'gemini') {
      const parts = [{ text: request.text || '' }, ...(request.images || []).map(image => ({ inlineData: image }))];
      return requestJson(`${baseUrl(provider)}/models/${encodeURIComponent(String(model).replace(/^models\//, ''))}:generateContent`, {
        method: 'POST', headers: headers(provider),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system || '' }] },
          contents: [{ role: 'user', parts }],
          generationConfig: { candidateCount: 1, maxOutputTokens: request.maxOutputTokens || 256 },
        }),
      }, request.timeoutMs || 45000);
    }
    const content = [{ type: 'text', text: request.text || '' }, ...(request.images || []).map(image => ({
      type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    }))];
    return requestJson(`${baseUrl(provider)}/chat/completions`, {
      method: 'POST', headers: headers(provider),
      body: JSON.stringify({
        model, messages: [{ role: 'system', content: request.system || '' }, { role: 'user', content }],
        [provider.url ? 'max_tokens' : 'max_completion_tokens']: request.maxOutputTokens || 256,
      }),
    }, request.timeoutMs || 45000);
  }
}

let sharedService;
function getAiService() {
  if (!sharedService) sharedService = new AiService(require('../../config').ai);
  return sharedService;
}

module.exports = { AiService, getAiService };
