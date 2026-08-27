const dns = require('dns').promises;
const https = require('https');
const net = require('net');
const { serializePost } = require('../utils/serialize');

const MAX_URL_LENGTH = 2048;
const MAX_HTML_BYTES = 128 * 1024;
const MAX_OEMBED_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;
const cardCache = new Map();

const urlCardAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 30,
  maxFreeSockets: 5,
  timeout: REQUEST_TIMEOUT_MS,
});

const cachePruner = setInterval(() => {
  pruneCardCache(Date.now());
}, 60000);
cachePruner.unref();

const OEMBED_JSON_TYPES = new Set([
  'application/json+oembed',
  'application/json',
  'text/json',
  'application/javascript',
  'text/javascript',
]);

const KNOWN_OEMBED_PROVIDERS = [
  { domains: ['youtube.com', 'youtu.be'], endpoint: 'https://www.youtube.com/oembed' },
  { domains: ['vimeo.com'], endpoint: 'https://vimeo.com/api/oembed.json' },
  { domains: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'], endpoint: 'https://www.tiktok.com/oembed' },
  { domains: ['soundcloud.com', 'on.soundcloud.com'], endpoint: 'https://soundcloud.com/oembed' },
  { domains: ['flickr.com', 'flic.kr'], endpoint: 'https://www.flickr.com/services/oembed/' },
  { domains: ['reddit.com', 'redd.it'], endpoint: 'https://www.reddit.com/oembed' },
  { domains: ['tumblr.com'], endpoint: 'https://www.tumblr.com/oembed/1.0' },
  { domains: ['codepen.io'], endpoint: 'https://codepen.io/api/oembed' },
  { domains: ['speakerdeck.com'], endpoint: 'https://speakerdeck.com/oembed.json' },
  { domains: ['mixcloud.com'], endpoint: 'https://www.mixcloud.com/oembed/' },
  { domains: ['dailymotion.com', 'dai.ly'], endpoint: 'https://www.dailymotion.com/services/oembed' },
  { domains: ['spotify.com', 'spotify.link'], endpoint: 'https://open.spotify.com/oembed' },
  { domains: ['twitter.com', 'x.com', 't.co'], endpoint: 'https://publish.twitter.com/oembed' },
  { domains: ['slideshare.net'], endpoint: 'https://www.slideshare.net/api/oembed/2' },
  { domains: ['sketchfab.com'], endpoint: 'https://sketchfab.com/oembed' },
  { domains: ['giphy.com'], endpoint: 'https://giphy.com/services/oembed' },
  { domains: ['pinterest.com', 'pin.it'], endpoint: 'https://www.pinterest.com/oembed.json' },
  { domains: ['imgur.com'], endpoint: 'https://api.imgur.com/oembed.json' },
  { domains: ['streamable.com'], endpoint: 'https://api.streamable.com/oembed.json' },
];

function isPrivateIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  );
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !isPrivateIpv4(address);
  if (family !== 6) return false;

  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    return !isPrivateIpv4(normalized.slice('::ffff:'.length));
  }
  return !(
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff')
  );
}

function decodeUrlEntities(value) {
  return String(value || '')
    .replace(/&amp;|&#0*38;|&#x0*26;/gi, '&');
}

function normalizeTargetUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return null;
  }
  const decodedValue = decodeUrlEntities(value);
  if (/[\u0000-\u001F\u007F]/.test(decodedValue)) return null;

  try {
    const target = new URL(decodedValue);
    const hostname = target.hostname.toLowerCase().replace(/\.$/, '');
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      (target.port && target.port !== '443') ||
      !hostname ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost')
    ) {
      return null;
    }
    target.hostname = hostname;
    target.hash = '';
    return target;
  } catch (_) {
    return null;
  }
}

async function resolvePublicAddresses(hostname) {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0 || records.length > 16) {
    throw new Error('URL host could not be resolved');
  }
  if (records.some((record) => !isPublicAddress(record.address))) {
    throw new Error('URL host resolves to a non-public address');
  }
  return records;
}

