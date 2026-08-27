const { parseDuration, parseIntegerRange } = require('./utils/settingFormats');

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

let rawConfig;
try {
  rawConfig = require('./config.json');
} catch (e) {
  console.error('[config] Failed to load server/config.json. Using minimal defaults.');
  rawConfig = {};
}

function get(path, defaultValue) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : defaultValue), rawConfig);
}

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return Boolean(fallback);
  if (['true', '1', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['false', '0', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  console.warn(`[config] ${name} must be a boolean; using configured default.`);
  return Boolean(fallback);
}

function envNonNegativeInteger(name, fallback) {
  const value = process.env[name];
  const candidate = value === undefined || value === '' ? fallback : value;
  const parsed = Number(candidate);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  console.warn(`[config] ${name} must be a non-negative integer; using configured default.`);
  const normalizedFallback = Number(fallback);
  return Number.isInteger(normalizedFallback) && normalizedFallback >= 0 ? normalizedFallback : 0;
}

function readSetting(envNames, configPaths, fallback) {
  for (const name of envNames) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  for (const path of configPaths) {
    const value = get(path, undefined);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function rangeSetting(label, envNames, configPaths, fallback, minimum = 0) {
  const value = readSetting(envNames, configPaths, fallback);
  const parsed = parseIntegerRange(value, { minimum });
  if (parsed) return parsed;

  console.warn(
    `[config] ${label} must use an integer range such as 10, 10.., ..10, or 10..15; using configured default.`,
  );
  return parseIntegerRange(fallback, { minimum });
}

function durationSetting(label, envNames, configPaths, fallback) {
  const value = readSetting(envNames, configPaths, fallback);
  const parsed = parseDuration(value);
  if (parsed !== null) return parsed;

  console.warn(
    `[config] ${label} must use milliseconds or a duration such as 10min, 15m10s, or 1000ms; using configured default.`,
  );
  return parseDuration(fallback);
}

function maximumRangeSetting(label, envNames, configPaths, legacyConfigPaths, fallback, minimum = 0) {
  const configured = readSetting(envNames, configPaths, undefined);
  if (configured !== undefined) {
    return rangeSetting(label, envNames, configPaths, fallback, minimum);
  }

  for (const path of legacyConfigPaths) {
    const legacyValue = get(path, undefined);
    if (legacyValue !== undefined && legacyValue !== null && legacyValue !== '') {
      return rangeSetting(label, [], [], `..${legacyValue}`, minimum);
    }
  }
  return rangeSetting(label, [], [], fallback, minimum);
}

function exactIntegerSetting(label, envNames, configPaths, fallback, minimum = 0) {
  const value = readSetting(envNames, configPaths, fallback);
  const parsed = parseIntegerRange(value, { minimum });
  if (parsed && parsed.min !== null && parsed.min === parsed.max) return parsed.min;

  console.warn(`[config] ${label} must be a non-negative integer; using configured default.`);
  const fallbackRange = parseIntegerRange(fallback, { minimum });
  return fallbackRange?.min ?? minimum;
}

function rateLimitSetting({ label, envPrefix, configPath, defaultWindow, defaultMax, legacyWindowPaths = [], legacyMaxPaths = [], legacyWindowEnv = [], legacyMaxEnv = [] }) {
  return {
    windowMs: durationSetting(
      `${label} window`,
      [`${envPrefix}_WINDOW`, ...legacyWindowEnv],
      [`${configPath}.window`, `${configPath}.windowMs`, ...legacyWindowPaths],
      defaultWindow,
    ),
    max: exactIntegerSetting(
      `${label} max`,
      [`${envPrefix}_MAX`, ...legacyMaxEnv],
      [`${configPath}.max`, ...legacyMaxPaths],
      defaultMax,
      1,
    ),
  };
}

function normalizeApiEndpoint(value, fallback = '/server') {
  const candidate = String(value === undefined || value === null ? fallback : value).trim();
  if (!candidate) return fallback;
  if (!candidate.startsWith('/')) {
    console.warn('[config] API endpoint must start with "/"; using configured default.');
    return normalizeApiEndpoint(fallback, '/server');
  }
  if (candidate === '/') return '/';
  return `/${candidate.replace(/^\/+|\/+$/g, '')}`;
}

function normalizeUserFilesEndpoint(value) {
  const candidate = String(value === undefined || value === null ? '' : value).trim();
  if (!candidate) return null;
  // 外部URL（http/https）も許可
  if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
    return candidate.replace(/\/+$/, '');
  }
  if (!candidate.startsWith('/')) {
    console.warn('[config] User-files endpoint must start with "/" or be a full HTTP(S) URL; file serving is disabled.');
    return null;
  }
  if (candidate === '/') return '/';
  return `/${candidate.replace(/^\/+|\/+$/g, '')}`;
}

function optionalPort(name, value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
  console.warn(`[config] ${name} must be an integer between 1 and 65535; file serving is disabled.`);
  return null;
}

const defaultCorsAllowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function normalizeCorsAllowedOrigins(value) {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const origins = new Set();

  for (const value of candidates) {
    const candidate = String(value || '').trim();
    if (!candidate) continue;
    // `*` はCORSの全オリジン許可を明示する設定値として扱う。
    if (candidate === '*') {
      origins.add('*');
      continue;
    }

    try {
      const url = new URL(candidate);
      const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
      const hasOnlyOrigin =
        url.username === '' &&
        url.password === '' &&
        (url.pathname === '/' || url.pathname === '') &&
        url.search === '' &&
        url.hash === '';
      if (!isHttp || !hasOnlyOrigin) throw new Error('invalid origin');
      origins.add(url.origin);
    } catch (_) {
      console.warn(
        `[config] Ignoring invalid CORS origin: ${candidate}. Use an http(s) origin without a path.`,
      );
    }
  }

  return [...origins];
}

function corsAllowedOriginsSetting() {
  if (process.env.NYAITTER_CORS_ALLOWED_ORIGINS !== undefined) {
    return process.env.NYAITTER_CORS_ALLOWED_ORIGINS;
  }
  // Backward compatibility for deployments that already use this variable.
  if (process.env.ALLOWED_ORIGINS !== undefined) return process.env.ALLOWED_ORIGINS;
  return get('cors.allowedOrigins', defaultCorsAllowedOrigins);
}

const turnstileSecretKey = process.env.TURNSTILE_SECRET_KEY || get('turnstile.secret', '');

const apiEndpoint = normalizeApiEndpoint(
  process.env.NYAITTER_API_ENDPOINT || get('server.apiEndpoint', '/server'),
);
const configuredUserFilesPort = optionalPort(
  'NYAITTER_USER_FILES_PORT',
  process.env.NYAITTER_USER_FILES_PORT !== undefined
    ? process.env.NYAITTER_USER_FILES_PORT
    : get('userFiles.port', null),
);
const defaultUserFilesEndpoint = configuredUserFilesPort
  ? '/uploads'
  : (`${apiEndpoint === '/' ? '' : apiEndpoint}/uploads` || '/uploads');
const configuredUserFilesEndpoint = process.env.NYAITTER_USER_FILES_ENDPOINT !== undefined
  ? process.env.NYAITTER_USER_FILES_ENDPOINT
  : get('userFiles.endpoint', undefined);

const config = {
  server: {
    port: parseInt(process.env.PORT, 10) || get('server.port', 3000),
    jsonBodyLimit: process.env.JSON_BODY_LIMIT || get('server.jsonBodyLimit', '2mb'),
    trustProxy: process.env.TRUST_PROXY === 'true' || get('server.trustProxy', false),
    apiEndpoint,
    publicUrl: readSetting(
      ['NYAITTER_API_PUBLIC_URL', 'NYAITTER_API_URL', 'API_PUBLIC_URL'],
      ['server.publicUrl', 'server.publicApiUrl'],
      '',
    ),
    maintenanceMode: envBoolean('NYAITTER_MAINTENANCE_MODE', get('server.maintenanceMode', false)),
  },

  userFiles: {
    // 未指定時はAPIエンドポイント配下で配信する。空文字の明示指定だけが配信無効化を表す。
    endpoint: normalizeUserFilesEndpoint(
      configuredUserFilesEndpoint === undefined
        ? defaultUserFilesEndpoint
        : configuredUserFilesEndpoint,
    ),
    port: configuredUserFilesPort,
  },

  static: {
    jsCssCacheMaxAge: get('static.jsCssCacheMaxAge', 3600),
    assetCacheMaxAge: get('static.assetCacheMaxAge', 86400),
  },

  client: {
    repository:
      process.env.NYAITTER_CLIENT_REPOSITORY ||
      get('client.repository', 'Nyaitter/Client'),
    publicUrl: readSetting(
      ['NYAITTER_CLIENT_PUBLIC_URL', 'NYAITTER_CLIENT_URL', 'NYAITTER_PUBLIC_URL', 'PUBLIC_URL', 'CLIENT_PUBLIC_URL'],
      ['client.publicUrl', 'federation.publicUrl'],
      '',
    ),
    resourceLinks: get('client.resourceLinks', [
      { name: 'ドキュメント', url: '#docs' },
      { name: 'Nyaitter(Github)', url: 'https://github.com/Nyaitter' },
      { name: 'サーバー(Github)', url: 'https://github.com/Nyaitter/Server' },
      { name: 'クライアント(Github)', url: 'https://github.com/Nyaitter/Client' },
      { name: 'Nyaitter.js(Github)', url: 'https://github.com/Nyaitter/Nyaitter.js' },
    ]),
    widgetLinks: get('client.widgetLinks', [
      { name: 'ルール', url: '#rule' },
      { name: 'ドキュメント', url: '#docs' },
      { name: 'GitHub', url: 'https://github.com/Nyaitter' },
    ]),
  },

  nmt: {
    enabled: envBoolean('NMT_ENABLED', envBoolean('NYAITTER_MANAGEMENT_TOOL_ENABLED', get('nmt.enabled', false))),
    port: envNonNegativeInteger('NMT_PORT', envNonNegativeInteger('NYAITTER_MANAGEMENT_TOOL_PORT', get('nmt.port', 4040))),
    host: process.env.NMT_HOST || process.env.NYAITTER_MANAGEMENT_TOOL_HOST || get('nmt.host', '0.0.0.0'),
    publicUrl: readSetting(
      ['NMT_PUBLIC_URL', 'NYAITTER_MANAGEMENT_TOOL_PUBLIC_URL'],
      ['nmt.publicUrl'],
      '',
    ),
    mode: (() => {
      const explicit = process.env.NMT_MODE || get('nmt.mode', '');
      if (['record_only', 'analysis_only', 'auto'].includes(explicit)) return explicit;
      if (envBoolean('NMT_AUTO_FIX', get('nmt.autoFix', false))) return 'auto';
      if (envBoolean('NMT_AUTO_ANALYSIS', get('nmt.autoAnalysis', false))) return 'analysis_only';
      return 'record_only';
    })(),
    guidelines: process.env.NMT_GUIDELINES || process.env.NMT_AUTO_GUIDELINES || get('nmt.guidelines', ''),
    autoAnalysis: envBoolean('NMT_AUTO_ANALYSIS', get('nmt.autoAnalysis', false)),
    autoFix: envBoolean('NMT_AUTO_FIX', get('nmt.autoFix', false)),
    autoIssue: envBoolean('NMT_AUTO_ISSUE', get('nmt.autoIssue', false)),
    autoPr: envBoolean('NMT_AUTO_PR', get('nmt.autoPr', false)),
    allowBash: envBoolean('NMT_ALLOW_BASH', get('nmt.allowBash', false)),
    requireApprovalForEdit: envBoolean('NMT_REQUIRE_APPROVAL_EDIT', get('nmt.requireApprovalForEdit', false)),
    requireApprovalForBash: envBoolean('NMT_REQUIRE_APPROVAL_BASH', get('nmt.requireApprovalForBash', true)),
    guardrails: {
      restrictToGitTracked: envBoolean('NMT_GUARD_GIT_TRACKED', get('nmt.guardrails.restrictToGitTracked', true)),
      syntaxValidation: envBoolean('NMT_GUARD_SYNTAX', get('nmt.guardrails.syntaxValidation', true)),
      blockEnvModification: envBoolean('NMT_GUARD_BLOCK_ENV', get('nmt.guardrails.blockEnvModification', true)),
      blockSuspiciousCommands: envBoolean('NMT_GUARD_BLOCK_COMMANDS', get('nmt.guardrails.blockSuspiciousCommands', true)),
    },
    githubToken: process.env.NMT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || get('nmt.githubToken', ''),
    githubRepo: process.env.NMT_GITHUB_REPO || get('nmt.githubRepo', 'Nyaitter/Server'),
    gitAuthorName: process.env.NMT_GIT_AUTHOR_NAME || process.env.GIT_AUTHOR_NAME || get('nmt.gitAuthorName', 'nyantorusabu'),
    gitAuthorEmail: process.env.NMT_GIT_AUTHOR_EMAIL || process.env.GIT_AUTHOR_EMAIL || get('nmt.gitAuthorEmail', 'nyantorusabu@outlook.jp'),
    geminiApiKey: process.env.NMT_GEMINI_API_KEY || process.env.GEMINI_API_KEY || get('nmt.geminiApiKey', ''),
    openaiApiKey: process.env.NMT_OPENAI_API_KEY || process.env.OPENAI_API_KEY || get('nmt.openaiApiKey', ''),
    aiModel: process.env.NMT_AI_MODEL || get('nmt.aiModel', 'auto'),
  },

  cors: {
    // NYAITTER_CORS_ALLOWED_ORIGINS takes a comma-separated list of origins.
    // `*` を含めると全オリジンを許可する。config.json uses an array at cors.allowedOrigins.
    allowedOrigins: normalizeCorsAllowedOrigins(corsAllowedOriginsSetting()),
    allowUnknownClient: envBoolean(
      'ARROW_UNKNOWN_CLIENT',
      get('cors.allowUnknownClient', get('ARROW_UNKNOWN_CLIENT', get('arrowUnknownClient', false))),
    ),
    credentials: envBoolean(
      'NYAITTER_CORS_CREDENTIALS',
      get('cors.credentials', false),
    ),
    preflightMaxAge: get('cors.preflightMaxAge', 600),
  },

  limits: {
    postContentLength: maximumRangeSetting(
      'post content length',
      ['NYAITTER_LIMIT_POST_CONTENT_LENGTH'],
      ['limits.postContentLength'],
      ['limits.postContentMax'],
      '..1000',
    ),
    dmContentLength: maximumRangeSetting(
      'DM content length',
      ['NYAITTER_LIMIT_DM_CONTENT_LENGTH'],
      ['limits.dmContentLength'],
      ['limits.dmContentMax'],
      '..2000',
    ),
    dmE2eEphemeralKeyLength: rangeSetting(
      'DM E2E ephemeral key length',
      ['NYAITTER_LIMIT_DM_E2E_EPHEMERAL_KEY_LENGTH'],
      ['limits.dmE2eEphemeralKeyLength'],
      '1..1024',
      1,
    ),
    dmE2eCiphertextLength: rangeSetting(
      'DM E2E ciphertext length',
      ['NYAITTER_LIMIT_DM_E2E_CIPHERTEXT_LENGTH'],
      ['limits.dmE2eCiphertextLength'],
      '1..16384',
      1,
    ),
    dmE2ePayloadLength: rangeSetting(
      'DM E2E payload length',
      ['NYAITTER_LIMIT_DM_E2E_PAYLOAD_LENGTH'],
      ['limits.dmE2ePayloadLength'],
      '..65536',
    ),
    userNameLength: rangeSetting(
      'user name length',
      ['NYAITTER_LIMIT_USER_NAME_LENGTH'],
      ['limits.userNameLength'],
      '1..50',
    ),
    profileBioLength: rangeSetting(
      'profile bio length',
      ['NYAITTER_LIMIT_PROFILE_BIO_LENGTH'],
      ['limits.profileBioLength'],
      '..500',
    ),
    scratchUsernameLength: rangeSetting(
      'Scratch username length',
      ['NYAITTER_LIMIT_SCRATCH_USERNAME_LENGTH'],
      ['limits.scratchUsernameLength'],
      '3..20',
    ),
    timelinePageSize: exactIntegerSetting(
      'timeline page size',
      ['NYAITTER_LIMIT_TIMELINE_PAGE_SIZE'],
      ['limits.timelinePageSize', 'limits.timelineDefaultLimit'],
      30,
      1,
    ),
    impostersPerParent: exactIntegerSetting(
      'imposters per parent',
      ['NYAITTER_LIMIT_IMPOSTERS_PER_PARENT'],
      ['limits.impostersPerParent'],
      5,
      0,
    ),
    groupMaxCreatedPerUser: exactIntegerSetting(
      'groups created per user',
      ['NYAITTER_GROUP_MAX_CREATED_PER_USER'],
      ['limits.groupMaxCreatedPerUser'],
      0,
      0,
    ),
    groupMaxMembershipsPerUser: exactIntegerSetting(
      'group memberships per user',
      ['NYAITTER_GROUP_MAX_MEMBERSHIPS_PER_USER'],
      ['limits.groupMaxMembershipsPerUser'],
      0,
      0,
    ),
    groupMaxHomeTabs: exactIntegerSetting(
      'group home tabs',
      ['NYAITTER_GROUP_MAX_HOME_TABS'],
      ['limits.groupMaxHomeTabs'],
      0,
      0,
    ),
    groupMaxMembersPerGroup: exactIntegerSetting(
      'group members per group',
      ['NYAITTER_GROUP_MAX_MEMBERS_PER_GROUP'],
      ['limits.groupMaxMembersPerGroup'],
      0,
      0,
    ),
    userSearchPageSize: rangeSetting(
      'user search page size',
      ['NYAITTER_LIMIT_USER_SEARCH_PAGE_SIZE'],
      ['limits.userSearchPageSize'],
      `1..${get('limits.userSearchMaxLimit', 100)}`,
      1,
    ),
    userSearchDefaultLimit: exactIntegerSetting(
      'user search default page size',
      ['NYAITTER_LIMIT_USER_SEARCH_DEFAULT_PAGE_SIZE'],
      ['limits.userSearchDefaultLimit'],
      20,
      1,
    ),
    dmMessagesPageSize: rangeSetting(
      'DM messages page size',
      ['NYAITTER_LIMIT_DM_MESSAGES_PAGE_SIZE'],
      ['limits.dmMessagesPageSize'],
      `1..${get('limits.dmMessagesMaxLimit', 100)}`,
      1,
    ),
    dmMessagesDefaultLimit: exactIntegerSetting(
      'DM messages default page size',
      ['NYAITTER_LIMIT_DM_MESSAGES_DEFAULT_PAGE_SIZE'],
      ['limits.dmMessagesDefaultLimit'],
      50,
      1,
    ),
    followingPageSize: exactIntegerSetting(
      'following page size',
      ['NYAITTER_LIMIT_FOLLOWING_PAGE_SIZE'],
      ['limits.followingPageSize', 'limits.followingDefaultLimit'],
      100,
      1,
    ),
    parentPostPreviewLength: exactIntegerSetting(
      'parent post preview length',
      ['NYAITTER_LIMIT_PARENT_POST_PREVIEW_LENGTH'],
      ['limits.parentPostPreviewLength'],
      100,
      0,
    ),
    maxFileUploadSizeMB: exactIntegerSetting(
      'maximum file upload size',
      ['NYAITTER_LIMIT_MAX_FILE_UPLOAD_SIZE_MB'],
      ['limits.maxFileUploadSizeMB'],
      5,
      1,
    ),
    fileDeleteBatchSize: exactIntegerSetting(
      'file delete batch size',
      ['NYAITTER_LIMIT_FILE_DELETE_BATCH_SIZE'],
      ['limits.fileDeleteBatchSize'],
      1000,
      1,
    ),
    postBatchSize: exactIntegerSetting(
      'post batch size',
      ['NYAITTER_LIMIT_POST_BATCH_SIZE'],
      ['limits.postBatchSize'],
      100,
      1,
    ),
    storageListPageSize: exactIntegerSetting(
      'storage list page size',
      ['NYAITTER_LIMIT_STORAGE_LIST_PAGE_SIZE'],
      ['limits.storageListPageSize'],
      500,
      1,
    ),
  },

  cache: {
    postCacheEnabled: envBoolean('POST_CACHE_ENABLED', get('cache.postCacheEnabled', true)),
    userCacheEnabled: envBoolean('USER_CACHE_ENABLED', get('cache.userCacheEnabled', true)),
    userCacheMaxSize: exactIntegerSetting(
      'user cache max size',
      ['USER_CACHE_MAX_SIZE'],
      ['cache.userCacheMaxSize'],
      3000,
      1,
    ),
    userCacheTtlMs: durationSetting(
      'user cache TTL',
      ['USER_CACHE_TTL_MS'],
      ['cache.userCacheTtlMs'],
      '60min',
    ),
    postCacheMaxSize: exactIntegerSetting(
      'post cache max size',
      ['POST_CACHE_MAX_SIZE'],
      ['cache.postCacheMaxSize'],
      5000,
      1,
    ),
    postCacheTtlMs: durationSetting(
      'post cache TTL',
      ['POST_CACHE_TTL_MS'],
      ['cache.postCacheTtlMs'],
      '24h',
    ),
    memoryCacheMaxHeapMb: envNonNegativeInteger(
      'MEMORY_CACHE_MAX_HEAP_MB',
      get('cache.memoryCacheMaxHeapMb', 0),
    ),
  },

  dm: {
    // 一時的に既定で無効。DM_E2E_ENABLED=true で明示的に再有効化できる。
    e2eEnabled: envBoolean('DM_E2E_ENABLED', get('dm.e2eEnabled', false)),
  },

  imageUpload: get('imageUpload', {}),

	  auth: {
	    sessionExpiryDays: get('auth.sessionExpiryDays', 30),
	    verificationCodeExpiryMinutes: get('auth.verificationCodeExpiryMinutes', 15),
	    botTokenPrefix: get('auth.botTokenPrefix', 'bot_'),
	    sessionTokenBytes: get('auth.sessionTokenBytes', 32),
	    botTokenIdBytes: get('auth.botTokenIdBytes', 16),
	    verificationCodeBytes: get('auth.verificationCodeBytes', 4),
	    maxPendingVerificationCodes: exactIntegerSetting(
	      'maximum pending Scratch verification codes',
	      ['NYAITTER_AUTH_MAX_PENDING_VERIFICATION_CODES'],
	      ['auth.maxPendingVerificationCodes'],
	      1000,
	      1,
	    ),
	    methods: {
	      scratch: {
	        enabled: envBoolean(
	          'AUTH_METHOD_SCRATCH_ENABLED',
	          envBoolean('AUTH_SCRATCH_ENABLED', get('auth.methods.scratch.enabled', true)),
	        ),
	        allowSignup: envBoolean(
	          'AUTH_METHOD_SCRATCH_ALLOW_SIGNUP',
	          envBoolean('AUTH_SCRATCH_ALLOW_SIGNUP', get('auth.methods.scratch.allowSignup', true)),
	        ),
	        verificationProjectId: String(
	          process.env.AUTH_SCRATCH_VERIFICATION_PROJECT_ID
	          || process.env.SCRATCH_VERIFICATION_PROJECT_ID
	          || get('auth.methods.scratch.verificationProjectId', '1239738451'),
	        ).trim(),
	        ipRestrictionEnabled: envBoolean(
	          'SCRATCH_IP_RESTRICTION_ENABLED',
	          get('auth.methods.scratch.ipRestrictionEnabled', get('auth.scratchVerification.ipRestrictionEnabled', true)),
	        ),
	        rejectNewScratcher: envBoolean(
	          'SCRATCH_REJECT_NEW_SCRATCHER',
	          get('auth.methods.scratch.rejectNewScratcher', get('auth.scratchVerification.rejectNewScratcher', true)),
	        ),
	        rejectStudentAccounts: envBoolean(
	          'SCRATCH_REJECT_STUDENT_ACCOUNTS',
	          get('auth.methods.scratch.rejectStudentAccounts', get('auth.scratchVerification.rejectStudentAccounts', true)),
	        ),
	        minQualifiedFollowers: envNonNegativeInteger(
	          'SCRATCH_MIN_QUALIFIED_FOLLOWERS',
	          get('auth.methods.scratch.minQualifiedFollowers', get('auth.scratchVerification.minQualifiedFollowers', 25)),
	        ),
	      },
	      passkey: {
	        enabled: envBoolean(
	          'AUTH_METHOD_PASSKEY_ENABLED',
	          envBoolean('AUTH_PASSKEY_ENABLED', get('auth.methods.passkey.enabled', false)),
	        ),
	        allowSignup: envBoolean(
	          'AUTH_METHOD_PASSKEY_ALLOW_SIGNUP',
	          envBoolean('AUTH_PASSKEY_ALLOW_SIGNUP', get('auth.methods.passkey.allowSignup', true)),
	        ),
	        rpName: String(
	          process.env.AUTH_PASSKEY_RP_NAME || get('auth.methods.passkey.rpName', 'Nyaitter'),
	        ).trim(),
	        rpId: String(
	          process.env.AUTH_PASSKEY_RP_ID || get('auth.methods.passkey.rpId', 'localhost'),
	        ).trim(),
	        origin: String(
	          process.env.AUTH_PASSKEY_ORIGIN || get('auth.methods.passkey.origin', ''),
	        ).trim(),
	      },
	      email: {
	        enabled: envBoolean(
	          'AUTH_METHOD_EMAIL_ENABLED',
	          envBoolean('AUTH_EMAIL_ENABLED', get('auth.methods.email.enabled', true)),
	        ),
	        allowSignup: envBoolean(
	          'AUTH_METHOD_EMAIL_ALLOW_SIGNUP',
	          envBoolean('AUTH_EMAIL_ALLOW_SIGNUP', get('auth.methods.email.allowSignup', true)),
	        ),
	        codeExpiryMinutes: envNonNegativeInteger(
	          'AUTH_EMAIL_CODE_EXPIRY_MINUTES',
	          get('auth.methods.email.codeExpiryMinutes', 10),
	        ),
	        codeLength: envNonNegativeInteger(
	          'AUTH_EMAIL_CODE_LENGTH',
	          get('auth.methods.email.codeLength', 6),
	        ),
	        smtp: {
	          host: String(process.env.SMTP_HOST || get('auth.methods.email.smtp.host', '')).trim(),
	          port: envNonNegativeInteger('SMTP_PORT', get('auth.methods.email.smtp.port', 587)),
	          secure: envBoolean('SMTP_SECURE', get('auth.methods.email.smtp.secure', false)),
	          user: String(process.env.SMTP_USER || get('auth.methods.email.smtp.user', '')).trim(),
	          pass: String(process.env.SMTP_PASS || get('auth.methods.email.smtp.pass', '')),
	          from: String(
	            process.env.SMTP_FROM
	            || process.env.EMAIL_FROM
	            || get('auth.methods.email.smtp.from', 'noreply@localhost')
	          ).trim(),
	        },
	        embeddedServer: {
	          enabled: envBoolean(
	            'AUTH_EMAIL_EMBEDDED_SERVER_ENABLED',
	            envBoolean('EMBEDDED_MAIL_SERVER_ENABLED', get('auth.methods.email.embeddedServer.enabled', false)),
	          ),
	          port: envNonNegativeInteger(
	            'EMBEDDED_MAIL_SERVER_PORT',
	            envNonNegativeInteger('SMTP_SERVER_PORT', get('auth.methods.email.embeddedServer.port', 2525)),
	          ),
	          host: String(
	            process.env.EMBEDDED_MAIL_SERVER_HOST
	            || process.env.SMTP_SERVER_HOST
	            || get('auth.methods.email.embeddedServer.host', '0.0.0.0')
	          ).trim(),
	          directDelivery: envBoolean(
	            'EMBEDDED_MAIL_DIRECT_DELIVERY_ENABLED',
	            envBoolean('SMTP_DIRECT_DELIVERY_ENABLED', get('auth.methods.email.embeddedServer.directDelivery', false)),
	          ),
	          hostname: String(
	            process.env.EMBEDDED_MAIL_HOSTNAME
	            || get('auth.methods.email.embeddedServer.hostname', 'localhost')
	          ).trim(),
	        },
	      },
	      nyaitter: {
	        enabled: envBoolean(
	          'AUTH_METHOD_NYAITTER_AUTH_ENABLED',
	          envBoolean('AUTH_NYAITTER_ENABLED', get('auth.methods.nyaitter.enabled', get('auth.nyaitterAuth.enabled', true))),
	        ),
	        allowSignup: envBoolean(
	          'AUTH_METHOD_NYAITTER_AUTH_ALLOW_SIGNUP',
	          envBoolean('AUTH_NYAITTER_ALLOW_SIGNUP', get('auth.methods.nyaitter.allowSignup', get('auth.nyaitterAuth.allowSignup', true))),
	        ),
	      },
	      oauth: {
	        enabled: envBoolean(
	          'AUTH_METHOD_OAUTH_ENABLED',
	          envBoolean('AUTH_OAUTH_ENABLED', get('auth.methods.oauth.enabled', false)),
	        ),
	        allowSignup: envBoolean(
	          'AUTH_METHOD_OAUTH_ALLOW_SIGNUP',
	          envBoolean('AUTH_OAUTH_ALLOW_SIGNUP', get('auth.methods.oauth.allowSignup', true)),
	        ),
	        providers: get('auth.methods.oauth.providers', {}),
	      },
	      password: {
	        enabled: envBoolean(
	          'AUTH_METHOD_PASSWORD_ENABLED',
	          envBoolean('AUTH_PASSWORD_ENABLED', get('auth.methods.password.enabled', false)),
	        ),
	        allowSignup: envBoolean(
	          'AUTH_METHOD_PASSWORD_ALLOW_SIGNUP',
	          envBoolean('AUTH_PASSWORD_ALLOW_SIGNUP', get('auth.methods.password.allowSignup', true)),
	        ),
	      },
	    },
	    scratchVerification: {
	      ipRestrictionEnabled: envBoolean(
	        'SCRATCH_IP_RESTRICTION_ENABLED',
	        get('auth.methods.scratch.ipRestrictionEnabled', get('auth.scratchVerification.ipRestrictionEnabled', true)),
	      ),
	      rejectNewScratcher: envBoolean(
	        'SCRATCH_REJECT_NEW_SCRATCHER',
	        get('auth.methods.scratch.rejectNewScratcher', get('auth.scratchVerification.rejectNewScratcher', true)),
	      ),
	      rejectStudentAccounts: envBoolean(
	        'SCRATCH_REJECT_STUDENT_ACCOUNTS',
	        get('auth.methods.scratch.rejectStudentAccounts', get('auth.scratchVerification.rejectStudentAccounts', true)),
	      ),
	      minQualifiedFollowers: envNonNegativeInteger(
	        'SCRATCH_MIN_QUALIFIED_FOLLOWERS',
	        get('auth.methods.scratch.minQualifiedFollowers', get('auth.scratchVerification.minQualifiedFollowers', 25)),
	      ),
	    },
	  },

	  autoMod: (() => {
		    const apiKey = readSetting(
		      ['AUTOMOD_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY'],
		      ['autoMod.apiKey', 'automod.apiKey', 'geminiModeration.apiKey', 'AUTOMOD_API_KEY', 'GEMINI_API_KEY'],
		      '',
		    );
		    const model = readSetting(
		      ['AUTOMOD_MODEL', 'GEMINI_MODEL', 'OPENAI_MODEL'],
		      ['autoMod.model', 'automod.model', 'geminiModeration.model', 'AUTOMOD_MODEL', 'GEMINI_MODEL'],
		      '',
		    );
		    const prompt = readSetting(
		      ['AUTOMOD_PROMPT', 'AUTOMOD_MOD_PROMPT', 'GEMINI_MOD_PROMPT'],
		      ['autoMod.prompt', 'automod.prompt', 'geminiModeration.prompt', 'AUTOMOD_PROMPT', 'GEMINI_MOD_PROMPT'],
		      '',
		    );
		    const endpoint = readSetting(
		      ['AUTOMOD_ENDPOINT', 'AUTOMOD_BASE_URL', 'OPENAI_BASE_URL'],
		      ['autoMod.endpoint', 'autoMod.baseUrl', 'automod.endpoint', 'geminiModeration.endpoint'],
		      '',
		    );
		    const configuredProvider = readSetting(
		      ['AUTOMOD_PROVIDER'],
		      ['autoMod.provider', 'automod.provider'],
		      '',
		    );
		    const provider = configuredProvider
		      ? String(configuredProvider).trim().toLowerCase()
		      : (endpoint || process.env.OPENAI_API_KEY ? 'openai' : 'gemini');

		    return {
		      apiKey,
		      model,
		      prompt,
		      endpoint,
		      provider,
		      maxImages: exactIntegerSetting(
		        'AutoMod max images',
		        ['AUTOMOD_MAX_IMAGES', 'AUTOMOD_MOD_MAX_IMAGES', 'GEMINI_MOD_MAX_IMAGES'],
		        ['autoMod.maxImages', 'automod.maxImages', 'geminiModeration.maxImages'],
		        0,
		        0,
		      ),
		      maxPendingJobs: exactIntegerSetting(
		        'AutoMod max pending jobs',
		        ['AUTOMOD_MAX_PENDING_JOBS', 'AUTOMOD_MOD_MAX_PENDING_JOBS', 'GEMINI_MOD_MAX_PENDING_JOBS'],
		        ['autoMod.maxPendingJobs', 'automod.maxPendingJobs', 'geminiModeration.maxPendingJobs'],
		        500,
		        1,
		      ),
		      enabled: Boolean(apiKey && model && prompt),
		    };
		  })(),

		  get geminiModeration() {
		    return this.autoMod;
		  },

		  moderation: {
		    descriptionMaxLength: exactIntegerSetting(
		      'moderation description max length',
		      ['REPORT_DESCRIPTION_MAX_LENGTH', 'MODERATION_DESCRIPTION_MAX_LENGTH'],
		      ['moderation.descriptionMaxLength', 'limits.reportDescriptionLength'],
		      2000,
		      1,
		    ),
		    reassignAfterMs: exactIntegerSetting(
		      'moderation reassign after ms',
		      ['REPORT_REASSIGN_AFTER_MS', 'MODERATION_REASSIGN_AFTER_MS'],
		      ['moderation.reassignAfterMs'],
		      24 * 60 * 60 * 1000,
		      1000,
		    ),
		  },

		  // VAPID private keys must only be supplied through environment variables
		  // in production. The public key is exposed only to authenticated clients.
		  push: {

	    vapidSubject: process.env.VAPID_SUBJECT || get('push.vapidSubject', ''),
	    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || get('push.vapidPublicKey', ''),
	    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || get('push.vapidPrivateKey', ''),
	  },

	  inMemory: {
    initialUserId: get('inMemory.initialUserId', 0),
  },

  database: {
    adapter: process.env.DB_ADAPTER || get('database.adapter', 'memory'),
    postgres: {
      ...get('database.postgres', {}),
      connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || get('database.postgres.connectionString', ''),
      sslCa: process.env.POSTGRES_SSL_CA || get('database.postgres.sslCa', ''),
      poolSize: Math.min(100, Math.max(1, Math.floor(Number(process.env.POSTGRES_POOL_SIZE || get('database.postgres.poolSize', 10)) || 10))),
      poolMin: Math.min(20, Math.max(1, Math.floor(Number(process.env.POSTGRES_POOL_MIN || get('database.postgres.poolMin', 2)) || 2))),
      poolIdleTimeoutMs: Math.min(86400000, Math.max(1000, Math.floor(Number(process.env.POSTGRES_POOL_IDLE_TIMEOUT_MS || get('database.postgres.poolIdleTimeoutMs', 300000)) || 300000))),
      poolMaxLifetimeSeconds: Math.min(86400, Math.max(60, Math.floor(Number(process.env.POSTGRES_POOL_MAX_LIFETIME_SECONDS || get('database.postgres.poolMaxLifetimeSeconds', 1800)) || 1800))),
      connectionTimeoutMs: Math.min(60000, Math.max(1000, Math.floor(Number(process.env.POSTGRES_CONNECTION_TIMEOUT_MS || get('database.postgres.connectionTimeoutMs', 15000)) || 15000))),
      transactionRetries: Math.min(10, Math.max(0, Math.floor(Number(process.env.POSTGRES_TRANSACTION_RETRIES || get('database.postgres.transactionRetries', 5)) || 0))),
      retryBaseDelayMs: Math.min(5000, Math.max(10, Math.floor(Number(process.env.POSTGRES_RETRY_BASE_DELAY_MS || get('database.postgres.retryBaseDelayMs', 50)) || 10))),
    },
    d1: {
      ...get('database.d1', {}),
      workerUrl: process.env.D1_WORKER_URL || get('database.d1.workerUrl', ''),
      // 認証トークンは本番では必ず環境変数から注入する。
      authToken: process.env.D1_WORKER_TOKEN || get('database.d1.authToken', ''),
      requestTimeoutMs: Math.min(60000, Math.max(100, Math.floor(Number(process.env.D1_REQUEST_TIMEOUT_MS || get('database.d1.requestTimeoutMs', 10000)) || 10000))),
      retryAttempts: Math.min(4, Math.max(0, Math.floor(Number(process.env.D1_RETRY_ATTEMPTS || get('database.d1.retryAttempts', 1)) || 0))),
      retryBaseDelayMs: Math.min(5000, Math.max(0, Math.floor(Number(process.env.D1_RETRY_BASE_DELAY_MS || get('database.d1.retryBaseDelayMs', 120)) || 0))),
      readCacheSeconds: Math.min(60, Math.max(0, Math.floor(Number(process.env.D1_READ_CACHE_SECONDS || get('database.d1.readCacheSeconds', 0)) || 0))),
      maxReadCacheEntries: Math.min(5000, Math.max(1, Math.floor(Number(process.env.D1_READ_CACHE_MAX_ENTRIES || get('database.d1.maxReadCacheEntries', 500)) || 500))),
      batchMaxItems: Math.min(500, Math.max(1, Math.floor(Number(process.env.D1_BATCH_MAX_ITEMS || get('database.d1.batchMaxItems', 100)) || 100))),
    },
  },

		storage: {
			adapter: process.env.STORAGE_ADAPTER || get('storage.adapter', 'local'),
			userQuotaMB: Math.min(102400, Math.max(1, Math.floor(Number(
				process.env.STORAGE_USER_QUOTA_MB || get('storage.userQuotaMB', 1024),
			) || 1024))),
			local: get('storage.local', { uploadDir: './uploads' }),
		r2: {
			...get('storage.r2', {}),
			cacheControl: process.env.R2_CACHE_CONTROL || get('storage.r2.cacheControl', 'public, max-age=31536000, immutable'),
			signedUrlCacheSeconds: Math.max(0, Number(process.env.R2_SIGNED_URL_CACHE_SECONDS || get('storage.r2.signedUrlCacheSeconds', 300)) || 0),
			signedUrlCacheMaxEntries: Math.min(10000, Math.max(1, Math.floor(Number(process.env.R2_SIGNED_URL_CACHE_MAX_ENTRIES || get('storage.r2.signedUrlCacheMaxEntries', 2000)) || 2000))),
			retryAttempts: Math.max(0, Number(process.env.R2_RETRY_ATTEMPTS || get('storage.r2.retryAttempts', 2)) || 0),
				retryBaseDelayMs: Math.max(0, Number(process.env.R2_RETRY_BASE_DELAY_MS || get('storage.r2.retryBaseDelayMs', 120)) || 0),
				deleteConcurrency: Math.min(32, Math.max(1, Math.floor(Number(process.env.R2_DELETE_CONCURRENCY || get('storage.r2.deleteConcurrency', 8)) || 8))),
			},
	},

  logging: {
    level: process.env.LOG_LEVEL || get('logging.level', 'info'),
    pretty: get('logging.pretty', true),
    requestIdHeader: get('logging.requestIdHeader', 'x-request-id'),
  },

  rateLimit: {
    enabled: envBoolean('NYAITTER_RATE_LIMIT_ENABLED', get('rateLimit.enabled', true)),
    maxTrackedKeys: exactIntegerSetting(
      'rate limit max tracked keys',
      ['NYAITTER_RATE_LIMIT_MAX_TRACKED_KEYS'],
      ['rateLimit.maxTrackedKeys'],
      10000,
      100,
    ),
    general: rateLimitSetting({
      label: 'general rate limit',
      envPrefix: 'NYAITTER_RATE_LIMIT_GENERAL',
      configPath: 'rateLimit.general',
      defaultWindow: '1min',
      defaultMax: 1000,
      legacyWindowPaths: ['rateLimit.windowMs'],
      legacyMaxPaths: ['rateLimit.max'],
    }),
    auth: rateLimitSetting({
      label: 'auth rate limit',
      envPrefix: 'NYAITTER_RATE_LIMIT_AUTH',
      configPath: 'rateLimit.auth',
      defaultWindow: '1min',
      defaultMax: 120,
      legacyWindowEnv: ['RATE_LIMIT_AUTH_WINDOW_MS'],
      legacyMaxEnv: ['RATE_LIMIT_AUTH_MAX'],
    }),
    postWrite: rateLimitSetting({
      label: 'post write rate limit',
      envPrefix: 'NYAITTER_RATE_LIMIT_POST_WRITE',
      configPath: 'rateLimit.postWrite',
      defaultWindow: '1min',
      defaultMax: 30,
    }),
    profileUpdate: rateLimitSetting({
      label: 'profile update rate limit',
      envPrefix: 'NYAITTER_RATE_LIMIT_PROFILE_UPDATE',
      configPath: 'rateLimit.profileUpdate',
      defaultWindow: '1min',
      defaultMax: 20,
    }),
    dmSend: rateLimitSetting({
      label: 'DM send rate limit',
      envPrefix: 'NYAITTER_RATE_LIMIT_DM_SEND',
      configPath: 'rateLimit.dmSend',
      defaultWindow: '1min',
      defaultMax: 60,
    }),
    upload: rateLimitSetting({
      label: 'upload rate limit',
      envPrefix: 'NYAITTER_RATE_LIMIT_UPLOAD',
      configPath: 'rateLimit.upload',
      defaultWindow: '1min',
      defaultMax: 30,
    }),
    notification: rateLimitSetting({
      label: 'notification rate limit',
      envPrefix: 'NYAITTER_RATE_LIMIT_NOTIFICATION',
      configPath: 'rateLimit.notification',
      defaultWindow: '1min',
      defaultMax: 60,
    }),
    reportCreate: rateLimitSetting({
      label: 'report create rate limit',
      envPrefix: 'NYAITTER_RATE_LIMIT_REPORT_CREATE',
      configPath: 'rateLimit.reportCreate',
      defaultWindow: '1min',
      defaultMax: 10,
    }),
    reportAction: rateLimitSetting({
      label: 'report action rate limit',
      envPrefix: 'NYAITTER_RATE_LIMIT_REPORT_ACTION',
      configPath: 'rateLimit.reportAction',
      defaultWindow: '1min',
      defaultMax: 30,
    }),
    verificationApplication: rateLimitSetting({
      label: 'verification application rate limit',
      envPrefix: 'NYAITTER_RATE_LIMIT_VERIFICATION_APPLICATION',
      configPath: 'rateLimit.verificationApplication',
      defaultWindow: '1min',
      defaultMax: 5,
    }),
  },

  security: {
    hsts: {
      // HTTPS終端を前提とする本番ではHSTSを既定で有効化する。
      enabled: get('security.hsts.enabled', isProduction),
      maxAge: get('security.hsts.maxAge', 31536000),
      includeSubDomains: get('security.hsts.includeSubDomains', true),
    },
    helmet: {
      enabled: get('security.helmet.enabled', false),
    },
  },

  health: {
    detailed: get('health.detailed', false),
  },

  rules: {
    filePath: String(
      process.env.RULES_FILE_PATH
      || process.env.RULE_FILE_PATH
      || get('rules.filePath', get('rulesFilePath', 'rule.nd')),
    ).trim(),
  },

  federation: {
    // PUBLIC_URL is optional. When absent, public URLs are derived from each
    // request's protocol and host (with proxy headers honored only if trustProxy is enabled).
    publicUrl: process.env.PUBLIC_URL || get('federation.publicUrl', ''),
    domain: process.env.SERVER_DOMAIN || get('federation.domain', 'example.com'),
    allow_external_login: get('federation.allow_external_login', true),
    trusted_servers: get('federation.trusted_servers', []),
  },

  turnstile: {
    // Cloudflare Turnstile. secret は /server/auth/scratch/generate を保護するための
    // サーバー側の鍵です。siteKey はクライアントが widget を描画する際に使えますが、
    // 通常は page/config.js の turnstileSiteKey をクライアント側で指定します。
    secret: turnstileSecretKey,
    siteKey: process.env.TURNSTILE_SITE_KEY || get('turnstile.siteKey', ''),
    enabled: Boolean(turnstileSecretKey),
  },

  postSharePort: envNonNegativeInteger('POST_SHARE_PORT', get('postSharePort', get('posts.sharePort', 0))) || null,
  postShareUrl: process.env.POST_SHARE_URL || get('postShareUrl', get('posts.shareUrl', '')) || null,
  frontendUrl: process.env.FRONTEND_URL || get('frontendUrl', get('client.url', '')),

  raw: rawConfig,
};

function validateConfig() {
  const errors = [];
  const isProd = isProduction;

  if (isProd) {
    if (!config.turnstile?.secret) {
      console.warn('[config] WARNING: TURNSTILE_SECRET_KEY is not set in production');
    }

    if (config.server.trustProxy === false) {
      console.warn('[config] WARNING: server.trustProxy should be true when running behind a reverse proxy in production');
    }

    if (config.database.adapter === 'memory') {
      console.warn('[config] WARNING: Using in-memory database in production is not recommended');
    }

    if (!process.env.PUBLIC_URL && !config.federation.publicUrl) {
      errors.push('PUBLIC_URL or federation.publicUrl must be configured in production');
    }

    if (config.federation.allow_external_login && (config.federation.trusted_servers || []).length === 0) {
      console.warn('[config] External login is configured but no trusted_servers are defined; it will remain disabled');
    }
  }

  const autoModSettings = [
    config.autoMod.apiKey,
    config.autoMod.model,
    config.autoMod.prompt,
  ].filter(Boolean);
  if (autoModSettings.length > 0 && !config.autoMod.enabled) {
    console.warn('[config] AutoMod is disabled until AUTOMOD_API_KEY (or GEMINI_API_KEY), AUTOMOD_MODEL (or GEMINI_MODEL), and AUTOMOD_PROMPT (or GEMINI_MOD_PROMPT) are all configured');
  }

  if (config.server.port < 1 || config.server.port > 65535) {
    errors.push('server.port must be between 1 and 65535');
  }
  if (config.userFiles.port && config.userFiles.port === config.server.port) {
    errors.push('userFiles.port must differ from server.port');
  }

  if (errors.length > 0) {
    console.error('[config] Configuration validation failed:');
    errors.forEach(e => console.error('  - ' + e));
    if (isProd) {
      process.exit(1);
    }
  }
}

validateConfig();

module.exports = config;
