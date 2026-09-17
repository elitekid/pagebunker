// 백그라운드: 저장 흐름, 배지, 메뉴, 메시지 API

import {
  action,
  actionBadge,
  alarms,
  browserApi,
  contextMenus,
  downloads,
  scripting,
  storage,
  tabs,
  windows,
} from './shared/browser.js';
import { canSaveTabUrl, isRestrictedUrl } from './shared/restricted-url.js';
import {
  ALARM_BACKUP,
  ALARM_WATCHDOG,
  DEFAULT_BACKUP_STATE,
  REPLACE_UNDO_KEY,
  requestBackupDownloadBlob,
  getBackupStatus,
  handleDownloadChanged,
  loadBackupState,
  markDataDirty,
  markFirstBackupNoticeShown,
  getReplaceUndoPointer,
  clearReplaceUndoPointer,
  reconcileBackupStartup,
  runBackup,
  saveBackupState,
  setBackupDeferred as setBackupEngineDeferred,
} from './shared/backup.js';
import {
  bulkAddTags,
  bulkMarkRead,
  bulkMoveToArchive,
  bulkMoveToTrash,
  bulkRestoreFromTrash,
  deleteArticle,
  deleteByImportJobId,
  ensureDb,
  findByMatchKey,
  getAllMatchKeys,
  getAllTags,
  getArticle,
  getArticleBody,
  getBodiesByIds,
  getSearchCorpus,
  importArticlesBatch,
  listArticles,
  markArticleRead,
  purgeExpiredTrash,
  restorePreviousBody,
  saveArticleRecord,
  savePosition,
  saveUndoRecord,
  updateArticle,
  wipeAllData,
  clearRestoreTemp,
  listIdbSnapshots,
} from './shared/db.js';
import {
  BODY_STATE,
  DEFAULT_SETTINGS,
  LOCATION,
  createArticle,
  generateId,
  loadSettings,
  resolveBodyState,
  saveSettings,
} from './shared/model.js';
import { matchKey, sameDocumentUrl } from './shared/url.js';

const EXTRACT_TIMEOUT_MS = 10_000;
const UNDO_WINDOW_MS = 60_000;
const FILL_BODY_MS = 30 * 60 * 1000;
const IMPORT_BATCH_SIZE = 1000;
const TRASH_ALARM = 'trash-cleanup';
const IMPORT_JOB_KEY = 'rl_import_job';
const FILL_PENDING_KEY = 'rl_fill_pending';
const BACKUP_DEFER_KEY = 'rl_backup_deferred';
const FIRST_RUN_KEY = 'rl_first_run_done';
const BADGE_COLOR = '#2457D6';
const BADGE_FAIL_COLOR = '#B91C1C';

const manifestMeta = browserApi.runtime.getManifest();
const isFirefox = !!manifestMeta.browser_specific_settings?.gecko;

let badgeGen = 0;
let badgeTimer = null;
let menuChain = Promise.resolve();

/** @type {{id:string,at:number}|null} */
let lastSave = null;

function i18n(key, subs = []) {
  return browserApi.i18n.getMessage(key, subs.map(String)) || key;
}

function urlOf(tab) {
  return tab?.url || tab?.pendingUrl || '';
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function summarizeArticle(article) {
  return {
    id: article.id,
    title: article.title,
    siteName: article.siteName,
    savedAt: article.savedAt,
    readState: article.readState,
    location: article.location,
    bodyState: article.bodyState,
    readingMinutes: article.readingMinutes,
    url: article.url,
  };
}

function formatSaveResult(result) {
  if (!result?.ok) {
    return { ok: false, code: result?.code || 'failed' };
  }
  if (result.duplicate) {
    return { ok: true, result: 'duplicate', article: summarizeArticle(result.article) };
  }
  if (result.keptBody) {
    return { ok: true, result: 'kept_body', article: summarizeArticle(result.article) };
  }
  if (result.linkOnly) {
    return { ok: true, result: 'link_only', article: summarizeArticle(result.article), undoable: true };
  }
  if (result.updated) {
    return { ok: true, result: 'updated', article: summarizeArticle(result.article) };
  }
  return {
    ok: true,
    result: 'saved',
    article: summarizeArticle(result.article),
    undoable: true,
  };
}

/** 페이지 우측 상단 알림(단축키·우클릭 저장) */
function injectPageToast(payload) {
  const HOST_ID = '__pagebunker_toast_host__';
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647';
    document.documentElement.appendChild(host);
  }

  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '';

  const style = document.createElement('style');
  style.textContent = `
    .wrap {
      font: 600 13px system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #047857;
      background: #ecfdf5;
      border: 1px solid #a7f3d0;
      border-radius: 8px;
      padding: 10px 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,.18);
      max-width: min(440px, calc(100vw - 32px));
      display: flex;
      align-items: center;
      gap: 14px;
      white-space: nowrap;
    }
    .wrap.warn { color: #92400e; background: #fffbeb; border-color: rgba(180,83,9,.35); }
    .msg { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
    .wrap button { flex: none; }
    button {
      border: none;
      background: none;
      color: #2457D6;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      padding: 0;
    }
    button:hover { text-decoration: underline; }
  `;

  const wrap = document.createElement('div');
  wrap.className = 'wrap' + (payload.warn ? ' warn' : '');
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = payload.text;
  wrap.appendChild(msg);

  let timer = null;
  let hover = false;
  const removeToast = () => {
    if (timer) clearTimeout(timer);
    host?.remove();
  };

  for (const btn of payload.buttons || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = btn.label;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: btn.action, ...btn.payload });
      removeToast();
    });
    wrap.appendChild(b);
  }

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!hover) removeToast();
    }, 4000);
  };
  wrap.addEventListener('mouseenter', () => { hover = true; });
  wrap.addEventListener('mouseleave', () => { hover = false; schedule(); });

  shadow.append(style, wrap);
  schedule();
}

