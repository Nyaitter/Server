function invalid(message) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
}

function parseDate(value, operator) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(`${operator}: は YYYY-MM-DD で指定してください`);
    const time = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid(`${operator}: の日付が正しくありません`);
    return time;
}

function parsePostSearchQuery(query) {
    const input = String(query || '').trim();
    const tokens = [];
    const pattern = /(-?\w+:)?"((?:\\.|[^"\\])*)"|(\S+)/g;
    let match;
    while ((match = pattern.exec(input))) {
        const raw = match[3] ?? `${match[1] || ''}${match[2].replace(/\\(["\\])/g, '$1')}`;
        const operator = (match[2] != null && !match[1]) ? null : /^(-?)(from|at|since|until|has|is):([\s\S]*)$/i.exec(raw);
        if (!operator) {
            tokens.push({ type: 'text', value: raw, quoted: match[2] != null });
            continue;
        }
        const [, negative, key, value] = operator;
        if (!value) invalid(`${key}: の値を指定してください`);
        const type = key.toLowerCase();
        if (negative && ['at', 'since', 'until'].includes(type)) invalid(`-${type}: は利用できません`);
        if (['at', 'since', 'until'].includes(type)) parseDate(value, type);
        if (type === 'has' && !['media', 'links', 'link'].includes(value.toLowerCase())) invalid('has: は media または links を指定してください');
        if (type === 'is' && !['reply', 'repost', 'quote'].includes(value.toLowerCase())) invalid('is: は reply、repost、quote を指定してください');
        tokens.push({ type, value, negative: Boolean(negative) });
    }
    // 演算子のない検索は既存のあいまい検索を維持する。
    const advanced = tokens.some(token => token.type !== 'text' || token.quoted);
    if ((input.match(/(?<!\\)"/g) || []).length % 2) invalid('引用符を閉じてください');
    return { advanced, tokens };
}

async function resolvePostSearchQuery(db, query) {
    const parsed = parsePostSearchQuery(query);
    if (!parsed.advanced) return null;
    for (const token of parsed.tokens) {
        if (token.type !== 'from') continue;
        const identifier = token.value.replace(/^@/, '');
        const numeric = identifier.replace(/^#/, '');
        let user = null;
        if (/^\d+$/.test(numeric) && Number.isSafeInteger(Number(numeric))) {
            user = await db.getUserById(Number(numeric));
        } else {
            user = await db.getUserByScid(identifier);
        }
        token.userId = user ? Number(user.id) : -1;
    }
    return parsed;
}

function matchesPostSearch(post, search) {
    const content = String(post.content || '').toLowerCase();
    const view = String(post.viewContent ?? post.view_content ?? post.content ?? '').toLowerCase();
    let tags = post.tags;
    if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = []; } }
    tags = Array.isArray(tags) ? tags.map(tag => String(tag).toLowerCase()) : [];
    const time = new Date(post.createdAt ?? post.created_at).getTime();
    return search.tokens.every(token => {
        let result = true;
        const value = token.value.toLowerCase();
        switch (token.type) {
            case 'text': return [content, view, ...tags].some(text => text.includes(value));
            case 'from': result = Number(post.userId ?? post.user_id) === token.userId; break;
            case 'at': result = time >= parseDate(value, 'at') && time < parseDate(value, 'at') + 86400000; break;
            case 'since': result = time >= parseDate(value, 'since'); break;
            case 'until': result = time < parseDate(value, 'until'); break;
            case 'has': {
                let attachments = post.attachments;
                if (typeof attachments === 'string') { try { attachments = JSON.parse(attachments); } catch { attachments = []; } }
                result = value === 'media' ? Array.isArray(attachments) && attachments.length > 0 : /https?:\/\//i.test(content);
                break;
            }
            case 'is': {
                const reply = post.replyTo ?? post.reply_to;
                const repost = post.repostTo ?? post.repost_to;
                result = value === 'reply' ? reply != null : value === 'quote' ? repost != null && content.trim() !== '' : repost != null && content.trim() === '';
                break;
            }
        }
        return token.negative ? !result : result;
    });
}

function buildPostSearchSql(search, { dialect = 'postgres', values = [], alias = '' } = {}) {
    const bind = value => { values.push(value); return dialect === 'postgres' ? `$${values.length}` : '?'; };
    const clauses = [];
    const text = column => `LOWER(COALESCE(CAST(${column} AS TEXT), ''))`;
    const date = dialect === 'postgres' ? 'created_at' : 'julianday(created_at)';
    const dateValue = time => dialect === 'postgres' ? bind(new Date(time).toISOString()) : `julianday(${bind(new Date(time).toISOString())})`;
    for (const token of search.tokens) {
        const value = token.value.toLowerCase();
        let clause;
        switch (token.type) {
            case 'text': {
                const needle = `%${value.replace(/[\\%_]/g, '\\$&')}%`;
                const fields = ['content', 'view_content'].map(column => `${text(column)} LIKE ${bind(needle)} ESCAPE '\\'`);
                const tagSource = dialect === 'postgres'
                    ? "jsonb_array_elements_text(CASE WHEN jsonb_typeof(tags::jsonb) = 'array' THEN tags::jsonb ELSE '[]'::jsonb END)"
                    : "json_each(CASE WHEN json_type(tags) = 'array' THEN tags ELSE '[]' END)";
                fields.push(`EXISTS (SELECT 1 FROM ${tagSource} AS search_tag WHERE LOWER(search_tag.value) LIKE ${bind(needle)} ESCAPE '\\')`);
                clause = `(${fields.join(' OR ')})`;
                break;
            }
            case 'from': clause = `user_id = ${bind(token.userId)}`; break;
            case 'at': clause = `(${date} >= ${dateValue(parseDate(value, 'at'))} AND ${date} < ${dateValue(parseDate(value, 'at') + 86400000)})`; break;
            case 'since': clause = `${date} >= ${dateValue(parseDate(value, 'since'))}`; break;
            case 'until': clause = `${date} < ${dateValue(parseDate(value, 'until'))}`; break;
            case 'has': clause = value === 'media'
                ? (dialect === 'postgres' ? "CASE WHEN jsonb_typeof(attachments::jsonb) = 'array' THEN jsonb_array_length(attachments::jsonb) > 0 ELSE FALSE END" : "COALESCE(json_array_length(attachments), 0) > 0")
                : `(${text('content')} LIKE '%https://%' OR ${text('content')} LIKE '%http://%')`; break;
            case 'is': clause = value === 'reply' ? 'reply_to IS NOT NULL' : value === 'quote'
                ? "(repost_to IS NOT NULL AND TRIM(COALESCE(content, '')) <> '')"
                : "(repost_to IS NOT NULL AND TRIM(COALESCE(content, '')) = '')"; break;
        }
        if (clause) clauses.push(token.negative ? `NOT (${clause})` : clause);
    }
    return { clauses: alias ? clauses.map(clause => clause.replace(/\b(created_at|user_id|content|view_content|tags|attachments|reply_to|repost_to)\b/g, column => `${alias}.${column}`)) : clauses, values };
}

module.exports = { parsePostSearchQuery, resolvePostSearchQuery, matchesPostSearch, buildPostSearchSql };
