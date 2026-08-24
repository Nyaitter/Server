'use strict';

const path = require('path');
const kuromoji = require('kuromoji');

const { extractViewContent } = require('../utils/viewContent');

const MAX_POST_TAGS = 10;
const MAX_CANDIDATE_LENGTH = 48;

const STOP_WORDS = new Set([
  'これ', 'それ', 'あれ', 'ここ', 'そこ', 'どこ', 'こと', 'もの', 'ため', 'よう',
  'さん', 'ちゃん', 'くん', 'する', 'いる', 'ある', 'なる', 'できる', '思う', '見る',
  '今日', '昨日', '明日', '今回', '自分', '私', '僕', '俺', 'あなた', 'みんな',
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'will', 'just', 'about',
]);

let tokenizerPromise = null;

function buildTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: path.join(__dirname, '../../node_modules/kuromoji/dict') })
        .build((error, tokenizer) => {
          if (error) reject(error);
          else resolve(tokenizer);
        });
    }).catch((error) => {
      console.error('[post-keywords] tokenizer initialization failed:', error.message);
      return null;
    });
  }
  return tokenizerPromise;
}

function normalizeKeyword(value) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/^[#＃]+/, '')
    .toLocaleLowerCase('ja-JP');
  if (!normalized || normalized.length > MAX_CANDIDATE_LENGTH) return null;
  if (!/[\p{L}\p{N}]/u.test(normalized)) return null;
  if (/^\d+$/u.test(normalized) || STOP_WORDS.has(normalized)) return null;
  if (/^[a-z]+$/u.test(normalized) && normalized.length < 3) return null;
  return normalized;
}

function stripNonContentSegments(content) {
  return String(content || '')
    .replace(/https?:\/\/[^\s]+/giu, ' ')
    .replace(/@[\p{L}\p{N}_-]+/giu, ' ');
}

function fallbackKeywords(content) {
  const scores = new Map();
  const add = (raw, boost = 1) => {
    const keyword = normalizeKeyword(raw);
    if (!keyword) return;
    scores.set(keyword, (scores.get(keyword) || 0) + boost + Math.min(2, keyword.length / 12));
  };

  const sanitized = stripNonContentSegments(content);
  for (const hashtag of sanitized.matchAll(/(?:#|＃)([\p{L}\p{N}_-]{1,48})/gu)) add(hashtag[1], 5);
  for (const word of sanitized.matchAll(/[a-zA-Z][a-zA-Z0-9_-]{2,47}/g)) add(word[0], 2);

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'ja'))
    .slice(0, MAX_POST_TAGS)
    .map(([keyword]) => keyword);
}

function extractCompoundTagsFromTokens(tokens) {
  const tagScores = new Map();
  const addTag = (raw, weight) => {
    const tag = normalizeKeyword(raw);
    if (!tag) return;
    tagScores.set(tag, (tagScores.get(tag) || 0) + weight + Math.min(2, tag.length / 10));
  };

  // 1. 連続する名詞（複合名詞句）: 例「人工知能技術」「機械学習モデル」
  let currentCompound = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.pos === '名詞' && t.pos_detail_1 !== '非自立' && t.pos_detail_1 !== '代名詞' && t.pos_detail_1 !== '数') {
      currentCompound.push(t.surface_form);
    } else {
      if (currentCompound.length > 1) {
        addTag(currentCompound.join(''), 6);
      }
      currentCompound = [];
    }
  }
  if (currentCompound.length > 1) {
    addTag(currentCompound.join(''), 6);
  }

  // 2. 「名詞 + の + 名詞」などの名詞句: 例「猫のカフェ」「技術の開発」
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokens[i].pos === '名詞' && tokens[i + 1].surface_form === 'の' && tokens[i + 2].pos === '名詞') {
      if (tokens[i].pos_detail_1 !== '非自立' && tokens[i + 2].pos_detail_1 !== '非自立') {
        addTag(tokens[i].surface_form + 'の' + tokens[i + 2].surface_form, 5);
      }
    }
  }

  return [...tagScores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'ja'))
    .slice(0, MAX_POST_TAGS)
    .map(([tag]) => tag);
}