function buildPageToastPayload(kind, articleId) {
  const buttons = [];
  if (kind === 'saved') {
    buttons.push(
      { label: i18n('ptoastReadNow'), action: 'openReader', payload: { id: articleId } },
      { label: i18n('ptoastUndo'), action: 'undoArticleSave', payload: { id: articleId } },
    );
    return { text: i18n('ptoastSaved'), warn: false, buttons };
  }
  if (kind === 'link') {
    buttons.push({ label: i18n('ptoastUndo'), action: 'undoArticleSave', payload: { id: articleId } });
    return { text: i18n('ptoastLinkOnly'), warn: true, buttons };
  }
  if (kind === 'duplicate') {
    buttons.push({ label: i18n('ptoastReadNow'), action: 'openReader', payload: { id: articleId } });
    return { text: i18n('ptoastDuplicate'), warn: false, buttons };
  }
  return { text: i18n('ptoastCannotSave'), warn: true, buttons: [] };
}

async function showPageToast(tabId, kind, articleId = null) {
  if (!scripting?.executeScript || !tabId) return false;
  const payload = buildPageToastPayload(kind, articleId);
  try {
    await scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: injectPageToast,
      args: [payload],
    });
    return true;
  } catch {
    return false;
  }
}

async function feedbackSaveResult(tab, result, feedback) {
  if (feedback === 'none') return;
  if (!result?.ok) {
    if (feedback === 'toast') {
      const shown = await showPageToast(tab.id, 'fail');
      if (!shown) await showBadgeFail();
    } else {
      await showBadgeFail();
    }
    return;
  }
  if (result.duplicate) {
    if (feedback === 'toast') {
      const shown = await showPageToast(tab.id, 'duplicate', result.article?.id);
      if (!shown) {
        await showBadge(i18n('badgeExists'));
        await setActionTooltip(i18n('badgeExistsTip', [result.article?.title || '']));
      }
    } else if (feedback === 'badge') {
      await showBadge(i18n('badgeExists'));
      await setActionTooltip(i18n('badgeExistsTip', [result.article?.title || '']));
    }
    return;
  }
  if (result.linkOnly) {
    if (feedback === 'toast') {
      const shown = await showPageToast(tab.id, 'link', result.article?.id);
      if (!shown) {
        await showBadge('+');
        await setActionTooltip(i18n('badgeSavedLinkOnly'));
      }
    } else if (feedback === 'badge') {
      await showBadge('+');
      await setActionTooltip(i18n('badgeSavedLinkOnly'));
    }
    return;
  }
  if (result.keptBody) {
    if (feedback === 'badge') {
      await showBadge(i18n('badgeExists'));
      await setActionTooltip(i18n('badgeBodyKept'));
    }
    return;
  }
  const label = result.updated ? i18n('badgeUpdated') : '+';
  const tip = result.updated ? i18n('badgeUpdated') : i18n('badgeSaved');
  if (feedback === 'toast') {
    const shown = await showPageToast(tab.id, 'saved', result.article?.id);
    if (!shown) {
      await showBadge(label);
      await setActionTooltip(tip);
    }
  } else if (feedback === 'badge') {
    await showBadge(label);
    await setActionTooltip(tip);
  }
}

