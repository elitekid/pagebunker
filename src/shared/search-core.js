// 검색 정규화·일치·구절 추출 (plan 4-4, Worker·UI 공용)

import { normalizeSearchText } from './model.js';

/** P4 실측 후 'bigram' 으로 교체 가능 — T4.3 */
export const SEARCH_INDEX_MODE = 'sequential';

const MAX_TERMS = 8;
const MAX_TERM_LEN = 100;
const PREVIEW_RADIUS = 40;

/**
 * @param {string} query
 * @returns {{phrases:string[],terms:string[]}}
 */
export function parseSearchQuery(query) {
  const raw = (query || '').trim();
  if (!raw) return { phrases: [], terms: [] };

  const phrases = [];
  const terms = [];
  const seen = new Set();
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const piece = (m[1] || m[2] || '').slice(0, MAX_TERM_LEN);
    const norm = normalizeSearchText(piece);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    if (m[1]) phrases.push(norm);
    else terms.push(norm);
    if (phrases.length + terms.length >= MAX_TERMS) break;
  }
  return { phrases, terms };
}

/**
 * @param {object} article
 * @param {string} searchText
 */
export function articleFieldBlob(article, searchText = '') {
  const tags = (article.tags || []).join(' ');
  return normalizeSearchText(
    [article.title, article.siteName, article.byline, tags, searchText].filter(Boolean).join(' ')
  );
}

/**
 * @param {string} blob
 * @param {string[]} phrases
 * @param {string[]} terms
 */
export function matchesQuery(blob, phrases, terms) {
  for (const p of phrases) {
    if (!blob.includes(p)) return false;
  }
  for (const t of terms) {
    if (!blob.includes(t)) return false;
  }
  return phrases.length > 0 || terms.length > 0;
}

/**
 * @param {object} article
 * @param {string} searchText
 * @param {string[]} phrases
 * @param {string[]} terms
 */
export function rankScore(article, searchText, phrases, terms) {
  const title = normalizeSearchText(article.title || '');
  const tags = normalizeSearchText((article.tags || []).join(' '));
  const site = normalizeSearchText(article.siteName || '');
  const body = normalizeSearchText(searchText || '');
  const all = [...phrases, ...terms];
  let score = 0;

  for (const q of all) {
    if (title.includes(q)) score += 100;
    else if (tags.includes(q) || site.includes(q)) score += 50;
    else if (body.includes(q)) score += 10;
  }
  return score;
}

/**
 * @param {string} searchText
 * @param {string[]} phrases
 * @param {string[]} terms
 */
function firstMatchIndex(norm, phrases, terms) {
  const needles = [...phrases, ...terms];
  let pos = -1;
  for (const n of needles) {
    const i = norm.indexOf(n);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  return pos;
}

function slicePreview(text, pos) {
  if (pos === -1 || !text) return '';
  const start = Math.max(0, pos - PREVIEW_RADIUS);
  const end = Math.min(text.length, pos + PREVIEW_RADIUS);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet += '…';
  return snippet;
}

export function extractPreview(searchText, phrases, terms) {
  const norm = normalizeSearchText(searchText || '');
  if (!norm) return '';
  return slicePreview(norm, firstMatchIndex(norm, phrases, terms));
}

/**
 * @param {string} displayText — extractSearchTextFromHtml 등 원문 대소문자·표기
 */
export function extractPreviewFromDisplayText(displayText, phrases, terms) {
  // 공백을 먼저 정리해 두어야 정규화 텍스트에서 찾은 위치가 원문에서도 같은 자리가 된다
  const source = (displayText || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!source) return '';
  const norm = source.toLowerCase();
  if (norm.length !== source.length) return '';
  return slicePreview(source, firstMatchIndex(norm, phrases, terms));
}

/**
 * @param {string} text
 * @param {string[]} phrases
 * @param {string[]} terms
 * @returns {DocumentFragment}
 */
export function highlightText(text, phrases, terms) {
  const frag = document.createDocumentFragment();
  if (!text) return frag;

  const needles = [...phrases, ...terms].filter(Boolean);
  if (!needles.length) {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }

  const lower = text.toLowerCase();
  const matches = [];

  for (const n of needles) {
    const nl = n.toLowerCase();
    let from = 0;
    while (from < lower.length) {
      const i = lower.indexOf(nl, from);
      if (i === -1) break;
      matches.push({ start: i, end: i + nl.length });
      from = i + nl.length;
    }
  }

  if (!matches.length) {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }

  matches.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const m of matches) {
    const last = merged[merged.length - 1];
    if (!last || m.start > last.end) merged.push({ ...m });
    else last.end = Math.max(last.end, m.end);
  }

  let cursor = 0;
  for (const m of merged) {
    if (m.start > cursor) {
      frag.appendChild(document.createTextNode(text.slice(cursor, m.start)));
    }
    const mark = document.createElement('mark');
    mark.textContent = text.slice(m.start, m.end);
    frag.appendChild(mark);
    cursor = m.end;
  }
  if (cursor < text.length) {
    frag.appendChild(document.createTextNode(text.slice(cursor)));
  }
  return frag;
}

/**
 * @param {object[]} items — {article, searchText}
 * @param {string} query
 */
export function searchArticles(items, query) {
  const { phrases, terms } = parseSearchQuery(query);
  if (!phrases.length && !terms.length) return [];

  const results = [];
  for (const { article, searchText } of items) {
    const blob = articleFieldBlob(article, searchText);
    if (!matchesQuery(blob, phrases, terms)) continue;
    const score = rankScore(article, searchText, phrases, terms);
    const preview = extractPreview(searchText, phrases, terms);
    results.push({ article, score, preview, phrases, terms });
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.article.savedAt || 0) - (a.article.savedAt || 0);
  });
  return results;
}
