// 백업 파일 스트리밍 파싱·검증 (plan 4-6, Worker·보관함 공용)

import { SCHEMA_VERSION } from './model.js';
import { createSha256Hasher, validateRawArticleEntry } from './backup-validate.js';

const ARTICLES_MARKER = '"articles":[';

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseHeaderFields(text) {
  const schemaVersion = Number((text.match(/"schemaVersion"\s*:\s*(\d+)/) || [])[1]);
  const dataRevision = Number((text.match(/"dataRevision"\s*:\s*(\d+)/) || [])[1]);
  const articleCount = Number((text.match(/"articleCount"\s*:\s*(\d+)/) || [])[1]);
  const sha256 = (text.match(/"sha256"\s*:\s*"([a-f0-9]{64})"/) || [])[1] || '';
  return { schemaVersion, dataRevision, articleCount, sha256 };
}

/**
 * 백업 JSON을 청크로 읽어 글 단위 검증 (articles 배열 원문 바이트로 해시)
 */
export class BackupStreamParser {
  constructor() {
    this.phase = 'header';
    this.buffer = new Uint8Array(0);
    this.headerText = '';
    this.meta = null;
    this.entries = [];
    this.hasher = null;
    this.articleIndex = 0;
    this.articleStarted = false;
    this.objectBuf = new Uint8Array(0);
    this.depth = 0;
    this.inString = false;
    this.escape = false;
    this.done = false;
    this.error = null;
    this.computedSha256 = '';
  }

  /**
   * @param {Uint8Array} chunk
   */
  feed(chunk) {
    if (this.done || this.error) return;
    this.buffer = concatBytes(this.buffer, chunk);
    this.pump();
  }

  pump() {
    while (!this.done && !this.error) {
      if (this.phase === 'header') {
        const marker = findSubarray(this.buffer, ARTICLES_MARKER);
        if (marker < 0) {
          if (this.buffer.length > 2 * 1024 * 1024) {
            this.error = { ok: false, code: 'bad_header' };
          }
          return;
        }
        const headerBytes = this.buffer.subarray(0, marker + ARTICLES_MARKER.length);
        this.headerText = decodeUtf8(headerBytes);
        this.meta = parseHeaderFields(this.headerText);
        if (this.meta.schemaVersion !== SCHEMA_VERSION) {
          this.error = { ok: false, code: 'bad_schema' };
          return;
        }
        this.hasher = createSha256Hasher();
        this.hasher.update(new TextEncoder().encode('['));
        this.buffer = this.buffer.subarray(marker + ARTICLES_MARKER.length);
        this.phase = 'articles';
        continue;
      }

      if (this.phase === 'articles') {
        if (!this.scanArticles()) return;
        continue;
      }

      if (this.phase === 'footer') {
        this.done = true;
        return;
      }
    }
  }

  scanArticles() {
    // 글 하나의 시작 위치만 기억하고, 끝나면 한 번에 잘라 온다. 조각 경계에 걸친 글은 조각마다 한 번만 이어 붙인다.
    const buf = this.buffer;
    let i = 0;
    let objStart = this.articleStarted ? 0 : -1;
    while (i < buf.length) {
      const b = buf[i];
      if (!this.articleStarted) {
        if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x2c) {
          i++;
          continue;
        }
        if (b === 0x5d) {
          this.hasher.update(new TextEncoder().encode(']'));
          this.buffer = buf.subarray(i + 1);
          return this.finishArticles();
        }
        if (b !== 0x7b) {
          this.error = { ok: false, code: 'bad_articles' };
          return false;
        }
        this.articleStarted = true;
        this.objectBuf = new Uint8Array(0);
        this.depth = 0;
        this.inString = false;
        this.escape = false;
        objStart = i;
      }

      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (b === 0x5c) this.escape = true;
        else if (b === 0x22) this.inString = false;
      } else if (b === 0x22) {
        this.inString = true;
      } else if (b === 0x7b) {
        this.depth++;
      } else if (b === 0x7d) {
        this.depth--;
        if (this.depth === 0) {
          const bytes = concatBytes(this.objectBuf, buf.subarray(objStart, i + 1));
          this.articleStarted = false;
          this.objectBuf = new Uint8Array(0);
          objStart = -1;
          if (!this.pushArticle(bytes)) return false;
        }
      }
      i++;
    }
    if (this.articleStarted && objStart >= 0) {
      // 조각 끝까지 글이 이어지면 남은 부분을 복사해 두고(원본 조각은 다음에 재사용되지 않음) 다음 조각을 기다린다
      this.objectBuf = concatBytes(this.objectBuf, buf.slice(objStart));
    }
    this.buffer = new Uint8Array(0);
    return false;
  }

  pushArticle(bytes) {
    if (this.articleIndex > 0) {
      this.hasher.update(new TextEncoder().encode(','));
    }
    this.hasher.update(bytes);
    let raw;
    try {
      raw = JSON.parse(decodeUtf8(bytes));
    } catch {
      this.error = { ok: false, code: 'bad_entry' };
      return false;
    }
    const v = validateRawArticleEntry(raw);
    if (!v.ok) {
      this.error = v;
      return false;
    }
    this.entries.push(v.entry);
    this.articleIndex++;
    return true;
  }

  finishArticles() {
    this.computedSha256 = this.hasher.digestHex();
    if (this.meta.sha256 && this.meta.sha256 !== this.computedSha256) {
      this.error = { ok: false, code: 'hash_mismatch' };
      return false;
    }
    if (
      Number.isFinite(this.meta.articleCount) &&
      this.meta.articleCount !== this.entries.length
    ) {
      this.error = { ok: false, code: 'bad_articles' };
      return false;
    }
    this.phase = 'footer';
    this.done = true;
    return true;
  }

  result() {
    if (this.error) return this.error;
    if (!this.done) return { ok: false, code: 'incomplete' };
    return {
      ok: true,
      entries: this.entries,
      meta: {
        schemaVersion: this.meta.schemaVersion,
        dataRevision: this.meta.dataRevision ?? 0,
        articleCount: this.entries.length,
        sha256: this.computedSha256,
      },
    };
  }
}

function concatBytes(a, b) {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * @param {Blob} blob
 */
export async function parseBackupBlob(blob) {
  const parser = new BackupStreamParser();
  const reader = blob.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(value);
  }
  return parser.result();
}

function findSubarray(haystack, needleStr) {
  const needle = new TextEncoder().encode(needleStr);
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}
