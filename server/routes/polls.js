'use strict';

const express = require('express');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const router = express.Router();

function getDbAdapter(req) {
	return req.app.locals.dbAdapter;
}

function safeParsePollId(id) {
	if (id == null) return null;
	const s = String(id).trim();
	return /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
}

// 投票の取得
router.get('/:pollId', optionalAuth, async (req, res) => {
	const pollId = safeParsePollId(req.params.pollId);
	if (!pollId) {
		return res.status(400).json({ error: '無効な投票IDです' });
	}

	const db = getDbAdapter(req);
	try {
		const poll = await db.getPollById(pollId, req.user?.id || null);
		if (!poll) {
			return res.status(404).json({ error: '投票が見つかりません' });
		}
		return res.json({ poll });
	} catch (error) {
		console.error('[polls] get error:', error.message);
		return res.status(500).json({ error: '投票の取得に失敗しました' });
	}
});

// 投票の実行
router.post('/:pollId/vote', requireAuth, async (req, res) => {
	const pollId = safeParsePollId(req.params.pollId);
	if (!pollId) {
		return res.status(400).json({ error: '無効な投票IDです' });
	}

	const db = getDbAdapter(req);
	const rawOptionIds = req.body.option_ids ?? req.body.optionIds;
	const optionIds = Array.isArray(rawOptionIds)
		? rawOptionIds.map(Number).filter(Number.isInteger)
		: (Number.isInteger(Number(rawOptionIds)) ? [Number(rawOptionIds)] : []);

	const otherText = typeof req.body.other_text === 'string'
		? req.body.other_text
		: (typeof req.body.otherText === 'string' ? req.body.otherText : null);

	try {
		const poll = await db.votePoll({
			pollId,
			userId: req.user.id,
			optionIds,
			otherText,
		});

		// リアルタイム接続へ投票更新を通知（利用可能な場合）
		if (req.app.locals.realtime?.broadcast) {
			try {
				req.app.locals.realtime.broadcast({
					type: 'poll_updated',
					poll_id: poll.id,
					post_id: poll.post_id,
					poll,
				});
			} catch (_) {}
		}

		return res.json({ poll });
	} catch (error) {
		console.error('[polls] vote error:', error.message);
		return res.status(400).json({ error: error.message || '投票に失敗しました' });
	}
});

module.exports = router;
