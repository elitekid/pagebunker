// 툴바 작은 창: 현재 탭 상태·저장·최근 글

import { browserApi, storage, tabs } from '../shared/browser.js';
import { BODY_STATE, deriveFileStatus, loadSettings, LOCATION, READ_STATE } from '../shared/model.js';

const RECENT_LIMIT = 5;
const AVATAR_VARS = [
  '--avatar-1', '--avatar-2', '--avatar-3', '--avatar-4',
  '--avatar-5', '--avatar-6', '--avatar-7', '--avatar-8',
];

const $ = (sel) => document.querySelector(sel);

let activeTab = null;
let tabState = null;
let recentArticles = [];
let saving = false;
let resultToast = null;
let backupPayload = null;
let searchFocus = false;

function t(key, subs = []) {
  return browserApi.i18n.getMessage(key, subs.map(String)) || key;
}

async function send(type, payload = {}) {
  try {
    return await browserApi.runtime.sendMessage({ type, ...payload });
  } catch (err) {
    return { ok: false, code: 'error', message: err?.message || String(err) };
  }
}

function applyTheme(settings) {
  const root = document.documentElement;
  root.classList.remove('theme-light', 'theme-dark');
  if (settings?.theme === 'light') root.classList.add('theme-light');
  else if (settings?.theme === 'dark') root.classList.add('theme-dark');
}

function applyI18n() {
  const uiLang = browserApi.i18n.getUILanguage?.() || 'en';
  document.documentElement.lang = uiLang.split('-')[0] || 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const msg = browserApi.i18n.getMessage(el.getAttribute('data-i18n'));
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const msg = browserApi.i18n.getMessage(el.getAttribute('data-i18n-placeholder'));
    if (msg) el.placeholder = msg;
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const msg = browserApi.i18n.getMessage(el.getAttribute('data-i18n-aria'));
    if (msg) el.setAttribute('aria-label', msg);
  });
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return t('popupBackupJustNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('popupBackupMinutesAgo', [min]);
  const hr = Math.floor(min / 60);
  if (hr < 48) return t('popupBackupHoursAgo', [hr]);
  const uiLang = browserApi.i18n.getUILanguage?.() || 'en';
  try {
    return new Date(ts).toLocaleString(uiLang, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return '';
  }
}

function backupErrorMessage(code) {
  const map = {
    access: 'backupErrAccess',
    disk: 'backupErrDisk',
    name: 'backupErrName',
    stalled: 'backupErrStalled',
    unknown: 'backupErrUnknown',
  };
  return t(map[code] || 'backupErrUnknown');
}

function renderBackupStatus() {
  const el = $('#backup-status');
  if (!backupPayload?.ok) {
    el.textContent = '';
    return;
  }
  const { status, settings } = backupPayload;
  const derived = deriveFileStatus(
    { revision: status.revision },
    {
      lastFileOkRevision: status.lastFileOkRevision,
      lastFileOkAt: status.lastFileOkAt,
      inflight: status.inflight,
      lastError: status.lastError,
    },
    settings,
  );
  let dotClass = 'status-dot';
  let text = '';
  switch (derived) {
    case 'off':
      dotClass += ' off';
      text = t('popupBackupOff');
      break;
    case 'paused':
      dotClass += ' failed';
      text = t('backupFilePaused');
      break;
    case 'writing':
      dotClass += ' writing';
      text = t('popupBackupWriting');
      break;
    case 'failed':
      dotClass += ' failed';
      text = t('popupBackupFailed', [backupErrorMessage(status?.lastError?.code)]);
      break;
    case 'pending':
      dotClass += ' pending';
      text = status?.lastFileOkAt
        ? t('popupBackupPending', [formatRelativeTime(status.lastFileOkAt)])
        : t('popupBackupPendingNever');
      break;
    case 'ok':
      text = t('popupBackupOk', [formatRelativeTime(status?.lastFileOkAt)]);
      break;
    default:
      dotClass += ' off';
      text = t('popupBackupNever');
  }
  el.innerHTML = `<span class="${dotClass}" aria-hidden="true"></span><span>${text}</span>`;
}

async function renderBackupNotice() {
  const notice = $('#backup-notice');
  const status = backupPayload?.status;
  const settings = backupPayload?.settings;
  // TabBunker와 같이 첫 백업 전(처음 창을 열 때)부터 보여 준다
  const show = !!settings?.autoFileBackup && !status?.firstBackupNoticeShown;
  notice.classList.toggle('hidden', !show);
  if (!show) return;
  const isFirefox = typeof browserApi.runtime.getBrowserInfo === 'function';
  $('#backup-notice-firefox').classList.toggle('hidden', !isFirefox);
}

function articleStatusLabel(article) {
  if (article.bodyState === BODY_STATE.LINK_ONLY
    || article.bodyState === BODY_STATE.NONE_IMPORTED) {
    return t('bodyLinkOnly');
  }
  if (article.location === LOCATION.ARCHIVE) return t('tabArchive');
  if (article.readState === READ_STATE.READ) return t('tabRead');
  return t('tabUnread');
}

function formatSavedDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString();
}