function readAttribute(tag, name) {
  const unquotedValue = `[^\\s"'=<>${String.fromCharCode(96)}]+`;
  const expression = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(${unquotedValue}))`,
    'i',
  );
  const match = expression.exec(tag);
  return match ? match[1] ?? match[2] ?? match[3] ?? '' : '';
}

function decodeHtmlText(value, maximumLength) {
  const decoded = String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const parsed = String(code).toLowerCase().startsWith('x')
        ? Number.parseInt(String(code).slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0x10ffff
        ? String.fromCodePoint(parsed)
        : '';
    })
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return decoded.slice(0, maximumLength);
}

function findMetaContent(html, acceptedKeys, maximumLength = 280) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = (readAttribute(tag, 'property') || readAttribute(tag, 'name')).toLowerCase();
    if (!acceptedKeys.has(key)) continue;
    const content = decodeHtmlText(readAttribute(tag, 'content'), maximumLength);
    if (content) return content;
  }
  return '';
}

function firstText(values, maximumLength) {
  for (const value of values) {
    const text = decodeHtmlText(value, maximumLength);
    if (text) return text;
  }
  return '';
}

function getJsonLdNodes(value, nodes = [], depth = 0) {
  if (depth > 4 || value === null || value === undefined) return nodes;
  if (Array.isArray(value)) {
    value.forEach((entry) => getJsonLdNodes(entry, nodes, depth + 1));
    return nodes;
  }
  if (typeof value !== 'object') return nodes;
  nodes.push(value);
  if (value['@graph']) getJsonLdNodes(value['@graph'], nodes, depth + 1);
  if (value.mainEntity) getJsonLdNodes(value.mainEntity, nodes, depth + 1);
  return nodes;
}

function getJsonLdName(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return getJsonLdName(value[0]);
  if (value && typeof value === 'object') return value.name || value.headline || '';
  return '';
}

function parseJsonLdMetadata(html) {
  const nodes = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = scriptPattern.exec(html)) !== null) {
    const type = readAttribute(`<script ${match[1]}>`, 'type').toLowerCase();
    if (type !== 'application/ld+json') continue;
    try {
      getJsonLdNodes(JSON.parse(match[2]), nodes);
    } catch (_) {
      // JSON-LD is optional metadata. Invalid blocks are ignored.
    }
  }

  for (const node of nodes) {
    const type = Array.isArray(node['@type']) ? node['@type'].join(' ') : String(node['@type'] || '');
    if (/BreadcrumbList|WebSite|Organization|Person/i.test(type)) continue;
    const title = firstText([node.headline, node.name, node.title], 160);
    const description = firstText([node.description, node.abstract], 280);
    const siteName = firstText([
      getJsonLdName(node.publisher),
      getJsonLdName(node.sourceOrganization),
      getJsonLdName(node.author),
    ], 100);
    if (title || description || siteName) return { title, description, siteName };
  }
  return { title: '', description: '', siteName: '' };
}

function parseCardMetadata(html, targetUrl) {
  const titleTag = /<title\b[^>]*>([\s\S]{0,4096}?)<\/title\s*>/i.exec(html);
  const jsonLd = parseJsonLdMetadata(html);
  const title = firstText([
    findMetaContent(html, new Set(['og:title', 'twitter:title']), 160),
    jsonLd.title,
    titleTag?.[1],
    targetUrl.hostname,
  ], 160);
  const description = firstText([
    findMetaContent(html, new Set(['og:description', 'twitter:description', 'description']), 280),
    jsonLd.description,
  ], 280);
  const siteName = firstText([
    findMetaContent(html, new Set(['og:site_name', 'twitter:site', 'application-name']), 100),
    jsonLd.siteName,
  ], 100);
  return {
    url: targetUrl.href,
    hostname: targetUrl.hostname,
    title,
    description,
    site_name: siteName,
  };
}

function hasRelation(tag, relation) {
  return readAttribute(tag, 'rel')
    .toLowerCase()
    .split(/\s+/)
    .includes(relation);
}

function isJsonOEmbedType(value) {
  return OEMBED_JSON_TYPES.has(String(value || '').toLowerCase().split(';')[0].trim());
}

function resolveOEmbedEndpoint(value, baseUrl) {
  try {
    return normalizeTargetUrl(new URL(value, baseUrl).href);
  } catch (_) {
    return null;
  }
}

function findOEmbedEndpointInHtml(html, targetUrl) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!hasRelation(tag, 'alternate') || !isJsonOEmbedType(readAttribute(tag, 'type'))) continue;
    const endpoint = resolveOEmbedEndpoint(readAttribute(tag, 'href'), targetUrl);
    if (endpoint) return endpoint;
  }
  return null;
}

function findOEmbedEndpointInLinkHeader(linkHeader, targetUrl) {
  const value = Array.isArray(linkHeader) ? linkHeader.join(',') : String(linkHeader || '');
  const expression = /<([^>]+)>((?:\s*;\s*[^,]+)*)/g;
  let match;
  while ((match = expression.exec(value)) !== null) {
    const parameters = match[2];
    const rel = /;\s*rel\s*=\s*"?([^";,]+)"?/i.exec(parameters)?.[1] || '';
    const type = /;\s*type\s*=\s*"?([^";,]+)"?/i.exec(parameters)?.[1] || '';
    if (!rel.toLowerCase().split(/\s+/).includes('alternate') || !isJsonOEmbedType(type)) continue;
    const endpoint = resolveOEmbedEndpoint(match[1], targetUrl);
    if (endpoint) return endpoint;
  }
  return null;
}

function buildKnownOEmbedEndpoint(targetUrl) {
  const hostname = targetUrl.hostname.toLowerCase();
  const provider = KNOWN_OEMBED_PROVIDERS.find(({ domains }) =>
    domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)),
  );
  if (!provider) return null;

  const endpoint = new URL(provider.endpoint);
  endpoint.searchParams.set('url', targetUrl.href);
  endpoint.searchParams.set('format', 'json');
  return normalizeTargetUrl(endpoint.href);
}

function isExpectedContentType(contentType, type) {
  const normalized = String(contentType || '').toLowerCase();
  if (type === 'html') {
    return /(^|\/)html(?:;|$)|application\/xhtml\+xml/.test(normalized);
  }
  return isJsonOEmbedType(normalized);
}

function fetchResource(targetUrl, { type, maxBytes, redirectCount = 0 }) {
  return resolvePublicAddresses(targetUrl.hostname).then((addresses) => {
    const address = addresses[0];
    return new Promise((resolve, reject) => {
      let completed = false;
      const finish = (callback) => (value) => {
        if (completed) return;
        completed = true;
        callback(value);
      };
      const request = https.request(
        {
          protocol: 'https:',
          hostname: targetUrl.hostname,
          port: 443,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: 'GET',
          agent: urlCardAgent,
          headers: {
            Accept: type === 'html'
              ? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1'
              : 'application/json,application/json+oembed;q=0.9,text/json;q=0.8,*/*;q=0.1',
            'Accept-Encoding': 'identity',
            'User-Agent': 'Nyaitter-URLCard/1.0',
            Range: `bytes=0-${maxBytes - 1}`,
          },
          servername: targetUrl.hostname,
          lookup: (_hostname, options, callback) => {
            // Node.jsのautoSelectFamilyはlookupへall:trueを渡す。
            // 単一値だけ返すとERR_INVALID_IP_ADDRESSになり、oEmbed取得全体がnullへ後退する。
            if (options?.all) {
              callback(null, [{ address: address.address, family: address.family }]);
              return;
            }
            callback(null, address.address, address.family);
          },
        },
        (response) => {
          const status = Number(response.statusCode || 0);
          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            if (redirectCount >= MAX_REDIRECTS) {
              finish(reject)(new Error('Too many redirects'));
              return;
            }
            const redirected = normalizeTargetUrl(
              new URL(response.headers.location, targetUrl).href,
            );
            if (!redirected) {
              finish(reject)(new Error('Unsafe redirect target'));
              return;
            }
            fetchResource(redirected, { type, maxBytes, redirectCount: redirectCount + 1 }).then(
              finish(resolve),
              finish(reject),
            );
            return;
          }

          const contentType = response.headers['content-type'];
          if (status < 200 || status >= 300 || !isExpectedContentType(contentType, type)) {
            response.resume();
            finish(reject)(new Error('Unexpected target content type'));
            return;
          }

          const chunks = [];
          let totalBytes = 0;
          response.on('data', (chunk) => {
            if (completed) return;
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
              response.destroy();
              finish(reject)(new Error('Remote response is too large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', finish(() => {
            resolve({
              targetUrl,
              headers: response.headers,
              body: Buffer.concat(chunks, totalBytes).toString('utf8'),
            });
          }));
          response.on('error', finish(reject));
        },
      );
      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error('URL card request timed out'));
      });
      request.on('error', finish(reject));
      request.end();
    });
  });
}

async function getOEmbedCard(endpoint, sourceUrl) {
  if (!endpoint) return null;
  try {
    const { body } = await fetchResource(endpoint, {
      type: 'json',
      maxBytes: MAX_OEMBED_BYTES,
    });
    const payload = JSON.parse(body);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const title = firstText([payload.title, payload.author_name, payload.provider_name], 160);
    const description = firstText([payload.description, payload.author_name], 280);
    const siteName = firstText([payload.provider_name, payload.provider_url], 100);
    if (!title && !description && !siteName) return null;
    return {
      url: sourceUrl.href,
      hostname: sourceUrl.hostname,
      title,
      description,
      site_name: siteName,
    };
  } catch (_) {
    return null;
  }
}

function mergeCards(primary, fallback) {
  if (!fallback) return primary;
  return {
    url: primary.url,
    hostname: primary.hostname,
    title: fallback.title || primary.title,
    description: fallback.description || primary.description,
    site_name: fallback.site_name || primary.site_name,
  };
}

function pruneCardCache(now) {
  for (const [key, entry] of cardCache) {
    if (!entry || entry.expiresAt <= now) cardCache.delete(key);
  }
  while (cardCache.size > MAX_CACHE_ENTRIES) {
    cardCache.delete(cardCache.keys().next().value);
  }
}

function extractNyaitterPostIdFromRawString(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const match = raw.match(/(?:#post\/|\/posts\/|\?post=)(\d+)/i) ||
                raw.match(/\/@[^/\s]+\/posts\/(\d+)/i);
  if (match && match[1]) {
    const id = Number(match[1]);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

async function getUrlCard(value, context = {}) {
  const now = Date.now();
  pruneCardCache(now);

  // 1. Check if raw URL/path matches a Nyaitter post and can be resolved via database
  const detectedPostId = extractNyaitterPostIdFromRawString(value);
  if (detectedPostId && context.db && typeof context.db.getPostById === 'function') {
    try {
      const post = await context.db.getPostById(detectedPostId);
      if (post) {
        const serialized = await serializePost(
          context.db,
          post,
          context.currentUserId || null,
          0,
          context.publicUrl || null,
          context.knownViewer || null,
        );
        if (serialized) {
          const cacheKey = `nyaitter:${detectedPostId}:${context.currentUserId || 0}`;
          const postCard = {
            type: 'nyaitter_post',
            url: value,
            post_id: Number(post.id),
            post: serialized,
          };
          cardCache.set(cacheKey, { card: postCard, expiresAt: now + CACHE_TTL_MS });
          pruneCardCache(now);
          return postCard;
        }
      }
    } catch (_) {}
  }

  const targetUrl = normalizeTargetUrl(value);
  if (!targetUrl) return null;

  const cacheKey = `${targetUrl.href}:${context.currentUserId || 0}`;
  const cached = cardCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.card;

  // 2. Standard remote URL resolution (oEmbed / Open Graph)
  let card = await getOEmbedCard(buildKnownOEmbedEndpoint(targetUrl), targetUrl);
  if (!card) {
    try {
      const { body, headers, targetUrl: finalUrl } = await fetchResource(targetUrl, {
        type: 'html',
        maxBytes: MAX_HTML_BYTES,
      });
      card = parseCardMetadata(body, finalUrl);
      const discoveredEndpoint =
        findOEmbedEndpointInLinkHeader(headers.link, finalUrl) ||
        findOEmbedEndpointInHtml(body, finalUrl);
      card = mergeCards(card, await getOEmbedCard(discoveredEndpoint, finalUrl));
    } catch (_) {
      return null;
    }
  }

  if (card && !card.type) {
    card.type = 'link';
  }

  cardCache.set(cacheKey, { card, expiresAt: now + CACHE_TTL_MS });
  pruneCardCache(now);
  return card;
}

module.exports = {
  getUrlCard,
  extractNyaitterPostIdFromRawString,
};
