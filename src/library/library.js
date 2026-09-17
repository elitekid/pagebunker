// 보관함: 목록·검색·가져오기·보내기 (plan 4-5~4-7, T4.5~T5.5)

import { browserApi, downloads, tabs } from '../shared/browser.js';
import { exportArticleMarkdown, exportArticlesHtml, setExportLabels } from '../shared/exporters.js';
import { filterArticles, sortArticles } from '../shared/db.js';
import {
  restoreBackupMergeFromValidated,
  restoreBackupReplaceFromValidated,
  undoReplaceRestore,
} from '../shared/restore-page.js';
import { extractSearchTextFromHtml } from '../shared/sanitize.js';
import { extractPreviewFromDisplayText, highlightText } from '../shared/search-core.js';
import { BODY_STATE } from '../shared/model.js';
import { shouldShowReviewPrompt } from '../shared/review-prompt.js';
import { getStoreReviewUrl } from '../shared/store-links.js';

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 250;

const $ = (id) => document.getElementById(id);

function t(key, subs = []) {
  return browserApi.i18n.getMessage(key, subs.map(String)) || key;
}

async function send(type, payload = {}) {
  return browserApi.runtime.sendMessage({ type, ...payload });
}

let allArticles = [];
let currentTab = 'unread';
let currentSort = 'newest';
let currentTag = '';
let displayCount = PAGE_SIZE;
let selectMode = false;
const selected = new Set();
let searchGen = 0;
let searchWorker = null;
let searchResults = null;
let searchTimer = null;
let enrichedGen = -1;
let enrichedUpTo = 0;
let pendingImport = null;
let pendingImportJobId = null;
let lastImportJobId = null;
let replaceUndoPtr = null;
let highlightId = null;
let settings = {};
let firstRunDone = false;
let backupState = null;

function applyI18n() {
  const uiLang = browserApi.i18n.getUILanguage?.() || 'en';
  document.documentElement.lang = uiLang.split('-')[0] || 'en';
  document.title = t('libraryTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const msg = browserApi.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    const msg = browserApi.i18n.getMessage(key);
    if (msg) el.placeholder = msg;
  });
}

function readerUrl(id) {
  return `../reader/reader.html?id=${encodeURIComponent(id)}`;
}

function initSearchWorker() {
  if (searchWorker) return;
  const url = browserApi.runtime.getURL('workers/search.worker.js');
  searchWorker = new Worker(url, { type: 'module' });
  searchWorker.onmessage = (ev) => {
    const { type, gen, results, total } = ev.data || {};
    if (type === 'cancelled' || gen !== searchGen) return;
    searchResults = { results, total };
    renderList();
  };
}

function runSearch(query) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = query.trim();
    if (!q) {
      searchResults = null;
      enrichedGen = -1;
      enrichedUpTo = 0;
      renderList();
      return;
    }
    initSearchWorker();
    searchGen++;
    enrichedGen = -1;
    enrichedUpTo = 0;
    const gen = searchGen;
    searchWorker.postMessage({ type: 'cancel', gen });
    const res = await send('getSearchCorpus');
    const corpus = res?.corpus || [];
    searchWorker.postMessage({ type: 'search', gen, query: q, items: corpus, offset: 0, limit: 500 });
  }, SEARCH_DEBOUNCE_MS);
}

function bodyStateLabel(state) {
  switch (state) {
    case BODY_STATE.NONE_IMPORTED:
      return t('bodyNoneImported');
    case BODY_STATE.FAILED_IFRAME:
      return t('bodyFailedIframe');
    case BODY_STATE.LINK_ONLY:
      return t('bodyLinkOnly');
    case BODY_STATE.TOO_LARGE:
      return t('bodyTooLarge');
    default:
      return '';
  }
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString();
}

