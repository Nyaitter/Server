#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { parseDuration, parseIntegerRange } = require('./utils/settingFormats');

const SERVER_DIR = __dirname;
const ENV_PATH = path.join(SERVER_DIR, '.env');
const CONFIG_PATH = path.join(SERVER_DIR, 'config.json');

dotenv.config({ path: ENV_PATH });

const issues = [];

function addIssue(level, code, message, resolution) {
    issues.push({ level, code, message, resolution });
}

function get(object, dottedPath, fallback) {
    return dottedPath
        .split('.')
        .reduce(
            (value, key) =>
                value && value[key] !== undefined ? value[key] : fallback,
            object,
        );
}

function setting(envName, config, configPath, fallback = '') {
    const envValue = process.env[envName];
    if (envValue !== undefined && envValue !== '') return envValue;
    return get(config, configPath, fallback);
}

function firstSetting(envNames, config, configPaths, fallback = '') {
    for (const envName of envNames) {
        const envValue = process.env[envName];
        if (envValue !== undefined && envValue !== '') return envValue;
    }
    for (const configPath of configPaths) {
        const value = get(config, configPath, undefined);
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return fallback;
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function isHttpUrl(value) {
    try {
        const url = new URL(String(value));
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function isCorsOrigin(value) {
    try {
        const url = new URL(String(value).trim());
        return (
            (url.protocol === 'http:' || url.protocol === 'https:') &&
            url.username === '' &&
            url.password === '' &&
            (url.pathname === '/' || url.pathname === '') &&
            url.search === '' &&
            url.hash === ''
        );
    } catch (_) {
        return false;
    }
}

function corsOriginValues(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',');
    return null;
}

function hasPlaceholder(value) {
    return /(?:^|[/:])(?:user|pass|password|example|changeme)(?:$|[/:@?])/i.test(
        String(value || ''),
    );
}

function inspectRangeSetting(config, { label, envName, configPath, fallback, minimum = 0, exact = false }) {
    const value = firstSetting([envName], config, [configPath], fallback);
    const range = parseIntegerRange(value, { minimum });
    if (!range || (exact && (range.min === null || range.min !== range.max))) {
        addIssue(
            'error',
            'LIMIT_RANGE_INVALID',
            `${label} が無効です: ${value}`,
            `${envName} または ${configPath} に 10、10..、..10、10..15 の形式で設定してください。`,
        );
    }
}

function inspectDurationSetting(config, { label, envName, configPath, fallback, legacyEnvName = null, legacyConfigPath = null }) {
    const envNames = legacyEnvName ? [envName, legacyEnvName] : [envName];
    const configPaths = legacyConfigPath ? [configPath, legacyConfigPath] : [configPath];
    const value = firstSetting(envNames, config, configPaths, fallback);
    if (parseDuration(value) === null) {
        addIssue(
            'error',
            'RATE_LIMIT_DURATION_INVALID',
            `${label} が無効です: ${value}`,
            `${envName} または ${configPath} に 10min、15m10s、1000ms の形式で設定してください。`,
        );
    }
}

function inspect() {
    let config;
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (error) {
        addIssue(
            'error',
            'CONFIG_JSON_INVALID',
            `server/config.json を読み込めません: ${error.message}`,
            'server/config.json のJSON構文を修正してください。',
        );
        return;
    }

    const nodeEnv = String(process.env.NODE_ENV || 'development').toLowerCase();
    const isProduction = nodeEnv === 'production';

    const port = Number(setting('PORT', config, 'server.port', 3000));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        addIssue(
            'error',
            'PORT_INVALID',
            `PORT が有効なTCPポートではありません: ${setting('PORT', config, 'server.port')}`,
            'PORT または server.port を1から65535までの整数に設定してください。',
        );
    }

    const apiEndpoint = String(
        setting('NYAITTER_API_ENDPOINT', config, 'server.apiEndpoint', '/server'),
    ).trim();
    if (!apiEndpoint.startsWith('/') || /[?#]/.test(apiEndpoint)) {
        addIssue(
            'error',
            'API_ENDPOINT_INVALID',
            `APIエンドポイントがパスとして無効です: ${apiEndpoint || '(空)'}`,
            'NYAITTER_API_ENDPOINT または server.apiEndpoint に /server、/、/v1 のような先頭が / のパスを設定してください。',
        );
    }

    const configuredCorsOrigins =
        process.env.NYAITTER_CORS_ALLOWED_ORIGINS !== undefined
            ? process.env.NYAITTER_CORS_ALLOWED_ORIGINS
            : process.env.ALLOWED_ORIGINS !== undefined
              ? process.env.ALLOWED_ORIGINS
              : get(config, 'cors.allowedOrigins', []);
    const corsOrigins = corsOriginValues(configuredCorsOrigins);
    if (corsOrigins === null) {
        addIssue(
            'error',
            'CORS_ALLOWED_ORIGINS_INVALID_TYPE',
            'CORS許可オリジンは文字列または配列で指定してください。',
            'NYAITTER_CORS_ALLOWED_ORIGINS にはカンマ区切りのURLを、config.json の cors.allowedOrigins にはURL配列を設定してください。',
        );
    } else {
        const invalidCorsOrigins = corsOrigins
            .map((origin) => String(origin || '').trim())
            .filter((origin) => origin && !isCorsOrigin(origin));
        if (invalidCorsOrigins.length > 0) {
            addIssue(
                'error',
                'CORS_ALLOWED_ORIGINS_INVALID',
                `CORS許可オリジンが無効です: ${invalidCorsOrigins.join(', ')}`,
                'http://localhost:3000 や https://client.example.com のように、パス・クエリ・フラグメントを含まないHTTP(S)オリジンを設定してください。',
            );
        }
    }

    const corsCredentialsValue = firstSetting(
        ['NYAITTER_CORS_CREDENTIALS'],
        config,
        ['cors.credentials'],
        false,
    );
    const corsCredentialsText = String(corsCredentialsValue).trim().toLowerCase();
    const corsCredentialsEnabled = ['true', '1', 'yes', 'on'].includes(corsCredentialsText);
    const corsCredentialsValid =
        typeof corsCredentialsValue === 'boolean' ||
        ['true', '1', 'yes', 'on', 'false', '0', 'no', 'off'].includes(corsCredentialsText);
    if (!corsCredentialsValid) {
        addIssue(
            'error',
            'CORS_CREDENTIALS_INVALID',
            `CORS資格情報の設定が無効です: ${corsCredentialsValue}`,
            'NYAITTER_CORS_CREDENTIALS または cors.credentials に true または false を設定してください。',
        );
    } else if (corsCredentialsEnabled && (!corsOrigins || corsOrigins.length === 0)) {
        addIssue(
            'error',
            'CORS_CREDENTIALS_ORIGINS_REQUIRED',
            '資格情報付きCORSが有効ですが、許可オリジンがありません。',
            'NYAITTER_CORS_ALLOWED_ORIGINS または cors.allowedOrigins に、信頼するClientのHTTP(S)オリジンを設定してください。',
        );
    }

    const rangeSettings = [
        ['ポスト本文の文字数制限', 'NYAITTER_LIMIT_POST_CONTENT_LENGTH', 'limits.postContentLength', '..1000', 0, false],
        ['DM本文の文字数制限', 'NYAITTER_LIMIT_DM_CONTENT_LENGTH', 'limits.dmContentLength', '..2000', 0, false],
        ['DM E2E一時鍵の文字数制限', 'NYAITTER_LIMIT_DM_E2E_EPHEMERAL_KEY_LENGTH', 'limits.dmE2eEphemeralKeyLength', '1..1024', 1, false],
        ['DM E2E暗号文の文字数制限', 'NYAITTER_LIMIT_DM_E2E_CIPHERTEXT_LENGTH', 'limits.dmE2eCiphertextLength', '1..16384', 1, false],
        ['DM E2Eペイロードの文字数制限', 'NYAITTER_LIMIT_DM_E2E_PAYLOAD_LENGTH', 'limits.dmE2ePayloadLength', '..65536', 0, false],
        ['表示名の文字数制限', 'NYAITTER_LIMIT_USER_NAME_LENGTH', 'limits.userNameLength', '1..50', 0, false],
        ['自己紹介の文字数制限', 'NYAITTER_LIMIT_PROFILE_BIO_LENGTH', 'limits.profileBioLength', '..500', 0, false],
        ['Scratchユーザー名の文字数制限', 'NYAITTER_LIMIT_SCRATCH_USERNAME_LENGTH', 'limits.scratchUsernameLength', '3..20', 1, false],
        ['タイムライン取得件数', 'NYAITTER_LIMIT_TIMELINE_PAGE_SIZE', 'limits.timelinePageSize', 30, 1, true],
        ['ユーザー検索ページサイズ', 'NYAITTER_LIMIT_USER_SEARCH_PAGE_SIZE', 'limits.userSearchPageSize', '1..100', 1, false],
        ['ユーザー検索既定件数', 'NYAITTER_LIMIT_USER_SEARCH_DEFAULT_PAGE_SIZE', 'limits.userSearchDefaultLimit', 20, 1, true],
        ['DMメッセージページサイズ', 'NYAITTER_LIMIT_DM_MESSAGES_PAGE_SIZE', 'limits.dmMessagesPageSize', '1..100', 1, false],
        ['DMメッセージ既定件数', 'NYAITTER_LIMIT_DM_MESSAGES_DEFAULT_PAGE_SIZE', 'limits.dmMessagesDefaultLimit', 50, 1, true],
        ['フォロー一覧取得件数', 'NYAITTER_LIMIT_FOLLOWING_PAGE_SIZE', 'limits.followingPageSize', 100, 1, true],
        ['親投稿プレビュー文字数', 'NYAITTER_LIMIT_PARENT_POST_PREVIEW_LENGTH', 'limits.parentPostPreviewLength', 100, 0, true],
        ['最大アップロード容量', 'NYAITTER_LIMIT_MAX_FILE_UPLOAD_SIZE_MB', 'limits.maxFileUploadSizeMB', 5, 1, true],
        ['ファイル一括削除件数', 'NYAITTER_LIMIT_FILE_DELETE_BATCH_SIZE', 'limits.fileDeleteBatchSize', 1000, 1, true],
        ['ポスト一括取得件数', 'NYAITTER_LIMIT_POST_BATCH_SIZE', 'limits.postBatchSize', 100, 1, true],
        ['保存ファイル一覧取得件数', 'NYAITTER_LIMIT_STORAGE_LIST_PAGE_SIZE', 'limits.storageListPageSize', 500, 1, true],
    ];
    for (const [label, envName, configPath, fallback, minimum, exact] of rangeSettings) {
        inspectRangeSetting(config, { label, envName, configPath, fallback, minimum, exact });
    }

    const rateLimitSettings = [
        ['一般APIのレート制限時間', 'NYAITTER_RATE_LIMIT_GENERAL_WINDOW', 'rateLimit.general.window', '1min', null, 'rateLimit.windowMs'],
        ['認証APIのレート制限時間', 'NYAITTER_RATE_LIMIT_AUTH_WINDOW', 'rateLimit.auth.window', '1min', 'RATE_LIMIT_AUTH_WINDOW_MS', 'rateLimit.auth.windowMs'],
        ['投稿操作のレート制限時間', 'NYAITTER_RATE_LIMIT_POST_WRITE_WINDOW', 'rateLimit.postWrite.window', '1min'],
        ['プロフィール更新のレート制限時間', 'NYAITTER_RATE_LIMIT_PROFILE_UPDATE_WINDOW', 'rateLimit.profileUpdate.window', '1min'],
        ['DM送信のレート制限時間', 'NYAITTER_RATE_LIMIT_DM_SEND_WINDOW', 'rateLimit.dmSend.window', '1min'],
        ['ファイル操作のレート制限時間', 'NYAITTER_RATE_LIMIT_UPLOAD_WINDOW', 'rateLimit.upload.window', '1min'],
        ['通知送信のレート制限時間', 'NYAITTER_RATE_LIMIT_NOTIFICATION_WINDOW', 'rateLimit.notification.window', '1min'],
        ['通報作成のレート制限時間', 'NYAITTER_RATE_LIMIT_REPORT_CREATE_WINDOW', 'rateLimit.reportCreate.window', '1min'],
        ['通報対応のレート制限時間', 'NYAITTER_RATE_LIMIT_REPORT_ACTION_WINDOW', 'rateLimit.reportAction.window', '1min'],
        ['認証申請のレート制限時間', 'NYAITTER_RATE_LIMIT_VERIFICATION_APPLICATION_WINDOW', 'rateLimit.verificationApplication.window', '1min'],
    ];
    for (const [label, envName, configPath, fallback, legacyEnvName, legacyConfigPath] of rateLimitSettings) {
        inspectDurationSetting(config, { label, envName, configPath, fallback, legacyEnvName, legacyConfigPath });
        inspectRangeSetting(config, {
            label: label.replace('時間', '件数'),
            envName: envName.replace(/_WINDOW$/, '_MAX'),
            configPath: configPath.replace(/\.window$/, '.max'),
            fallback: 1,
            minimum: 1,
            exact: true,
        });
    }

    const userFilesEndpoint = String(
        setting('NYAITTER_USER_FILES_ENDPOINT', config, 'userFiles.endpoint', ''),
    ).trim();
    const userFilesPortValue = setting(
        'NYAITTER_USER_FILES_PORT',
        config,
        'userFiles.port',
        '',
    );
    const userFilesPort = userFilesPortValue === '' || userFilesPortValue === null
        ? null
        : Number(userFilesPortValue);
    if (userFilesEndpoint && (!userFilesEndpoint.startsWith('/') || /[?#]/.test(userFilesEndpoint))) {
        addIssue(
            'error',
            'USER_FILES_ENDPOINT_INVALID',
            `ユーザーファイルの公開パスが無効です: ${userFilesEndpoint}`,
            'NYAITTER_USER_FILES_ENDPOINT または userFiles.endpoint に /uploads のような先頭が / のパスを設定してください。',
        );
    }
    if (userFilesPort !== null && (!Number.isInteger(userFilesPort) || userFilesPort < 1 || userFilesPort > 65535)) {
        addIssue(
            'error',
            'USER_FILES_PORT_INVALID',
            `ユーザーファイルの専用ポートが無効です: ${userFilesPortValue}`,
            'NYAITTER_USER_FILES_PORT または userFiles.port を1から65535までの整数に設定してください。',
        );
    }
    if (userFilesPort !== null && userFilesPort === port) {
        addIssue(
            'error',
            'USER_FILES_PORT_CONFLICT',
            'ユーザーファイルの専用ポートがServerポートと同じです。',
            'NYAITTER_USER_FILES_PORT と PORT には異なるポート番号を設定してください。',
        );
    }

    const databaseAdapter = String(
        setting('DB_ADAPTER', config, 'database.adapter', 'memory'),
    ).toLowerCase();
    if (!['memory', 'inmemory', 'postgres', 'pg', 'd1', 'cloudflare-d1'].includes(databaseAdapter)) {
        addIssue(
            'error',
            'DATABASE_ADAPTER_UNSUPPORTED',
            `未対応のDB_ADAPTERです: ${databaseAdapter || '(空)'}`,
            'DB_ADAPTER を memory、postgres、または d1 のいずれかに設定してください。',
        );
    }

    if (databaseAdapter === 'postgres' || databaseAdapter === 'pg') {
        const databaseUrl = setting(
            'DATABASE_URL',
            config,
            'database.postgres.connectionString',
        );
        if (!isHttpUrl(String(databaseUrl).replace(/^postgres(?:ql)?:/i, 'http:'))) {
            addIssue(
                'error',
                'DATABASE_URL_MISSING_OR_INVALID',
                'PostgreSQLを選択していますが、有効なDATABASE_URLがありません。',
                'DATABASE_URL に postgres://ユーザー:パスワード@ホスト:5432/データベース名 を設定してください。',
            );
        } else if (hasPlaceholder(databaseUrl)) {
            addIssue(
                'warning',
                'DATABASE_URL_PLACEHOLDER',
                'PostgreSQLの接続文字列に例示用の値が含まれている可能性があります。',
                'DATABASE_URL または database.postgres.connectionString を実際の接続情報に置き換えてください。',
            );
        }
    }


    if (databaseAdapter === 'd1' || databaseAdapter === 'cloudflare-d1') {
        const workerUrl = setting('D1_WORKER_URL', config, 'database.d1.workerUrl');
        const token = setting('D1_WORKER_TOKEN', config, 'database.d1.authToken');
        if (!isHttpUrl(workerUrl)) {
            addIssue(
                'error',
                'D1_WORKER_URL_MISSING_OR_INVALID',
                'D1を選択していますが、有効なD1_WORKER_URLがありません。',
                'D1_WORKER_URL にD1プロキシWorkerのHTTPS URLを設定してください。',
            );
        }
        if (!isNonEmptyString(token)) {
            addIssue(
                'error',
                'D1_WORKER_TOKEN_MISSING',
                'D1を選択していますが、D1_WORKER_TOKENがありません。',
                'D1_WORKER_TOKEN にD1プロキシWorkerと共有する認証トークンを設定してください。',
            );
        }
    }

    const storageAdapter = String(
        setting('STORAGE_ADAPTER', config, 'storage.adapter', 'local'),
    ).toLowerCase();
    if (!['local', 'filesystem', 'r2', 'cloudflare-r2'].includes(storageAdapter)) {
        addIssue(
            'error',
            'STORAGE_ADAPTER_UNSUPPORTED',
            `未対応のSTORAGE_ADAPTERです: ${storageAdapter || '(空)'}`,
            'STORAGE_ADAPTER を local または r2 に設定してください。',
        );
    }

    if (storageAdapter === 'r2' || storageAdapter === 'cloudflare-r2') {
        const requiredR2Settings = [
            ['R2_ACCOUNT_ID', 'storage.r2.accountId'],
            ['R2_BUCKET', 'storage.r2.bucket'],
            ['R2_ACCESS_KEY_ID', 'storage.r2.accessKeyId'],
            ['R2_SECRET_ACCESS_KEY', 'storage.r2.secretAccessKey'],
        ];
        const missing = requiredR2Settings
            .filter(([envName, configPath]) => !isNonEmptyString(setting(envName, config, configPath)))
            .map(([envName]) => envName);
        if (missing.length > 0) {
            addIssue(
                'error',
                'R2_SETTINGS_MISSING',
                `R2を選択していますが、必要な設定がありません: ${missing.join(', ')}`,
                '不足している値を server/.env または server/config.json の storage.r2 に設定してください。',
            );
        }
    }

    const clientRepository = String(
        setting('NYAITTER_CLIENT_REPOSITORY', config, 'client.repository', 'Nyaitter/Client'),
    ).trim();
    if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(clientRepository) &&
        !/^(https?|ssh):\/\//.test(clientRepository) &&
        !/^git@[^:]+:.+/.test(clientRepository)
    ) {
        addIssue(
            'error',
            'CLIENT_REPOSITORY_INVALID',
            `client.repository がGitリポジトリとして無効です: ${clientRepository || '(空)'}`,
            'NYAITTER_CLIENT_REPOSITORY または client.repository に owner/repository 形式かGit URLを設定してください。',
        );
    }

    const vapidSettings = [
        process.env.VAPID_SUBJECT || get(config, 'push.vapidSubject', ''),
        process.env.VAPID_PUBLIC_KEY || get(config, 'push.vapidPublicKey', ''),
        process.env.VAPID_PRIVATE_KEY || get(config, 'push.vapidPrivateKey', ''),
    ];
    const vapidCount = vapidSettings.filter(isNonEmptyString).length;
    if (vapidCount > 0 && vapidCount < 3) {
        addIssue(
            'error',
            'VAPID_SETTINGS_INCOMPLETE',
            'Push通知のVAPID設定が一部だけ指定されています。',
            'VAPID_SUBJECT、VAPID_PUBLIC_KEY、VAPID_PRIVATE_KEY をすべて設定するか、すべて未設定にしてください。',
        );
    }

    const autoModApiKey = firstSetting(
        ['AUTOMOD_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY'],
        config,
        ['autoMod.apiKey', 'automod.apiKey', 'geminiModeration.apiKey'],
    );
    const autoModModel = firstSetting(
        ['AUTOMOD_MODEL', 'GEMINI_MODEL', 'OPENAI_MODEL'],
        config,
        ['autoMod.model', 'automod.model', 'geminiModeration.model'],
    );
    const autoModPrompt = firstSetting(
        ['AUTOMOD_PROMPT', 'AUTOMOD_MOD_PROMPT', 'GEMINI_MOD_PROMPT'],
        config,
        ['autoMod.prompt', 'automod.prompt', 'geminiModeration.prompt'],
    );
    const autoModSpecified = [autoModApiKey, autoModModel, autoModPrompt].filter(isNonEmptyString).length;
    if (autoModSpecified > 0 && autoModSpecified < 3) {
        addIssue(
            'warning',
            'AUTOMOD_SETTINGS_INCOMPLETE',
            'AutoModの設定が一部のみ指定されています。',
            'AUTOMOD_API_KEY, AUTOMOD_MODEL, AUTOMOD_PROMPT をすべて設定するか、すべて未設定にしてください。',
        );
    }

    if (isProduction) {
        const publicUrl = setting('PUBLIC_URL', config, 'federation.publicUrl');
        if (!isHttpUrl(publicUrl)) {
            addIssue(
                'error',
                'PUBLIC_URL_MISSING_OR_INVALID',
                '本番環境ですが、有効なPUBLIC_URLがありません。',
                'PUBLIC_URL または federation.publicUrl に公開HTTPS URLを設定してください。',
            );
        }

        if (databaseAdapter === 'memory' || databaseAdapter === 'inmemory') {
            addIssue(
                'warning',
                'MEMORY_DATABASE_IN_PRODUCTION',
                '本番環境でインメモリDBを使用しています。再起動するとデータが消えます。',
                'DB_ADAPTER を postgres または d1 に変更し、対応する接続設定を追加してください。',
            );
        }

        const trustProxy = String(
            setting('TRUST_PROXY', config, 'server.trustProxy', 'false'),
        ).toLowerCase();
        if (!['true', '1', 'yes', 'on'].includes(trustProxy)) {
            addIssue(
                'warning',
                'TRUST_PROXY_DISABLED',
                '本番環境でTRUST_PROXYが無効です。リバースプロキシ配下ではIP・HTTPS判定が正しくない場合があります。',
                '信頼できるリバースプロキシの背後で運用する場合だけ TRUST_PROXY=true を設定してください。',
            );
        }
    }
}

inspect();

if (issues.length === 0) {
    console.log('[config-check] 設定上の不備は検出されませんでした。');
} else {
    for (const issue of issues) {
        const label = issue.level === 'error' ? 'ERROR' : 'WARNING';
        console.log(`\n[config-check] ${label} ${issue.code}`);
        console.log(`  内容: ${issue.message}`);
        console.log(`  対応: ${issue.resolution}`);
    }
}

const errorCount = issues.filter((issue) => issue.level === 'error').length;
const warningCount = issues.filter((issue) => issue.level === 'warning').length;
console.log(`\n[config-check] 結果: エラー ${errorCount}件、警告 ${warningCount}件`);

if (errorCount > 0) process.exitCode = 1;
