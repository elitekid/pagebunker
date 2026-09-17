// IndexedDB 스키마·트랜잭션 (plan 4-3)

import {
  BODY_STATE,
  SCHEMA_VERSION,
  computeReadingMinutes,
  createArticle,
  createBodyRestore,
  normalizeSearchText,
  searchTextFromBody,
} from './model.js';

export const DB_NAME = 'readlater';
export const DB_VERSION = 1;

const STORE_ARTICLES = 'articles';
const STORE_BODIES = 'bodies';
const STORE_TEXTS = 'texts';
const STORE_META = 'meta';
const STORE_SNAPSHOTS = 'snapshots';
const STORE_UNDO = 'undo';

let dbPromise = null;

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    tx.onerror = () => reject(tx.error);
  });
}

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE_ARTICLES)) {
          const articles = db.createObjectStore(STORE_ARTICLES, { keyPath: 'id' });
          articles.createIndex('matchKey', 'matchKey', { unique: false });
          articles.createIndex('location', 'location', { unique: false });
          articles.createIndex('readState', 'readState', { unique: false });
          articles.createIndex('savedAt', 'savedAt', { unique: false });
          articles.createIndex('importJobId', 'importJobId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_BODIES)) {
          db.createObjectStore(STORE_BODIES, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_TEXTS)) {
          db.createObjectStore(STORE_TEXTS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'name' });
        }
        if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
          db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_UNDO)) {
          db.createObjectStore(STORE_UNDO, { keyPath: 'jobId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function getMeta(tx) {
  const store = tx.objectStore(STORE_META);
  const schema = await reqToPromise(store.get('schemaVersion'));
  const revision = await reqToPromise(store.get('dataRevision'));
  return {
    schemaVersion: schema?.value ?? SCHEMA_VERSION,
    dataRevision: revision?.value ?? 0,
  };
}

async function bumpRevision(tx) {
  const store = tx.objectStore(STORE_META);
  const cur = await reqToPromise(store.get('dataRevision'));
  const next = (cur?.value ?? 0) + 1;
  store.put({ name: 'dataRevision', value: next });
  store.put({ name: 'schemaVersion', value: SCHEMA_VERSION });
  return next;
}

export async function ensureDb() {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readwrite');
  const store = tx.objectStore(STORE_META);
  const schema = await reqToPromise(store.get('schemaVersion'));
  if (!schema) {
    store.put({ name: 'schemaVersion', value: SCHEMA_VERSION });
    store.put({ name: 'dataRevision', value: 0 });
  }
  await txDone(tx);
  return db;
}

export async function getDataRevision() {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readonly');
  const rev = await reqToPromise(tx.objectStore(STORE_META).get('dataRevision'));
  await txDone(tx);
  return rev?.value ?? 0;
}

/**
 * @param {string} key
 */
export async function findByMatchKey(key) {
  const db = await openDb();
  const tx = db.transaction(STORE_ARTICLES, 'readonly');
  const idx = tx.objectStore(STORE_ARTICLES).index('matchKey');
  const all = await reqToPromise(idx.getAll(key));
  await txDone(tx);
  if (!all.length) return null;
  return all.sort((a, b) => b.savedAt - a.savedAt)[0];
}

export async function getArticle(id) {
  const db = await openDb();
  const tx = db.transaction(STORE_ARTICLES, 'readonly');
  const article = await reqToPromise(tx.objectStore(STORE_ARTICLES).get(id));
  await txDone(tx);
  return article || null;
}

export async function getArticleBody(id) {
  const db = await openDb();
  const tx = db.transaction(STORE_BODIES, 'readonly');
  const body = await reqToPromise(tx.objectStore(STORE_BODIES).get(id));
  await txDone(tx);
  return body?.html || '';
}

/**
 * @param {string[]} ids
 * @returns {Promise<Record<string, string>>}
 */
export async function getBodiesByIds(ids) {
  if (!ids?.length) return {};
  const db = await openDb();
  const tx = db.transaction(STORE_BODIES, 'readonly');
  const store = tx.objectStore(STORE_BODIES);
  const bodies = {};
  for (const id of ids) {
    const body = await reqToPromise(store.get(id));
    if (body?.html) bodies[id] = body.html;
  }
  await txDone(tx);
  return bodies;
}

export async function getArticleWithBody(id) {
  const article = await getArticle(id);
  if (!article) return null;
  const html = await getArticleBody(id);
  return { article, html };
}

export async function listArticles() {
  const db = await openDb();
  const tx = db.transaction(STORE_ARTICLES, 'readonly');
  const all = await reqToPromise(tx.objectStore(STORE_ARTICLES).getAll());
  await txDone(tx);
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * @param {object} params
 */
export async function saveArticleRecord(params) {
  const {
    article: articleInput,
    html = '',
    text = '',
    isUpdate = false,
    previousBody = null,
  } = params;

  const article = createArticle({ ...articleInput });
  if (text) {
    article.textLength = text.length;
    article.readingMinutes = computeReadingMinutes(text, article.lang);
  }
  const searchText = searchTextFromBody(html, text);

  const db = await openDb();
  const tx = db.transaction(
    [STORE_ARTICLES, STORE_BODIES, STORE_TEXTS, STORE_META],
    'readwrite'
  );

  const articles = tx.objectStore(STORE_ARTICLES);
  const bodies = tx.objectStore(STORE_BODIES);
  const texts = tx.objectStore(STORE_TEXTS);

  if (isUpdate && previousBody && article.bodyState === BODY_STATE.FULL) {
    article.bodyRestore = createBodyRestore(previousBody.html, previousBody.text);
  }

  articles.put(article);

  if (article.bodyState === BODY_STATE.FULL && html) {
    bodies.put({ id: article.id, html });
    texts.put({ id: article.id, searchText });
  } else if (isUpdate) {
    /* link_only 등으로 갱신 시 기존 full 본문 유지 (T1.6) */
  } else {
    bodies.delete(article.id);
    texts.delete(article.id);
  }

  const revision = await bumpRevision(tx);
  await txDone(tx);

  return { article, revision };
}

/**
 * 기존 full 본문을 덮어쓰지 않고 메타만 갱신
 */
export async function updateArticleMetaOnly(article) {
  const db = await openDb();
  const tx = db.transaction([STORE_ARTICLES, STORE_META], 'readwrite');
  tx.objectStore(STORE_ARTICLES).put(article);
  const revision = await bumpRevision(tx);
  await txDone(tx);
  return { article, revision };
}

/**
 * @param {string} id
 * @param {object} articlePatch
 * @param {{html?:string,text?:string,keepBody?:boolean}} bodyPatch
 */
export async function updateArticle(id, articlePatch, bodyPatch = {}) {
  const existing = await getArticle(id);
  if (!existing) throw new Error('article not found');

  const db = await openDb();
  const tx = db.transaction(
    [STORE_ARTICLES, STORE_BODIES, STORE_TEXTS, STORE_META],
    'readwrite'
  );

  const merged = { ...existing, ...articlePatch, id, updatedAt: Date.now() };
  const articles = tx.objectStore(STORE_ARTICLES);
  const bodies = tx.objectStore(STORE_BODIES);
  const texts = tx.objectStore(STORE_TEXTS);

  if (bodyPatch.keepBody) {
    articles.put(merged);
  } else if (merged.bodyState === BODY_STATE.FULL && bodyPatch.html) {
    if (existing.bodyState === BODY_STATE.FULL && bodyPatch.previousHtml) {
      merged.bodyRestore = createBodyRestore(bodyPatch.previousHtml, bodyPatch.previousText || '');
    }
    articles.put(merged);
    bodies.put({ id, html: bodyPatch.html });
    texts.put({ id, searchText: searchTextFromBody(bodyPatch.html || '', bodyPatch.text || '') });
  } else {
    articles.put(merged);
  }

  const revision = await bumpRevision(tx);
  await txDone(tx);
  return { article: merged, revision };
}

/**
 * @param {string} id
 */
export async function deleteArticle(id) {
  const db = await openDb();
  const tx = db.transaction(
    [STORE_ARTICLES, STORE_BODIES, STORE_TEXTS, STORE_META],
    'readwrite'
  );
  tx.objectStore(STORE_ARTICLES).delete(id);
  tx.objectStore(STORE_BODIES).delete(id);
  tx.objectStore(STORE_TEXTS).delete(id);
  const revision = await bumpRevision(tx);
  await txDone(tx);
  return revision;
}

/**
 * @param {string} id
 * @param {{paraIndex:number,ratio:number}} position
 */
export async function savePosition(id, position) {
  const article = await getArticle(id);
  if (!article) return;
  article.position = position;
  const db = await openDb();
  const tx = db.transaction(STORE_ARTICLES, 'readwrite');
  tx.objectStore(STORE_ARTICLES).put(article);
  await txDone(tx);
}

/**
 * @param {string} id
 */
export async function restorePreviousBody(id) {
  const article = await getArticle(id);
  if (!article?.bodyRestore) return null;

  const db = await openDb();
  const tx = db.transaction(
    [STORE_ARTICLES, STORE_BODIES, STORE_TEXTS, STORE_META],
    'readwrite'
  );

  const restore = article.bodyRestore;
  const updated = { ...article, bodyRestore: null, updatedAt: Date.now() };
  tx.objectStore(STORE_ARTICLES).put(updated);
  tx.objectStore(STORE_BODIES).put({ id, html: restore.html });
  tx.objectStore(STORE_TEXTS).put({ id, searchText: normalizeSearchText(restore.text || '') });

  const revision = await bumpRevision(tx);
  await txDone(tx);
  return { article: updated, revision };
}

export async function markArticleRead(id) {
  const article = await getArticle(id);
  if (!article) return null;
  const updated = {
    ...article,
    readState: 'read',
    readAt: Date.now(),
    updatedAt: Date.now(),
  };
  const db = await openDb();
  const tx = db.transaction([STORE_ARTICLES, STORE_META], 'readwrite');
  tx.objectStore(STORE_ARTICLES).put(updated);
  const revision = await bumpRevision(tx);
  await txDone(tx);
  return { article: updated, revision };
}

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * @param {object} opts
 */
export function filterArticles(articles, opts = {}) {
  const { tab = 'unread', tag = '', queryIds = null } = opts;
  let list = articles.filter((a) => a.location !== 'trash' || tab === 'trash');

  switch (tab) {
    case 'unread':
      list = list.filter((a) => a.location === 'inbox' && a.readState === 'unread');
      break;
    case 'read':
      list = list.filter((a) => a.location === 'inbox' && a.readState === 'read');
      break;
    case 'archive':
      list = list.filter((a) => a.location === 'archive');
      break;
    case 'trash':
      list = list.filter((a) => a.location === 'trash');
      break;
    default:
      break;
  }

  if (tag) {
    list = list.filter((a) => (a.tags || []).includes(tag));
  }
  if (queryIds) {
    const set = new Set(queryIds);
    list = list.filter((a) => set.has(a.id));
  }
  return list;
}

/**
 * @param {object[]} articles
 * @param {string} sort
 */
export function sortArticles(articles, sort = 'newest') {
  const copy = [...articles];
  switch (sort) {
    case 'oldest':
      copy.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
      break;
    case 'shortest':
      copy.sort((a, b) => (a.textLength || 0) - (b.textLength || 0));
      break;
    default:
      copy.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }
  return copy;
}

export async function getAllMatchKeys() {
  const articles = await listArticles();
  return articles.map((a) => a.matchKey).filter(Boolean);
}

export async function getAllTags() {
  const articles = await listArticles();
  const tags = new Set();
  for (const a of articles) {
    for (const t of a.tags || []) tags.add(t);
  }
  return [...tags].sort();
}

/**
 * 검색용 articles + searchText
 */
export async function getSearchCorpus() {
  const db = await openDb();
  const tx = db.transaction([STORE_ARTICLES, STORE_TEXTS], 'readonly');
  const articles = await reqToPromise(tx.objectStore(STORE_ARTICLES).getAll());
  const texts = await reqToPromise(tx.objectStore(STORE_TEXTS).getAll());
  await txDone(tx);
  const textMap = new Map(texts.map((t) => [t.id, t.searchText || '']));
  return articles.map((a) => ({ article: a, searchText: textMap.get(a.id) || '' }));
}

/**
 * @param {string[]} ids
 * @param {object} patch
 */
export async function bulkPatchArticles(ids, patch) {
  const db = await openDb();
  const tx = db.transaction([STORE_ARTICLES, STORE_META], 'readwrite');
  const store = tx.objectStore(STORE_ARTICLES);
  const now = Date.now();
  const updated = [];
  for (const id of ids) {
    const article = await reqToPromise(store.get(id));
    if (!article) continue;
    const merged = { ...article, ...patch, id, updatedAt: now };
    store.put(merged);
    updated.push(merged);
  }
  const revision = await bumpRevision(tx);
  await txDone(tx);
  return { articles: updated, revision };
}

/**
 * @param {string[]} ids
 */
export async function bulkMarkRead(ids) {
  const now = Date.now();
  return bulkPatchArticles(ids, { readState: 'read', readAt: now });
}

/**
 * @param {string[]} ids
 */
export async function bulkMoveToArchive(ids) {
  return bulkPatchArticles(ids, { location: 'archive' });
}

/**
 * @param {string[]} ids
 */
export async function bulkMoveToTrash(ids) {
  const db = await openDb();
  const tx = db.transaction([STORE_ARTICLES, STORE_META], 'readwrite');
  const store = tx.objectStore(STORE_ARTICLES);
  const now = Date.now();
  for (const id of ids) {
    const article = await reqToPromise(store.get(id));
    if (!article || article.location === 'trash') continue;
    store.put({
      ...article,
      location: 'trash',
      locationBefore: article.location,
      trashedAt: now,
      updatedAt: now,
    });
  }
  const revision = await bumpRevision(tx);
  await txDone(tx);
  return revision;
}

/**
 * @param {string[]} ids
 */
export async function bulkRestoreFromTrash(ids) {
  const db = await openDb();
  const tx = db.transaction([STORE_ARTICLES, STORE_META], 'readwrite');
  const store = tx.objectStore(STORE_ARTICLES);
  const now = Date.now();
  for (const id of ids) {
    const article = await reqToPromise(store.get(id));
    if (!article || article.location !== 'trash') continue;
    store.put({
      ...article,
      location: article.locationBefore || 'inbox',
      locationBefore: null,
      trashedAt: null,
      updatedAt: now,
    });
  }
  const revision = await bumpRevision(tx);
  await txDone(tx);
  return revision;
}

/**
 * @param {string[]} ids
 */
export async function bulkAddTags(ids, newTags) {
  const tagsToAdd = [...new Set(newTags)].filter(Boolean);
  if (!tagsToAdd.length) return { articles: [], revision: 0 };

  const db = await openDb();
  const tx = db.transaction([STORE_ARTICLES, STORE_META], 'readwrite');
  const store = tx.objectStore(STORE_ARTICLES);
  const now = Date.now();
  const updated = [];
  for (const id of ids) {
    const article = await reqToPromise(store.get(id));
    if (!article) continue;
    const tags = [...new Set([...(article.tags || []), ...tagsToAdd])];
    const merged = { ...article, tags, updatedAt: now };
    store.put(merged);
    updated.push(merged);
  }
  const revision = await bumpRevision(tx);
  await txDone(tx);
  return { articles: updated, revision };
}

/**
 * @param {object[]} articleInputs — createArticle 호환 객체, importJobId 포함
 */
export async function importArticlesBatch(articleInputs) {
  const db = await openDb();
  const tx = db.transaction(
    [STORE_ARTICLES, STORE_BODIES, STORE_TEXTS, STORE_META],
    'readwrite'
  );
  const articles = tx.objectStore(STORE_ARTICLES);
  const saved = [];

  for (const input of articleInputs) {
    const article = createArticle(input);
    articles.put(article);
    saved.push(article);
  }

  const revision = await bumpRevision(tx);
  await txDone(tx);
  return { articles: saved, revision };
}

/**
 * @param {string} jobId
 */
export async function deleteByImportJobId(jobId) {
  const db = await openDb();
  const tx = db.transaction(
    [STORE_ARTICLES, STORE_BODIES, STORE_TEXTS, STORE_META],
    'readwrite'
  );
  const articles = tx.objectStore(STORE_ARTICLES);
  const bodies = tx.objectStore(STORE_BODIES);
  const texts = tx.objectStore(STORE_TEXTS);
  const idx = articles.index('importJobId');
  const toDelete = await reqToPromise(idx.getAll(jobId));
  for (const a of toDelete) {
    articles.delete(a.id);
    bodies.delete(a.id);
    texts.delete(a.id);
  }
  const revision = await bumpRevision(tx);
  await txDone(tx);
  return { count: toDelete.length, revision };
}

/**
 * @param {string} jobId
 * @param {object} record
 */
export async function saveUndoRecord(jobId, record) {
  const db = await openDb();
  const tx = db.transaction(STORE_UNDO, 'readwrite');
  tx.objectStore(STORE_UNDO).put({ jobId, ...record });
  await txDone(tx);
}

/**
 * @param {string} jobId
 */
export async function getUndoRecord(jobId) {
  const db = await openDb();
  const tx = db.transaction(STORE_UNDO, 'readonly');
  const rec = await reqToPromise(tx.objectStore(STORE_UNDO).get(jobId));
  await txDone(tx);
  return rec || null;
}

export async function purgeExpiredTrash() {
  const cutoff = Date.now() - TRASH_RETENTION_MS;
  const db = await openDb();
  const tx = db.transaction(
    [STORE_ARTICLES, STORE_BODIES, STORE_TEXTS, STORE_META],
    'readwrite'
  );
  const articles = tx.objectStore(STORE_ARTICLES);
  const bodies = tx.objectStore(STORE_BODIES);
  const texts = tx.objectStore(STORE_TEXTS);
  const all = await reqToPromise(articles.getAll());
  let count = 0;
  for (const a of all) {
    if (a.location !== 'trash') continue;
    if (!a.trashedAt || a.trashedAt > cutoff) continue;
    articles.delete(a.id);
    bodies.delete(a.id);
    texts.delete(a.id);
    count++;
  }
  let revision = null;
  if (count > 0) revision = await bumpRevision(tx);
  await txDone(tx);
  return { count, revision };
}

/**
 * @param {string[]} ids
 */
export async function getArticlesWithBodies(ids) {
  const result = [];
  for (const id of ids) {
    const data = await getArticleWithBody(id);
    if (data) result.push(data);
  }
  return result;
}

/**
 * 백업용 일관된 읽기 (plan 4-6, T6.1)
 */
export async function readBackupSnapshot() {
  const db = await openDb();
  const tx = db.transaction(
    [STORE_ARTICLES, STORE_BODIES, STORE_TEXTS, STORE_META],
    'readonly'
  );
  const articles = await reqToPromise(tx.objectStore(STORE_ARTICLES).getAll());
  const bodies = await reqToPromise(tx.objectStore(STORE_BODIES).getAll());
  const texts = await reqToPromise(tx.objectStore(STORE_TEXTS).getAll());
  const meta = await getMeta(tx);
  await txDone(tx);

  const bodyMap = new Map(bodies.map((b) => [b.id, b.html || '']));
  const entries = articles.map((article) => ({
    article,
    html: bodyMap.get(article.id) || '',
  }));

  return { meta, entries };
}

const SNAPSHOT_LIMIT = 500 * 1024 * 1024;
const SNAPSHOT_MAX_COUNT = 3;

function snapshotEntrySize(entry) {
  return entry.size || 0;
}

/**
 * @param {number} dataRevision
 */
export async function hasIdbSnapshotForRevision(dataRevision) {
  const all = await listIdbSnapshots();
  return all.some((e) => e.dataRevision === dataRevision);
}

/**
 * @param {{ dataRevision: number, size: number, sha256: string, blob: Blob }} meta
 */
export async function saveIdbSnapshotBlob(meta) {
  const { dataRevision, sha256, blob } = meta;
  const size = meta.size || blob.size;
  const db = await openDb();
  const tx = db.transaction(STORE_SNAPSHOTS, 'readwrite');
  const store = tx.objectStore(STORE_SNAPSHOTS);
  const existing = await reqToPromise(store.getAll());

  const sameRev = existing.find((e) => e.dataRevision === dataRevision);
  if (sameRev) {
    await txDone(tx);
    return { ok: true, id: sameRev.id, size: sameRev.size, skipped: true };
  }

  const total = existing.reduce((s, e) => s + snapshotEntrySize(e), 0) + size;
  if (size > SNAPSHOT_LIMIT || total > SNAPSHOT_LIMIT) {
    await txDone(tx);
    return { ok: false, code: 'too_large', size, total };
  }

  const id = `snap-${Date.now()}`;
  const createdAt = Date.now();
  store.put({
    id,
    createdAt,
    dataRevision,
    size,
    sha256,
    blob,
  });

  const sorted = [...existing, { id, createdAt, size }].sort(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
  );
  for (const old of sorted.slice(SNAPSHOT_MAX_COUNT)) {
    store.delete(old.id);
  }

  await txDone(tx);
  return { ok: true, id, size };
}

/**
 * @param {object} snap
 */
export async function readIdbSnapshotEntries(snap) {
  if (!snap) return null;
  if (snap.payload?.articles) {
    return snap.payload.articles.map((e) => ({
      article: e.article,
      html: e.html || '',
    }));
  }
  if (snap.blob) {
    const { parseBackupBlob } = await import('./backup-stream-parse.js');
    const result = await parseBackupBlob(snap.blob);
    if (!result.ok) return null;
    return result.entries;
  }
  return null;
}

export async function listIdbSnapshots() {
  const db = await openDb();
  const tx = db.transaction(STORE_SNAPSHOTS, 'readonly');
  const all = await reqToPromise(tx.objectStore(STORE_SNAPSHOTS).getAll());
  await txDone(tx);
  return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * @param {string} id
 */
export async function getIdbSnapshot(id) {
  const db = await openDb();
  const tx = db.transaction(STORE_SNAPSHOTS, 'readonly');
  const snap = await reqToPromise(tx.objectStore(STORE_SNAPSHOTS).get(id));
  await txDone(tx);
  return snap || null;
}

/**
 * @param {object[]} entries
 */
export async function mergeBackupEntries(entries) {
  const db = await openDb();
  const tx = db.transaction(
    [STORE_ARTICLES, STORE_BODIES, STORE_TEXTS, STORE_META],
    'readwrite'
  );
  const articles = tx.objectStore(STORE_ARTICLES);
  const bodies = tx.objectStore(STORE_BODIES);
  const texts = tx.objectStore(STORE_TEXTS);
  let added = 0;

  for (const entry of entries) {
    const article = createArticle(entry.article);
    const existing = await reqToPromise(
      articles.index('matchKey').getAll(article.matchKey)
    );
    if (existing.length) continue;

    articles.put(article);
    if (entry.html && article.bodyState === BODY_STATE.FULL) {
      bodies.put({ id: article.id, html: entry.html });
      texts.put({
        id: article.id,
        searchText: searchTextFromBody(entry.html, entry.text || ''),
      });
    }
    added++;
  }

  const revision = await bumpRevision(tx);
  await txDone(tx);
  return { added, revision };
}

/**
 * @param {object[]} entries
 * @param {object} meta
 */
export async function replaceAllData(entries, meta = {}) {
  const db = await openDb();
  const tx = db.transaction(
    [STORE_ARTICLES, STORE_BODIES, STORE_TEXTS, STORE_META],
    'readwrite'
  );
  const articles = tx.objectStore(STORE_ARTICLES);
  const bodies = tx.objectStore(STORE_BODIES);
  const texts = tx.objectStore(STORE_TEXTS);
  const metaStore = tx.objectStore(STORE_META);

  articles.clear();
  bodies.clear();
  texts.clear();

  for (const entry of entries) {
    const article = createArticle(entry.article);
    articles.put(article);
    if (entry.html && article.bodyState === BODY_STATE.FULL) {
      bodies.put({ id: article.id, html: entry.html });
      texts.put({
        id: article.id,
        searchText: searchTextFromBody(entry.html, entry.text || ''),
      });
    }
  }

  metaStore.put({ name: 'schemaVersion', value: meta.schemaVersion ?? SCHEMA_VERSION });
  metaStore.put({ name: 'dataRevision', value: meta.dataRevision ?? 0 });

  await txDone(tx);
  return { count: entries.length };
}

const TEMP_DB = 'readlater_restore_temp';
const TEMP_VERSION = 1;

function openTempDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TEMP_DB, TEMP_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains('entries')) {
        db.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function clearRestoreTemp() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(TEMP_DB);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

/**
 * @param {object[]} entries
 */
export async function stageRestoreEntries(entries) {
  const db = await openTempDb();
  const tx = db.transaction('entries', 'readwrite');
  const store = tx.objectStore('entries');
  store.clear();
  for (const entry of entries) {
    store.put(entry);
  }
  await txDone(tx);
  db.close();
}

export async function readStagedRestoreEntries() {
  const db = await openTempDb();
  const tx = db.transaction('entries', 'readonly');
  const all = await reqToPromise(tx.objectStore('entries').getAll());
  await txDone(tx);
  db.close();
  return all;
}

/**
 * @param {string} jobId
 * @param {object} record
 */
export async function saveReplaceUndo(jobId, record) {
  return saveUndoRecord(jobId, record);
}
