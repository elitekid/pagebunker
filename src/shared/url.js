// 보수적 주소 정규화 (plan 4-5 matchKey)

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
]);

function stripHash(hash) {
  if (!hash || hash === '#' || hash === '#top') return '';
  if (hash.startsWith('#') && !hash.startsWith('#/')) return '';
  return hash;
}

/**
 * @param {string} url
 * @returns {string|null}
 */
export function matchKey(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();

    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
      u.port = '';
    }

    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (!TRACKING_PARAMS.has(k.toLowerCase())) {
        kept.push([k, v]);
      }
    }
    u.search = '';
    for (const [k, v] of kept) {
      u.searchParams.append(k, v);
    }

    u.hash = stripHash(u.hash);
    return u.href;
  } catch {
    return null;
  }
}

/**
 * 해시만 다른 경우 같은 문서로 본다.
 * @param {string} a
 * @param {string} b
 */
export function sameDocumentUrl(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    ua.hash = '';
    ub.hash = '';
    return ua.href === ub.href;
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isHttpUrl(url) {
  return url?.startsWith('http://') || url?.startsWith('https://');
}