function fallbackTags(content) {
  const scores = new Map();
  const add = (raw, boost = 1) => {
    const keyword = normalizeKeyword(raw);
    if (!keyword) return;
    scores.set(keyword, (scores.get(keyword) || 0) + boost + Math.min(2, keyword.length / 12));
  };

  const sanitized = stripNonContentSegments(content);
  // ハッシュタグや複数単語フレーズ
  for (const hashtag of sanitized.matchAll(/(?:#|＃)([\p{L}\p{N}_-]{1,48})/gu)) add(hashtag[1], 5);
  for (const phrase of sanitized.matchAll(/[\p{L}\p{N}_-]{3,20}の[\p{L}\p{N}_-]{2,20}/gu)) add(phrase[0], 4);

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'ja'))
    .slice(0, MAX_POST_TAGS)
    .map(([keyword]) => keyword);
}

async function extractPostWords(content) {
  const viewContent = extractViewContent(content);
  const sanitized = stripNonContentSegments(viewContent);
  if (!sanitized.trim()) return [];

  const tokenizer = await buildTokenizer();
  if (!tokenizer) return fallbackKeywords(sanitized);

  const scores = new Map();
  const add = (raw, weight) => {
    const keyword = normalizeKeyword(raw);
    if (!keyword) return;
    scores.set(keyword, (scores.get(keyword) || 0) + weight + Math.min(2, keyword.length / 12));
  };

  for (const hashtag of sanitized.matchAll(/(?:#|＃)([\p{L}\p{N}_-]{1,48})/gu)) {
    add(hashtag[1], 8);
  }

  for (const token of tokenizer.tokenize(sanitized)) {
    const partOfSpeech = token.pos;
    if (partOfSpeech !== '名詞' && partOfSpeech !== '動詞' && partOfSpeech !== '形容詞') continue;
    const basicForm = token.basic_form && token.basic_form !== '*' ? token.basic_form : token.surface_form;
    const detail = token.pos_detail_1;
    const weight = partOfSpeech === '名詞'
      ? (detail === '固有名詞' ? 7 : 4)
      : 2;
    add(basicForm, weight);
  }

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'ja'))
    .slice(0, MAX_POST_TAGS)
    .map(([keyword]) => keyword);
}

async function extractPostTags(content) {
  const viewContent = extractViewContent(content);
  const sanitized = stripNonContentSegments(viewContent);
  if (!sanitized.trim()) return [];

  const tokenizer = await buildTokenizer();
  if (!tokenizer) return fallbackTags(sanitized);

  const tokens = tokenizer.tokenize(sanitized);
  const phraseTags = extractCompoundTagsFromTokens(tokens);
  return phraseTags;
}

async function extractPostTagsAndWords(content) {
  const viewContent = extractViewContent(content);
  const sanitized = stripNonContentSegments(viewContent);
  if (!sanitized.trim()) return { words: [], tags: [], combined: [] };

  const tokenizer = await buildTokenizer();
  if (!tokenizer) {
    const words = fallbackKeywords(sanitized);
    const tags = fallbackTags(sanitized);
    const combined = [...new Set([...tags, ...words])].slice(0, 10);
    return { words, tags, combined };
  }

  const tokens = tokenizer.tokenize(sanitized);
  const tags = extractCompoundTagsFromTokens(tokens).slice(0, 5);

  const scores = new Map();
  const add = (raw, weight) => {
    const keyword = normalizeKeyword(raw);
    if (!keyword) return;
    scores.set(keyword, (scores.get(keyword) || 0) + weight + Math.min(2, keyword.length / 12));
  };

  for (const hashtag of sanitized.matchAll(/(?:#|＃)([\p{L}\p{N}_-]{1,48})/gu)) {
    add(hashtag[1], 8);
  }

  for (const token of tokens) {
    const partOfSpeech = token.pos;
    if (partOfSpeech !== '名詞' && partOfSpeech !== '動詞' && partOfSpeech !== '形容詞') continue;
    const basicForm = token.basic_form && token.basic_form !== '*' ? token.basic_form : token.surface_form;
    const detail = token.pos_detail_1;
    const weight = partOfSpeech === '名詞'
      ? (detail === '固有名詞' ? 7 : 4)
      : 2;
    add(basicForm, weight);
  }

  const words = [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'ja'))
    .slice(0, 5)
    .map(([keyword]) => keyword);

  const combined = [...new Set([...tags, ...words])].slice(0, 10);
  return { words, tags, combined };
}

// 投稿に保存するキーワード（tags 5個 + words 5個 の合計最大10個）
async function extractPostKeywords(content) {
  const { combined } = await extractPostTagsAndWords(content);
  return combined;
}

module.exports = {
  extractPostKeywords,
  extractPostWords,
  extractPostTags,
  extractPostTagsAndWords,
  MAX_POST_TAGS,
};