async function showBadge(text, color = BADGE_COLOR) {
  badgeGen++;
  const gen = badgeGen;
  clearTimeout(badgeTimer);
  await actionBadge.setBadgeBackgroundColor({ color });
  await actionBadge.setBadgeText({ text });
  badgeTimer = setTimeout(() => {
    if (gen === badgeGen) {
      actionBadge.setBadgeText({ text: '' }).catch(() => {});
    }
  }, 2500);
}

async function showBadgeFail() {
  await showBadge('!', BADGE_FAIL_COLOR);
}

async function setActionTooltip(text) {
  await actionBadge.setTitle({ title: text || i18n('actionTitle') });
}

function runMenuTask(fn) {
  const run = menuChain.then(() => fn());
  menuChain = run.catch(() => {});
  return run;
}

async function registerContextMenus() {
  if (!contextMenus) return;
  return runMenuTask(async () => {
    await contextMenus.removeAll();
    await contextMenus.create({
      id: 'rl-save-page',
      contexts: ['page'],
      title: i18n('ctxSavePage'),
    });
    await contextMenus.create({
      id: 'rl-open-library-page',
      contexts: ['page'],
      title: i18n('ctxOpenLibraryPage'),
    });
    await contextMenus.create({
      id: 'rl-open-library',
      contexts: ['action'],
      title: i18n('ctxOpenLibrary'),
    });
    await contextMenus.create({
      id: 'rl-undo-save',
      contexts: ['action'],
      title: i18n('ctxUndoSave'),
    });
  });
}

async function runExtract(tabId) {
  if (!scripting?.executeScript) {
    throw new Error('scripting unavailable');
  }

  const files = [
    'vendor/Readability.js',
    'shared/sanitize-body.js',
    'content/extract.js',
  ];

  const execPromise = scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'ISOLATED',
    files,
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('extract timeout')), EXTRACT_TIMEOUT_MS);
  });

  const results = await Promise.race([execPromise, timeoutPromise]);
  const frameResult = results?.[0]?.result;
  return frameResult || { ok: false, reason: 'empty' };
}

function buildArticleFromTab(tab, extract, bodyState) {
  const tabUrl = urlOf(tab);
  const finalUrl = extract?.finalUrl || tabUrl;
  const title =
    extract?.title ||
    extract?.docTitle ||
    tab.title ||
    finalUrl;

  return createArticle({
    url: finalUrl,
    matchKey: matchKey(finalUrl) || matchKey(tabUrl) || finalUrl,
    title,
    siteName: extract?.siteName || '',
    byline: extract?.byline || '',
    lang: extract?.lang || '',
    excerpt: extract?.excerpt || '',
    publishedTime: extract?.publishedTime || '',
    modifiedTime: extract?.modifiedTime || '',
    bodyState,
    source: 'save',
  });
}

async function doDeleteAllData() {
  let state = await loadBackupState();
  if (state.inflight) {
    const ignored = [...(state.ignoredDownloadIds || []), state.inflight.downloadId].filter(Boolean);
    state = { ...state, inflight: null, ignoredDownloadIds: ignored };
  }
  await wipeAllData();
  await clearRestoreTemp();
  await storage.local.remove([
    IMPORT_JOB_KEY,
    FILL_PENDING_KEY,
    BACKUP_DEFER_KEY,
    FIRST_RUN_KEY,
    REPLACE_UNDO_KEY,
  ]);
  await saveSettings(storage.local, DEFAULT_SETTINGS);
  await clearReplaceUndoPointer();
  state = {
    ...DEFAULT_BACKUP_STATE,
    ignoredDownloadIds: state.ignoredDownloadIds || [],
  };
  await saveBackupState(state);
  await alarms.clear(ALARM_BACKUP);
  await alarms.clear(ALARM_WATCHDOG);
  return { ok: true };
}

// 탭 주소 읽기 권한(tabs) 없이도 확장 자기 화면은 찾을 수 있다: 크롬·엣지는 runtime.getContexts, 그 밖에는 tabs.query 결과의 url
async function findLibraryTab(base) {
  const getContexts = browserApi.runtime?.getContexts;
  if (typeof getContexts === 'function') {
    try {
      const contexts = await getContexts.call(browserApi.runtime, { contextTypes: ['TAB'] });
      const hit = contexts.find((c) => c.tabId >= 0 && (c.documentUrl || '').startsWith(base));
      if (hit) return { id: hit.tabId, windowId: hit.windowId, url: hit.documentUrl };
    } catch {
      /* 지원하지 않으면 아래로 */
    }
  }
  const allTabs = await tabs.query({});
  return allTabs.find((tab) => tab.url && tab.url.startsWith(base)) || null;
}

