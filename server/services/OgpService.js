'use strict';

/**
 * Service for generating Open Graph Protocol (OGP) tags, HTML meta embeds,
 * and oEmbed responses for Discord, Twitter, and other platforms.
 */

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
		.replace(/"/g, '&quot;');
}

function resolveMediaUrl(raw, publicUrl) {
	if (!raw || typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (/^https?:\/\//i.test(trimmed)) return trimmed;

	const base = (publicUrl || '').replace(/\/+$/, '');
	const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
	return `${base}${path}`;
}

function resolveAuthorAvatar(author, publicUrl) {
	if (!author) return null;
	if (author.icon_data) {
		const resolved = resolveMediaUrl(author.icon_data, publicUrl);
		if (resolved) return resolved;
	}
	if (author.id != null) {
		const base = (publicUrl || '').replace(/\/+$/, '');
		return `${base}/api/users/${encodeURIComponent(String(author.id))}/icon`;
	}
	return null;
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
	if (!Array.isArray(attachments)) return { images, videos };

	for (const att of attachments) {
		const rawUrl = att.url || (att.id ? `/user_files/${encodeURIComponent(att.id)}` : null);
		const fullUrl = resolveMediaUrl(rawUrl, publicUrl);
		if (!fullUrl) continue;

		if (isVideoAttachment(att)) {
			videos.push({
				url: fullUrl,
				contentType: att.contentType || (fullUrl.endsWith('.webm') ? 'video/webm' : 'video/mp4'),
			});
		} else if (isImageAttachment(att) || !att.type) {
			images.push({
				url: fullUrl,
				contentType: att.contentType || 'image/jpeg',
			});
		}
	}
	return { images, videos };
}

function generatePostOgpTags({ post, author, publicUrl }) {
	const authorName = author?.name || 'Unknown User';
	const userDisplayId = formatUserDisplayId(author);
	const title = userDisplayId ? `${authorName} (${userDisplayId}) on Nyaitter` : `${authorName} on Nyaitter`;

	let description = post?.content || '';
	if (post?.mask) {
		description = '🔒 [この投稿はマスクされています]';
	} else if (!description && post?.attachments?.length > 0) {
		description = `[添付ファイル ${post.attachments.length}件]`;
	}
	if (!description) {
		description = 'Nyaitterのポスト';
	}

	const postUrl = `${publicUrl}/posts/${post?.id}`;
	const avatarUrl = resolveAuthorAvatar(author, publicUrl);
	const { images, videos } = extractMediaAttachments(post?.attachments, publicUrl);

	const firstImage = images[0]?.url || null;
	const firstVideo = videos[0] || null;

	const ogImage = firstImage || avatarUrl || `${publicUrl}/logo.png`;
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

	return `
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="theme-color" content="${themeColor}" />

    <!-- Open Graph / Facebook -->
    <meta property="og:type" content="${firstVideo ? 'video.other' : 'article'}" />
    <meta property="og:site_name" content="Nyaitter" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(postUrl)}" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />
${videoTags}
    <!-- Twitter -->
    <meta name="twitter:card" content="${twitterCard}" />
    <meta name="twitter:site" content="@Nyaitter" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(ogImage)}" />

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

	const { images, videos } = extractMediaAttachments(post?.attachments, publicUrl);
	const firstImage = images[0]?.url || null;
	const firstVideo = videos[0] || null;

	const json = {
		version: '1.0',
		type: firstVideo ? 'video' : (firstImage ? 'photo' : 'rich'),
		provider_name: 'Nyaitter',
		provider_url: publicUrl,
		author_name: fullAuthorTitle,
		author_url: authorUrl,
		author_icon_url: avatarUrl,
		title: post?.content ? post.content.slice(0, 100) : 'Nyaitter Post',
	};

	if (firstVideo) {
		json.html = `<video controls width="100%" poster="${escapeHtml(firstImage || avatarUrl || '')}"><source src="${escapeHtml(firstVideo.url)}" type="${escapeHtml(firstVideo.contentType)}"></video>`;
		json.width = 1280;
		json.height = 720;
		if (firstImage || avatarUrl) {
			json.thumbnail_url = firstImage || avatarUrl;
		}
	} else if (firstImage) {
		json.url = firstImage;
		json.width = 1200;
		json.height = 630;
		json.thumbnail_url = firstImage;
	} else {
		json.html = `<blockquote><p>${escapeHtml(post?.content || '')}</p>&mdash; ${escapeHtml(fullAuthorTitle)} <a href="${escapeHtml(postUrl)}">${escapeHtml(postUrl)}</a></blockquote>`;
		if (avatarUrl) {
			json.thumbnail_url = avatarUrl;
		}
	}

	return json;
}

function generatePostHtml({ post, author, publicUrl, frontendUrl = null }) {
	const ogpTags = generatePostOgpTags({ post, author, publicUrl });
	const authorName = author?.name || 'Unknown User';
	const userDisplayId = formatUserDisplayId(author);
	const avatarUrl = resolveAuthorAvatar(author, publicUrl);
	const { images, videos } = extractMediaAttachments(post?.attachments, publicUrl);

	const content = post?.mask ? '🔒 [この投稿はマスクされています]' : (post?.content || '');
	const safeContent = escapeHtml(content);
	const safeAuthor = escapeHtml(authorName);
	const safeDisplayId = escapeHtml(userDisplayId);
	const postId = Number(post?.id);

	let mediaHtml = '';
	for (const img of images) {
		mediaHtml += `<div style="margin-top:12px;"><img src="${escapeHtml(img.url)}" alt="attachment" style="max-width:100%; border-radius:8px;" /></div>`;
	}
	for (const vid of videos) {
		mediaHtml += `<div style="margin-top:12px;"><video controls style="max-width:100%; border-radius:8px;" src="${escapeHtml(vid.url)}"></video></div>`;
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
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; color: #333; line-height: 1.6; background-color: #f7f9fa; }
        .card { border: 1px solid #e1e8ed; border-radius: 12px; padding: 24px; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
        .header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
        .avatar { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background: #eee; }
        .user-info { display: flex; flex-direction: column; }
        .author { font-weight: bold; font-size: 1.1em; }
        .handle { color: #657786; font-size: 0.9em; }
        .content { font-size: 1.05em; white-space: pre-wrap; word-break: break-word; margin-top: 8px; }
        .footer { margin-top: 20px; font-size: 0.9em; color: #888; border-top: 1px solid #eee; padding-top: 12px; }
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
        <div class="content">${safeContent}</div>
        ${mediaHtml}
        <div class="footer">Nyaitter • <a id="redirectLink" href="${escapeHtml(publicUrl || '')}">Nyaitterで開く</a></div>
    </div>
</body>
</html>`;
}

module.exports = {
	isCrawler,
	generatePostOgpTags,
	generatePostHtml,
	generateOembedJson,
	resolveAuthorAvatar,
	formatUserDisplayId,
	extractMediaAttachments,
	escapeHtml,
};
