const api = require('../utils/ApiRegistry');
const sharp = require('sharp');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');
const {
	isOwnedAttachmentKey,
	normalizeContentType,
	normalizeStorageKey,
} = require('../adapters/storage/safeStoragePath');
const {
	resolvePostingUser,
	assertPostingUserWritable,
} = require('../services/auth/PostAsUserService');

const router = api.createRouter({
	tag: 'uploads',
	basePath: '/uploads',
	description: 'ファイルアップロード・メディア管理 API',
});

const { createRateLimiter } = require('../middleware/rateLimit');
const uploadLimiter = createRateLimiter(config.rateLimit.upload);

function getStorageAdapter(req) {
	return req.app.locals.storageAdapter;
}

function decodeBase64File(value) {
	if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
		throw new Error('Invalid base64 file data');
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
		throw new Error('Invalid base64 file data');
	}
	return Buffer.from(value, 'base64');
}

router.get({
	path: '/preview',
	summary: '添付画像ファイルのサムネイル（プレビュー）取得',
	auth: 'none',
}, async (req, res) => {
	const storage = getStorageAdapter(req);
	if (!storage || typeof storage.read !== 'function') {
		return res.status(501).json({ error: 'Storage adapter not available' });
	}

	let fileId;
	try {
		fileId = normalizeStorageKey(req.query.file_id);
	} catch (_) {
		return res.status(400).json({ error: 'Invalid file_id' });
	}
	if (!fileId.startsWith('attachments/')) {
		return res.status(404).json({ error: 'Preview not found' });
	}

	try {
		const file = await storage.read(fileId);
		const contentType = normalizeContentType(file?.contentType);
		if (!contentType.startsWith('image/')) {
			return res.status(415).json({ error: 'Preview is only available for images' });
		}
		const preview = await sharp(file.buffer, {
			animated: false,
			limitInputPixels: 40_000_000,
			failOn: 'error',
		})
			.rotate()
			.resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
			.webp({ quality: 38, effort: 3, smartSubsample: true })
			.toBuffer();
		res.set({
			'Content-Type': 'image/webp',
			'Cache-Control': 'public, max-age=604800, immutable',
			'X-Content-Type-Options': 'nosniff',
		});
		res.send(preview);
	} catch (err) {
		if (err?.code === 'ENOENT' || err?.name === 'NoSuchKey') {
			return res.status(404).json({ error: 'Preview not found' });
		}
		console.warn('[uploads] preview error:', err.message);
		res.status(404).json({ error: 'Preview not found' });
	}
});

router.post({
	path: '/',
	summary: '画像などのファイルをアップロード',
	auth: 'required',
}, requireAuth, uploadLimiter, async (req, res) => {
	const storage = getStorageAdapter(req);
	if (!storage || typeof storage.upload !== 'function') {
		return res.status(501).json({ error: 'Storage adapter not available' });
	}

	const { file, fileName, contentType, as_user_id } = req.body || {};
	let uploadUser;
	try {
		uploadUser = assertPostingUserWritable(
			await resolvePostingUser(req, req.app.locals.dbAdapter, as_user_id),
		);
	} catch (error) {
		return res.status(error.statusCode || 403).json({ error: error.message });
	}
	if (!file || typeof fileName !== 'string' || !fileName.trim()) {
		return res.status(400).json({ error: 'file and fileName are required' });
	}

	const normalizedContentType = normalizeContentType(contentType);
	let buffer;
	try {
		buffer = decodeBase64File(file);
	} catch (_) {
		return res.status(400).json({ error: 'Invalid base64 file data' });
	}

	const maxSize = (config.limits.maxFileUploadSizeMB || 10) * 1024 * 1024;
	if (buffer.length === 0) {
		return res.status(400).json({ error: 'File must not be empty' });
	}
	if (buffer.length > maxSize) {
		return res.status(413).json({
			error: `File too large (max ${config.limits.maxFileUploadSizeMB}MB)`,
		});
	}

	try {
		const result = await storage.upload({
			file: buffer,
			fileName,
			contentType: normalizedContentType,
			folder: `attachments/${uploadUser.id}`,
		});
		res.json(result);
	} catch (err) {
		console.error('[uploads] upload error:', err);
		if (err?.code === 'STORAGE_QUOTA_EXCEEDED') {
			return res.status(413).json({
				error: 'ストレージの保存上限を超えるため、アップロードできません。',
				limit_bytes: err.limitBytes,
				used_bytes: err.usedBytes,
			});
		}
		if (Number.isInteger(err?.statusCode)) {
			return res.status(err.statusCode).json({ error: err.message });
		}
		res.status(500).json({ error: 'ファイルのアップロードに失敗しました' });
	}
});

