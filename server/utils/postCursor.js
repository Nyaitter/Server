'use strict';

function encodePostCursor(post, extra = null) {
	if (!post) return null;
	const id = Number(post.id ?? post.i ?? post.postId ?? post.post_id);
	if (!Number.isInteger(id) || id <= 0) return null;
	const rawDate = post.createdAt ?? post.created_at ?? post.c;
	const parsedDate = rawDate ? new Date(rawDate) : null;
	if (!parsedDate || Number.isNaN(parsedDate.getTime())) return null;

	const pos = (post.position != null ? Number(post.position) : (extra != null ? Number(extra) : null));
	const payload = Number.isInteger(pos)
		? JSON.stringify([parsedDate.toISOString(), id, pos])
		: JSON.stringify([parsedDate.toISOString(), id]);
	return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodePostCursor(cursor) {
	if (!cursor || typeof cursor !== 'string') return null;
	try {
		const raw = Buffer.from(cursor.trim(), 'base64url').toString('utf8');
		let createdAt = null;
		let id = null;
		let position = null;

		if (raw.startsWith('[') && raw.endsWith(']')) {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed) && parsed.length >= 2) {
				createdAt = parsed[0];
				id = Number(parsed[1]);
				if (parsed.length >= 3 && Number.isInteger(Number(parsed[2]))) {
					position = Number(parsed[2]);
				}
			}
		} else if (raw.startsWith('{') && raw.endsWith('}')) {
			const parsed = JSON.parse(raw);
			createdAt = parsed.c || parsed.createdAt || parsed.created_at;
			id = Number(parsed.i || parsed.id);
			if (parsed.p != null && Number.isInteger(Number(parsed.p))) {
				position = Number(parsed.p);
			}
		} else if (raw.includes('_')) {
			const parts = raw.split('_');
			createdAt = parts[0];
			id = Number(parts[1]);
			if (parts.length >= 3 && Number.isInteger(Number(parts[2]))) {
				position = Number(parts[2]);
			}
		}

		if (!createdAt || !Number.isInteger(id) || id <= 0) return null;
		const parsedDate = new Date(createdAt);
		if (Number.isNaN(parsedDate.getTime())) return null;

		return {
			createdAt: parsedDate.toISOString(),
			id,
			...(position != null ? { position } : {}),
		};
	} catch {
		return null;
	}
}

module.exports = {
	encodePostCursor,
	decodePostCursor,
};