function getVisibleArticles() {
  let list;
  if (searchResults) {
    list = searchResults.results.map((r) => ({
      ...r.article,
      _preview: r.preview,
      _phrases: r.phrases,
      _terms: r.terms,
    }));
  } else {
    list = filterArticles(allArticles, { tab: currentTab, tag: currentTag });
    list = sortArticles(list, currentSort);
  }
  return list;
}

async function enrichSearchPreviews(results, limit) {
  const cap = Math.min(limit, 100);
  if (!results?.length || cap <= 0) return;
  if (searchGen === enrichedGen && cap <= enrichedUpTo) return;

  const slice = results.slice(0, cap);
  const ids = slice.map((r) => r.article.id);
  const res = await send('getBodiesForPreview', { ids });
  const bodies = res?.bodies || {};

  for (const r of slice) {
    const html = bodies[r.article.id];
    if (!html) continue;
    const displayText = extractSearchTextFromHtml(html);
    const preview = extractPreviewFromDisplayText(displayText, r.phrases || [], r.terms || []);
    if (preview) r.preview = preview;
  }

  enrichedGen = searchGen;
  enrichedUpTo = cap;
}

let renderSeq = 0;

async function renderList() {
  // 조각 보강을 기다리는 사이 새 그리기가 시작되면 이전 것은 버린다(항목 중복 방지)
  const seq = ++renderSeq;
  if (searchResults?.results?.length) {
    await enrichSearchPreviews(searchResults.results, displayCount);
    if (seq !== renderSeq) return;
  }
  const listEl = $('list');
  const emptyEl = $('empty');
  const loadMoreEl = $('btn-load-more');
  listEl.innerHTML = '';

  const visible = getVisibleArticles();
  const slice = visible.slice(0, displayCount);

  if (!slice.length) {
    emptyEl.classList.remove('hidden');
    loadMoreEl.classList.add('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  for (const article of slice) {
    const li = document.createElement('li');
    li.className = 'article-item';
    if (selectMode) li.classList.add('select-mode');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'item-select';
    cb.checked = selected.has(article.id);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(article.id);
      else selected.delete(article.id);
      updateSelectionBar();
    });
    li.appendChild(cb);

    const card = document.createElement('div');
    card.className = 'article-card';
    if (highlightId && article.id === highlightId) card.classList.add('highlight');

    const titleLink = document.createElement('a');
    titleLink.className = 'title-link';
    titleLink.href = readerUrl(article.id);
    titleLink.textContent = article.title || article.url;
    card.appendChild(titleLink);

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    const parts = [article.siteName, formatDate(article.savedAt), t('minRead', [String(article.readingMinutes || 1)])];
    meta.textContent = parts.filter(Boolean).join(' · ');
    card.appendChild(meta);

    if (article._preview) {
      const prev = document.createElement('div');
      prev.className = 'item-preview';
      prev.appendChild(highlightText(article._preview, article._phrases || [], article._terms || []));
      card.appendChild(prev);
    } else if (article.excerpt) {
      const prev = document.createElement('div');
      prev.className = 'item-preview';
      prev.textContent = article.excerpt;
      card.appendChild(prev);
    }

    if (article.tags?.length) {
      const tagsEl = document.createElement('div');
      for (const tag of article.tags) {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.textContent = tag;
        tagsEl.appendChild(chip);
      }
      card.appendChild(tagsEl);
    }

    const badges = document.createElement('div');
    badges.className = 'item-badges';
    const bodyLabel = bodyStateLabel(article.bodyState);
    if (bodyLabel) {
      const b = document.createElement('span');
      b.className = 'badge badge-warn';
      b.textContent = bodyLabel;
      badges.appendChild(b);
    }
    if (article.source && article.source !== 'save') {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = article.source;
      badges.appendChild(b);
    }
    if (badges.childNodes.length) card.appendChild(badges);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    if (article.bodyState === BODY_STATE.NONE_IMPORTED || article.bodyState === BODY_STATE.LINK_ONLY || article.bodyState === BODY_STATE.FAILED_IFRAME) {
      const fillBtn = document.createElement('button');
      fillBtn.type = 'button';
      fillBtn.textContent = t('fillBody');
      fillBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await send('startFillBody', { id: article.id });
      });
      actions.appendChild(fillBtn);
    }

    if (highlightId && article.id === highlightId) {
      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.textContent = article.bodyState === BODY_STATE.FULL ? t('refreshBody') : t('fillBodySave');
      refreshBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const ok = await confirmDialog(t('confirmRefreshBody'));
        if (!ok) return;
        const res = await send('confirmBodyRefresh', { id: article.id });
        if (res?.ok) await reload();
        else if (res?.code === 'no_tab') alert(t('openOriginalFirst'));
      });
      actions.appendChild(refreshBtn);
    }

    if (currentTab === 'trash') {
      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.textContent = t('restore');
      restoreBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await send('bulkRestore', { ids: [article.id] });
        await reload();
      });
      actions.appendChild(restoreBtn);
    }

    if (actions.childNodes.length) card.appendChild(actions);
    li.appendChild(card);
    listEl.appendChild(li);
  }

  loadMoreEl.classList.toggle('hidden', slice.length >= visible.length);
  updateSelectionBar();
}

