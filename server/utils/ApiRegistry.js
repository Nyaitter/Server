'use strict';

const express = require('express');

const TAG_LABELS = {
  posts: '投稿・タイムライン',
  polls: '投票',
  users: 'ユーザー・プロフィール',
  auth: '認証・セッション',
  dm: 'ダイレクトメッセージ',
  groups: 'グループ',
  uploads: 'ファイルアップロード',
  notifications: '通知',
  ranking: 'ランキング',
  reports: '通報・モデレーション',
  appeals: '異議申し立て',
  verification: '認証バッジ申請',
  push: 'WebPush 通知',
  rules: 'サーバー規約',
  'nyaitter-auth': 'NyaitterAuth',
  oembed: 'oEmbed 埋め込み',
  'url-cards': 'URL カード',
  ui: 'UI・テーマ',
  system: 'システムステータス',
  spec: 'API 仕様',
  docs: '公式ドキュメント',
};

const AUTH_METADATA = {
  required: { label: '要ログイン', type: 'required' },
  admin: { label: '管理者専用', type: 'admin' },
  session: { label: 'セッション必須', type: 'required' },
  optional: { label: '任意認証', type: 'optional' },
  bot: { label: 'Bot 専用', type: 'bot' },
  none: { label: '認証不要', type: 'none' },
};

function generateSdkSnippet(endpoint) {
  const method = endpoint.method.toUpperCase();
  const tag = endpoint.tag;
  const path = endpoint.path;

  const sdkMap = {
    posts: {
      'POST /': 'await client.posts.create({ content: "投稿本文" });',
      'GET /': 'const timeline = await client.posts.getTimeline();',
      'GET /trending': 'const trending = await client.posts.getTrending();',
      'GET /search': 'const search = await client.posts.search("キーワード");',
      'POST /:id/like': 'await client.posts.like(postId);',
      'POST /:id/star': 'await client.posts.star(postId);',
      'POST /:id/repost': 'await client.posts.repost(postId);',
      'DELETE /:id': 'await client.posts.delete(postId);',
    },
    polls: {
      'POST /': 'await client.polls.create({ postId: 123, options: ["選択肢A", "選択肢B"] });',
      'GET /:pollId': 'const poll = await client.polls.get(pollId);',
      'POST /:pollId/vote': 'await client.polls.vote(pollId, { optionIndex: 0 });',
    },
    users: {
      'GET /:userId': 'const user = await client.users.get(userId);',
      'POST /:userId/follow': 'await client.users.follow(userId);',
      'GET /search': 'const users = await client.users.search("ユーザー名");',
    },
    dm: {
      'GET /': 'const dms = await client.dm.list();',
      'POST /:dmId/messages': 'await client.dm.sendMessage(dmId, { text: "メッセージ" });',
    },
  };

  if (sdkMap[tag]?.[`${method} ${path}`]) {
    return `import { NyaitterClient } from 'nyaitter';\nconst client = new NyaitterClient({ token: 'YOUR_TOKEN' });\n${sdkMap[tag][`${method} ${path}`]}`;
  }

  return `import { NyaitterClient } from 'nyaitter';\nconst client = new NyaitterClient({ token: 'YOUR_TOKEN' });\nconst response = await client.request('${method}', '${endpoint.fullPath}');`;
}

function generateCurlSnippet(endpoint) {
  const method = endpoint.method.toUpperCase();
  if (endpoint.auth === 'none') {
    return `curl -X ${method} "https://your-nyaitter-server.com${endpoint.fullPath}"`;
  }
  return `curl -X ${method} "https://your-nyaitter-server.com${endpoint.fullPath}" \\\n  -H "Authorization: Bearer YOUR_TOKEN"`;
}

/**
 * NyaitterAPI 共通仕様レジストリ
 * すべての公開 API エンドポイントのメタデータ（パス、メソッド、概要、認証要否など）を一元管理し、
 * 仕様登録されていないエンドポイントの公開を禁止します。
 */
class ApiRegistry {
  constructor() {
    this._endpoints = new Map();
    this._routers = [];
  }

  /**
   * 仕様定義を検証します。
   * @param {object} spec
   */
  validateSpec(spec) {
    if (!spec || typeof spec !== 'object') {
      throw new Error('API 仕様オブジェクト (spec) が必須です。');
    }
    if (typeof spec.path !== 'string' || !spec.path.trim().startsWith('/')) {
      throw new Error(`API パスは '/' から始まる文字列である必要があります: ${spec.path}`);
    }
    if (!spec.summary || typeof spec.summary !== 'string' || spec.summary.trim() === '') {
      throw new Error(`API 仕様に summary（機能の概要）が必須です: [${spec.method || 'METHOD'}] ${spec.path}`);
    }
    const validAuth = ['none', 'optional', 'required', 'admin', 'session', 'frozen_session', 'bot'];
    if (spec.auth && !validAuth.includes(spec.auth)) {
      throw new Error(`無効な auth 指定です (${spec.auth}): [${spec.method}] ${spec.path}`);
    }
  }

