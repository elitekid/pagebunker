// 백업 복원 검증 Worker (plan 4-6, T6.5)

import { BackupStreamParser } from '../shared/backup-stream-parse.js';
import { validateBackupFile } from '../shared/backup-validate.js';

let streamParser = null;

self.onmessage = async (ev) => {
  const { type, text, chunk } = ev.data || {};

  if (type === 'validate') {
    try {
      const result = await validateBackupFile(text || '');
      self.postMessage({ type: 'validated', result });
    } catch (err) {
      self.postMessage({ type: 'error', message: err?.message || String(err) });
    }
    return;
  }

  if (type === 'validateStart') {
    streamParser = new BackupStreamParser();
    return;
  }

  if (type === 'validateChunk') {
    if (!streamParser) streamParser = new BackupStreamParser();
    try {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      streamParser.feed(bytes);
      if (streamParser.error) {
        self.postMessage({ type: 'validated', result: streamParser.error });
        streamParser = null;
      }
    } catch (err) {
      self.postMessage({ type: 'error', message: err?.message || String(err) });
      streamParser = null;
    }
    return;
  }

  if (type === 'validateEnd') {
    if (!streamParser) {
      self.postMessage({ type: 'validated', result: { ok: false, code: 'incomplete' } });
      return;
    }
    try {
      streamParser.pump();
      self.postMessage({ type: 'validated', result: streamParser.result() });
    } catch (err) {
      self.postMessage({ type: 'error', message: err?.message || String(err) });
    } finally {
      streamParser = null;
    }
  }
};
