// 가져오기 Worker — 50MB 파일 처리 (plan 4-5, T5.1)

import { decodeCsvUtf8 } from '../shared/csv.js';
import { detectImportFormat, parseImportFile } from '../shared/importers.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

self.onmessage = (ev) => {
  const { type, buffer, format, existingKeys } = ev.data || {};

  if (type === 'preview') {
    try {
      if (buffer.byteLength > MAX_FILE_BYTES) {
        self.postMessage({ type: 'error', code: 'too_large' });
        return;
      }
      const text = decodeCsvUtf8(buffer);
      const keys = new Set(existingKeys || []);
      const detected = format || detectImportFormat(text);
      const result = parseImportFile(text, detected, keys);
      self.postMessage({ type: 'preview', result });
    } catch (err) {
      self.postMessage({ type: 'error', code: 'decode', message: err?.message });
    }
    return;
  }

  if (type === 'parse') {
    try {
      const text = decodeCsvUtf8(buffer);
      const keys = new Set(existingKeys || []);
      const detected = format || detectImportFormat(text);
      const result = parseImportFile(text, detected, keys);
      self.postMessage({ type: 'parsed', result });
    } catch (err) {
      self.postMessage({ type: 'error', code: 'decode', message: err?.message });
    }
  }
};
