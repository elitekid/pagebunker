// 백업·복원 (plan 4-6, TabBunker 규칙 이식)

import { hashArticlesFromEntries } from './backup-build.js';
import { alarms, browserApi, downloads, offscreen, storage } from './browser.js';
import {
  SCHEMA_VERSION,
  loadSettings,
} from './model.js';
import { getDataRevision } from './db.js';

export const BACKUP_STATE_KEY = 'rl_backup_state';
export const REPLACE_UNDO_KEY = 'rl_replace_undo';
export const BACKUP_SUBFOLDER = 'PageBunker';
export const LATEST_FILENAME = 'pagebunker-latest.json';
export const ALARM_BACKUP = 'rl-backup';
export const ALARM_WATCHDOG = 'rl-backup-watchdog';

const MIN_DELAY_MS = 2 * 60 * 1000;
const MAX_DELAY_MS = 10 * 60 * 1000;
const DATED_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_DATED_FILES = 7;
const WATCHDOG_MS = 2 * 60 * 1000;

export const DEFAULT_BACKUP_STATE = {
  lastFileOkRevision: 0,
  lastFileOkAt: null,
  latestDownloadId: null,
  firstDirtyAt: null,
  inflight: null,
  lastError: null,
  retryCount: 0,
  retryNotBefore: null,
  lastDatedAt: null,
  lastDatedRevision: 0,
  datedSeq: 0,
  datedFiles: [],
  datedError: null,
  snapshotWarning: null,
  firstBackupDone: false,
  firstBackupNoticeShown: false,
  abandonedLatestIds: [],
  ignoredDownloadIds: [],
};

const urlById = new Map();
let backupDeferred = false;

export function setBackupDeferred(deferred) {
  backupDeferred = deferred;
}

export { sha256Hex } from './backup-validate.js';

/**
 * @param {object} snapshot
 */
export async function buildBackupFile(snapshot) {
  const articles = snapshot.entries.map((e) => ({
    article: e.article,
    html: e.html || '',
  }));
  const sha256 = await hashArticlesFromEntries(snapshot.entries);
  const file = {
    schemaVersion: SCHEMA_VERSION,
    dataRevision: snapshot.meta.dataRevision,
    articleCount: articles.length,
    createdAt: Date.now(),
    sha256,
    articles,
  };
  return { file, json: JSON.stringify(file), sha256 };
}

export async function getReplaceUndoPointer() {
  const data = await storage.local.get(REPLACE_UNDO_KEY);
  return data[REPLACE_UNDO_KEY] || null;
}

export async function saveReplaceUndoPointer(record) {
  await storage.local.set({ [REPLACE_UNDO_KEY]: record });
}

export async function clearReplaceUndoPointer() {
  await storage.local.remove(REPLACE_UNDO_KEY);
}

export async function loadBackupState() {
  const data = await storage.local.get(BACKUP_STATE_KEY);
  return { ...DEFAULT_BACKUP_STATE, ...(data[BACKUP_STATE_KEY] || {}) };
}

export async function saveBackupState(state) {
  await storage.local.set({ [BACKUP_STATE_KEY]: state });
}

function isDirty(revision, state) {
  return revision > (state.lastFileOkRevision || 0);
}

function datedFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${BACKUP_SUBFOLDER}/pagebunker-${stamp}.json`;
}

function classifyInterrupt(error) {
  const current = error?.current || String(error || '');
  if (current.includes('USER_CANCELED')) return 'canceled';
  return 'unknown';
}

function classifyException(err) {
  const msg = String(err?.message || err || '');
  if (msg.toLowerCase().includes('filename')) return 'name';
  return 'unknown';
}

function revokeUrl(id) {
  const url = urlById.get(id);
  if (url && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
    urlById.delete(id);
  }
}

async function ensureOffscreen() {
  if (!offscreen) return false;
  const has = await offscreen.hasDocument();
  if (has) return true;
  await offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Create backup blob URLs without large message payloads',
  });
  return true;
}

export async function requestBackupDownloadBlob(reason = 'backup') {
  const manifestMeta = browserApi.runtime.getManifest();
  const isFirefox = !!manifestMeta.browser_specific_settings?.gecko;
  if (!isFirefox && offscreen) {
    await ensureOffscreen();
    const res = await browserApi.runtime.sendMessage({ type: 'offscreenBackupBlob', reason });
    if (res?.ok && res.url) {
      await applySnapshotResult(res.snapshot);
      return res;
    }
    throw new Error(res?.message || 'offscreen backup failed');
  }
  const { createBackupBlobUrlInContext } = await import('./backup-build.js');
  const res = await createBackupBlobUrlInContext();
  await applySnapshotResult(res.snapshot);
  return res;
}

function truncateErrorMessage(message, max = 300) {
  const text = String(message || '').trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function buildLastError(code, message) {
  const entry = { code, at: Date.now() };
  const trimmed = truncateErrorMessage(message);
  if (trimmed) entry.message = trimmed;
  return entry;
}

async function scheduleRetry(state) {
  const retryCount = (state.retryCount || 0) + 1;
  const delay = retryCount === 1 ? 5 * 60 * 1000 : 30 * 60 * 1000;
  const retryNotBefore = Date.now() + delay;
  await saveBackupState({
    ...state,
    retryCount,
    retryNotBefore,
    inflight: null,
  });
  if (alarms?.create) {
    await alarms.create(ALARM_BACKUP, { when: retryNotBefore });
  }
}

async function applySnapshotResult(snapRes) {
  if (!snapRes) return;
  const state = await loadBackupState();
  if (!snapRes.ok) {
    await saveBackupState({
      ...state,
      snapshotWarning: { code: snapRes.code, at: Date.now() },
    });
  } else if (!snapRes.skipped) {
    await saveBackupState({ ...state, snapshotWarning: null });
  }
}

// 자동 백업 다운로드 동안만 브라우저 다운로드 표시(버블·툴바 아이콘)를 숨긴다. 크롬·엣지 전용, 파이어폭스는 API 없음(TabBunker 1.1.0과 같음)
async function setDownloadUi(enabled) {
  const fn = browserApi.downloads?.setUiOptions;
  if (typeof fn !== 'function') return;
  try {
    await fn.call(browserApi.downloads, { enabled });
  } catch {
    /* 권한 없음 등 */
  }
}

// 진행 중인 백업 다운로드가 없으면 다운로드 표시를 되돌린다
export async function restoreDownloadUiIfIdle() {
  const state = await loadBackupState();
  if (!state.inflight) await setDownloadUi(true);
}

async function handleBackupFailure(state, code, message) {
  try {
    await handleBackupFailureInner(state, code, message);
  } finally {
    await setDownloadUi(true);
  }
}

async function handleBackupFailureInner(state, code, message) {
  const lastError = buildLastError(code, message);
  if (code === 'canceled') {
    await saveBackupState({
      ...state,
      inflight: null,
      lastError,
    });
    return;
  }
  const failedState = {
    ...state,
    inflight: null,
    lastError,
  };
  await saveBackupState(failedState);
  await scheduleRetry(failedState);
}

export async function markDataDirty() {
  const state = await loadBackupState();
  const revision = await getDataRevision();
  if (!state.firstDirtyAt && isDirty(revision, state)) {
    await saveBackupState({ ...state, firstDirtyAt: Date.now() });
  }
  await ensureBackupAlarm();
}

async function ensureBackupAlarm() {
  if (!alarms?.create) return;
  const state = await loadBackupState();
  const settings = await loadSettings(storage.local);
  if (!settings.autoFileBackup || backupDeferred) return;

  const now = Date.now();
  const firstDirty = state.firstDirtyAt || now;
  const when = Math.min(
    Math.max(firstDirty + MIN_DELAY_MS, now),
    firstDirty + MAX_DELAY_MS,
    state.retryNotBefore ?? Infinity
  );

  const existing = await alarms.get(ALARM_BACKUP);
  if (existing?.scheduledTime && existing.scheduledTime <= when + 1000) return;

  await alarms.create(ALARM_BACKUP, { when });
}

async function cleanupDatedFiles(state) {
  let datedFiles = [...(state.datedFiles || [])];
  datedFiles.sort((a, b) => (a.seq || 0) - (b.seq || 0));

  while (datedFiles.length > MAX_DATED_FILES) {
    const oldest = datedFiles[0];
    if (!downloads?.removeFile) break;
    // 다운로드 기록만 지우면 파일이 디스크에 남는다. 파일을 먼저 지우고 기록을 지운다.
    // 사용자가 이미 옮기거나 지운 파일이면 삭제가 실패해도 목록에서는 뺀다.
    try {
      await downloads.removeFile(oldest.downloadId);
    } catch {
      /* 파일 없음 */
    }
    try {
      await downloads.erase({ id: oldest.downloadId });
    } catch {
      /* 기록 없음 */
    }
    datedFiles = datedFiles.slice(1);
  }
  return { ...state, datedFiles };
}

async function startDatedDownload(state, revision) {
  let blobResult;
  try {
    blobResult = await requestBackupDownloadBlob('dated');
  } catch {
    await saveBackupState({
      ...state,
      inflight: null,
      datedError: { code: 'unknown', at: Date.now() },
    });
    return loadBackupState();
  }
  const { url } = blobResult;
  const filename = datedFilename();
  try {
    await setDownloadUi(false);
    const id = await downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    urlById.set(id, url);
    const newState = {
      ...state,
      inflight: {
        downloadId: id,
        kind: 'dated',
        revision,
        filename,
        startedAt: Date.now(),
      },
    };
    await saveBackupState(newState);
    if (alarms?.create) {
      await alarms.create(ALARM_WATCHDOG, { when: Date.now() + WATCHDOG_MS });
    }
    return loadBackupState();
  } catch (err) {
    await handleBackupFailure(state, classifyException(err), err?.message);
    revokeUrl(url);
    return loadBackupState();
  }
}

export async function settleDownload(item) {
  let state = await loadBackupState();
  if ((state.ignoredDownloadIds || []).includes(item.id)) return;

  const isInflight = state.inflight && state.inflight.downloadId === item.id;
  const abandoned = (state.abandonedLatestIds || []).find((a) => a.id === item.id);
  if (!isInflight && !abandoned) return;

  if (item.state === 'complete') {
    if (isInflight && state.inflight.kind === 'latest') {
      const R = state.inflight.revision;
      const id = item.id;
      const prevLatest = state.latestDownloadId;
      state = {
        ...state,
        inflight: null,
        lastFileOkRevision: Math.max(state.lastFileOkRevision || 0, R),
        lastFileOkAt: Date.now(),
        latestDownloadId: id,
        lastError: null,
        retryCount: 0,
        retryNotBefore: null,
        firstBackupDone: true,
      };
      if (R >= (await getDataRevision())) {
        state.firstDirtyAt = null;
      }
      await saveBackupState(state);
      revokeUrl(id);

      if (prevLatest && prevLatest !== id && downloads?.erase) {
        try {
          await downloads.erase({ id: prevLatest });
        } catch {
          /* ignore */
        }
      }

      const now = Date.now();
      const shouldDate =
        !state.datedError &&
        (state.lastDatedAt === null ||
          (now - state.lastDatedAt >= DATED_INTERVAL_MS && state.lastDatedRevision !== R));

      if (shouldDate) {
        state = await startDatedDownload(state, R);
      }
      await ensureBackupAlarm();
      return;
    }

    if (isInflight && state.inflight.kind === 'dated') {
      const R = state.inflight.revision;
      state = {
        ...state,
        inflight: null,
        lastDatedAt: Date.now(),
        lastDatedRevision: R,
        datedSeq: (state.datedSeq || 0) + 1,
        datedFiles: [
          ...(state.datedFiles || []),
          {
            downloadId: item.id,
            seq: (state.datedSeq || 0) + 1,
            at: Date.now(),
            revision: R,
          },
        ],
        datedError: null,
      };
      state = await cleanupDatedFiles(state);
      await saveBackupState(state);
      revokeUrl(item.id);
      return;
    }
  }

  if (item.state === 'interrupted') {
    const code = classifyInterrupt(item.error);
    if (isInflight) {
      if (state.inflight.kind === 'latest') {
        await handleBackupFailure(state, code);
      } else {
        await saveBackupState({
          ...state,
          inflight: null,
          datedError: { code, at: Date.now() },
        });
      }
      revokeUrl(item.id);
    }
  }
}

async function reconcileInflight() {
  const state = await loadBackupState();
  if (!state.inflight || !downloads?.search) return state;

  const items = await downloads.search({ id: state.inflight.downloadId });
  const item = items[0];
  if (!item) {
    await saveBackupState({
      ...state,
      inflight: null,
      lastError: { code: 'unknown', at: Date.now() },
    });
    return loadBackupState();
  }

  if (item.state === 'complete' || item.state === 'interrupted') {
    await settleDownload(item);
    return loadBackupState();
  }

  const elapsed = Date.now() - (state.inflight.startedAt || 0);
  if (elapsed > WATCHDOG_MS) {
    const abandoned = [...(state.abandonedLatestIds || [])];
    if (state.inflight.kind === 'latest') {
      abandoned.push({ id: state.inflight.downloadId, revision: state.inflight.revision });
    }
    const failedState = {
      ...state,
      inflight: null,
      lastError: buildLastError('stalled'),
      abandonedLatestIds: abandoned,
    };
    await saveBackupState(failedState);
    await scheduleRetry(failedState);
    return loadBackupState();
  }

  if (alarms?.create) {
    await alarms.create(ALARM_WATCHDOG, { when: Date.now() + WATCHDOG_MS - elapsed });
  }
  return state;
}

export async function runBackup(trigger = 'alarm') {
  let state = await loadBackupState();
  const settings = await loadSettings(storage.local);
  const revision = await getDataRevision();
  const now = Date.now();
  const isManual = trigger === 'manual';

  state = await reconcileInflight();
  if (state.inflight) return state;

  if (!isManual && backupDeferred) return state;

  const dirty = isDirty(revision, state);
  if (
    !isManual &&
    (!settings.autoFileBackup ||
      now < (state.retryNotBefore ?? 0) ||
      !dirty)
  ) {
    return state;
  }

  if (!isManual && state.firstDirtyAt) {
    const earliest = state.firstDirtyAt + MIN_DELAY_MS;
    const latest = state.firstDirtyAt + MAX_DELAY_MS;
    if (now < earliest) {
      if (alarms?.create) await alarms.create(ALARM_BACKUP, { when: earliest });
      return state;
    }
    if (now > latest && !dirty) return state;
  }

  let blobResult;
  try {
    blobResult = await requestBackupDownloadBlob(trigger);
  } catch (err) {
    await handleBackupFailure(state, classifyException(err), err?.message);
    return loadBackupState();
  }
  const { url, sha256, dataRevision } = blobResult;
  const filename = `${BACKUP_SUBFOLDER}/${LATEST_FILENAME}`;

  try {
    await setDownloadUi(false);
    const id = await downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'overwrite',
    });
    urlById.set(id, url);

    state = {
      ...state,
      inflight: {
        downloadId: id,
        kind: 'latest',
        revision: dataRevision,
        filename,
        startedAt: Date.now(),
        sha256,
      },
    };
    await saveBackupState(state);
    if (alarms?.create) {
      await alarms.create(ALARM_WATCHDOG, { when: Date.now() + WATCHDOG_MS });
    }

    const items = await downloads.search({ id });
    if (items[0] && (items[0].state === 'complete' || items[0].state === 'interrupted')) {
      await settleDownload(items[0]);
      await restoreDownloadUiIfIdle();
    }
    return loadBackupState();
  } catch (err) {
    revokeUrl(url);
    await handleBackupFailure(state, classifyException(err), err?.message);
    return loadBackupState();
  }
}

export async function reconcileBackupStartup() {
  await reconcileInflight();
  await restoreDownloadUiIfIdle();
  const state = await loadBackupState();
  const settings = await loadSettings(storage.local);
  const revision = await getDataRevision();
  if (
    settings.autoFileBackup &&
    isDirty(revision, state) &&
    !backupDeferred &&
    Date.now() >= (state.retryNotBefore ?? 0)
  ) {
    return runBackup('startup');
  }
  return state;
}

export async function getBackupStatus() {
  const state = await loadBackupState();
  const revision = await getDataRevision();
  return {
    revision,
    lastFileOkRevision: state.lastFileOkRevision,
    lastFileOkAt: state.lastFileOkAt,
    dirty: isDirty(revision, state),
    deferred: backupDeferred,
    inflight: !!state.inflight,
    lastError: state.lastError,
    snapshotWarning: state.snapshotWarning,
    firstBackupDone: state.firstBackupDone,
    firstBackupNoticeShown: state.firstBackupNoticeShown,
    subfolder: BACKUP_SUBFOLDER,
  };
}

export async function markFirstBackupNoticeShown() {
  const state = await loadBackupState();
  await saveBackupState({ ...state, firstBackupNoticeShown: true });
}

export function handleDownloadChanged(delta) {
  if (!delta?.state && !delta?.error) return;
  if (!downloads?.search) return;
  downloads.search({ id: delta.id }).then((items) => {
    const item = items[0];
    if (item && (item.state === 'complete' || item.state === 'interrupted')) {
      settleDownload(item)
        .catch(() => {})
        .then(() => restoreDownloadUiIfIdle())
        .catch(() => {});
    }
  });
}
