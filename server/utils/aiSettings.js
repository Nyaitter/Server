const TYPES = new Set(['openai', 'gemini', 'antigravity', 'codex', 'opencode']);

function normalizeProviders(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error('AI_PROVIDERS must be a JSON array'); }
  }
  if (!Array.isArray(value)) throw new Error('AI_PROVIDERS must be a JSON array');
  const ids = new Set();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`AI provider ${index + 1} must be an object`);
    const type = String(entry.type || '').trim().toLowerCase();
    if (!TYPES.has(type)) throw new Error(`AI provider ${index + 1} has an unsupported type`);
    const id = String(entry.id || `${type}:${index + 1}`).trim();
    if (!/^[A-Za-z0-9._:-]+$/.test(id) || id === 'auto' || ids.has(id)) throw new Error(`AI provider ${index + 1} has a duplicate or invalid id`);
    ids.add(id);
    const url = String(entry.url || '').trim().replace(/\/+$/, '');
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error(`AI provider ${id} has an invalid URL`); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error(`AI provider ${id} must use an HTTP(S) base URL without credentials or query parameters`);
      }
      if (['codex', 'opencode', 'antigravity'].includes(type)) throw new Error(`AI provider ${id} uses a CLI and cannot specify url`);
    }
    if (entry.roumodels !== undefined && (!Array.isArray(entry.roumodels) || entry.roumodels.some(m => typeof m !== 'string' || !m.trim()))) {
      throw new Error(`AI provider ${id} roumodels must be an array of model names`);
    }
    return {
      id, type, url, apikey: String(entry.apikey || ''),
      defmodel: String(entry.defmodel || '').trim(),
      roumodels: entry.roumodels === undefined ? null : [...new Set(entry.roumodels.map(m => m.trim()))],
      command: String(entry.command || '').trim(),
    };
  });
}

module.exports = { normalizeProviders };
