// Pocket·Instapaper CSV·북마크 HTML·Pocket HTML 변환 (plan 4-5, fixtures/FORMATS.md)

import { parseCsv, rowsToObjects } from './csv.js';
import { matchKey, isHttpUrl } from './url.js';
import { BODY_STATE, LOCATION, READ_STATE, SOURCE } from './model.js';

const POCKET_COLS = ['title', 'url', 'time_added', 'tags', 'status'];
const INSTAPAPER_REQUIRED = ['URL', 'Title', 'Folder'];

/**
 * @param {string} text
 */
export function detectImportFormat(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return 'unknown';

  const lower = trimmed.slice(0, 800).toLowerCase();
  if (lower.includes('<h1>unread</h1>') || lower.includes('<h1>read archive</h1>')) {
    return 'pocket_html';
  }
  if (lower.includes('<!doctype netscape-bookmark-file') || lower.includes('<dl')) {
    return 'bookmarks';
  }

  const firstLine = trimmed.split(/\r?\n/)[0];
  if (firstLine.includes(',')) {
    try {
      const rows = parseCsv(`${firstLine}\n`);
      const headers = (rows[0] || []).map((h) => h.trim());
      const hset = new Set(headers);
      if (POCKET_COLS.every((h) => hset.has(h))) return 'pocket';
      if (INSTAPAPER_REQUIRED.every((h) => hset.has(h))) return 'instapaper';
    } catch {
      /* fall through */
    }
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.schemaVersion != null && Array.isArray(parsed.articles)) return 'backup';
    } catch {
      if (trimmed.includes('"schemaVersion"') && trimmed.includes('"articles"')) return 'backup';
    }
  }

  return 'unknown';
}

/**
 * @param {number} raw
 */
function parseUnixMs(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return Date.now();
  const digits = String(Math.trunc(raw)).length;
  if (digits >= 13) return Math.trunc(raw);
  return Math.trunc(raw) * 1000;
}

/**
 * @param {string} raw
 */
function parseInstapaperTags(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed === '[]') return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean);
  } catch {
    /* fall through */
  }
  return trimmed.split(',').map((t) => t.trim()).filter(Boolean);
}

/**
 * @param {Record<string, string>} row
 * @param {number} lineNo
 */
function pocketRowToArticle(row, lineNo) {
  const url = (row.url || '').trim();
  if (!isHttpUrl(url)) {
    return { error: { line: lineNo, reason: 'no_url', sample: row.title || url } };
  }

  const status = (row.status || '').toLowerCase();
  const tags = (row.tags || '')
    .split('|')
    .map((t) => t.trim())
    .filter(Boolean);

  const timeAdded = parseInt(row.time_added, 10);
  const savedAt = Number.isFinite(timeAdded) ? parseUnixMs(timeAdded) : Date.now();

  return {
    article: {
      url,
      matchKey: matchKey(url) || url,
      title: (row.title || '').trim() || url,
      tags,
      savedAt,
      updatedAt: savedAt,
      readState: READ_STATE.UNREAD,
      location: status === 'archive' ? LOCATION.ARCHIVE : LOCATION.INBOX,
      bodyState: BODY_STATE.NONE_IMPORTED,
      source: SOURCE.POCKET,
    },
  };
}

/**
 * @param {Record<string, string>} row
 * @param {number} lineNo
 */
function instapaperRowToArticle(row, lineNo) {
  const url = (row.URL || '').trim();
  if (!isHttpUrl(url)) {
    return { error: { line: lineNo, reason: 'no_url', sample: row.Title || url } };
  }

  const folder = (row.Folder || '').trim();
  const folderLower = folder.toLowerCase();
  let location = LOCATION.INBOX;
  let readState = READ_STATE.UNREAD;
  const tags = parseInstapaperTags(row.Tags);

  if (folderLower === 'archive') {
    location = LOCATION.ARCHIVE;
  } else if (folderLower === 'starred') {
    tags.push('starred');
  } else if (folder && folderLower !== 'unread') {
    tags.push(folder);
  }

  const ts = parseInt(row.Timestamp, 10);
  const savedAt = Number.isFinite(ts) ? parseUnixMs(ts) : Date.now();

  return {
    article: {
      url,
      matchKey: matchKey(url) || url,
      title: (row.Title || '').trim() || url,
      excerpt: (row.Selection || '').trim().slice(0, 200),
      tags: [...new Set(tags)],
      savedAt,
      updatedAt: savedAt,
      readState,
      location,
      bodyState: BODY_STATE.NONE_IMPORTED,
      source: SOURCE.INSTAPAPER,
    },
  };
}

/**
 * @param {string} html
 */