async function openLibrary(query = '') {
  const base = browserApi.runtime.getURL('library/library.html');
  const suffix = query.startsWith('?') ? query : query ? `?${query}` : '';
  const targetUrl = `${base}${suffix}`;
  const existing = await findLibraryTab(base);
  if (existing?.id) {
    // 복구·가져오기처럼 화면을 지정해 열 때는 이미 열린 보관함도 그 주소로 다시 연다
    const props = suffix && existing.url !== targetUrl ? { active: true, url: targetUrl } : { active: true };
    await tabs.update(existing.id, props);
    if (existing.windowId && windows?.update) {
      await windows.update(existing.windowId, { focused: true });
    }
    return { ok: true, focused: true };
  }
  await tabs.create({ url: targetUrl, active: true });
  return { ok: true, focused: false };
}

function openReaderTab(articleId) {
  const url = browserApi.runtime.getURL(`reader/reader.html?id=${encodeURIComponent(articleId)}`);
  return tabs.create({ url, active: true });
}

async function getTabSaveState(tabId, url, title) {
  const extensionBase = browserApi.runtime.getURL('');
  const saveCheck = canSaveTabUrl(url, extensionBase);
  const host = hostFromUrl(url);
  if (!saveCheck.canSave) {
    return {
      ok: true,
      canSave: false,
      reasonCode: saveCheck.code,
      title: title || '',
      host,
    };
  }
  const key = matchKey(url);
  const existing = key ? await findByMatchKey(key) : null;
  if (existing && existing.location !== LOCATION.TRASH) {
    return {
      ok: true,
      canSave: true,
      saved: true,
      title: existing.title || title || '',
      host: host || existing.siteName || '',
      article: summarizeArticle(existing),
    };
  }
  return {
    ok: true,
    canSave: true,
    saved: false,
    title: title || '',
    host,
  };
}

async function listRecentArticles(limit = 5) {
  const articles = await listArticles();
  const recent = articles
    .filter((a) => a.location !== LOCATION.TRASH)
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
    .slice(0, limit)
    .map(summarizeArticle);
  return { ok: true, articles: recent, total: articles.filter((a) => a.location !== LOCATION.TRASH).length };
}

async function undoArticleSave(articleId) {
  if (!articleId) return { ok: false, code: 'none' };
  if (!lastSave || lastSave.id !== articleId) {
    return { ok: false, code: 'none' };
  }
  const age = Date.now() - lastSave.at;
  if (age > UNDO_WINDOW_MS) {
    return { ok: false, code: 'expired' };
  }
  await deleteArticle(articleId);
  lastSave = null;
  await afterDataMutation();
  return { ok: true, id: articleId };
}

/**
 * @param {object} tab
 * @param {object} opts
 */
async function getFillPending() {
  const data = await storage.local.get(FILL_PENDING_KEY);
  const pending = data[FILL_PENDING_KEY];
  if (!pending) return null;
  if (pending.expiresAt < Date.now()) {
    await storage.local.remove(FILL_PENDING_KEY);
    return null;
  }
  return pending;
}

async function setFillPending(pending) {
  if (!pending) {
    await storage.local.remove(FILL_PENDING_KEY);
    return;
  }
  await storage.local.set({ [FILL_PENDING_KEY]: pending });
}

async function getImportJob() {
  const data = await storage.local.get(IMPORT_JOB_KEY);
  return data[IMPORT_JOB_KEY] || null;
}

async function setImportJob(job) {
  if (!job) await storage.local.remove(IMPORT_JOB_KEY);
  else await storage.local.set({ [IMPORT_JOB_KEY]: job });
}

async function setBackupDeferred(deferred) {
  setBackupEngineDeferred(deferred);
  if (deferred) await storage.local.set({ [BACKUP_DEFER_KEY]: true });
  else await storage.local.remove(BACKUP_DEFER_KEY);
}

async function afterDataMutation() {
  await markDataDirty();
}

async function scheduleTrashCleanup() {
  if (!alarms?.create) return;
  await alarms.create(TRASH_ALARM, { periodInMinutes: 24 * 60 });
}

async function runTrashCleanup() {
  try {
    await ensureDb();
    const res = await purgeExpiredTrash();
    if (res.count > 0) console.log(`trash cleanup: ${res.count} articles`);
  } catch (err) {
    console.error('trash cleanup failed:', err);
  }
}