function domainLetter(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host ? host[0].toUpperCase() : '?';
  } catch {
    return '?';
  }
}

function avatarColorVar(domain) {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) | 0;
  }
  return AVATAR_VARS[Math.abs(hash) % AVATAR_VARS.length];
}

function siteLabel(article) {
  // 작성자·매체명이 섞이는 siteName 대신 주소의 사이트를 먼저 보여 준다(스펙 4.9)
  try {
    const host = new URL(article.url).hostname.replace(/^www\./, '');
    if (host) return host;
  } catch {
    /* 주소가 없으면 아래로 */
  }
  return article.siteName || '';
}

function showResultToast(kind, articleId = null) {
  resultToast = { kind, articleId };
  const toast = $('#toast');
  const text = $('#toast-text');
  const undoBtn = $('#btn-toast-undo');
  toast.classList.remove('hidden', 'warn');
  undoBtn.classList.add('hidden');

  if (kind === 'saved') {
    text.textContent = t('popupResultSaved');
    undoBtn.classList.remove('hidden');
    undoBtn.dataset.articleId = articleId || '';
  } else if (kind === 'link') {
    toast.classList.add('warn');
    text.textContent = t('popupResultLinkOnly');
    undoBtn.classList.remove('hidden');
    undoBtn.dataset.articleId = articleId || '';
  } else if (kind === 'undone') {
    text.textContent = t('popupResultUndone');
  } else if (kind === 'refreshed') {
    text.textContent = t('popupResultRefreshed');
  } else if (kind === 'failed') {
    toast.classList.add('warn');
    text.textContent = t('popupResultFailed');
  }
}

function hideResultToast() {
  resultToast = null;
  $('#toast').classList.add('hidden');
}

function restrictedReasonText(code) {
  switch (code) {
    case 'store':
      return t('popupReasonStore');
    case 'extension':
      return t('popupReasonExtension');
    default:
      return t('popupReasonBrowser');
  }
}

