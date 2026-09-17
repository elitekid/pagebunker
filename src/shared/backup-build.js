// 백업 파일 조각 생성 (offscreen·파이어폭스 백그라운드 공용, plan 4-6)

import { createSha256Hasher } from './backup-validate.js';
import { SCHEMA_VERSION } from './model.js';
import {
  getDataRevision,
  hasIdbSnapshotForRevision,
  readBackupSnapshot,
  saveIdbSnapshotBlob,
} from './db.js';

/**
 * @param {{ article: object, html?: string }} entry
 */
export function entryToBackupJson(entry) {
  return JSON.stringify({
    article: entry.article,
    html: entry.html || '',
  });
}

/**
 * @param {{ article: object, html?: string }[]} entries
 */
export async function hashArticlesFromEntries(entries) {
  const hasher = createSha256Hasher();
  const enc = new TextEncoder();
  hasher.update(enc.encode('['));
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) hasher.update(enc.encode(','));
    hasher.update(enc.encode(entryToBackupJson(entries[i])));
  }
  hasher.update(enc.encode(']'));
  return hasher.digestHex();
}

/**
 * @param {{ meta: object, entries: object[] }} snapshot
 */
export async function buildBackupBlobFromSnapshot(snapshot) {
  const { meta, entries } = snapshot;
  const createdAt = Date.now();
  const sha256 = await hashArticlesFromEntries(entries);
  const enc = new TextEncoder();

  const header =
    `{"schemaVersion":${SCHEMA_VERSION},` +
    `"dataRevision":${meta.dataRevision},` +
    `"articleCount":${entries.length},` +
    `"createdAt":${createdAt},` +
    `"sha256":"${sha256}","articles":[`;

  const parts = [header];
  let bytes = enc.encode(header).length;

  for (let i = 0; i < entries.length; i++) {
    if (i > 0) {
      parts.push(',');
      bytes += 1;
    }
    const piece = entryToBackupJson(entries[i]);
    parts.push(piece);
    bytes += enc.encode(piece).length;
  }

  parts.push(']}');
  bytes += 2;

  const blob = new Blob(parts, { type: 'application/json' });
  return {
    blob,
    sha256,
    dataRevision: meta.dataRevision,
    articleCount: entries.length,
    bytes,
    createdAt,
  };
}

/**
 * 보관함·offscreen·파이어폭스 백그라운드에서 IDB 스냅샷 생성 (조각 Blob)
 */
export async function createIdbSnapshotInContext() {
  const dataRevision = await getDataRevision();
  if (await hasIdbSnapshotForRevision(dataRevision)) {
    return { ok: true, skipped: true, dataRevision };
  }
  const snapshot = await readBackupSnapshot();
  const built = await buildBackupBlobFromSnapshot(snapshot);
  return saveIdbSnapshotBlob({
    dataRevision: built.dataRevision,
    size: built.bytes,
    sha256: built.sha256,
    blob: built.blob,
  });
}

/**
 * IndexedDB를 읽어 Blob URL 생성 (offscreen·파이어폭스 백그라운드)
 */
export async function createBackupBlobUrlInContext() {
  const snapshot = await readBackupSnapshot();
  const built = await buildBackupBlobFromSnapshot(snapshot);
  let snapshotResult;
  if (await hasIdbSnapshotForRevision(built.dataRevision)) {
    snapshotResult = { ok: true, skipped: true, dataRevision: built.dataRevision };
  } else {
    snapshotResult = await saveIdbSnapshotBlob({
      dataRevision: built.dataRevision,
      size: built.bytes,
      sha256: built.sha256,
      blob: built.blob,
    });
  }
  const url = URL.createObjectURL(built.blob);
  return {
    ok: true,
    url,
    sha256: built.sha256,
    dataRevision: built.dataRevision,
    articleCount: built.articleCount,
    bytes: built.bytes,
    snapshot: snapshotResult,
  };
}