  /**
   * エンドポイント仕様を登録します。
   * @param {object} spec
   */
  registerEndpoint(spec) {
    this.validateSpec(spec);
    const key = `${spec.method.toUpperCase()} ${spec.fullPath || spec.path}`;
    const normalizedTag = spec.tag || 'general';
    const normalizedAuth = spec.auth || 'none';

    const endpointObj = {
      method: spec.method.toUpperCase(),
      path: spec.path,
      fullPath: spec.fullPath || spec.path,
      tag: normalizedTag,
      tagLabel: TAG_LABELS[normalizedTag] || normalizedTag,
      summary: spec.summary.trim(),
      description: spec.description ? spec.description.trim() : undefined,
      auth: normalizedAuth,
      authBadge: AUTH_METADATA[normalizedAuth] || AUTH_METADATA.none,
      parameters: spec.parameters || undefined,
      requestBody: spec.requestBody || undefined,
      responses: spec.responses || undefined,
      deprecated: Boolean(spec.deprecated),
    };

    endpointObj.snippets = {
      sdk: generateSdkSnippet(endpointObj),
      curl: generateCurlSnippet(endpointObj),
    };

    this._endpoints.set(key, endpointObj);
  }

  /**
   * 登録された全 API 仕様の一覧を取得します。
   * @returns {object[]}
   */
  getEndpoints() {
    return Array.from(this._endpoints.values());
  }

  /**
   * タグラベル一覧を取得します。
   * @returns {Record<string, string>}
   */
  getTagLabels() {
    return { ...TAG_LABELS };
  }

  /**
   * OpenAPI 3.0 互換の仕様オブジェクトを生成します。
   * @param {object} [info]
   * @returns {object}
   */
  getOpenApiSpec(info = {}) {
    const paths = {};
    const tagsSet = new Set();

    for (const ep of this._endpoints.values()) {
      tagsSet.add(ep.tag);
      const openApiPath = ep.fullPath.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
      if (!paths[openApiPath]) paths[openApiPath] = {};

      paths[openApiPath][ep.method.toLowerCase()] = {
        tags: [ep.tag],
        summary: ep.summary,
        description: ep.description,
        deprecated: ep.deprecated,
        security: ep.auth === 'none' ? [] : [{ bearerAuth: [] }, { cookieAuth: [] }],
        parameters: ep.parameters,
        requestBody: ep.requestBody,
        responses: ep.responses || {
          200: { description: 'Successful response' },
        },
      };
    }

    return {
      openapi: '3.0.3',
      info: {
        title: 'Nyaitter API',
        version: '0.1.0',
        description: 'Nyaitter Server REST API Specification',
        ...info,
      },
      tags: Array.from(tagsSet).map((name) => ({ name, description: TAG_LABELS[name] || undefined })),
      paths,
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
          },
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'nyaitter_session',
          },
        },
      },
    };
  }

  /**
   * 仕様登録が必須化された API ルーターを作成します。
   *
   * @param {object} options
   * @param {string} options.tag - API カテゴリ名（例: 'posts', 'users'）
   * @param {string} [options.basePath] - ベースパス（例: '/posts'）
   * @param {string} [options.description] - カテゴリ説明
   * @returns {import('express').Router}
   */
  createRouter({ tag, basePath = '', description = '' } = {}) {
    const expressRouter = express.Router();
    const registry = this;
    const cleanBasePath = basePath ? `/${basePath.replace(/^\/+|\/+$/g, '')}` : '';

    const wrapMethod = (httpMethod) => {
      return (specOrPath, ...handlers) => {
        let spec;
        if (typeof specOrPath === 'string') {
          const maybeSpec = handlers.find((h) => h && typeof h === 'object' && !Array.isArray(h) && (h.summary || h.auth));
          if (!maybeSpec) {
            throw new Error(`[ApiRegistry] エンドポイント [${httpMethod.toUpperCase()}] ${cleanBasePath}${specOrPath} に API 仕様（summary, auth 等）の登録が必須です。仕様オブジェクトを第1引数に渡してください。`);
          }
          spec = { ...maybeSpec, path: specOrPath, method: httpMethod };
          handlers = handlers.filter((h) => h !== maybeSpec);
        } else if (specOrPath && typeof specOrPath === 'object') {
          spec = { ...specOrPath, method: httpMethod };
        } else {
          throw new Error(`[ApiRegistry] [${httpMethod.toUpperCase()}] の登録には仕様オブジェクト (spec) が必須です。`);
        }

        spec.tag = spec.tag || tag || 'general';
        spec.fullPath = `${cleanBasePath}${spec.path}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';

        registry.registerEndpoint(spec);
        return expressRouter[httpMethod.toLowerCase()](spec.path, ...handlers);
      };
    };

    const routerProxy = new Proxy(expressRouter, {
      get(target, prop) {
        const lowerProp = String(prop).toLowerCase();
        if (['get', 'post', 'put', 'patch', 'delete'].includes(lowerProp)) {
          return wrapMethod(lowerProp);
        }
        if (prop === 'register') {
          return (spec, ...handlers) => {
            if (!spec || !spec.method) throw new Error('[ApiRegistry] register には method が必須です。');
            return wrapMethod(spec.method.toLowerCase())(spec, ...handlers);
          };
        }
        if (prop === 'specTag') return tag;
        if (prop === 'specBasePath') return cleanBasePath;
        return target[prop];
      },
    });

    this._routers.push({ tag, basePath: cleanBasePath, description, router: routerProxy });
    return routerProxy;
  }
}

const defaultRegistry = new ApiRegistry();

module.exports = defaultRegistry;
module.exports.ApiRegistry = ApiRegistry;
