// 글 스키마, 상태 전이, 읽기 시간 (plan 4-3)

import { extractSearchTextFromHtml } from './sanitize.js';
import { matchKey } from './url.js';

export const SCHEMA_VERSION = 1;

export const BODY_STATE = {
  FULL: 'full',
  LINK_ONLY: 'link_only',
  FAILED_IFRAME: 'failed_iframe',
  TOO_LARGE: 'too_large',
  NONE_IMPORTED: 'none_imported',
};

export const READ_STATE = {
  UNREAD: 'unread',
  READ: 'read',
};

export const LOCATION = {
  INBOX: 'inbox',
  ARCHIVE: 'archive',
  TRASH: 'trash',
};

export const SOURCE = {
  SAVE: 'save',
  POCKET: 'pocket',
  INSTAPAPER: 'instapaper',
  BOOKMARKS: 'bookmarks',
  BACKUP: 'backup',
};

export const DEFAULT_SETTINGS = {
  autoMarkRead: true,
  showImagesDefault: false,
  autoFileBackup: true,
  fontSize: 18,
  lineHeight: 1.6,
  contentWidth: 680,
  theme: 'auto',
  installedAt: null,
  saveCount: 0,
};

const SETTINGS_KEY = 'rl_settings';

export function generateId() {
  if (globalThis.crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * @param {string} text
 */
export function normalizeSearchText(text) {
  if (!text) return '';
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} raw — 저장된 publishedTime 원문
 * @param {string} [locale]
 */
export function formatPublishedTime(raw, locale) {
  if (!raw) return '';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  if (dateOnly) {
    const [y, m, d] = raw.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    if (Number.isNaN(dt.getTime())) return raw;
    return dt.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return raw;
  return new Date(parsed).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * @param {string} html
 */
export function searchTextFromBody(html, plainText = '') {
  // 전역 등록에 기대지 않고 직접 가져온 함수를 쓴다(백그라운드가 정리기를 따로 불러오지 않아도 동작)
  const fromHtml = html ? extractSearchTextFromHtml(html) : '';
  return normalizeSearchText(fromHtml || plainText);
}

/**
 * @param {string} text
 * @param {string} [lang]
 */
export function computeReadingMinutes(text, lang) {
  const len = text?.length || 0;
  if (len === 0) return 1;

  const hangul = (text.match(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g) || []).length;
  const ratio = len > 0 ? hangul / len : 0;
  const isKorean = lang === 'ko' || ratio >= 0.3;

  if (isKorean) {
    return Math.max(1, Math.ceil(len / 500));
  }
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 230));
}

/**
 * @param {object} input
 */
export function createArticle(input) {
  const now = Date.now();
  const url = input.url || '';
  const text = input.text || '';
  const lang = input.lang || '';

  return {
    id: input.id || generateId(),
    url,
    matchKey: input.matchKey || matchKey(url) || url,
    title: input.title || input.docTitle || url,
    siteName: input.siteName || '',
    byline: input.byline || '',
    lang,
    excerpt: input.excerpt || '',
    publishedTime: input.publishedTime || '',
    modifiedTime: input.modifiedTime || '',
    savedAt: input.savedAt ?? now,
    updatedAt: input.updatedAt ?? now,
    readState: input.readState || READ_STATE.UNREAD,
    readAt: input.readAt ?? null,
    location: input.location || LOCATION.INBOX,
    locationBefore: input.locationBefore ?? null,
    trashedAt: input.trashedAt ?? null,
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    // 본문 텍스트 없이 다시 만들 때(복원·교체·되돌리기)는 저장돼 있던 값을 유지한다
    textLength: text ? text.length : (Number.isFinite(input.textLength) ? input.textLength : 0),
    readingMinutes: text
      ? computeReadingMinutes(text, lang)
      : (Number.isFinite(input.readingMinutes) && input.readingMinutes >= 1 ? input.readingMinutes : 1),
    position: input.position ?? { paraIndex: 0, ratio: 0 },
    bodyState: input.bodyState || BODY_STATE.LINK_ONLY,
    source: input.source || SOURCE.SAVE,
    importJobId: input.importJobId ?? null,
    bodyRestore: input.bodyRestore ?? null,
  };
}

/**
 * @param {object} article
 * @param {object} patch
 */
export function applyArticlePatch(article, patch) {
  return { ...article, ...patch, updatedAt: Date.now() };
}

/**
 * @param {object} article
 */
export function markRead(article) {
  return applyArticlePatch(article, {
    readState: READ_STATE.READ,
    readAt: Date.now(),
  });
}

/**
 * @param {object} article
 * @param {{paraIndex:number,ratio:number}} position
 */
export function withPosition(article, position) {
  return { ...article, position };
}

/**
 * @param {object} extract
 * @param {string} tabUrl
 */
export function resolveBodyState(extract, tabUrl) {
  if (!extract?.ok) {
    if (extract?.reason === 'too_many_nodes') return BODY_STATE.LINK_ONLY;
    if (extract?.reason === 'too_large') return BODY_STATE.TOO_LARGE;
    if (extract?.reason === 'iframe') return BODY_STATE.FAILED_IFRAME;
    return BODY_STATE.LINK_ONLY;
  }
  if (!extract.html || extract.linkOnly) return BODY_STATE.LINK_ONLY;
  const textLen = extract.text?.length || 0;
  const paraCount = (extract.text?.match(/\n\n/g) || []).length + 1;
  if (textLen < 80 && paraCount <= 1) return BODY_STATE.LINK_ONLY;
  return BODY_STATE.FULL;
}

/**
 * full 본문 교체 시 이전 본문 1회 복구용 스냅샷
 * @param {string} html
 * @param {string} text
 */
export function createBodyRestore(html, text) {
  return { html, text, savedAt: Date.now() };
}

export async function loadSettings(storageApi) {
  const data = await storageApi.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
}

export async function saveSettings(storageApi, patch) {
  const current = await loadSettings(storageApi);
  const next = { ...current, ...patch };
  await storageApi.set({ [SETTINGS_KEY]: next });
  return next;
}