function updateSelectionBar() {
  const bar = $('selection-bar');
  const exportBtn = $('btn-export');
  if (!selectMode) {
    bar.classList.add('hidden');
    exportBtn.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  exportBtn.classList.remove('hidden');
  $('selection-count').textContent = t('selectedCount', [String(selected.size)]);
  $('btn-sel-restore').classList.toggle('hidden', currentTab !== 'trash');
}

async function reload() {
  const res = await send('listArticles');
  allArticles = res?.articles || [];
  const tagsRes = await send('getTags');
  const tagSelect = $('tag-filter');
  const cur = tagSelect.value;
  tagSelect.innerHTML = `<option value="">${t('allTags')}</option>`;
  for (const tag of tagsRes?.tags || []) {
    const opt = document.createElement('option');
    opt.value = tag;
    opt.textContent = tag;
    tagSelect.appendChild(opt);
  }
  tagSelect.value = cur;
  renderList();
}

function renderImportPreview(result) {
  const el = $('import-preview');
  $('btn-restore-merge')?.classList.add('hidden');
  $('btn-restore-replace')?.classList.add('hidden');
  if (!result || result.format === 'unknown') {
    el.textContent = t('importUnsupported');
    $('btn-import-apply').disabled = true;
    return;
  }
  if (result.format === 'backup') {
    const count = result.validated?.meta?.articleCount ?? result.validated?.entries?.length ?? 0;
    el.textContent = count
      ? `${t('restorePrompt')} (${count})`
      : t('restorePrompt');
    $('btn-import-apply').disabled = true;
    $('btn-restore-merge')?.classList.remove('hidden');
    $('btn-restore-replace')?.classList.remove('hidden');
    pendingImport = { result, validated: result.validated };
    return;
  }
  const s = result.stats || {};
  const toImport = (result.articles || []).filter((a) => a.kind !== 'duplicate');
  let html = `<p>${t('importStats', [
    String(s.newCount || 0),
    String(s.duplicateCount || 0),
    String(s.candidateCount || 0),
    String(s.errorCount || 0),
  ])}</p>`;
  html += `<p>${t('importWillAdd', [String(toImport.length)])}</p>`;
  if (result.errors?.length) {
    html += `<p>${t('importErrors')}</p><ul>`;
    for (const err of result.errors.slice(0, 5)) {
      html += `<li class="error-sample">${escapeHtml(String(err.line))}: ${escapeHtml(err.sample || err.reason || '')}</li>`;
    }
    html += '</ul>';
  }
  el.innerHTML = html;
  $('btn-import-apply').disabled = toImport.length === 0;
  pendingImport = { result, toImport };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    $('confirm-message').textContent = message;
    const dlg = $('confirm-dialog');
    const yes = $('btn-confirm-yes');
    const onYes = () => { dlg.close(); yes.removeEventListener('click', onYes); resolve(true); };
    yes.addEventListener('click', onYes);
    dlg.addEventListener('close', () => resolve(false), { once: true });
    dlg.showModal();
  });
}

