// 백업 파일 구조 검증 (DOM·확장 API 없음, plan 4-6)

import { SCHEMA_VERSION, createArticle } from './model.js';
import { isHttpUrl, matchKey } from './url.js';

export const FIELD_MAX = 10_000;
export const URL_MAX = 4096;
export const HTML_MAX = 5 * 1024 * 1024;

/**
 * @param {ArrayBuffer|Uint8Array} data
 */
export async function sha256Hex(data) {
  const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

function sha256Block(h, w) {
  for (let i = 16; i < 64; i++) {
    const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
    const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = h[0];
  let b = h[1];
  let c = h[2];
  let d = h[3];
  let e = h[4];
  let f = h[5];
  let g = h[6];
  let hh = h[7];
  for (let i = 0; i < 64; i++) {
    const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) | 0;
    const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  h[0] = (h[0] + a) | 0;
  h[1] = (h[1] + b) | 0;
  h[2] = (h[2] + c) | 0;
  h[3] = (h[3] + d) | 0;
  h[4] = (h[4] + e) | 0;
  h[5] = (h[5] + f) | 0;
  h[6] = (h[6] + g) | 0;
  h[7] = (h[7] + hh) | 0;
}

/** 글 단위 백업 조각 해시용 증분 SHA-256 */
export function createSha256Hasher() {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const buf = new Uint8Array(64);
  let pos = 0;
  let totalBits = 0;

  function process(data, off, len) {
    while (len > 0) {
      const take = Math.min(64 - pos, len);
      buf.set(data.subarray(off, off + take), pos);
      pos += take;
      off += take;
      len -= take;
      if (pos === 64) {
        const w = new Uint32Array(64);
        for (let i = 0; i < 16; i++) {
          w[i] =
            (buf[i * 4] << 24) |
            (buf[i * 4 + 1] << 16) |
            (buf[i * 4 + 2] << 8) |
            buf[i * 4 + 3];
        }
        sha256Block(h, w);
        pos = 0;
      }
    }
  }

  return {
    update(data) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      totalBits += bytes.length * 8;
      process(bytes, 0, bytes.length);
    },
    digestHex() {
      const padLen = pos < 56 ? 64 - pos : 128 - pos;
      const pad = new Uint8Array(padLen);
      pad[0] = 0x80;
      const lenHi = Math.floor(totalBits / 0x100000000);
      const lenLo = totalBits >>> 0;
      pad[padLen - 8] = (lenHi >>> 24) & 0xff;
      pad[padLen - 7] = (lenHi >>> 16) & 0xff;
      pad[padLen - 6] = (lenHi >>> 8) & 0xff;
      pad[padLen - 5] = lenHi & 0xff;
      pad[padLen - 4] = (lenLo >>> 24) & 0xff;
      pad[padLen - 3] = (lenLo >>> 16) & 0xff;
      pad[padLen - 2] = (lenLo >>> 8) & 0xff;
      pad[padLen - 1] = lenLo & 0xff;
      process(pad, 0, padLen);
      let out = '';
      for (let i = 0; i < 8; i++) {
        out += (h[i] >>> 24).toString(16).padStart(2, '0');
        out += ((h[i] >>> 16) & 0xff).toString(16).padStart(2, '0');
        out += ((h[i] >>> 8) & 0xff).toString(16).padStart(2, '0');
        out += (h[i] & 0xff).toString(16).padStart(2, '0');
      }
      return out;
    },
  };
}

/**
 * @param {object} raw
 */
export function validateRawArticleEntry(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, code: 'bad_entry' };
  const article = raw.article;
  if (!article || typeof article !== 'object') return { ok: false, code: 'bad_article' };
  if (typeof article.url !== 'string' || article.url.length > URL_MAX || !isHttpUrl(article.url)) {
    return { ok: false, code: 'bad_url' };
  }
  if (typeof article.title !== 'string' || article.title.length > FIELD_MAX) {
    return { ok: false, code: 'bad_title' };
  }
  const html = typeof raw.html === 'string' ? raw.html : '';
  if (html.length > HTML_MAX) return { ok: false, code: 'html_too_large' };

  const normalized = createArticle({
    ...article,
    url: article.url,
    matchKey: matchKey(article.url) || article.url,
    source: article.source || 'backup',
  });
  delete normalized.bodyRestore;

  return {
    ok: true,
    entry: {
      article: normalized,
      html,
    },
  };
}

/**
 * @param {string} text
 */
export async function validateBackupFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'invalid_json' };
  }

  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, code: 'bad_schema' };
  }
  if (!Array.isArray(parsed.articles)) {
    return { ok: false, code: 'bad_articles' };
  }

  const articlesJson = JSON.stringify(parsed.articles);
  const sha256 = await sha256Hex(new TextEncoder().encode(articlesJson));
  if (parsed.sha256 && parsed.sha256 !== sha256) {
    return { ok: false, code: 'hash_mismatch' };
  }

  const entries = [];
  for (const raw of parsed.articles) {
    const v = validateRawArticleEntry(raw);
    if (!v.ok) return v;
    entries.push(v.entry);
  }

  return {
    ok: true,
    entries,
    meta: {
      schemaVersion: parsed.schemaVersion,
      dataRevision: parsed.dataRevision ?? 0,
      articleCount: entries.length,
      sha256,
    },
  };
}