router.get({
	path: '/storage',
	summary: '自分のストレージ使用状況とファイル一覧の取得',
	auth: 'required',
}, requireAuth, async (req, res) => {
	const storage = getStorageAdapter(req);
	if (!storage || typeof storage.getUsage !== 'function' || typeof storage.listFiles !== 'function') {
		return res.status(501).json({ error: 'Storage inventory is not available' });
	}

	const folder = `attachments/${req.user.id}`;
	const limitBytes = Math.max(1, Number(config.storage?.userQuotaMB || 1024)) * 1024 * 1024;
	try {
		const [usedBytes, files] = await Promise.all([
			storage.getUsage(folder),
			storage.listFiles(folder, { limit: config.limits.storageListPageSize }),
		]);
		res.json({
			limit_mb: Number(config.storage?.userQuotaMB || 1024),
			limit_bytes: limitBytes,
			used_bytes: Math.max(0, Number(usedBytes) || 0),
			used_percent: Math.min(100, (Math.max(0, Number(usedBytes) || 0) / limitBytes) * 100),
			files: Array.isArray(files) ? files : [],
		});
	} catch (err) {
		console.error('[uploads] storage inventory error:', err);
		res.status(500).json({ error: 'ストレージ情報の取得に失敗しました' });
	}
});

router.delete({
	path: '/',
	summary: 'アップロード済みファイルの削除',
	auth: 'required',
}, requireAuth, uploadLimiter, async (req, res) => {
	const storage = getStorageAdapter(req);
	const { fileIds, as_user_id } = req.body || {};
	let uploadUser;
	try {
		uploadUser = assertPostingUserWritable(
			await resolvePostingUser(req, req.app.locals.dbAdapter, as_user_id),
		);
	} catch (error) {
		return res.status(error.statusCode || 403).json({ error: error.message });
	}
	if (!Array.isArray(fileIds) || fileIds.length === 0) {
		return res.status(400).json({ error: 'fileIds is required' });
	}
	if (!storage || typeof storage.delete !== 'function') {
		return res.status(501).json({ error: 'Storage adapter not available' });
	}

	try {
		for (const fileId of fileIds) {
				if (typeof fileId !== 'string' || !isOwnedAttachmentKey(fileId, uploadUser.id)) {
				return res.status(403).json({ error: 'You can only delete your own attachments' });
			}
		}
		const uniqueFileIds = [...new Set(fileIds)];
			if (uniqueFileIds.length > config.limits.fileDeleteBatchSize) {
				return res.status(400).json({
					error: `A maximum of ${config.limits.fileDeleteBatchSize} files can be deleted per request`,
				});
			}
		if (typeof storage.deleteMany === 'function') {
			await storage.deleteMany(uniqueFileIds);
		} else {
			await Promise.all(uniqueFileIds.map((fileId) => storage.delete(fileId)));
		}
		res.json({ success: true, deleted_count: uniqueFileIds.length });
	} catch (err) {
		console.error('[uploads] delete error:', err);
		res.status(500).json({ error: 'ファイル削除に失敗しました' });
	}
});

module.exports = router;
