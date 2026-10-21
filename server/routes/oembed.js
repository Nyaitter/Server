'use strict';

const api = require('../utils/ApiRegistry');
const {
	generateOembedJson,
	generateGroupOembedJson,
	generateStageOembedJson,
} = require('../services/OgpService');
const { getPublicUrl } = require('../utils/nyaitterAddress');
const { parseEmbedTarget, getPublicGroup, getPublicStage } = require('../services/EmbedService');

const router = api.createRouter({
	tag: 'oembed',
	basePath: '/oembed',
	description: 'oEmbed 埋め込み API',
});

router.get({
	path: '/',
	summary: '投稿 URL からの oEmbed 埋め込みメタデータ取得',
	auth: 'none',
}, async (req, res) => {
	const rawUrl = req.query.url;
	if (!rawUrl || typeof rawUrl !== 'string') {
		return res.status(400).json({ error: 'url query parameter is required' });
	}

	try {
		const parsed = new URL(rawUrl);
		const db = req.app.locals.dbAdapter;
		const publicUrl = getPublicUrl(req);
		const entity = parseEmbedTarget(rawUrl);
		if (entity) {
			if (entity.kind === 'group') {
				const group = await getPublicGroup(db, entity.id);
				if (!group) return res.status(404).json({ error: 'Group not found' });
				return res.json(generateGroupOembedJson({
					group,
					publicUrl,
					groupUrl: rawUrl,
				}));
			}
			const result = await getPublicStage(db, entity.id);
			if (!result) return res.status(404).json({ error: 'Stage not found' });
			return res.json(generateStageOembedJson({
				stage: result.stage,
				host: result.host,
				publicUrl,
				stageUrl: rawUrl,
			}));
		}

		let postId = null;
		const pathMatch = parsed.pathname.match(/\/(?:posts?|api\/posts)\/(\d+)/i);
		if (pathMatch) {
			postId = Number(pathMatch[1]);
		} else if (parsed.searchParams.has('post')) {
			postId = Number(parsed.searchParams.get('post'));
		} else if (parsed.searchParams.has('post_id')) {
			postId = Number(parsed.searchParams.get('post_id'));
		} else if (parsed.hash) {
			const hashMatch = parsed.hash.match(/#\/?posts?\/(\d+)/i);
			if (hashMatch) postId = Number(hashMatch[1]);
		}

		if (!postId) {
			return res.status(404).json({ error: 'Post not found from URL' });
		}

		const post = await db.getPostById(postId);
		if (!post) {
			return res.status(404).json({ error: 'Post not found' });
		}

		const author = await db.getUserById(post.userId ?? post.user_id);
		const oembedData = generateOembedJson({
			post,
			author,
			publicUrl,
			postUrl: rawUrl,
		});

		res.json(oembedData);
	} catch (err) {
		console.error('[oembed] error:', err);
		res.status(500).json({ error: 'Failed to generate oEmbed response' });
	}
});

module.exports = router;