async function handleStandardImportFile(file) {
  if (file.size > 50 * 1024 * 1024) {
    renderImportPreview({ format: 'unknown' });
    $('import-preview').textContent = t('importTooLarge');
    return;
  }
  const buffer = await file.arrayBuffer();
  const keysRes = await send('getMatchKeys');
  const worker = new Worker(browserApi.runtime.getURL('workers/import.worker.js'), { type: 'module' });
  worker.onmessage = (ev) => {
    if (ev.data?.type === 'preview') {
      renderImportPreview(ev.data.result);
      worker.terminate();
    } else if (ev.data?.type === 'error') {
      $('import-preview').textContent = t('importDecodeError');
      $('btn-import-apply').disabled = true;
      worker.terminate();
    }
  };
  // 이어서 가져오기 중이면 원래 작업 번호를 유지한다(일반 가져오기 버튼에서만 초기화)
  worker.postMessage({ type: 'preview', buffer, existingKeys: keysRes?.keys || [] });
}

async function handleBackupImportFile(file) {
  const worker = new Worker(browserApi.runtime.getURL('workers/restore.worker.js'), { type: 'module' });
  let failed = false;

  worker.onmessage = (ev) => {
    if (ev.data?.type === 'validated') {
      const result = ev.data.result;
      if (result.ok) {
        renderImportPreview({ format: 'backup', validated: result });
      } else if (
        result.code === 'bad_schema' ||
        result.code === 'bad_header' ||
        result.code === 'invalid_json'
      ) {
        handleStandardImportFile(file);
      } else {
        $('import-preview').textContent = t('restoreFailed', [result.code || '']);
        $('btn-import-apply').disabled = true;
      }
      worker.terminate();
    } else if (ev.data?.type === 'error') {
      $('import-preview').textContent = t('importDecodeError');
      $('btn-import-apply').disabled = true;
      worker.terminate();
    }
  };

  worker.postMessage({ type: 'validateStart' });
  try {
    const reader = file.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      worker.postMessage({ type: 'validateChunk', chunk: value });
    }
    worker.postMessage({ type: 'validateEnd' });
  } catch {
    failed = true;
    $('import-preview').textContent = t('importDecodeError');
    $('btn-import-apply').disabled = true;
    worker.terminate();
  }
  if (!failed) pendingImportJobId = null;
}

async function handleImportFile(file) {
  if (!file) return;
  if (/\.json$/i.test(file.name)) {
    return handleBackupImportFile(file);
  }
  return handleStandardImportFile(file);
}

function backupErrorLabel(lastError) {
  const code = lastError?.code || 'unknown';
  const key = `backupError_${code}`;
  const localized = browserApi.i18n.getMessage(key);
  if (localized) return localized;
  if (lastError?.message) return lastError.message;
  return t('backupStatusError');
}

function updateReplaceUndoButton(ptr) {
  const btn = $('btn-restore-undo');
  if (!btn) return;
  if (!ptr?.jobId) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
  const when = ptr.at ? new Date(ptr.at).toLocaleString() : '';
  btn.textContent = when ? t('restoreUndoReplaceAt', [when]) : t('restoreUndoReplace');
}

function renderBackupStatus(backup) {
  backupState = backup;
  const el = $('backup-status');
  if (!backup) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  if (backup.deferred) {
    el.textContent = t('backupDeferred');
    return;
  }
  if (backup.lastError) {
    el.textContent = backupErrorLabel(backup.lastError);
    return;
  }
  if (backup.dirty || backup.inflight) {
    el.textContent = t('backupStatusPending');
    return;
  }
  if (backup.lastFileOkAt) {
    el.textContent = t('backupStatusOk', [new Date(backup.lastFileOkAt).toLocaleString()]);
  } else {
    el.textContent = t('backupStatusNever');
  }
  renderReviewBanner();
}