async function saveFromTab(tab, opts = {}) {
  const { forceUpdate = false, feedback = 'badge' } = opts;
  let fillArticleId = opts.fillArticleId ?? null;
  const tabUrl = urlOf(tab);
  const tabId = tab.id;

  // 주소를 받을 수 없거나 웹·파일 주소가 아닌 페이지(브라우저 내부 페이지 등)는 빈 글을 만들지 않는다
  if (!tabId || !/^(https?|file):/i.test(tabUrl)) {
    await feedbackSaveResult(tab, { ok: false, code: 'cannot_save' }, feedback);
    if (feedback === 'badge') await setActionTooltip(i18n('badgeCannotSave'));
    return { ok: false, code: 'cannot_save' };
  }

  if (isRestrictedUrl(tabUrl)) {
    const article = createArticle({
      url: tabUrl || '',
      matchKey: matchKey(tabUrl) || tabUrl,
      title: tab.title || tabUrl || i18n('untitled'),
      bodyState: BODY_STATE.LINK_ONLY,
    });
    const saved = await saveArticleRecord({
      article,
      html: '',
      text: '',
      isUpdate: false,
    });
    lastSave = { id: saved.article.id, at: Date.now() };
    await afterDataMutation();
    const linkResult = { ok: true, article: saved.article, linkOnly: true };
    await feedbackSaveResult(tab, linkResult, feedback);
    return linkResult;
  }

  let extract;
  try {
    extract = await runExtract(tabId);
  } catch (err) {
    console.error('extract failed:', err);
    await feedbackSaveResult(tab, { ok: false, code: 'extract_failed' }, feedback);
    if (feedback === 'badge') await setActionTooltip(i18n('badgeFailed'));
    return { ok: false, code: 'extract_failed' };
  }

  const finalUrl = extract.finalUrl || tabUrl;
  if (!sameDocumentUrl(finalUrl, tabUrl)) {
    if (feedback === 'badge') {
      await showBadge('~', BADGE_FAIL_COLOR);
      await setActionTooltip(i18n('badgePageChanged'));
    } else {
      await feedbackSaveResult(tab, { ok: false, code: 'page_changed' }, feedback);
    }
    return { ok: false, code: 'page_changed' };
  }

  const bodyState = resolveBodyState(extract, tabUrl);
  const key = matchKey(finalUrl) || matchKey(tabUrl);
  let existing = null;
  let refreshMode = forceUpdate;

  // 보관함의 "본문 채우기/본문 새로 저장"이 연 원문 탭에서만 연결을 적용한다(다른 탭의 새 글이 섞이지 않게)
  const fillPending = fillArticleId ? null : await getFillPending();
  if (fillPending && fillPending.tabId === tabId) {
    const candidate = await getArticle(fillPending.articleId);
    if (candidate) {
      if (key === fillPending.matchKey) {
        existing = candidate;
        fillArticleId = candidate.id;
        refreshMode = true;
      } else if ((fillPending.redirectCount || 0) < 1) {
        existing = candidate;
        fillArticleId = candidate.id;
        refreshMode = true;
        await setFillPending({ ...fillPending, redirectCount: 1, matchKey: key });
      } else {
        await setFillPending(null);
        await showBadgeFail();
        await setActionTooltip(i18n('badgeFillMismatch'));
        await openLibrary(`?highlight=${encodeURIComponent(candidate.id)}`);
        return { ok: false, code: 'fill_mismatch', articleId: candidate.id, finalUrl };
      }
    }
  } else if (fillArticleId) {
    existing = await getArticle(fillArticleId);
  }
  if (!existing) existing = await findByMatchKey(key);

  if (existing && !refreshMode && !fillArticleId) {
    const dupResult = { ok: true, duplicate: true, article: existing };
    await feedbackSaveResult(tab, dupResult, feedback);
    return dupResult;
  }

  const articleData = buildArticleFromTab(tab, extract, bodyState);
  if (existing) {
    articleData.id = existing.id;
    articleData.savedAt = existing.savedAt;
    articleData.readState = existing.readState;
    articleData.readAt = existing.readAt;
    articleData.location = existing.location;
    articleData.tags = existing.tags;
  }

  const newIsFull = bodyState === BODY_STATE.FULL;
  const oldIsFull = existing?.bodyState === BODY_STATE.FULL;

  if (existing && oldIsFull && !newIsFull) {
    await updateArticle(existing.id, {
      ...articleData,
      bodyState: existing.bodyState,
    }, { keepBody: true });
    const keptResult = { ok: true, article: existing, keptBody: true };
    await feedbackSaveResult(tab, keptResult, feedback);
    return keptResult;
  }

  let previousBody = null;
  if (existing && oldIsFull && newIsFull) {
    const prevHtml = await getArticleBody(existing.id);
    previousBody = { html: prevHtml, text: extract.text || '' };
  }

  const saved = await saveArticleRecord({
    article: articleData,
    html: newIsFull ? extract.html : '',
    text: newIsFull ? extract.text : '',
    isUpdate: !!existing,
    previousBody,
  });

  if (fillArticleId) {
    await setFillPending(null);
  }

  lastSave = { id: saved.article.id, at: Date.now() };
  if (newIsFull && !existing) {
    const settings = await loadSettings(storage.local);
    const saveCount = (settings.saveCount ?? 0) + 1;
    await saveSettings(storage.local, { saveCount });
  }
  await afterDataMutation();

  const saveResult = {
    ok: true,
    article: saved.article,
    updated: !!existing,
    linkOnly: !newIsFull,
  };
  await feedbackSaveResult(tab, saveResult, feedback);
  return saveResult;
}

