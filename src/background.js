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
} from './shared/browser.js';
import {
  ALARM_BACKUP,
  ALARM_WATCHDOG,
  requestBackupDownloadBlob,
  getBackupStatus,
  handleDownloadChanged,
  markDataDirty,
  markFirstBackupNoticeShown,
  getReplaceUndoPointer,
  reconcileBackupStartup,
  runBackup,
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
} from './shared/db.js';
import {
  BODY_STATE,
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

function isRestrictedUrl(url) {
  if (!url) return true;
  if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:')) return true;
  if (url.startsWith('chrome-extension://') || url.startsWith('moz-extension://')) return true;
  if (url.startsWith('file:')) return true;
  // 확장 스토어는 브라우저가 스크립트 주입을 막는다
  if (/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons|addons\.mozilla\.org)(\/|$)/.test(url)) return true;
  if (url.endsWith('.pdf') || url.includes('.pdf?')) return true;
  return false;
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

async function openLibrary(query = '') {
  const url = browserApi.runtime.getURL(`library/library.html${query}`);
  await tabs.create({ url, active: true });
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
  const { forceUpdate = false } = opts;
  let fillArticleId = opts.fillArticleId ?? null;
  const tabUrl = urlOf(tab);
  const tabId = tab.id;

  // 주소를 받을 수 없거나 웹·파일 주소가 아닌 페이지(브라우저 내부 페이지 등)는 빈 글을 만들지 않는다
  if (!tabId || !/^(https?|file):/i.test(tabUrl)) {
    await showBadgeFail();
    await setActionTooltip(i18n('badgeCannotSave'));
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
    await showBadge('+');
    await setActionTooltip(i18n('badgeSavedLinkOnly'));
    await afterDataMutation();
    return { ok: true, article: saved.article, linkOnly: true };
  }

  let extract;
  try {
    extract = await runExtract(tabId);
  } catch (err) {
    console.error('extract failed:', err);
    await showBadgeFail();
    await setActionTooltip(i18n('badgeFailed'));
    return { ok: false, code: 'extract_failed' };
  }

  const finalUrl = extract.finalUrl || tabUrl;
  if (!sameDocumentUrl(finalUrl, tabUrl)) {
    await showBadge('~', BADGE_FAIL_COLOR);
    await setActionTooltip(i18n('badgePageChanged'));
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
    await showBadge(i18n('badgeExists'));
    await setActionTooltip(i18n('badgeExistsTip', [existing.title]));
    await openLibrary(`?highlight=${encodeURIComponent(existing.id)}`);
    return { ok: true, duplicate: true, article: existing };
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
    await showBadge(i18n('badgeExists'));
    await setActionTooltip(i18n('badgeBodyKept'));
    return { ok: true, article: existing, keptBody: true };
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
  await showBadge(existing ? i18n('badgeUpdated') : '+');
  await setActionTooltip(
    newIsFull ? i18n('badgeSaved') : i18n('badgeSavedLinkOnly')
  );
  if (newIsFull && !existing) {
    const settings = await loadSettings(storage.local);
    const saveCount = (settings.saveCount ?? 0) + 1;
    await saveSettings(storage.local, { saveCount });
  }
  await afterDataMutation();

  return { ok: true, article: saved.article, updated: !!existing };
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

action.onClicked.addListener((tab) => {
  saveFromTab(tab).catch((err) => {
    console.error('saveFromTab:', err);
    showBadgeFail();
  });
});

browserApi.commands.onCommand.addListener((command) => {
  if (command !== 'save-article') return;
  tabs.query({ active: true, currentWindow: true }).then((list) => {
    const tab = list[0];
    if (tab) saveFromTab(tab).catch(() => showBadgeFail());
  });
});

if (contextMenus?.onClicked) {
  contextMenus.onClicked.addListener((info, tab) => {
    runMenuTask(async () => {
      if (info.menuItemId === 'rl-save-page' && tab) {
        await saveFromTab(tab);
        return;
      }
      if (info.menuItemId === 'rl-open-library') {
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
        return {
          ok: true,
          firstRunDone: !!data[FIRST_RUN_KEY],
          backupDeferred: !!data[BACKUP_DEFER_KEY],
          backup,
          replaceUndo,
          settings,
        };
      }

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
