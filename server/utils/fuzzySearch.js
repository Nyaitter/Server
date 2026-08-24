'use strict';

/**
 * 類似度および80%許容のあいまい検索ユーティリティ
 */

function calculateStringSimilarity(str1, str2) {
	const s1 = String(str1 || '').trim().toLowerCase().replace(/^[#＃]/, '');
	const s2 = String(str2 || '').trim().toLowerCase().replace(/^[#＃]/, '');
	if (s1 === s2) return 1.0;
	if (!s1 || !s2) return 0.0;

	const len1 = s1.length;
	const len2 = s2.length;
	const maxLen = Math.max(len1, len2);
	const minLen = Math.min(len1, len2);

	// 1. 部分一致率（一方が他方に完全に含まれる場合）
	const isSubstring = s1.includes(s2) || s2.includes(s1);
	const substringSim = isSubstring ? minLen / maxLen : 0;

	// 2. Levenshtein距離類似度
	const d = Array.from({ length: len1 + 1 }, () => new Array(len2 + 1).fill(0));
	for (let i = 0; i <= len1; i++) d[i][0] = i;
	for (let j = 0; j <= len2; j++) d[0][j] = j;

	for (let i = 1; i <= len1; i++) {
		for (let j = 1; j <= len2; j++) {
			const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
			d[i][j] = Math.min(
				d[i - 1][j] + 1,
				d[i][j - 1] + 1,
				d[i - 1][j - 1] + cost,
			);
		}
	}
	const levSim = 1 - d[len1][len2] / maxLen;

	// 3. Bigram Dice係数
	let diceSim = 0;
	if (len1 >= 2 && len2 >= 2) {
		const bg1 = new Map();
		for (let i = 0; i < len1 - 1; i++) {
			const bg = s1.slice(i, i + 2);
			bg1.set(bg, (bg1.get(bg) || 0) + 1);
		}
		let intersection = 0;
		for (let i = 0; i < len2 - 1; i++) {
			const bg = s2.slice(i, i + 2);
			if (bg1.has(bg) && bg1.get(bg) > 0) {
				intersection++;
				bg1.set(bg, bg1.get(bg) - 1);
			}
		}
		diceSim = (2 * intersection) / ((len1 - 1) + (len2 - 1));
	}

	return Math.max(substringSim, levSim, diceSim);
}

/**
 * テキスト中に対象クエリが80%以上の類似度であいまい一致するか判定する
 * @param {string} text - 検索対象テキスト
 * @param {string} query - 検索クエリ
 * @param {number} threshold - 許容閾値（デフォルト 0.8 = 80%）
 * @returns {boolean}
 */
function isFuzzyMatch(text, query, threshold = 0.8) {
	const target = String(text || '').trim().toLowerCase();
	const q = String(query || '').trim().toLowerCase().replace(/^[#＃]/, '');
	if (!target || !q) return false;

	// 完全一致またはそのまま含まれる場合は即マッチ
	if (target.includes(q)) return true;

	const qLen = q.length;
	if (qLen <= 1) return false;

	// スライディングウィンドウ探索 (qLen, qLen - 1, qLen + 1)
	for (const windowLen of [qLen, qLen - 1, qLen + 1]) {
		if (windowLen <= 0 || windowLen > target.length) continue;
		for (let i = 0; i <= target.length - windowLen; i++) {
			const sub = target.slice(i, i + windowLen);
			const sim = calculateStringSimilarity(sub, q);
			if (sim >= threshold) return true;
		}
	}

	return false;
}

module.exports = {
	calculateStringSimilarity,
	isFuzzyMatch,
};