async function startFillBody(articleId) {
  const article = await getArticle(articleId);
  if (!article) return { ok: false, code: 'not_found' };
  // 활성 탭 권한은 사용자가 그 탭에서 다시 저장해야 생기므로, 원문 탭을 열고 연결만 기록한다
  const tab = await tabs.create({ url: article.url, active: true });
  await setFillPending({
    articleId,
    matchKey: article.matchKey,
    originalUrl: article.url,
    expiresAt: Date.now() + FILL_BODY_MS,
    redirectCount: 0,
    tabId: tab.id,
  });
  await setActionTooltip(i18n('fillBodyHint'));
  return { ok: true };
}

async function runImportBatch(articles, jobId) {
  const inputs = articles.map((a) => ({
    ...a,
    importJobId: jobId,
    bodyState: BODY_STATE.NONE_IMPORTED,
  }));
  return importArticlesBatch(inputs);
}

async function applyImport(articleEntries, jobId) {
  await setBackupDeferred(true);
  const job = {
    jobId,
    status: 'running',
    processedIndex: 0,
    totalCount: articleEntries.length,
    startedAt: Date.now(),
  };
  await setImportJob(job);

  let processed = 0;
  for (let i = 0; i < articleEntries.length; i += IMPORT_BATCH_SIZE) {
    const batch = articleEntries.slice(i, i + IMPORT_BATCH_SIZE).map((e) => e.article);
    await runImportBatch(batch, jobId);
    processed += batch.length;
    job.processedIndex = processed;
    await setImportJob(job);
  }

  await saveUndoRecord(jobId, { kind: 'import', at: Date.now(), count: articleEntries.length });
  job.status = 'done';
  await setImportJob(job);
  await setBackupDeferred(false);
  await afterDataMutation();
  return { ok: true, count: articleEntries.length, jobId };
}

async function resumeImport(articleEntries, jobId) {
  const existing = await getImportJob();
  if (!existing || existing.jobId !== jobId) {
    return { ok: false, code: 'no_job' };
  }
  // 다시 고른 파일의 미리보기에서 이미 들어간 글은 중복으로 빠지므로, 앞을 건너뛰지 않고 받은 목록 전체를 같은 작업 번호로 넣는다
  const start = existing.processedIndex || 0;
  const remaining = articleEntries;
  await setBackupDeferred(true);
  existing.status = 'running';
  existing.totalCount = start + remaining.length;
  await setImportJob(existing);

  let processed = start;
  for (let i = 0; i < remaining.length; i += IMPORT_BATCH_SIZE) {
    const batch = remaining.slice(i, i + IMPORT_BATCH_SIZE).map((e) => e.article);
    await runImportBatch(batch, jobId);
    processed += batch.length;
    existing.processedIndex = processed;
    await setImportJob(existing);
  }

  await saveUndoRecord(jobId, { kind: 'import', at: Date.now(), count: existing.totalCount });
  existing.status = 'done';
  await setImportJob(existing);
  await setBackupDeferred(false);
  await afterDataMutation();
  return { ok: true, count: remaining.length, jobId };
}

async function cancelImportJob(jobId) {
  const res = await deleteByImportJobId(jobId);
  await setImportJob(null);
  await setBackupDeferred(false);
  await afterDataMutation();
  return { ok: true, deleted: res.count };
}

async function undoImportJob(jobId) {
  const res = await deleteByImportJobId(jobId);
  await afterDataMutation();
  return { ok: true, deleted: res.count };
}

async function exportSelected(ids, format) {
  const items = [];
  for (const id of ids) {
    const article = await getArticle(id);
    if (!article) continue;
    const html = await getArticleBody(id);
    items.push({ article, html });
  }
  if (!items.length) return { ok: false, code: 'empty' };
  return { ok: true, items, format };
}