function renderPageSection() {
  const container = $('#page-content');
  container.innerHTML = '';

  if (!tabState) {
    const note = document.createElement('p');
    note.className = 'save-note';
    note.textContent = t('loading');
    container.appendChild(note);
    return;
  }

  if (!tabState.canSave) {
    const row = document.createElement('div');
    row.className = 'save-row';
    const heading = document.createElement('h2');
    heading.className = 'save-heading';
    heading.id = 'page-heading';
    heading.textContent = t('popupCannotSaveTitle');
    row.appendChild(heading);
    container.appendChild(row);

    const note = document.createElement('p');
    note.className = 'save-note';
    note.textContent = `${restrictedReasonText(tabState.reasonCode)} ${t('popupCannotSaveHint')}`;
    container.appendChild(note);
    return;
  }

  if (saving) {
    const row = document.createElement('div');
    row.className = 'save-row';
    const heading = document.createElement('h2');
    heading.className = 'save-heading';
    heading.id = 'page-heading';
    heading.textContent = tabState.title || t('untitled');
    row.appendChild(heading);
    container.appendChild(row);

    const note = document.createElement('p');
    note.className = 'save-note';
    note.textContent = tabState.host || '';
    container.appendChild(note);

    const btns = document.createElement('div');
    btns.className = 'save-btns';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn primary save-btn';
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${t('popupSaving')}`;
    btns.appendChild(btn);
    container.appendChild(btns);
    return;
  }

  const article = tabState.saved ? tabState.article : null;
  const title = article?.title || tabState.title || t('untitled');

  const row = document.createElement('div');
  row.className = 'save-row';
  const heading = document.createElement('h2');
  heading.className = 'save-heading';
  heading.id = 'page-heading';
  heading.textContent = title;
  row.appendChild(heading);

  if (article) {
    const mark = document.createElement('span');
    mark.className = 'saved-mark';
    mark.textContent = `✓ ${t('saved')}`;
    row.appendChild(mark);
  }
  container.appendChild(row);

  const note = document.createElement('p');
  note.className = 'save-note';
  if (article) {
    const meta = [
      siteLabel(article),
      t('popupSavedOn', [formatSavedDate(article.savedAt)]),
      articleStatusLabel(article),
    ].filter(Boolean).join(' · ');
    note.textContent = meta;
  } else {
    const parts = [tabState.host || ''].filter(Boolean);
    note.textContent = parts.join(' · ') || t('popupSaveHint');
  }
  container.appendChild(note);

  const btns = document.createElement('div');
  btns.className = 'save-btns';

  if (article) {
    const readBtn = document.createElement('button');
    readBtn.type = 'button';
    readBtn.className = 'btn primary save-btn';
    readBtn.textContent = t('popupReadNow');
    readBtn.addEventListener('click', () => openReader(article.id));
    btns.appendChild(readBtn);

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn save-btn';
    refreshBtn.textContent = t('fillBodySave');
    refreshBtn.addEventListener('click', () => refreshBody());
    btns.appendChild(refreshBtn);
  } else {
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn primary save-btn';
    saveBtn.textContent = t('popupSaveArticle');
    saveBtn.addEventListener('click', () => saveCurrentTab());
    btns.appendChild(saveBtn);
  }
  container.appendChild(btns);
}

function filterRecent(query) {
  const q = query.trim().toLowerCase();
  if (!q) return recentArticles;
  return recentArticles.filter((a) => {
    const title = (a.title || '').toLowerCase();
    const site = siteLabel(a).toLowerCase();
    return title.includes(q) || site.includes(q);
  });
}

function renderArticles() {
  const query = $('#search').value;
  const filtered = filterRecent(query);
  const listEl = $('#article-list');
  listEl.innerHTML = '';

  const hasAny = recentArticles.length > 0;
  $('#groups-empty').classList.toggle('hidden', hasAny);
  $('#saved-label').classList.toggle('hidden', !hasAny);
  $('#search').classList.toggle('hidden', !hasAny);
  $('#groups-nomatch').classList.toggle('hidden', !hasAny || !query || filtered.length > 0);

  const highlightId = resultToast?.articleId;
  for (const article of filtered.slice(0, RECENT_LIMIT)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'art-card';
    if (article.id === highlightId) btn.classList.add('hl');
    btn.setAttribute('role', 'listitem');

    const domain = siteLabel(article);
    const fav = document.createElement('span');
    fav.className = 'favicon';
    fav.textContent = domainLetter(article.url);
    fav.style.background = `var(${avatarColorVar(domain || '?')})`;

    const main = document.createElement('span');
    main.className = 'art-main';
    const titleEl = document.createElement('div');
    titleEl.className = 'art-title';
    titleEl.textContent = article.title || t('untitled');
    const metaEl = document.createElement('div');
    metaEl.className = 'art-meta';
    const timePart = article.bodyState === BODY_STATE.LINK_ONLY
      || article.bodyState === BODY_STATE.NONE_IMPORTED
      ? t('bodyLinkOnly')
      : t('minRead', [article.readingMinutes || 1]);
    metaEl.textContent = [siteLabel(article), formatSavedDate(article.savedAt), timePart]
      .filter(Boolean)
      .join(' · ');

    main.append(titleEl, metaEl);
    btn.append(fav, main);
    btn.addEventListener('click', () => openReader(article.id));
    listEl.appendChild(btn);
  }

  const moreEl = $('#more-note');
  if (filtered.length > RECENT_LIMIT) {
    moreEl.classList.remove('hidden');
    moreEl.textContent = t('popupMoreInLibrary', [filtered.length - RECENT_LIMIT]);
  } else {
    moreEl.classList.add('hidden');
  }
}

async function loadActiveTab() {
  const list = await tabs.query({ active: true, currentWindow: true });
  activeTab = list[0] || null;
  if (!activeTab?.id) {
    tabState = { canSave: false, reasonCode: 'browser', title: '', host: '' };
    return;
  }
  const url = activeTab.url || activeTab.pendingUrl || '';
  const res = await send('getTabSaveState', {
    tabId: activeTab.id,
    url,
    title: activeTab.title || '',
  });
  tabState = res?.ok ? res : { canSave: false, reasonCode: 'browser', title: activeTab.title || '', host: '' };
}

async function loadRecent() {
  const res = await send('listRecentArticles', { limit: 50 });
  recentArticles = res?.articles || [];
}

async function reloadBackup() {
  const statusRes = await send('getBackupStatus');
  const settings = await loadSettings(storage.local);
  backupPayload = { ok: statusRes?.ok, status: statusRes?.status, settings };
  renderBackupStatus();
  await renderBackupNotice();
}

async function saveCurrentTab() {
  if (!activeTab?.id || saving) return;
  saving = true;
  renderPageSection();
  const res = await send('saveTabArticle', { tabId: activeTab.id });
  saving = false;
  if (!res?.ok) {
    showResultToast('failed');
    renderPageSection();
    return;
  }
  if (res.result === 'saved') showResultToast('saved', res.article?.id);
  else if (res.result === 'link_only') showResultToast('link', res.article?.id);
  await loadActiveTab();
  await loadRecent();
  renderPageSection();
  renderArticles();
  await reloadBackup();
}

async function refreshBody() {
  if (!activeTab?.id || saving) return;
  saving = true;
  renderPageSection();
  const res = await send('refreshTabBody', { tabId: activeTab.id });
  saving = false;
  if (res?.ok) {
    showResultToast('refreshed');
    await loadActiveTab();
    await loadRecent();
    await reloadBackup();
  } else {
    showResultToast('failed');
  }
  renderPageSection();
  renderArticles();
}

async function undoSave(articleId) {
  const res = await send('undoArticleSave', { id: articleId });
  if (!res?.ok) return;
  showResultToast('undone');
  await loadActiveTab();
  await loadRecent();
  renderPageSection();
  renderArticles();
  await reloadBackup();
}

function openReader(id) {
  const url = browserApi.runtime.getURL(`reader/reader.html?id=${encodeURIComponent(id)}`);
  tabs.create({ url, active: true }).then(() => window.close());
}

async function dismissBackupNotice() {
  await send('dismissBackupNotice');
  $('#backup-notice').classList.add('hidden');
}

function setupListeners() {
  $('#btn-toast-undo').addEventListener('click', () => {
    const id = $('#btn-toast-undo').dataset.articleId;
    if (id) undoSave(id);
  });
  $('#btn-notice-ok').addEventListener('click', () => dismissBackupNotice());
  $('#btn-notice-settings').addEventListener('click', async () => {
    await dismissBackupNotice();
    browserApi.runtime.openOptionsPage();
    window.close();
  });
  $('#search').addEventListener('input', () => renderArticles());
  $('#btn-open-library').addEventListener('click', async () => {
    await send('focusLibrary');
    window.close();
  });
  $('#btn-settings').addEventListener('click', () => {
    browserApi.runtime.openOptionsPage();
    window.close();
  });
  $('#btn-import').addEventListener('click', async () => {
    await send('focusLibrary', { query: '?import=1' });
    window.close();
  });
}

async function init() {
  applyI18n();
  setupListeners();
  const settings = await loadSettings(storage.local);
  applyTheme(settings);
  await reloadBackup();
  await Promise.all([loadActiveTab(), loadRecent()]);
  renderPageSection();
  renderArticles();
  if (searchFocus) {
    const input = $('#search');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    searchFocus = false;
  }
}

init();
