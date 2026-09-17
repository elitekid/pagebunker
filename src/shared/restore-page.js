// 보관함 페이지에서 백업 복원 (DOM 정리기 사용, plan 4-5·4-6)

import { validateBackupFile } from './backup-validate.js';
import { clearReplaceUndoPointer, saveReplaceUndoPointer } from './backup.js';
import { createIdbSnapshotInContext } from './backup-build.js';
import {
  BODY_STATE,
  SCHEMA_VERSION,
  createArticle,
  searchTextFromBody,
} from './model.js';
import { matchKey } from './url.js';
import { extractSearchTextFromHtml, sanitizeHtml } from './sanitize.js';
import {
  clearRestoreTemp,
  getIdbSnapshot,
  getUndoRecord,
  listIdbSnapshots,
  mergeBackupEntries,
  readIdbSnapshotEntries,
  readStagedRestoreEntries,
  replaceAllData,
  saveReplaceUndo,
  stageRestoreEntries,
} from './db.js';

/**
 * @param {object} raw
 */
export function finalizeRestoreEntry(raw) {
  const base = raw.article.url;
  const cleanHtml = raw.html ? sanitizeHtml(raw.html, base) : '';
  // 본문이 없는 글은 원래 상태(본문 없음·iframe 실패·너무 큼)를 유지한다
  const bodyState = cleanHtml
    ? BODY_STATE.FULL
    : (Object.values(BODY_STATE).includes(raw.article.bodyState) && raw.article.bodyState !== BODY_STATE.FULL
      ? raw.article.bodyState
      : BODY_STATE.LINK_ONLY);
  const plain = cleanHtml ? extractSearchTextFromHtml(cleanHtml) : '';
  const normalized = createArticle({
    ...raw.article,
    url: raw.article.url,
    matchKey: matchKey(raw.article.url) || raw.article.url,
    bodyState,
    // 글자 수·읽기 시간은 본문에서 다시 계산한다
    text: plain,
    source: raw.article.source || 'backup',
  });
  delete normalized.bodyRestore;
  return {
    article: normalized,
    html: cleanHtml,
    text: searchTextFromBody(cleanHtml, plain),
  };
}

/**
 * @param {object[]} rawEntries
 */
export function finalizeRestoreEntries(rawEntries) {
  return rawEntries.map(finalizeRestoreEntry);
}

/**
 * @param {{ ok: boolean, entries?: object[], meta?: object, code?: string }} validated
 */
export async function restoreBackupMergeFromValidated(validated) {
  if (!validated?.ok) return validated;
  const entries = finalizeRestoreEntries(validated.entries);
  const res = await mergeBackupEntries(entries);
  return { ok: true, added: res.added, revision: res.revision };
}

/**
 * @param {{ ok: boolean, entries?: object[], meta?: object, code?: string }} validated
 */
export async function restoreBackupReplaceFromValidated(validated) {
  if (!validated?.ok) return validated;

  const entries = finalizeRestoreEntries(validated.entries);

  const snapRes = await createIdbSnapshotInContext();
  if (!snapRes.ok) {
    return { ok: false, code: 'snapshot_blocked', hint: 'merge_or_export' };
  }

  await stageRestoreEntries(entries);
  const staged = await readStagedRestoreEntries();
  if (staged.length !== entries.length) {
    await clearRestoreTemp();
    return { ok: false, code: 'stage_failed' };
  }

  const snapshots = await listIdbSnapshots();
  const protectId = snapRes.id || snapshots[0]?.id;
  await replaceAllData(entries, validated.meta);
  await clearRestoreTemp();

  const at = Date.now();
  const jobId = `replace-${at}`;
  await saveReplaceUndo(jobId, {
    kind: 'replace',
    at,
    snapshotId: protectId,
    count: entries.length,
  });
  await saveReplaceUndoPointer({ jobId, at, snapshotId: protectId });

  return { ok: true, count: entries.length, undoJobId: jobId, at, snapshotId: protectId };
}

/**
 * @param {string} text
 */
export async function restoreBackupMerge(text) {
  const validated = await validateBackupFile(text);
  return restoreBackupMergeFromValidated(validated);
}

/**
 * @param {string} text
 */
export async function restoreBackupReplace(text) {
  const validated = await validateBackupFile(text);
  return restoreBackupReplaceFromValidated(validated);
}

/**
 * @param {string} jobId
 */
export async function undoReplaceRestore(jobId) {
  const record = jobId ? await getUndoRecord(jobId) : null;
  const snapshotId = record?.snapshotId;
  const snap = snapshotId
    ? await getIdbSnapshot(snapshotId)
    : (await listIdbSnapshots())[0];
  const rawEntries = await readIdbSnapshotEntries(snap);
  if (!rawEntries?.length) {
    return { ok: false, code: 'no_snapshot' };
  }
  const entries = finalizeRestoreEntries(rawEntries);
  await replaceAllData(entries, {
    schemaVersion: SCHEMA_VERSION,
    dataRevision: snap.dataRevision,
  });
  await clearReplaceUndoPointer();
  return { ok: true, count: entries.length };
}