async function undoLastSave() {
  if (!lastSave) {
    await setActionTooltip(i18n('undoNone'));
    return { ok: false, code: 'none' };
  }
  const age = Date.now() - lastSave.at;
  if (age > UNDO_WINDOW_MS) {
    await setActionTooltip(i18n('undoExpired'));
    return { ok: false, code: 'expired' };
  }
  await deleteArticle(lastSave.id);
  const id = lastSave.id;
  lastSave = null;
  await showBadge('-');
  await setActionTooltip(i18n('undoDone'));
  await afterDataMutation();
  return { ok: true, id };
}

browserApi.runtime.onInstalled.addListener((details) => {
  ensureDb().catch(() => {});
  scheduleTrashCleanup().catch(() => {});
  if (details.reason === 'install') {
    loadSettings(storage.local)
      .then(async (settings) => {
        if (settings.installedAt == null) {
          await saveSettings(storage.local, { installedAt: Date.now() });
        }
      })
      .catch(() => {});
  }
});

if (alarms?.onAlarm) {
  alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === TRASH_ALARM) runTrashCleanup();
    if (alarm.name === ALARM_BACKUP) runBackup('alarm').catch(console.error);
    if (alarm.name === ALARM_WATCHDOG) reconcileBackupStartup().catch(console.error);
  });
}

if (downloads?.onChanged) {
  downloads.onChanged.addListener((delta) => handleDownloadChanged(delta));
}

async function recoverInterruptedImport() {
  const job = await getImportJob();
  if (job?.status === 'running' && job.processedIndex < job.totalCount) {
    job.status = 'paused';
    await setImportJob(job);
    await setBackupDeferred(true);
  }
}

registerContextMenus();
ensureDb()
  .then(() => runTrashCleanup())
  .then(() => recoverInterruptedImport())
  .then(() => reconcileBackupStartup())
  .catch(() => {});
scheduleTrashCleanup().catch(() => {});

storage.local.get(BACKUP_DEFER_KEY).then((data) => {
  setBackupEngineDeferred(!!data[BACKUP_DEFER_KEY]);
}).catch(() => {});

browserApi.commands.onCommand.addListener((command) => {
  if (command !== 'save-article') return;
  tabs.query({ active: true, currentWindow: true }).then((list) => {
    const tab = list[0];
    if (tab) {
      saveFromTab(tab, { feedback: 'toast' }).catch(() => showBadgeFail());
    }
  });
});

if (contextMenus?.onClicked) {
  contextMenus.onClicked.addListener((info, tab) => {
    runMenuTask(async () => {
      if (info.menuItemId === 'rl-save-page' && tab) {
        await saveFromTab(tab, { feedback: 'toast' });
        return;
      }
      if (info.menuItemId === 'rl-open-library-page' || info.menuItemId === 'rl-open-library') {
        await openLibrary();
        return;
      }
      if (info.menuItemId === 'rl-undo-save') {
        await undoLastSave();
      }
    });
  });
}

