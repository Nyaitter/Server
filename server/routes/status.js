const api = require('../utils/ApiRegistry');
const config = require('../config');
const {
	getPublicUrl,
	getApiPublicUrl,
	getPostShareUrl,
} = require('../utils/nyaitterAddress');
const { defaultRegistry: authProviderRegistry } = require('../services/auth/AuthProviderRegistry');

const router = api.createRouter({
	tag: 'system',
	basePath: '',
	description: 'システム状態・基本設定 API',
});

function getDbAdapter(req) {
	return req.app.locals.dbAdapter;
}

function serializeIntegerRange(range) {
	return {
		min: Number.isInteger(range?.min) ? range.min : null,
		max: Number.isInteger(range?.max) ? range.max : null,
	};
}

function serializeRateLimit(limit) {
	return {
		window_ms: Number.isInteger(limit?.windowMs) ? limit.windowMs : null,
		max: Number.isInteger(limit?.max) ? limit.max : null,
	};
}

function getPublicClientLimits() {
	const rateLimits = {};
	Object.entries(config.rateLimit || {}).forEach(([name, limit]) => {
		if (name === 'enabled' || !limit || typeof limit !== 'object') return;
		rateLimits[name] = serializeRateLimit(limit);
	});

	return {
		input: {
			post_content_length: serializeIntegerRange(
				config.limits.postContentLength,
			),
			dm_content_length: serializeIntegerRange(
				config.limits.dmContentLength,
			),
			user_name_length: serializeIntegerRange(
				config.limits.userNameLength,
			),
			profile_bio_length: serializeIntegerRange(
				config.limits.profileBioLength,
			),
			scratch_username_length: serializeIntegerRange(
				config.limits.scratchUsernameLength,
			),
		},
		upload: {
			max_file_size_bytes: config.limits.maxFileUploadSizeMB * 1024 * 1024,
		},
		rate_limits: {
			enabled: Boolean(config.rateLimit?.enabled),
			limits: rateLimits,
		},
	};
}

router.get({
	path: '/status',
	summary: 'サーバーの稼働状態・制限値・認証プロバイダー設定の取得',
	auth: 'none',
}, async (req, res) => {
	let dbStatus = 'ok';

	try {
		const db = getDbAdapter(req);
		if (db && typeof db.connect === 'function') {
			dbStatus = 'connected';
		}
	} catch (error) {
		dbStatus = 'error';
		console.warn('[server] DB status check exception:', error.message);
	}

	const publicUrl = getPublicUrl(req);

	res.json({
		server: 'ok',
		timestamp: new Date().toISOString(),
		database: dbStatus,
		identity: {
			public_url: publicUrl,
			api_url: getApiPublicUrl(req),
			post_share_url: getPostShareUrl(req),
			nyaitter_id_format: '#{localId}',
		},
		client_config: {
			user_file_endpoint: config.userFiles.endpoint,
			post_share_url: getPostShareUrl(req),
			turnstile_site_key: config.turnstile?.siteKey || '',
			push: {
				enabled: Boolean(config.push?.vapidPublicKey && config.push?.vapidPrivateKey),
				vapid_public_key: config.push?.vapidPublicKey || '',
			},
			resource_links: config.client?.resourceLinks || [],
			widget_links: config.client?.widgetLinks || [],
		},
		auth_methods: authProviderRegistry.listEnabledProviderNames(config, req),
		turnstile: {
			enabled: Boolean(config.turnstile?.enabled),
		},
		client_limits: getPublicClientLimits(),
	});
});

module.exports = router;
