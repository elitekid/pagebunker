// 저장 불가 URL 판정(백그라운드·작은 창 공용)

const STORE_RE =
  /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons|addons\.mozilla\.org)(\/|$)/;

/**
 * @param {string} url
 */
export function isRestrictedUrl(url) {
  if (!url) return true;
  if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:')) return true;
  if (url.startsWith('chrome-extension://') || url.startsWith('moz-extension://')) return true;
  if (url.startsWith('file:')) return true;
  if (STORE_RE.test(url)) return true;
  if (url.endsWith('.pdf') || url.includes('.pdf?')) return true;
  return false;
}

/**
 * @param {string} url
 * @param {string} [extensionBaseUrl] runtime.getURL('') — 자기 확장 페이지 구분
 * @returns {'browser'|'store'|'extension'|null}
 */
export function getRestrictedReason(url, extensionBaseUrl = '') {
  if (!url) return 'browser';
  if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:')) return 'browser';
  if (url.startsWith('file:')) return 'browser';
  if (url.endsWith('.pdf') || url.includes('.pdf?')) return 'browser';
  if (STORE_RE.test(url)) return 'store';
  if (url.startsWith('chrome-extension://') || url.startsWith('moz-extension://')) {
    if (extensionBaseUrl && url.startsWith(extensionBaseUrl)) return 'extension';
    return 'browser';
  }
  return null;
}

/**
 * @param {string} url
 * @param {string} [extensionBaseUrl]
 */
export function canSaveTabUrl(url, extensionBaseUrl = '') {
  if (!url || !/^https?:/i.test(url)) {
    return { canSave: false, code: 'browser' };
  }
  const reason = getRestrictedReason(url, extensionBaseUrl);
  if (reason) return { canSave: false, code: reason };
  return { canSave: true, code: null };
}