browserApi.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handle = async () => {
    switch (msg.type) {
      case 'listArticles':
        return { ok: true, articles: await listArticles() };

      case 'getArticle': {
        const article = await getArticle(msg.id);
        if (!article) return { ok: false, code: 'not_found' };
        const html = await getArticleBody(msg.id);
        return { ok: true, article, html };
      }

      case 'markRead': {
        const res = await markArticleRead(msg.id);
        return res ? { ok: true, article: res.article } : { ok: false };
      }

      case 'savePosition': {
        await savePosition(msg.id, msg.position);
        return { ok: true };
      }

      case 'restoreBody': {
        const res = await restorePreviousBody(msg.id);
        return res ? { ok: true, article: res.article } : { ok: false, code: 'none' };
      }

      case 'refreshBody':
        return startFillBody(msg.id);


      case 'getSettings':
        return { ok: true, settings: await loadSettings(storage.local) };

      case 'updateSettings': {
        const settings = await saveSettings(storage.local, msg.patch || {});
        return { ok: true, settings };
      }

      case 'undoLastSave':
        return undoLastSave();

      case 'getTabSaveState':
        return getTabSaveState(msg.tabId, msg.url, msg.title);

      case 'saveTabArticle': {
        const tab = await tabs.get(msg.tabId);
        const result = await saveFromTab(tab, { feedback: 'none' });
        return formatSaveResult(result);
      }

      case 'refreshTabBody': {
        const tab = await tabs.get(msg.tabId);
        const result = await saveFromTab(tab, { forceUpdate: true, feedback: 'none' });
        return formatSaveResult(result);
      }

      case 'undoArticleSave':
        return undoArticleSave(msg.id);

      case 'listRecentArticles':
        return listRecentArticles(msg.limit || 5);

      case 'focusLibrary':
      case 'openLibrary':
        return openLibrary(msg.query || '');

      case 'openReader':
        await openReaderTab(msg.id);
        return { ok: true };

      case 'getSearchCorpus':
        return { ok: true, corpus: await getSearchCorpus() };

      case 'getBodiesForPreview': {
        const bodies = await getBodiesByIds(msg.ids || []);
        return { ok: true, bodies };
      }

      case 'getTags':
        return { ok: true, tags: await getAllTags() };

      case 'getMatchKeys':
        return { ok: true, keys: await getAllMatchKeys() };

      case 'bulkMarkRead': {
        const res = await bulkMarkRead(msg.ids || []);
        await afterDataMutation();
        return { ok: true, ...res };
      }

      case 'bulkArchive': {
        const res = await bulkMoveToArchive(msg.ids || []);
        await afterDataMutation();
        return { ok: true, ...res };
      }

      case 'bulkTrash':
        await bulkMoveToTrash(msg.ids || []);
        await afterDataMutation();
        return { ok: true };

      case 'bulkRestore':
        await bulkRestoreFromTrash(msg.ids || []);
        await afterDataMutation();
        return { ok: true };

      case 'bulkAddTags': {
        const res = await bulkAddTags(msg.ids || [], msg.tags || []);
        await afterDataMutation();
        return { ok: true, ...res };
      }

      case 'bulkDelete': {
        for (const id of msg.ids || []) await deleteArticle(id);
        await afterDataMutation();
        return { ok: true };
      }

      case 'purgeTrash': {
        const res = await purgeExpiredTrash();
        if (res.count > 0) await afterDataMutation();
        return { ok: true, ...res };
      }

      case 'getImportJob':
        return { ok: true, job: await getImportJob(), backupDeferred: !!(await storage.local.get(BACKUP_DEFER_KEY))[BACKUP_DEFER_KEY] };

      case 'importApply': {
        const entries = (msg.articles || []).filter((e) => e.kind !== 'duplicate');
        const jobId = msg.jobId || generateId();
        if (msg.resume) return resumeImport(entries, jobId);
        return applyImport(entries, jobId);
      }

      case 'importCancel':
        return cancelImportJob(msg.jobId);

      case 'importUndo':
        return undoImportJob(msg.jobId);

      case 'startFillBody':
        return startFillBody(msg.id);

      case 'getFillPending':
        return { ok: true, pending: await getFillPending() };

      case 'clearFillPending':
        await setFillPending(null);
        return { ok: true };

      case 'exportArticles':
        return exportSelected(msg.ids || [], msg.format);

      case 'getLibraryState': {
        const data = await storage.local.get([FIRST_RUN_KEY, BACKUP_DEFER_KEY]);
        const backup = await getBackupStatus();
        const replaceUndo = await getReplaceUndoPointer();
        const settings = await loadSettings(storage.local);
        const snapshots = await listIdbSnapshots();
        return {
          ok: true,
          firstRunDone: !!data[FIRST_RUN_KEY],
          backupDeferred: !!data[BACKUP_DEFER_KEY],
          backup,
          replaceUndo,
          settings,
          latestSnapshotAt: snapshots[0]?.createdAt || null,
        };
      }

      case 'deleteAllData':
        return doDeleteAllData();

      case 'getBackupStatus':
        return { ok: true, status: await getBackupStatus() };

      case 'backupNow':
        return { ok: true, state: await runBackup('manual') };

      case 'exportBackupJson': {
        const payload = await requestBackupDownloadBlob('export');
        return {
          ok: true,
          url: payload.url,
          sha256: payload.sha256,
          dataRevision: payload.dataRevision,
          articleCount: payload.articleCount,
          bytes: payload.bytes,
        };
      }

      case 'notifyDataChanged':
        await markDataDirty();
        return { ok: true };

      case 'dismissBackupNotice':
        await markFirstBackupNoticeShown();
        return { ok: true };

      case 'dismissFirstRun':
        await storage.local.set({ [FIRST_RUN_KEY]: true });
        return { ok: true };

      case 'requestBodyRefresh': {
        const article = await getArticle(msg.id);
        if (!article) return { ok: false, code: 'not_found' };
        return { ok: true, article, needsConfirm: true };
      }

      case 'confirmBodyRefresh':
        return startFillBody(msg.id);


      default:
        return { ok: false, code: 'unknown' };
    }
  };

  handle()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, message: err?.message }));
  return true;
});

export { isFirefox };
