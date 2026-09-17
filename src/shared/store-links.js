// 스토어·이슈·소스 링크 (리뷰 URL 판별 포함)

export const ISSUES_URL = 'https://github.com/elitekid/pagebunker/issues';
export const SOURCE_URL = 'https://github.com/elitekid/pagebunker';

export const STORE_REVIEW_URLS = {
  // 스토어 등록 후 채운다
  chrome: '',
  edge: '',
  firefox: '',
};

/** 확장 실행 환경에서 스토어 종류 판별 */
export function detectStoreBrowser() {
  if (typeof location !== 'undefined' && location.protocol === 'moz-extension:') {
    return 'firefox';
  }
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Edg/')) {
    return 'edge';
  }
  return 'chrome';
}

/** 현재 브라우저용 스토어 리뷰 페이지 URL (미설정이면 빈 문자열) */
export function getStoreReviewUrl() {
  return STORE_REVIEW_URLS[detectStoreBrowser()] || '';
}
