'use strict';

/**
 * Service for generating Open Graph Protocol (OGP) tags, HTML meta embeds,
 * and oEmbed responses for Discord, Twitter/X, Mastodon, Slack, and other platforms.
 */

const { extractViewContent } = require('../utils/viewContent');

const BOT_USER_AGENTS = [
	'discordbot',
	'twitterbot',
	'facebookexternalhit',
	'slackbot',
	'telegrambot',
	'linespider',
	'mastodon',
	'misskey',
	'pleroma',
	'applebot',
	'whatsapp',
	'linkedinbot',
	'pinterest',
	'googlebot',
	'bingbot',
	'yandexbot',
	'baiduspider',
	'duckduckbot',
	'embedly',
	'quora link preview',
	'outbrain',
	'vkshare',
	'w3c_validator',
];

function isCrawler(userAgent) {
	if (!userAgent || typeof userAgent !== 'string') return false;
	const lower = userAgent.toLowerCase();
	return BOT_USER_AGENTS.some((bot) => lower.includes(bot));
}

function escapeHtml(str) {
	if (!str) return '';
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function resolveMediaUrl(raw, publicUrl) {
	if (!raw || typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	if (trimmed.startsWith('data:image/')) return trimmed;

	const base = (publicUrl || '').replace(/\/+$/, '');
	if (trimmed.startsWith('/user_files/') || trimmed.startsWith('user_files/')) {
		const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
		return `${base}${path}`;
	}
	if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
		return `${base}/user_files/${encodeURIComponent(trimmed)}`;
	}
	const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
	return `${base}${path}`;
}

function resolveAuthorAvatar(author, publicUrl) {
	if (!author) return null;
	const base = (publicUrl || '').replace(/\/+$/, '');
	const iconData = author.icon_data || author.iconData || author.avatar;
	if (iconData && typeof iconData === 'string') {
		const resolved = resolveMediaUrl(iconData, publicUrl);
		if (resolved) return resolved;
	}
	if (author.id != null) {
		return `${base}/server/api/users/${encodeURIComponent(String(author.id))}/icon`;
	}
	return `${base}/logo.png`;
}

function formatUserDisplayId(author) {
	if (!author) return '';
	if (author.nyaitter_id) return author.nyaitter_id;
	if (author.id != null) return `#${author.id}`;
	if (author.scid) return `@${author.scid}`;
	return '';
}

function isVideoAttachment(att) {
	if (!att) return false;
	const type = String(att.type || att.contentType || '').toLowerCase();
	const name = String(att.name || att.filename || att.url || '').toLowerCase();
	return (
		type.startsWith('video/') ||
		type === 'video' ||
		/\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(name)
	);
}

function isAudioAttachment(att) {
	if (!att) return false;
	const type = String(att.type || att.contentType || '').toLowerCase();
	const name = String(att.name || att.filename || att.url || '').toLowerCase();
	return (
		type.startsWith('audio/') ||
		type === 'audio' ||
		/\.(mp3|ogg|wav|m4a|aac|flac|opus)$/i.test(name)
	);
}

function isImageAttachment(att) {
	if (!att) return false;
	const type = String(att.type || att.contentType || '').toLowerCase();
	const name = String(att.name || att.filename || att.url || '').toLowerCase();
	return (
		type.startsWith('image/') ||
		type === 'image' ||
		/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(name)
	);
}

function extractMediaAttachments(attachments, publicUrl) {
	const images = [];
	const videos = [];
	const audios = [];
	if (!Array.isArray(attachments)) return { images, videos, audios };

	for (const att of attachments) {
		if (!att) continue;
		let rawUrl = null;
		if (typeof att === 'string') {
			rawUrl = att;
		} else {
			rawUrl = att.url || (att.id || att.file_id || att.fileId ? `/user_files/${encodeURIComponent(att.id || att.file_id || att.fileId)}` : null);
		}
		const fullUrl = resolveMediaUrl(rawUrl, publicUrl);
		if (!fullUrl) continue;

		if (isVideoAttachment(att)) {
			videos.push({
				url: fullUrl,
				contentType: (att && typeof att === 'object' && att.contentType) || (fullUrl.endsWith('.webm') ? 'video/webm' : 'video/mp4'),
				name: (att && typeof att === 'object' && (att.name || att.filename)) || 'video',
			});
		} else if (isAudioAttachment(att)) {
			audios.push({
				url: fullUrl,
				contentType: (att && typeof att === 'object' && att.contentType) || 'audio/mpeg',
				name: (att && typeof att === 'object' && (att.name || att.filename)) || 'audio',
			});
		} else if (isImageAttachment(att) || (att && !att.type)) {
			images.push({
				url: fullUrl,
				contentType: (att && typeof att === 'object' && att.contentType) || 'image/jpeg',
				name: (att && typeof att === 'object' && (att.name || att.filename)) || 'image',
			});
		}
	}
	return { images, videos, audios };
}

const NAMED_COLORS = new Set([
	'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange',
	'purple', 'pink', 'gray', 'grey', 'brown', 'cyan', 'magenta',
	'lime', 'navy', 'teal', 'silver', 'maroon', 'olive', 'aqua',
	'fuchsia',
]);

/**
 * NyarkDown 及び Markdown の装飾を安全な HTML へ変換する。
 *
 * @param {string} content 元のポストテキスト
 * @param {string} publicUrl サーバーのベースURL
 * @returns {string} 装飾適用済みの安全なHTML文字列
 */
function renderDecoratedContentHtml(content, publicUrl = '') {
	if (!content) return '';
	let text = String(content);

	// 1. コードブロックの保護
	const codeBlocks = [];
	text = text.replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
		const idx = codeBlocks.length;
		codeBlocks.push(`<pre style="background:#282c34;color:#abb2bf;padding:12px;border-radius:8px;overflow-x:auto;font-family:monospace;font-size:0.9em;margin:8px 0;"><code>${escapeHtml(code.trim())}</code></pre>`);
		return `\u0000CODEBLOCK${idx}\u0000`;
	});

	// 2. インラインコードの保護
	const inlineCodes = [];
	text = text.replace(/`([^`\r\n]+)`/g, (_, code) => {
		const idx = inlineCodes.length;
		inlineCodes.push(`<code style="background:rgba(0,0,0,0.06);padding:2px 5px;border-radius:4px;font-family:monospace;font-size:0.9em;color:#e06c75;">${escapeHtml(code)}</code>`);
		return `\u0000INLINECODE${idx}\u0000`;
	});

	// 3. HTMLエスケープ
	text = escapeHtml(text);

	// 4. NyarkDown 装飾タグのパース
	// [c=color]...[/c], [color=color]...[/color], [c=color]...[/]
	text = text.replace(/\[(?:c|color)=([#a-zA-Z0-9]+)\]([\s\S]*?)\[\/(?:c|color)?\]/gi, (match, color, inner) => {
		const clr = color.toLowerCase();
		const validColor = /^#[0-9a-f]{3,8}$/i.test(clr) || NAMED_COLORS.has(clr);
		if (validColor) {
			return `<span style="color:${clr};">${inner}</span>`;
		}
		return inner;
	});

	// [s=size]...[/s], [size=size]...[/size], [s=size]...[/] (0.5 〜 3)
	text = text.replace(/\[(?:s|size)=([0-9.]+)\]([\s\S]*?)\[\/(?:s|size)?\]/gi, (match, size, inner) => {
		const num = parseFloat(size);
		if (Number.isFinite(num) && num >= 0.5 && num <= 3) {
			return `<span style="font-size:${num}em;">${inner}</span>`;
		}
		return inner;
	});

	// [r=rotate]...[/r], [rotate=rotate]...[/rotate] (-180 〜 180 deg)
	text = text.replace(/\[(?:r|rotate)=(-?[0-9.]+)\]([\s\S]*?)\[\/(?:r|rotate)?\]/gi, (match, deg, inner) => {
		const num = parseFloat(deg);
		if (Number.isFinite(num) && num >= -180 && num <= 180) {
			return `<span style="display:inline-block;transform:rotate(${num}deg);">${inner}</span>`;
		}
		return inner;
	});

	// [x=val]...[/x], [y=val]...[/y] (-2 〜 2 em)
	text = text.replace(/\[x=(-?[0-9.]+)\]([\s\S]*?)\[\/x?\]/gi, (match, val, inner) => {
		const num = parseFloat(val);
		if (Number.isFinite(num) && num >= -2 && num <= 2) {
			return `<span style="display:inline-block;transform:translateX(${num}em);">${inner}</span>`;
		}
		return inner;
	});
	text = text.replace(/\[y=(-?[0-9.]+)\]([\s\S]*?)\[\/y?\]/gi, (match, val, inner) => {
		const num = parseFloat(val);
		if (Number.isFinite(num) && num >= -2 && num <= 2) {
			return `<span style="display:inline-block;transform:translateY(${num}em);">${inner}</span>`;
		}
		return inner;
	});

	// [ruby=rt]...[/ruby], [rb=rt]...[/rb]
	text = text.replace(/\[(?:ruby|rb)=([^\]\r\n]+)\]([\s\S]*?)\[\/(?:ruby|rb)?\]/gi, (_, rt, inner) => {
		return `<ruby>${inner}<rp>(</rp><rt>${rt}</rt><rp>)</rp></ruby>`;
	});

	// 5. Markdown インライン装飾
	// ***太字斜体***
	text = text.replace(/\*\*\*([^*\r\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
	// **太字** / __太字__
	text = text.replace(/\*\*([^*\r\n]+)\*\*/g, '<strong>$1</strong>');
	text = text.replace(/__([^_\r\n]+)__/g, '<strong>$1</strong>');
	// *斜体*
	text = text.replace(/\*([^*\r\n]+)\*/g, '<em>$1</em>');
	// ~~取り消し線~~
	text = text.replace(/~~([^~\r\n]+)~~/g, '<s>$1</s>');
	// ==ハイライト==
	text = text.replace(/==([^=\r\n]+)==/g, '<mark style="background:#ffeb3b;color:#222;padding:0 2px;border-radius:2px;">$1</mark>');
	// ++下線++
	text = text.replace(/\+\+([^+・\r\n]+)\+\+/g, '<u>$1</u>');
	// ||ネタバレ||
	text = text.replace(/\|\|([^|\r\n]+)\|\|/g, '<span style="background:#4a4a4a;color:#4a4a4a;border-radius:4px;padding:0 4px;cursor:pointer;" title="クリックして表示" onclick="this.style.color=\'inherit\';this.style.background=\'rgba(0,0,0,0.08)\';">$1</span>');
	// ^上付き^ / ~下付き~
	text = text.replace(/\^([^\^\r\n]+)\^/g, '<sup>$1</sup>');
	text = text.replace(/~([^~\r\n]+)~/g, '<sub>$1</sub>');

	// 6. リンク・メンション・ハッシュタグ・カスタム絵文字
	// Markdown リンク [ラベル](URL)
	text = text.replace(/\[([^\]\r\n]+)\]\(((?:https?:\/\/)[^\s\)]+)\)/gi, (_, label, url) => {
		return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:#79529c;text-decoration:underline;">${label}</a>`;
	});

	// 自動URLリンク
	text = text.replace(/(?<!href=")(https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=]+)/g, (url) => {
		return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:#79529c;text-decoration:underline;word-break:break-all;">${url}</a>`;
	});

	// メンション @123 または @name
	text = text.replace(/@(\d+)/g, (_, userId) => {
		return `<a href="${publicUrl}/#profile/${userId}" style="color:#79529c;font-weight:600;text-decoration:none;">@#${userId.padStart(4, '0')}</a>`;
	});

	// ハッシュタグ #tag
	text = text.replace(/(?:^|\s)#([a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)/g, (match, tag) => {
		return ` <a href="${publicUrl}/#explore?q=%23${encodeURIComponent(tag)}" style="color:#79529c;font-weight:500;text-decoration:none;">#${tag}</a>`;
	});

	// カスタム絵文字 _emoji_
	text = text.replace(/_([A-Za-z0-9_-]{1,80})_/g, (_, emojiId) => {
		return `<img src="${publicUrl}/emoji/${encodeURIComponent(emojiId)}.svg" alt="_${emojiId}_" style="height:1.2em;vertical-align:-0.2em;margin:0 0.05em;" onerror="this.outerHTML='_${emojiId}_'" />`;
	});

	// 7. 見出しと引用
	text = text.split('\n').map((line) => {
		if (/^###\s+(.*)$/.test(line)) {
			return line.replace(/^###\s+(.*)$/, '<h4 style="margin:12px 0 6px 0;font-size:1.1em;font-weight:bold;">$1</h4>');
		}
		if (/^##\s+(.*)$/.test(line)) {
			return line.replace(/^##\s+(.*)$/, '<h3 style="margin:14px 0 6px 0;font-size:1.2em;font-weight:bold;">$1</h3>');
		}
		if (/^#\s+(.*)$/.test(line)) {
			return line.replace(/^#\s+(.*)$/, '<h2 style="margin:16px 0 8px 0;font-size:1.3em;font-weight:bold;">$1</h2>');
		}
		if (/^&gt;\s*(.*)$/.test(line)) {
			return line.replace(/^&gt;\s*(.*)$/, '<blockquote style="border-left:4px solid #79529c;padding-left:10px;margin:6px 0;color:#555;font-style:italic;">$1</blockquote>');
		}
		return line;
	}).join('\n');

	// 8. 改行を <br> に変換
	text = text.replace(/\r?\n/g, '<br />');

	// 9. 保護していたコードブロックとインラインコードの復元
	inlineCodes.forEach((html, idx) => {
		text = text.replace(`\u0000INLINECODE${idx}\u0000`, html);
	});
	codeBlocks.forEach((html, idx) => {
		text = text.replace(`\u0000CODEBLOCK${idx}\u0000`, html);
	});

	return text;
}

function generatePostOgpTags({ post, author, publicUrl }) {
	const authorName = author?.name || 'Unknown User';
	const userDisplayId = formatUserDisplayId(author);
	const title = userDisplayId ? `${authorName} (${userDisplayId}) on Nyaitter` : `${authorName} on Nyaitter`;

	const cleanContent = extractViewContent(post?.content || '');
	let description = cleanContent;
	if (post?.mask) {
		description = '🔒 [この投稿はマスクされています]';
	} else if (!description && post?.attachments?.length > 0) {
		description = `[添付ファイル ${post.attachments.length}件]`;
	}
	if (!description) {
		description = 'Nyaitterのポスト';
	}
	if (description.length > 300) {
		description = description.slice(0, 297) + '...';
	}

	const postUrl = `${publicUrl}/posts/${post?.id}`;
	const avatarUrl = resolveAuthorAvatar(author, publicUrl);
	const { images, videos, audios } = extractMediaAttachments(post?.attachments, publicUrl);

	const firstImage = images[0]?.url || null;
	const firstVideo = videos[0] || null;
	const firstAudio = audios[0] || null;

	let twitterCard = 'summary';
	if (firstVideo) {
		twitterCard = 'player';
	} else if (firstImage) {
		twitterCard = 'summary_large_image';
	}

	const themeColor = '#79529c';
	const oEmbedUrl = `${publicUrl}/api/oembed?url=${encodeURIComponent(postUrl)}`;

	let videoTags = '';
	if (firstVideo) {
		videoTags = `
    <!-- Video Player for Discord/Twitter -->
    <meta property="og:video" content="${escapeHtml(firstVideo.url)}" />
    <meta property="og:video:secure_url" content="${escapeHtml(firstVideo.url)}" />
    <meta property="og:video:type" content="${escapeHtml(firstVideo.contentType)}" />
    <meta property="og:video:width" content="1280" />
    <meta property="og:video:height" content="720" />
    <meta name="twitter:player" content="${escapeHtml(firstVideo.url)}" />
    <meta name="twitter:player:width" content="1280" />
    <meta name="twitter:player:height" content="720" />
`;
	}

	let audioTags = '';
	if (firstAudio) {
		audioTags = `
    <!-- Audio Player -->
    <meta property="og:audio" content="${escapeHtml(firstAudio.url)}" />
    <meta property="og:audio:secure_url" content="${escapeHtml(firstAudio.url)}" />
    <meta property="og:audio:type" content="${escapeHtml(firstAudio.contentType)}" />
`;
	}

	// 複数画像がある場合は複数の og:image タグを出力（Discord / Telegram / Facebook のギャラリー表示用）
	let imageTags = '';
	if (images.length > 0) {
		imageTags = images.slice(0, 4).map((img) => `    <meta property="og:image" content="${escapeHtml(img.url)}" />`).join('\n');
	} else if (avatarUrl) {
		imageTags = `    <meta property="og:image" content="${escapeHtml(avatarUrl)}" />`;
	} else {
		imageTags = `    <meta property="og:image" content="${escapeHtml(publicUrl)}/logo.png" />`;
	}

	const twitterImage = firstImage || avatarUrl || `${publicUrl}/logo.png`;

	return `
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="theme-color" content="${themeColor}" />

    <!-- Open Graph / Facebook / Discord -->
    <meta property="og:type" content="${firstVideo ? 'video.other' : (firstAudio ? 'music.song' : 'article')}" />
    <meta property="og:site_name" content="Nyaitter" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(postUrl)}" />
${imageTags}
${videoTags}${audioTags}
    <!-- Twitter / X -->
    <meta name="twitter:card" content="${twitterCard}" />
    <meta name="twitter:site" content="@Nyaitter" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(twitterImage)}" />

    <!-- oEmbed -->
    <link rel="alternate" type="application/json+oembed" href="${escapeHtml(oEmbedUrl)}" title="${escapeHtml(title)}" />
`;
}

function generateOembedJson({ post, author, publicUrl, postUrl }) {
	const authorName = author ? author.name : 'Nyaitter User';
	const userDisplayId = formatUserDisplayId(author);
	const fullAuthorTitle = userDisplayId ? `${authorName} (${userDisplayId})` : authorName;
	const authorUrl = author ? `${publicUrl}/#profile/${author.id}` : publicUrl;
	const avatarUrl = resolveAuthorAvatar(author, publicUrl);

	const { images, videos, audios } = extractMediaAttachments(post?.attachments, publicUrl);
	const firstImage = images[0]?.url || null;
	const firstVideo = videos[0] || null;

	const cleanContent = extractViewContent(post?.content || '');
	const decoratedHtml = renderDecoratedContentHtml(
		post?.mask ? '🔒 [この投稿はマスクされています]' : (post?.content || ''),
		publicUrl,
	);

	const json = {
		version: '1.0',
		type: 'rich',
		provider_name: 'Nyaitter',
		provider_url: publicUrl,
		author_name: fullAuthorTitle,
		author_url: authorUrl,
		author_icon_url: avatarUrl,
		title: cleanContent.slice(0, 100) || 'Nyaitter Post',
	};

	if (firstImage) {
		json.thumbnail_url = firstImage;
		json.thumbnail_width = 1200;
		json.thumbnail_height = 630;
	} else if (avatarUrl) {
		json.thumbnail_url = avatarUrl;
	}

	let mediaEmbedHtml = '';
	if (images.length === 1) {
		mediaEmbedHtml = `<div style="margin-top:10px;"><img src="${escapeHtml(images[0].url)}" alt="image" style="max-width:100%;max-height:400px;border-radius:8px;object-fit:cover;" /></div>`;
	} else if (images.length > 1) {
		const imgItems = images.slice(0, 4).map((img) => `<img src="${escapeHtml(img.url)}" alt="image" style="width:100%;height:140px;object-fit:cover;border-radius:6px;" />`).join('');
		mediaEmbedHtml = `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-top:10px;">${imgItems}</div>`;
	} else if (firstVideo) {
		mediaEmbedHtml = `<div style="margin-top:10px;"><video controls width="100%" style="max-height:400px;border-radius:8px;background:#000;" poster="${escapeHtml(avatarUrl || '')}"><source src="${escapeHtml(firstVideo.url)}" type="${escapeHtml(firstVideo.contentType)}"></video></div>`;
	} else if (audios.length > 0) {
		mediaEmbedHtml = `<div style="margin-top:10px;"><audio controls style="width:100%;" src="${escapeHtml(audios[0].url)}"></audio></div>`;
	}

	json.html = `<blockquote class="nyaitter-embed" style="max-width:540px;margin:12px auto;padding:16px;background:#ffffff;border:1px solid #e1e8ed;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(authorName)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;" />` : ''}
        <div>
            <div style="font-weight:700;font-size:15px;color:#111;"><a href="${escapeHtml(authorUrl)}" style="color:inherit;text-decoration:none;">${escapeHtml(authorName)}</a></div>
            ${userDisplayId ? `<div style="font-size:13px;color:#657786;">${escapeHtml(userDisplayId)}</div>` : ''}
        </div>
    </div>
    <div style="font-size:15px;line-height:1.5;word-break:break-word;">${decoratedHtml}</div>
    ${mediaEmbedHtml}
    <div style="margin-top:12px;padding-top:8px;border-top:1px solid #f0f3f5;font-size:12px;color:#888;display:flex;justify-content:space-between;align-items:center;">
        <span>Nyaitter</span>
        <a href="${escapeHtml(postUrl || publicUrl)}" target="_blank" rel="noopener noreferrer" style="color:#79529c;text-decoration:none;font-weight:600;">Nyaitterで表示</a>
    </div>
</blockquote>`;

	return json;
}

function generatePostHtml({ post, author, publicUrl, frontendUrl = null }) {
	const ogpTags = generatePostOgpTags({ post, author, publicUrl });
	const authorName = author?.name || 'Unknown User';
	const userDisplayId = formatUserDisplayId(author);
	const avatarUrl = resolveAuthorAvatar(author, publicUrl);
	const { images, videos, audios } = extractMediaAttachments(post?.attachments, publicUrl);

	const content = post?.mask ? '🔒 [この投稿はマスクされています]' : (post?.content || '');
	const decoratedContentHtml = renderDecoratedContentHtml(content, publicUrl);
	const safeAuthor = escapeHtml(authorName);
	const safeDisplayId = escapeHtml(userDisplayId);
	const postId = Number(post?.id);

	let mediaHtml = '';
	if (images.length === 1) {
		mediaHtml = `
        <div class="media-single" style="margin-top:14px;">
            <img src="${escapeHtml(images[0].url)}" alt="attachment" style="max-width:100%;max-height:520px;border-radius:10px;object-fit:contain;background:#f3f4f6;" />
        </div>`;
	} else if (images.length > 1) {
		const gridImages = images.map((img) => `
            <div style="position:relative;width:100%;padding-top:75%;overflow:hidden;border-radius:8px;background:#f3f4f6;">
                <img src="${escapeHtml(img.url)}" alt="attachment" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;" />
            </div>`).join('');
		mediaHtml = `
        <div class="media-grid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:14px;">
            ${gridImages}
        </div>`;
	}

	for (const vid of videos) {
		mediaHtml += `
        <div class="media-video" style="margin-top:14px;">
            <video controls preload="metadata" style="max-width:100%;max-height:500px;border-radius:10px;background:#000;" src="${escapeHtml(vid.url)}"></video>
        </div>`;
	}

	for (const aud of audios) {
		mediaHtml += `
        <div class="media-audio" style="margin-top:12px;">
            <audio controls style="width:100%;" src="${escapeHtml(aud.url)}"></audio>
        </div>`;
	}

	return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${ogpTags}
    <script>
        (function() {
            var postId = ${JSON.stringify(postId)};
            var explicitFrontend = ${JSON.stringify(frontendUrl || '')};
            var targetUrl = '';
            if (explicitFrontend) {
                targetUrl = explicitFrontend.replace(/\\/+$/, '') + '/#post/' + postId;
            } else {
                var hostname = window.location.hostname.replace(/^(?:link|api)\\./i, '');
                var portSuffix = (window.location.port && window.location.port !== '80' && window.location.port !== '443' && window.location.port !== '3005') ? (':' + window.location.port) : '';
                targetUrl = window.location.protocol + '//' + hostname + portSuffix + '/#post/' + postId;
            }
            if (targetUrl) {
                window.location.replace(targetUrl);
            }
        })();
    </script>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; max-width: 600px; margin: 30px auto; padding: 16px; color: #222; line-height: 1.6; background-color: #f7f9fa; }
        .card { border: 1px solid #e1e8ed; border-radius: 16px; padding: 24px; background: #fff; box-shadow: 0 4px 14px rgba(0,0,0,0.06); }
        .header { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
        .avatar { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background: #eee; flex-shrink: 0; }
        .user-info { display: flex; flex-direction: column; overflow: hidden; }
        .author { font-weight: 700; font-size: 1.1em; color: #111; text-decoration: none; }
        .handle { color: #657786; font-size: 0.9em; margin-top: 1px; }
        .content { font-size: 1.05em; line-height: 1.6; word-break: break-word; margin-top: 10px; }
        .content a { color: #79529c; text-decoration: none; }
        .content a:hover { text-decoration: underline; }
        .footer { margin-top: 22px; font-size: 0.9em; color: #888; border-top: 1px solid #f0f3f5; padding-top: 14px; display: flex; justify-content: space-between; align-items: center; }
        .footer a { color: #79529c; text-decoration: none; font-weight: 600; }
        .footer a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="card">
        <div class="header">
            ${avatarUrl ? `<img class="avatar" src="${escapeHtml(avatarUrl)}" alt="${safeAuthor}" />` : ''}
            <div class="user-info">
                <div class="author">${safeAuthor}</div>
                ${safeDisplayId ? `<div class="handle">${safeDisplayId}</div>` : ''}
            </div>
        </div>
        <div class="content">${decoratedContentHtml}</div>
        ${mediaHtml}
        <div class="footer">
            <span>Nyaitter</span>
            <a id="redirectLink" href="${escapeHtml(publicUrl || '')}/#post/${postId}">Nyaitterで開く</a>
        </div>
    </div>
</body>
</html>`;
}

module.exports = {
	isCrawler,
	generatePostOgpTags,
	generatePostHtml,
	generateOembedJson,
	renderDecoratedContentHtml,
	resolveAuthorAvatar,
	formatUserDisplayId,
	extractMediaAttachments,
	escapeHtml,
};