function isReviewBannerBlocked() {
  if (!firstRunDone) return true;
  if (!$('onboarding').classList.contains('hidden')) return true;
  if ($('import-dialog').open) return true;
  return false;
}

function renderReviewBanner() {
  const banner = $('review-banner');
  if (!banner) return;
  const reviewUrl = getStoreReviewUrl();
  if (!reviewUrl) {
    banner.classList.add('hidden');
    return;
  }
  const show =
    shouldShowReviewPrompt({
      settings,
      backupState,
      firstRunDone,
    }) && !isReviewBannerBlocked();
  banner.classList.toggle('hidden', !show);
}

async function maybeShowBackupNotice(backup) {
  const notice = $('backup-notice');
  if (!backup?.firstBackupDone || backup.firstBackupNoticeShown) {
    notice.classList.add('hidden');
    return;
  }
  notice.classList.remove('hidden');
  $('backup-notice-text').textContent = t('backupLocationNotice', [backup.subfolder || 'PageBunker']);
}

async function applyImport() {
  if (!pendingImport?.toImport?.length) return;
  const jobRes = await send('getImportJob');
  const resume = jobRes?.job?.status === 'paused' && pendingImportJobId;
  const res = await send('importApply', {
    articles: pendingImport.toImport,
    jobId: pendingImportJobId || undefined,
    resume,
  });
  if (res?.ok) {
    pendingImportJobId = null;
    lastImportJobId = res.jobId;
    $('btn-import-undo').classList.remove('hidden');
    $('import-dialog').close();
    await reload();
  }
}

