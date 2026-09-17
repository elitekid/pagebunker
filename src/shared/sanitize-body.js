// DOM 정리기 핵심 (plan 4-2). 주입·모듈 공용 — export 없음

// 같은 페이지에 반복 주입돼도 전역 이름이 충돌하지 않도록 함수 범위로 감싼다
(() => {
const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'figure', 'figcaption', 'img', 'a',
  'em', 'strong', 'b', 'i', 'u', 's', 'sup', 'sub',
  'br', 'hr', 'span', 'div',
]);

const LINK_ATTRS = new Set(['href']);
const IMG_ATTRS = new Set(['src', 'alt']);
const CELL_ATTRS = new Set(['colspan', 'rowspan']);

function isHttpProtocol(proto) {
  return proto === 'http:' || proto === 'https:';
}

function sanitizeUrl(value, baseURI, httpsOnly = false) {
  if (!value) return null;
  try {
    const u = new URL(value, baseURI);
    if (httpsOnly) {
      return u.protocol === 'https:' ? u.href : null;
    }
    return isHttpProtocol(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function sanitizeIntAttr(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 50) return null;
  return String(n);
}

const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'th', 'td', 'caption', 'blockquote', 'pre', 'figcaption',
]);

function unwrapElement(el) {
  const parent = el.parentNode;
  if (!parent) return [];
  const moved = [];
  while (el.firstChild) {
    moved.push(el.firstChild);
    parent.insertBefore(el.firstChild, el);
  }
  parent.removeChild(el);
  return moved;
}

function sanitizeNode(node, baseURI) {
  if (node.nodeType === Node.TEXT_NODE) return;
  if (node.nodeType !== Node.ELEMENT_NODE) {
    node.remove();
    return;
  }

  const el = node;
  const tag = el.tagName.toLowerCase();
  const ns = el.namespaceURI;

  if (ns && ns !== 'http://www.w3.org/1999/xhtml') {
    const moved = unwrapElement(el);
    for (const child of moved) sanitizeNode(child, baseURI);
    return;
  }

  if (!ALLOWED_TAGS.has(tag)) {
    const moved = unwrapElement(el);
    for (const child of moved) sanitizeNode(child, baseURI);
    return;
  }

  const attrs = [...el.attributes];
  for (const attr of attrs) {
    const name = attr.name.toLowerCase();
    let keep = false;
    let newVal = attr.value;

    if (tag === 'a' && LINK_ATTRS.has(name)) {
      const href = sanitizeUrl(newVal, baseURI, false);
      if (href) {
        newVal = href;
        keep = true;
      }
    } else if (tag === 'img' && IMG_ATTRS.has(name)) {
      if (name === 'src') {
        const src = sanitizeUrl(newVal, baseURI, true);
        if (src) {
          newVal = src;
          keep = true;
        }
      } else {
        keep = true;
      }
    } else if ((tag === 'th' || tag === 'td') && CELL_ATTRS.has(name)) {
      const v = sanitizeIntAttr(newVal);
      if (v) {
        newVal = v;
        keep = true;
      }
    }

    if (keep) {
      el.setAttribute(name, newVal);
    } else {
      el.removeAttribute(attr.name);
    }
  }

  if (tag === 'img') {
    if (!el.getAttribute('src')) {
      el.remove();
      return;
    }
  }

  for (const child of [...el.childNodes]) {
    sanitizeNode(child, baseURI);
  }
}

function sanitizeHtml(html, baseURI) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.body || doc.documentElement;
  for (const child of [...root.childNodes]) {
    sanitizeNode(child, baseURI);
  }
  return root.innerHTML;
}

function normalizeSearchText(text) {
  if (!text) return '';
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// 정리기를 거친 본문 문자열에서 검색 텍스트를 만든다. 서비스워커·Worker에는 DOM이 없으므로 문자열만 쓴다.
// 블록 요소 경계와 줄바꿈 요소 자리에는 공백을 넣어 제목·문단이 붙지 않게 한다.
const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITY_MAP[code.toLowerCase()] ?? m;
  });
}

function extractSearchTextFromHtml(html) {
  if (!html) return '';
  const blockPattern = [...BLOCK_TAGS, 'br', 'hr', 'div', 'ul', 'ol', 'table', 'tr', 'figure'].join('|');
  const spaced = html.replace(new RegExp(`<\\/?(?:${blockPattern})\\b[^>]*>`, 'gi'), ' ');
  const stripped = spaced.replace(/<[^>]*>/g, '');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

function prepareReaderHtml(html, baseURI) {
  const clean = sanitizeHtml(html, baseURI);
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  doc.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return doc.body.innerHTML;
}

function stripImagesForDisplay(html, imageLabel = 'Image') {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('img').forEach((img) => {
    const alt = img.getAttribute('alt') || '';
    const placeholder = doc.createElement('span');
    placeholder.className = 'rl-img-placeholder';
    placeholder.textContent = alt || imageLabel;
    img.replaceWith(placeholder);
  });
  return doc.body.innerHTML;
}

function enableImagesInHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('img[src]').forEach((img) => {
    img.referrerPolicy = 'no-referrer';
  });
  return doc.body.innerHTML;
}

const api = {
  sanitizeHtml,
  normalizeSearchText,
  extractSearchTextFromHtml,
  prepareReaderHtml,
  stripImagesForDisplay,
  enableImagesInHtml,
};

if (typeof globalThis !== 'undefined') {
  globalThis.ReadLaterSanitize = api;
}
})();
