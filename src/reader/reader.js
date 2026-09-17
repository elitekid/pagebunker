// 읽기 화면 (plan 4-7, D1, 읽음·위치)

import { browserApi, storage } from '../shared/browser.js';
import {
  enableImagesInHtml,
  prepareReaderHtml,
  stripImagesForDisplay,
} from '../shared/sanitize.js';
import { loadSettings, saveSettings, formatPublishedTime } from '../shared/model.js';

const $ = (id) => document.getElementById(id);

function t(key, subs = []) {
  return browserApi.i18n.getMessage(key, subs.map(String)) || key;
}

async function send(type, payload = {}) {
  return browserApi.runtime.sendMessage({ type, ...payload });
}

function applyI18n() {
  const uiLang = browserApi.i18n.getUILanguage?.() || 'en';
  document.documentElement.lang = uiLang.split('-')[0] || 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const msg = browserApi.i18n.getMessage(key);
    if (msg) {
      if (el.tagName === 'OPTION') el.textContent = msg;
      else el.textContent = msg;
    }
  });
}

function getArticleId() {
  const params = new URLSearchParams(location.search);
  return params.get('id');
}

function setText(el, text) {
  el.textContent = text || '';
}

function applyReaderStyles(settings) {
  const root = document.documentElement;
  const main = $('reader-main');
  root.classList.remove('theme-light', 'theme-dark');
  main.classList.remove('theme-light', 'theme-dark');
  if (settings.theme === 'light') {
    root.classList.add('theme-light');
  } else if (settings.theme === 'dark') {
    root.classList.add('theme-dark');
  }
  main.style.setProperty('--reader-font-size', `${settings.fontSize}px`);
  main.style.setProperty('--reader-line-height', String(settings.lineHeight));
  main.style.setProperty('--reader-width', `${settings.contentWidth}px`);

  $('font-size').value = settings.fontSize;
  $('line-height').value = settings.lineHeight;
  $('content-width').value = settings.contentWidth;
  $('theme').value = settings.theme;
}

let articleId = null;
let article = null;
let rawHtml = '';
let imagesShown = false;
let settings = null;
let scrollInputSeen = false;
let suppressAutoRead = true;
let positionTimer = null;
let autoReadObserver = null;

function renderContent() {
  const base = article?.url || location.href;
  const showImages = imagesShown || settings.showImagesDefault;
  let html = prepareReaderHtml(rawHtml, base);
  if (!showImages) {
    html = stripImagesForDisplay(html, t('exportImageLabel'));
    $('btn-show-images').textContent = t('showImages');
  } else {
    html = enableImagesInHtml(html);
    $('btn-show-images').textContent = t('hideImages');
  }
  $('content').innerHTML = html;
  restoreScrollPosition();
  setupAutoRead();
}

function countParagraphs() {
  return $('content').querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre').length;
}

function restoreScrollPosition() {
  if (!article?.position) return;
  const blocks = $('content').querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre');
  const idx = Math.min(article.position.paraIndex || 0, Math.max(0, blocks.length - 1));
  const el = blocks[idx];
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const offset = rect.height * (article.position.ratio || 0);
  window.scrollTo({ top: window.scrollY + rect.top - offset - 80 });
  setTimeout(() => {
    suppressAutoRead = false;
  }, 500);
}

function visibleParagraphIndex() {
  // 화면 위쪽 기준선(도구 막대 아래)에 걸쳐 있는 첫 블록과 그 블록 안에서 지나간 비율을 기록한다
  const blocks = $('content').querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre');
  const line = 80;
  for (let i = 0; i < blocks.length; i++) {
    const rect = blocks[i].getBoundingClientRect();
    if (rect.bottom > line) {
      const ratio = Math.max(0, Math.min(1, (line - rect.top) / Math.max(rect.height, 1)));
      return { paraIndex: i, ratio };
    }
  }
  return { paraIndex: Math.max(0, blocks.length - 1), ratio: 1 };
}

function schedulePositionSave() {
  clearTimeout(positionTimer);
  positionTimer = setTimeout(() => {
    if (!articleId) return;
    const pos = visibleParagraphIndex();
    send('savePosition', { id: articleId, position: pos }).catch(() => {});
  }, 1000);
}

