// 설정 페이지

import { browserApi, downloads } from '../shared/browser.js';
import {
  backupErrorMessage,
  formatRelativeTime,
  normalizeBackupStatus,
} from '../shared/backup-status-ui.js';
import { BACKUP_SUBFOLDER, LATEST_FILENAME } from '../shared/backup.js';
import { deriveFileStatus, loadSettings } from '../shared/model.js';
import { getStoreReviewUrl, ISSUES_URL } from '../shared/store-links.js';
import { showToast } from '../shared/ui-toast.js';

const $ = (id) => document.getElementById(id);

let backupStatus = null;
let backupInProgress = false;
let saveHintTimer = null;

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

function applyI18n() {
  const uiLang = browserApi.i18n.getUILanguage?.() || 'en';
  document.documentElement.lang = uiLang.split('-')[0] || 'en';
  document.title = t('settingsTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const msg = browserApi.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
}

function notify(text, warn = false) {
  const el = $('toast');
  el.classList.toggle('warn', warn);
  showToast(el, text);
}

function flashSaved() {
  const el = $('save-hint');
  el.textContent = t('optionsSavedFlash');
  el.classList.add('saved');
  clearTimeout(saveHintTimer);
  saveHintTimer = setTimeout(() => {
    el.textContent = t('optionsAutoSaveHint');
    el.classList.remove('saved');
  }, 2000);
}

function setThemeRadio(theme) {
  const val = theme || 'auto';
  const radio = document.querySelector(`input[name="theme"][value="${val}"]`);
  if (radio) radio.checked = true;
}

function renderBackupStatusDesc() {
  const el = $('backup-status-desc');
  const folder = t('optionsBackupFolderName', [BACKUP_SUBFOLDER]);
  if (!backupStatus?.ok) {
    el.innerHTML = `<span class="status-dot off" aria-hidden="true"></span><span>${t('optionsBackupRecoverHint')} · ${folder}</span>`;
    return;
  }
  const { revision, state, settings } = backupStatus;
  const status = deriveFileStatus({ revision }, state, settings);
  let dotClass = 'status-dot';
  let text = '';
  switch (status) {
    case 'off':
      dotClass += ' off';
      text = t('optionsBackupStatusOff');
      break;
    case 'paused':
      dotClass += ' failed';
      text = t('optionsBackupStatusPaused');
      break;
    case 'writing':
      dotClass += ' writing';
      text = t('optionsBackupStatusWriting');
      break;
    case 'failed':
      dotClass += ' failed';
      text = t('optionsBackupStatusFailed', [backupErrorMessage(state?.lastError?.code, t)]);
      break;
    case 'pending':
      dotClass += ' pending';
      text = state?.lastFileOkAt
        ? t('optionsBackupStatusPending', [formatRelativeTime(state.lastFileOkAt, t)])
        : t('optionsBackupStatusPendingNever');
      break;
    case 'ok':
      text = t('optionsBackupStatusOk', [formatRelativeTime(state?.lastFileOkAt, t)]);
      break;
    default:
      dotClass += ' off';
      text = t('optionsBackupStatusNever');
  }
  el.innerHTML = `<span class="${dotClass}" aria-hidden="true"></span><span>${text} · ${folder}</span>`;
}

function updateBackupDependentUI() {
  const on = $('autoFileBackup').checked;
  document.querySelectorAll('[data-backup-dependent]').forEach((row) => {
    row.classList.toggle('disabled', !on);
  });
  $('btn-backup-now').disabled = !on || backupInProgress;
}

async function refreshBackupStatus() {
  const res = await send('getBackupStatus');
  const settings = await loadSettings(browserApi.storage.local);
  backupStatus = normalizeBackupStatus(res?.status, settings);
  renderBackupStatusDesc();
}

async function patchSettings(patch) {
  const res = await send('updateSettings', { patch });
  if (res?.ok) {
    flashSaved();
    if (patch.autoFileBackup !== undefined) {
      await refreshBackupStatus();
    }
    updateBackupDependentUI();
    return true;
  }
  notify(res?.message || String(res?.code || 'error'), true);
  return false;
}

function renderShortcutKeys(shortcut) {
  const container = $('shortcut-keys');
  container.replaceChildren();
  if (!shortcut) {
    const span = document.createElement('span');
    span.className = 'shortcut-none';
    span.textContent = t('optionsShortcutNone');
    container.appendChild(span);
    return;
  }
  const parts = shortcut.includes('+')
    ? shortcut.split('+').map((s) => s.trim()).filter(Boolean)
    : [...shortcut.replace(/\s/g, '')];
  for (const part of parts) {
    const kbd = document.createElement('kbd');
    kbd.className = 'keycap';
    kbd.textContent = part;
    container.appendChild(kbd);
  }
}

async function loadShortcutDisplay() {
  const isFirefox = typeof browserApi.runtime.getBrowserInfo === 'function';
  const changeBtn = $('btn-shortcut-change');
  const firefoxHint = $('shortcut-firefox-hint');
  if (isFirefox) {
    changeBtn.classList.add('hidden');
    firefoxHint.classList.remove('hidden');
  } else {
    changeBtn.classList.remove('hidden');
    firefoxHint.classList.add('hidden');
  }

  try {
    const cmds = await browserApi.commands.getAll();
    const saveCmd = cmds.find((c) => c.name === 'save-article');
    renderShortcutKeys(saveCmd?.shortcut || '');
  } catch {
    renderShortcutKeys('');
  }
}

async function openShortcutSettings() {
  if (typeof browserApi.runtime.getBrowserInfo === 'function') return;
  const url = navigator.userAgent.includes('Edg/')
    ? 'edge://extensions/shortcuts'
    : 'chrome://extensions/shortcuts';
  try {
    await browserApi.tabs.create({ url });
  } catch {
    $('btn-shortcut-change').classList.add('hidden');
    $('shortcut-fallback-hint').classList.remove('hidden');
  }
}

// 삭제 전 안전장치: 지울 글 개수와 백업 파일로 되살릴 수 있는지 알려 준다(스펙 4.10)
async function deleteAll() {
  const [listRes, statusRes, settings] = await Promise.all([
    send('listArticles'),
    send('getBackupStatus'),
    loadSettings(browserApi.storage.local),
  ]);
  const count = listRes?.articles?.length ?? 0;
  const st = statusRes?.status;
  const fileStatus = st
    ? deriveFileStatus(
        { revision: st.revision },
        { lastFileOkRevision: st.lastFileOkRevision, lastFileOkAt: st.lastFileOkAt, inflight: st.inflight, lastError: st.lastError },
        settings,
      )
    : 'never';
  const recoverable = fileStatus === 'ok';
  $('confirm-delete-title').textContent = t('deleteAllConfirmCount', [String(count)]);
  const note = $('confirm-delete-backup');
  note.textContent = recoverable
    ? t('deleteAllRecoverable')
    : settings.autoFileBackup
      ? t('deleteAllNotRecoverable')
      : t('deleteAllBackupOff');
  note.classList.toggle('warn', !recoverable);
  $('btn-confirm-backup-now').classList.toggle('hidden', recoverable || !settings.autoFileBackup);
  $('confirm-dialog').showModal();
  $('btn-confirm-cancel').focus();
}

async function confirmDeleteAll() {
  $('confirm-dialog').close();
  const res = await send('deleteAllData');
  if (res?.ok) {
    notify(t('deleted'));
    await refreshBackupStatus();
  } else {
    notify(res?.message || String(res?.code || 'error'), true);
  }
}

function bindAutoSave() {
  $('autoMarkRead').addEventListener('change', () => {
    patchSettings({ autoMarkRead: $('autoMarkRead').checked });
  });
  $('showImagesDefault').addEventListener('change', () => {
    patchSettings({ showImagesDefault: $('showImagesDefault').checked });
  });
  $('autoFileBackup').addEventListener('change', async () => {
    await patchSettings({ autoFileBackup: $('autoFileBackup').checked });
  });
  document.querySelectorAll('input[name="theme"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      patchSettings({ theme: radio.value });
    });
  });

  $('btn-backup-now').addEventListener('click', async () => {
    backupInProgress = true;
    updateBackupDependentUI();
    const res = await send('backupNow');
    backupInProgress = false;
    await refreshBackupStatus();
    updateBackupDependentUI();
    // 이미 최신이라 상태 줄이 그대로여도 누른 결과가 보이게 한다
    if (res?.ok === false) notify(t('backupFailed'), true);
    else notify(t('backupDone'));
  });

  $('btn-export-backup').addEventListener('click', async () => {
    const res = await send('exportBackupJson');
    if (!res?.ok || !res.url) {
      notify(t('backupFailed'), true);
      return;
    }
    try {
      await downloads.download({
        url: res.url,
        filename: `${BACKUP_SUBFOLDER}/${LATEST_FILENAME}`,
        saveAs: true,
      });
    } catch {
      notify(t('backupFailed'), true);
    }
  });

  $('btn-restore-backup').addEventListener('click', () => {
    send('openLibrary', { query: '?restore=1' });
  });

  $('btn-open-import').addEventListener('click', () => {
    send('openLibrary', { query: '?import=1' });
  });

  $('btn-open-library').addEventListener('click', () => {
    send('openLibrary');
  });

  $('btn-shortcut-change').addEventListener('click', openShortcutSettings);
  $('btn-delete-all').addEventListener('click', deleteAll);
  $('btn-confirm-delete').addEventListener('click', confirmDeleteAll);
  $('btn-confirm-backup-now').addEventListener('click', async () => {
    $('confirm-dialog').close();
    $('btn-backup-now')?.click();
  });
  $('btn-confirm-cancel').addEventListener('click', () => {
    $('confirm-dialog').close();
  });

  const reviewLink = $('link-about-review');
  if (!getStoreReviewUrl()) reviewLink.classList.add('hidden');
}

async function init() {
  const settings = await loadSettings(browserApi.storage.local);
  applyI18n();

  $('autoMarkRead').checked = settings.autoMarkRead;
  $('showImagesDefault').checked = settings.showImagesDefault;
  $('autoFileBackup').checked = settings.autoFileBackup;
  setThemeRadio(settings.theme);

  $('link-about-review').href = getStoreReviewUrl() || '#';
  $('link-about-report').href = ISSUES_URL;
  $('version-label').textContent = t('optionsVersion', [browserApi.runtime.getManifest().version]);

  bindAutoSave();
  await loadShortcutDisplay();
  await refreshBackupStatus();
  updateBackupDependentUI();
}

init();