function parsePocketHtml(html) {
  const items = [];
  let line = 0;
  const sections = html.split(/<h1[^>]*>/i).slice(1);
  for (const chunk of sections) {
    const headingEnd = chunk.indexOf('</h1>');
    const heading = chunk.slice(0, headingEnd).replace(/<[^>]+>/g, '').trim().toLowerCase();
    const isArchive = heading.includes('archive');
    const rest = chunk.slice(headingEnd);
    const linkRe = /<a\s+([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(rest))) {
      line++;
      const url = m[2].trim();
      if (!isHttpUrl(url)) continue;
      const attrs = m[1] + m[3];
      const timeMatch = attrs.match(/time_added\s*=\s*["']?(\d+)/i);
      const timeAdded = timeMatch ? parseInt(timeMatch[1], 10) : 0;
      const savedAt = Number.isFinite(timeAdded) ? parseUnixMs(timeAdded) : Date.now();
      const tagsMatch = attrs.match(/tags\s*=\s*["']([^"']*)["']/i);
      const tags = (tagsMatch?.[1] || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const title = m[4].replace(/<[^>]+>/g, '').trim() || url;
      items.push({
        article: {
          url,
          matchKey: matchKey(url) || url,
          title,
          tags,
          savedAt,
          updatedAt: savedAt,
          readState: READ_STATE.UNREAD,
          location: isArchive ? LOCATION.ARCHIVE : LOCATION.INBOX,
          bodyState: BODY_STATE.NONE_IMPORTED,
          source: SOURCE.POCKET,
        },
        line,
      });
    }
  }
  return items;
}

/**
 * @param {number} raw
 */
function parseBookmarkDate(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return Date.now();
  return parseUnixMs(raw);
}

/**
 * @param {string} html
 */
function parseBookmarksHtml(html) {
  const items = [];
  const folderStack = [];
  let line = 0;
  const tokenRe = /<H3[^>]*>([^<]*)<\/H3>|<\/DL>|<A\s+([^>]*?)HREF\s*=\s*["']([^"']+)["']([^>]*)>([^<]*)<\/A>/gi;
  let m;
  while ((m = tokenRe.exec(html))) {
    if (m[1] !== undefined) {
      const name = m[1].trim();
      if (name && !/^bookmarks bar$/i.test(name)) folderStack.push(name);
      continue;
    }
    if (m[0].toUpperCase() === '</DL>') {
      if (folderStack.length) folderStack.pop();
      continue;
    }
    line++;
    const url = m[3].trim();
    if (!isHttpUrl(url)) continue;
    const attrs = (m[2] || '') + (m[4] || '');
    const title = (m[5] || '').trim() || url;
    const dateMatch = attrs.match(/ADD_DATE\s*=\s*["']?(\d+)/i);
    const addDate = dateMatch ? parseInt(dateMatch[1], 10) : 0;
    const savedAt = parseBookmarkDate(addDate);
    const tagsMatch = attrs.match(/TAGS\s*=\s*["']([^"']*)["']/i);
    const tags = [
      ...folderStack,
      ...(tagsMatch?.[1] || '').split(',').map((t) => t.trim()).filter(Boolean),
    ];
    items.push({
      article: {
        url,
        matchKey: matchKey(url) || url,
        title,
        tags: [...new Set(tags)],
        savedAt,
        updatedAt: savedAt,
        readState: READ_STATE.UNREAD,
        location: LOCATION.INBOX,
        bodyState: BODY_STATE.NONE_IMPORTED,
        source: SOURCE.BOOKMARKS,
      },
      line,
    });
  }
  return items;
}

/**
 * @param {string} text
 * @param {string} format
 * @param {Set<string>} existingKeys
 */
export function parseImportFile(text, format, existingKeys = new Set()) {
  const errors = [];
  const articles = [];
  let newCount = 0;
  let duplicateCount = 0;
  let candidateCount = 0;

  const classify = (article) => {
    const key = article.matchKey || matchKey(article.url);
    if (existingKeys.has(key)) {
      duplicateCount++;
      return 'duplicate';
    }
    const slashVariant = key?.endsWith('/') ? key.slice(0, -1) : `${key}/`;
    if (key && existingKeys.has(slashVariant)) {
      candidateCount++;
      return 'candidate';
    }
    newCount++;
    return 'new';
  };

  if (format === 'pocket' || format === 'instapaper') {
    let rows;
    try {
      rows = parseCsv(text);
    } catch (err) {
      return { format, errors: [{ line: 0, reason: err.message }], articles: [], stats: {} };
    }
    const { headers, records } = rowsToObjects(rows);
    const hset = new Set(headers);
    const expected = format === 'pocket' ? POCKET_COLS : INSTAPAPER_REQUIRED;
    if (expected.some((h) => !hset.has(h))) {
      return { format: 'unknown', errors: [{ line: 0, reason: 'bad_headers' }], articles: [], stats: {} };
    }

    records.forEach((row, idx) => {
      const lineNo = idx + 2;
      const parsed =
        format === 'pocket' ? pocketRowToArticle(row, lineNo) : instapaperRowToArticle(row, lineNo);
      if (parsed.error) {
        errors.push(parsed.error);
        return;
      }
      const kind = classify(parsed.article);
      articles.push({ ...parsed, kind });
    });
  } else if (format === 'pocket_html') {
    const items = parsePocketHtml(text);
    for (const item of items) {
      const kind = classify(item.article);
      articles.push({ article: item.article, kind, line: item.line });
    }
  } else if (format === 'bookmarks') {
    const items = parseBookmarksHtml(text);
    for (const item of items) {
      const kind = classify(item.article);
      articles.push({ article: item.article, kind, line: item.line });
    }
  } else if (format === 'backup') {
    return { format, errors: [{ line: 0, reason: 'use_restore' }], articles: [], stats: {} };
  } else {
    return { format: 'unknown', errors: [{ line: 0, reason: 'unsupported' }], articles: [], stats: {} };
  }

  return {
    format,
    errors,
    articles,
    stats: { newCount, duplicateCount, candidateCount, errorCount: errors.length },
  };
}

/**
 * @param {string} text
 * @param {Set<string>} existingKeys
 */
export function importPreview(text, existingKeys) {
  const format = detectImportFormat(text);
  if (format === 'unknown') {
    return { format, errors: [{ line: 0, reason: 'unsupported' }], articles: [], stats: {} };
  }
  if (format === 'backup') {
    return { format, errors: [{ line: 0, reason: 'use_restore' }], articles: [], stats: {} };
  }
  return parseImportFile(text, format, existingKeys);
}

/**
 * @param {string} a
 * @param {string} b
 */
export function isSlashDuplicateCandidate(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith('/') ? a.slice(0, -1) === b : `${a}/` === b;
}