function setupAutoRead() {
  if (autoReadObserver) autoReadObserver.disconnect();
  if (!settings.autoMarkRead || article?.readState === 'read') return;

  const sentinel = $('read-sentinel');
  let sentinelVisible = false;
  let readTimer = null;

  // 끝 요소가 보이고, 사용자가 스크롤했고, 창이 활성인 상태가 3초 이어지면 읽음으로 표시한다
  const cancel = () => { clearTimeout(readTimer); readTimer = null; };
  const arm = () => {
    if (readTimer || !sentinelVisible || suppressAutoRead || !scrollInputSeen) return;
    if (document.hidden || !document.hasFocus()) return;
    readTimer = setTimeout(() => {
      readTimer = null;
      if (sentinelVisible && !suppressAutoRead && scrollInputSeen && !document.hidden && document.hasFocus()) {
        markRead();
      }
    }, 3000);
  };

  autoReadObserver = new IntersectionObserver((entries) => {
    sentinelVisible = entries.some((e) => e.isIntersecting);
    if (sentinelVisible) arm(); else cancel();
  }, { threshold: 0.5 });
  autoReadObserver.observe(sentinel);

  window.addEventListener('scroll', () => arm(), { passive: true });
  window.addEventListener('focus', () => arm());
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); else arm(); });
}

function setupNoticeBanner() {
  const banner = $('notice-banner');
  const text = $('notice-text');
  const action = $('btn-notice-action');
  banner.classList.add('hidden');
  action.onclick = null;

  if (article?.bodyState === 'none_imported' || article?.bodyState === 'link_only' || article?.bodyState === 'failed_iframe') {
    banner.classList.remove('hidden');
    text.textContent =
      article.bodyState === 'failed_iframe' ? t('bodyFailedIframeHint') : t('bodyNoneImportedHint');
    action.textContent = t('fillBody');
    action.onclick = async () => {
      await send('startFillBody', { id: articleId });
      text.textContent = t('fillBodyWaiting');
    };
  }

  const dismiss = $('btn-notice-dismiss');
  dismiss.replaceWith(dismiss.cloneNode(true));
  $('btn-notice-dismiss').addEventListener('click', () => {
    banner.classList.add('hidden');
  });
}

async function markRead() {
  if (!articleId || article?.readState === 'read') return;
  const res = await send('markRead', { id: articleId });
  if (res?.ok) {
    article = res.article;
    $('btn-mark-read').disabled = true;
  }
}

async function init() {
  applyI18n();
  settings = await loadSettings(storage.local);
  imagesShown = settings.showImagesDefault;
  applyReaderStyles(settings);

  articleId = getArticleId();
  if (!articleId) {
    $('loading').classList.add('hidden');
    $('error').classList.remove('hidden');
    setText($('error'), t('articleNotFound'));
    return;
  }

  const res = await send('getArticle', { id: articleId });
  if (!res?.ok) {
    $('loading').classList.add('hidden');
    $('error').classList.remove('hidden');
    setText($('error'), t('articleNotFound'));
    return;
  }

  article = res.article;
  rawHtml = res.html || '';

  $('loading').classList.add('hidden');
  $('article').classList.remove('hidden');

  setText($('title'), article.title);
  const uiLang = browserApi.i18n.getUILanguage?.() || 'en';
  const locale = uiLang.split('-')[0] || 'en';
  const metaParts = [
    article.siteName,
    article.byline,
    formatPublishedTime(article.publishedTime, locale),
  ].filter(Boolean);
  setText($('meta-line'), metaParts.join(' · '));
  setText($('read-time'), t('minRead', [String(article.readingMinutes || 1)]));

  $('link-original').href = article.url;
  $('btn-mark-read').disabled = article.readState === 'read';
  $('btn-restore-body').classList.toggle('hidden', !article.bodyRestore);

  setupNoticeBanner();

  renderContent();

  if (countParagraphs() <= 2) {
    suppressAutoRead = false;
  }

  $('btn-show-images').addEventListener('click', () => {
    imagesShown = !imagesShown;
    renderContent();
  });

  $('btn-mark-read').addEventListener('click', () => markRead());

  $('btn-restore-body').addEventListener('click', async () => {
    const r = await send('restoreBody', { id: articleId });
    if (r?.ok) {
      article = r.article;
      const fresh = await send('getArticle', { id: articleId });
      rawHtml = fresh.html || '';
      $('btn-restore-body').classList.add('hidden');
      renderContent();
    }
  });

  ['font-size', 'line-height', 'content-width', 'theme'].forEach((id) => {
    $(id).addEventListener('input', async () => {
      settings = {
        ...settings,
        fontSize: parseInt($('font-size').value, 10),
        lineHeight: parseFloat($('line-height').value),
        contentWidth: parseInt($('content-width').value, 10),
        theme: $('theme').value,
      };
      applyReaderStyles(settings);
      // 화면을 연 뒤 다른 곳에서 바뀐 설정(저장 횟수 등)을 덮어쓰지 않도록 이 화면이 바꾼 값만 저장한다
      await saveSettings(storage.local, {
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
        contentWidth: settings.contentWidth,
        theme: settings.theme,
      });
    });
  });

  window.addEventListener('scroll', () => {
    scrollInputSeen = true;
    schedulePositionSave();
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) schedulePositionSave();
  });
}

init();
