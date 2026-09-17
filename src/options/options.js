// 설정 화면

import { browserApi, storage } from '../shared/browser.js';
import { loadSettings } from '../shared/model.js';

const $ = (id) => document.getElementById(id);

function t(key) {
  return browserApi.i18n.getMessage(key) || key;
}

async function send(type, payload = {}) {
  return browserApi.runtime.sendMessage({ type, ...payload });
}

function applyI18n() {
  const uiLang = browserApi.i18n.getUILanguage?.() || 'en';
  document.documentElement.lang = uiLang.split('-')[ 0] || 'en';
  document.title = t('settingsTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const msg = browserApi.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
}

async function init() {
  applyI18n();
  const settings = await loadSettings(storage.local);

  $('autoMarkRead').checked = settings.autoMarkRead;
  $('showImagesDefault').checked = settings.showImagesDefault;
  $('autoFileBackup').checked = settings.autoFileBackup;

  $('btn-save').addEventListener('click', save);

  $('btn-manual-backup').addEventListener('click', async () => {
    $('status').textContent = t('backupRunning');
    const res = await send('backupNow');
    if (res?.ok) {
      $('status').textContent = t('backupDone');
    } else {
      $('status').textContent = t('backupFailed');
    }
  });
}

function readFormPatch() {
  return {
    autoMarkRead: $('autoMarkRead').checked,
    showImagesDefault: $('showImagesDefault').checked,
    autoFileBackup: $('autoFileBackup').checked,
  };
}

async function save() {
  const patch = readFormPatch();
  const res = await send('updateSettings', { patch });
  if (res?.ok) {
    $('status').textContent = t('saved');
    if (patch.autoFileBackup) {
      await send('backupNow');
    }
  } else {
    $('status').textContent = res?.message || t('saveFailed');
  }
}

init();
