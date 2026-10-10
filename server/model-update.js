#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { getAiService } = require('./services/ai/AiService');

getAiService().updateModelDb().then(database => {
  console.log(`[ai] ModelDB updated: ${database.providers.length} providers, ${database.providers.reduce((sum, entry) => sum + entry.models.length, 0)} models`);
}).catch(() => {
  console.error('[ai] ModelDB update failed; check AI_PROVIDERS and the ModelDB path');
  process.exitCode = 1;
});
