// offscreen: IndexedDB에서 백업 Blob URL 생성 (크롬·엣지, plan 4-6)

import { createBackupBlobUrlInContext } from '../shared/backup-build.js';
import { browserApi } from '../shared/browser.js';

const blobUrls = new Set();

browserApi.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'offscreenBackupBlob') return false;
  (async () => {
    try {
      const result = await createBackupBlobUrlInContext();
      if (result.ok && result.url) blobUrls.add(result.url);
      sendResponse(result);
    } catch (err) {
      sendResponse({ ok: false, message: err?.message || String(err) });
    }
  })();
  return true;
});
