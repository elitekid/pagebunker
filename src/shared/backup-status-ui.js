// 파일·스냅샷 백업 상태 표시 (작은 창·설정·보관함 공통)

import { deriveFileStatus } from './model.js';

/**
 * @param {(key: string, subs?: string[]) => string} t
 */
export function formatRelativeTime(ts, t) {
  if (!ts) return '';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return t('popupBackupJustNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('popupBackupMinutesAgo', [min]);
  const hr = Math.floor(min / 60);
  if (hr < 48) return t('popupBackupHoursAgo', [hr]);
  const uiLang = typeof navigator !== 'undefined' && navigator.language
    ? navigator.language
    : 'en';
  try {
    return new Date(ts).toLocaleString(uiLang, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return '';
  }
}

/**
 * @param {(key: string, subs?: string[]) => string} t
 */
export function formatSnapshotTime(ts, t, locale) {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const time = date.toLocaleTimeString(locale || undefined, { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (dayDiff === 0) return t('dateToday', [time]);
  if (dayDiff === 1) return t('dateYesterday', [time]);
  const dateOpts = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) dateOpts.year = 'numeric';
  return `${date.toLocaleDateString(locale || undefined, dateOpts)} ${time}`;
}

/**
 * @param {(key: string, subs?: string[]) => string} t
 */
export function backupErrorMessage(code, t) {
  const map = {
    access: 'backupErrAccess',
    disk: 'backupErrDisk',
    name: 'backupErrName',
    stalled: 'backupErrStalled',
    unknown: 'backupErrUnknown',
  };
  return t(map[code] || 'backupErrUnknown');
}

/**
 * @param {{ ok?: boolean, revision?: number, state?: object, settings?: object }} backupStatus
 * @param {(key: string, subs?: string[]) => string} t
 * @returns {{ dotClass: string, text: string }}
 */
export function fileBackupStatusParts(backupStatus, t) {
  if (!backupStatus?.ok) {
    return { dotClass: 'status-dot off', text: t('popupBackupNever') };
  }
  const { revision, state, settings } = backupStatus;
  const status = deriveFileStatus({ revision }, state, settings);
  let dotClass = 'status-dot';
  let text = '';
  switch (status) {
    case 'off':
      dotClass += ' off';
      text = t('popupBackupOff');
      break;
    case 'paused':
      dotClass += ' failed';
      text = t('backupFilePaused');
      break;
    case 'writing':
      dotClass += ' writing';
      text = t('popupBackupWriting');
      break;
    case 'failed':
      dotClass += ' failed';
      text = t('popupBackupFailed', [backupErrorMessage(state?.lastError?.code, t)]);
      break;
    case 'pending':
      dotClass += ' pending';
      text = state?.lastFileOkAt
        ? t('popupBackupPending', [formatRelativeTime(state.lastFileOkAt, t)])
        : t('popupBackupPendingNever');
      break;
    case 'ok':
      text = t('popupBackupOk', [formatRelativeTime(state?.lastFileOkAt, t)]);
      break;
    default:
      dotClass += ' off';
      text = t('popupBackupNever');
  }
  return { dotClass, text };
}

/**
 * @param {number|null|undefined} createdAt
 * @param {(key: string, subs?: string[]) => string} t
 * @param {string} [locale]
 */
export function snapshotStatusParts(createdAt, t, locale) {
  if (createdAt) {
    const when = formatSnapshotTime(createdAt, t, locale);
    return { dotClass: 'status-dot', text: t('vaultSnapshotOk', [when]) };
  }
  return { dotClass: 'status-dot off', text: t('vaultSnapshotNone') };
}

/** HTML 한 줄 (라벨 + 점 + 문구) */
export function statusLineHtml(labelKey, parts, t) {
  const labelHtml = labelKey
    ? `<span class="backup-status-label">${escapeHtml(t(labelKey))}</span>`
    : '';
  return (
    labelHtml +
    `<span class="${parts.dotClass}" aria-hidden="true"></span>` +
    `<span>${parts.text}</span>`
  );
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * getBackupStatus 응답을 UI용 형태로 변환
 * @param {object} status
 * @param {object} settings
 */
export function normalizeBackupStatus(status, settings) {
  if (!status) return { ok: false };
  return {
    ok: true,
    revision: status.revision,
    state: {
      lastFileOkRevision: status.lastFileOkRevision,
      lastFileOkAt: status.lastFileOkAt,
      inflight: status.inflight,
      lastError: status.lastError,
      paused: status.paused,
    },
    settings,
  };
}