async function checkImportResume() {
  const res = await send('getImportJob');
  const job = res?.job;
  const el = $('import-resume');
  if (!job || job.status === 'done') {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  if ((job.status === 'paused' || job.status === 'running') && job.processedIndex < job.totalCount) {
    el.innerHTML = `<p>${t('importInterrupted', [String(job.processedIndex), String(job.totalCount)])}</p>
      <button type="button" id="btn-resume-import">${t('importResume')}</button>
      <button type="button" id="btn-cancel-import">${t('importCancelJob')}</button>`;
    $('btn-resume-import').addEventListener('click', () => {
      pendingImportJobId = job.jobId;
      $('import-dialog').showModal();
      renderReviewBanner();
      el.textContent = t('importReselectFile');
    });
    $('btn-cancel-import').addEventListener('click', async () => {
      const ok = await confirmDialog(t('importCancelConfirm'));
      if (ok) {
        await send('importCancel', { jobId: job.jobId });
        await reload();
        checkImportResume();
      }
    });
  }
}

// 첫 실행 안내에 실제 배정된 단축키를 보여준다. 다른 확장과 겹쳐 배정되지 않았으면 설정 방법을 안내한다
async function showShortcutHint() {
  const el = $('onboarding-shortcut');
  if (!el || !browserApi.commands?.getAll) return;
  try {
    const cmds = await browserApi.commands.getAll();
    const cmd = cmds.find((c) => c.name === 'save-article');
    const isFirefox = !!browserApi.runtime.getManifest().browser_specific_settings?.gecko;
    el.textContent = cmd?.shortcut
      ? t('onboardingShortcut', [cmd.shortcut])
      : isFirefox
        ? t('onboardingShortcutUnsetFirefox')
        : t('onboardingShortcutUnset', [navigator.userAgent.includes('Edg/') ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts']);
  } catch {
    el.textContent = '';
  }
}

async function init() {
  applyI18n();
  setExportLabels({
    title: t('exportDocTitle'),
    image: t('exportImageLabel'),
    lang: (browserApi.i18n.getUILanguage() || 'en').split('-')[0],
  });

  const params = new URLSearchParams(location.search);
  highlightId = params.get('highlight');

  const stateRes = await send('getLibraryState');
  firstRunDone = !!stateRes?.firstRunDone;
  settings = stateRes?.settings || {};
  if (!firstRunDone) {
    $('onboarding').classList.remove('hidden');
    showShortcutHint();
  }
  renderBackupStatus(stateRes?.backup);
  maybeShowBackupNotice(stateRes?.backup);
  replaceUndoPtr = stateRes?.replaceUndo || null;
  updateReplaceUndoButton(replaceUndoPtr);

  await reload();
  await checkImportResume();
  renderReviewBanner();

  $('search').addEventListener('input', (e) => runSearch(e.target.value));

  $('sort').addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderList();
  });

  $('tag-filter').addEventListener('change', (e) => {
    currentTag = e.target.value;
    displayCount = PAGE_SIZE;
    renderList();
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab;
      displayCount = PAGE_SIZE;
      selected.clear();
      renderList();
    });
  });

  $('btn-load-more').addEventListener('click', () => {
    displayCount += PAGE_SIZE;
    renderList();
  });

  $('btn-select-mode').addEventListener('click', () => {
    selectMode = !selectMode;
    selected.clear();
    $('btn-select-mode').textContent = selectMode ? t('cancelSelect') : t('selectMode');
    renderList();
  });

  $('btn-sel-cancel').addEventListener('click', () => {
    selectMode = false;
    selected.clear();
    $('btn-select-mode').textContent = t('selectMode');
    renderList();
  });

  $('btn-sel-read').addEventListener('click', async () => {
    await send('bulkMarkRead', { ids: [...selected] });
    selected.clear();
    await reload();
  });

  $('btn-sel-archive').addEventListener('click', async () => {
    await send('bulkArchive', { ids: [...selected] });
    selected.clear();
    await reload();
  });

  $('btn-sel-trash').addEventListener('click', async () => {
    await send('bulkTrash', { ids: [...selected] });
    selected.clear();
    await reload();
  });

  $('btn-sel-restore').addEventListener('click', async () => {
    await send('bulkRestore', { ids: [...selected] });
    selected.clear();
    await reload();
  });

  $('btn-sel-tags').addEventListener('click', () => {
    if (!selected.size) return;
    $('tag-dialog').showModal();
  });

  $('btn-tag-apply').addEventListener('click', async () => {
    const raw = $('tag-input').value;
    const tags = raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    await send('bulkAddTags', { ids: [...selected], tags });
    $('tag-dialog').close();
    $('tag-input').value = '';
    await reload();
  });

  $('btn-sel-export').addEventListener('click', () => {
    if (!selected.size) return;
    $('export-dialog').showModal();
  });

  $('btn-export').addEventListener('click', () => {
    if (!selected.size) {
      selectMode = true;
      renderList();
      return;
    }
    $('export-dialog').showModal();
  });

  $('btn-export-apply').addEventListener('click', async () => {
    const format = document.querySelector('input[name="export-format"]:checked')?.value || 'html';
    const res = await send('exportArticles', { ids: [...selected], format });
    if (!res?.ok || !res.items) return;
    if (format === 'html') {
      const html = exportArticlesHtml(res.items);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      await downloads.download({ url, filename: `PageBunker/export-${Date.now()}.html`, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } else {
      const usedNames = new Set();
      for (const item of res.items) {
        const md = exportArticleMarkdown(item);
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        // 한국어 등 유니코드 제목은 살리고 파일 이름에 쓸 수 없는 문자만 바꾼다. 같은 이름은 번호를 붙인다
        let safeTitle = (item.article.title || 'article').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'article';
        if (usedNames.has(safeTitle)) safeTitle = `${safeTitle} (${usedNames.size + 1})`;
        usedNames.add(safeTitle);
        await downloads.download({ url, filename: `PageBunker/${safeTitle}.md`, saveAs: res.items.length === 1 });
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    }
    $('export-dialog').close();
  });

  $('btn-import').addEventListener('click', () => {
    pendingImportJobId = null;
    $('import-dialog').showModal();
    renderReviewBanner();
  });

  $('btn-onboarding-import').addEventListener('click', () => {
    $('import-dialog').showModal();
    renderReviewBanner();
  });

  $('btn-onboarding-dismiss').addEventListener('click', async () => {
    await send('dismissFirstRun');
    firstRunDone = true;
    $('onboarding').classList.add('hidden');
    renderReviewBanner();
  });

  $('btn-review-write')?.addEventListener('click', async () => {
    const reviewUrl = getStoreReviewUrl();
    if (!reviewUrl || !tabs) return;
    await tabs.create({ url: reviewUrl });
    const res = await send('updateSettings', { patch: { reviewPrompt: 'rated' } });
    if (res?.ok) settings = res.settings || { ...settings, reviewPrompt: 'rated' };
    renderReviewBanner();
  });

  $('btn-review-dismiss')?.addEventListener('click', async () => {
    const res = await send('updateSettings', { patch: { reviewPrompt: 'dismissed' } });
    if (res?.ok) settings = res.settings || { ...settings, reviewPrompt: 'dismissed' };
    renderReviewBanner();
  });

  $('import-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleImportFile(file);
  });

  $('btn-import-apply').addEventListener('click', applyImport);

  $('import-dialog')?.addEventListener('close', () => {
    renderReviewBanner();
  });

  $('btn-restore-merge')?.addEventListener('click', async () => {
    if (!pendingImport?.validated) return;
    const res = await restoreBackupMergeFromValidated(pendingImport.validated);
    if (res?.ok) {
      await send('notifyDataChanged');
      $('import-dialog').close();
      await reload();
    } else {
      $('import-preview').textContent = t('restoreFailed', [res?.code || '']);
    }
  });

  $('btn-restore-replace')?.addEventListener('click', async () => {
    if (!pendingImport?.validated) return;
    const ok = await confirmDialog(t('restoreReplaceConfirm'));
    if (!ok) return;
    const res = await restoreBackupReplaceFromValidated(pendingImport.validated);
    if (res?.ok) {
      replaceUndoPtr = {
        jobId: res.undoJobId,
        at: res.at || Date.now(),
        snapshotId: res.snapshotId,
      };
      updateReplaceUndoButton(replaceUndoPtr);
      await send('notifyDataChanged');
      $('import-dialog').close();
      await reload();
    } else if (res?.code === 'snapshot_blocked') {
      $('import-preview').textContent = t('restoreSnapshotBlocked');
    } else {
      $('import-preview').textContent = t('restoreFailed', [res?.code || '']);
    }
  });

  $('btn-restore-undo')?.addEventListener('click', async () => {
    if (!replaceUndoPtr?.jobId) return;
    const ok = await confirmDialog(t('restoreUndoReplaceConfirm'));
    if (!ok) return;
    const res = await undoReplaceRestore(replaceUndoPtr.jobId);
    if (res?.ok) {
      replaceUndoPtr = null;
      updateReplaceUndoButton(null);
      await send('notifyDataChanged');
      await reload();
    } else {
      alert(t('restoreFailed', [res?.code || '']));
    }
  });

  $('btn-backup-notice-dismiss')?.addEventListener('click', async () => {
    await send('dismissBackupNotice');
    $('backup-notice').classList.add('hidden');
  });

  $('btn-import-undo').addEventListener('click', async () => {
    if (!lastImportJobId) return;
    const ok = await confirmDialog(t('importUndoConfirm'));
    if (!ok) return;
    await send('importUndo', { jobId: lastImportJobId });
    lastImportJobId = null;
    $('btn-import-undo').classList.add('hidden');
    await reload();
  });
}

init();
