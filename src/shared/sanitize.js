// DOM 정리기 (plan 4-2) — ES 모듈 진입점

import './sanitize-body.js';

const api = globalThis.ReadLaterSanitize;

export const sanitizeHtml = api.sanitizeHtml;
export const normalizeSearchText = api.normalizeSearchText;
export const extractSearchTextFromHtml = api.extractSearchTextFromHtml;
export const prepareReaderHtml = api.prepareReaderHtml;
export const stripImagesForDisplay = api.stripImagesForDisplay;
export const enableImagesInHtml = api.enableImagesInHtml;
