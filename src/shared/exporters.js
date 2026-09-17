// HTML·마크다운 내보내기 (plan 4-2, T5.5)

import { prepareReaderHtml } from './sanitize.js';

// 화면 언어에 맞춘 문구. 보관함 페이지가 setExportLabels로 넘긴다(기본값은 영어)
const labels = { title: 'PageBunker Export', image: 'Image', lang: 'en' };
export function setExportLabels(next) {
  Object.assign(labels, next);
}

const EXPORT_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function replaceRemoteImages(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return html;

  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    const alt = img.getAttribute('alt') || '';
    const link = doc.createElement('a');
    link.href = src;
    link.textContent = `[${labels.image}] ${alt ? alt + ' ' : ''}${src}`;
    img.replaceWith(link);
  }
  return root.innerHTML;
}

/**
 * @param {object[]} items — {article, html}
 */
export function exportArticlesHtml(items, title = labels.title) {
  const lines = [
    '<!DOCTYPE html>',
    `<html lang="${escapeHtml(labels.lang)}">`,
    '<head>',
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`,
    `<title>${escapeHtml(title)}</title>`,
    '<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.6}nav{margin-bottom:2rem}article{margin-bottom:3rem;border-top:1px solid #ccc;padding-top:1.5rem}h1{font-size:1.5rem}h2{font-size:1.1rem;color:#555}</style>',
    '</head>',
    '<body>',
    `<h1>${escapeHtml(title)}</h1>`,
    '<nav><ol>',
  ];

  for (const { article } of items) {
    lines.push(`<li><a href="#${escapeHtml(article.id)}">${escapeHtml(article.title || article.url)}</a></li>`);
  }
  lines.push('</ol></nav>');

  for (const { article, html } of items) {
    const base = article.url || '';
    let body = prepareReaderHtml(html || '', base);
    body = replaceRemoteImages(body);
    const meta = [article.siteName, article.byline, article.publishedTime].filter(Boolean).join(' · ');
    lines.push(`<article id="${escapeHtml(article.id)}">`);
    lines.push(`<h1>${escapeHtml(article.title || '')}</h1>`);
    if (meta) lines.push(`<h2>${escapeHtml(meta)}</h2>`);
    lines.push(`<p><a href="${escapeHtml(article.url)}">${escapeHtml(article.url)}</a></p>`);
    lines.push(body);
    lines.push('</article>');
  }

  lines.push('</body></html>');
  return lines.join('\n');
}

function htmlToMarkdown(html, base) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return '';

  const parts = [];
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'h1') { parts.push('\n\n# '); walkChildren(node); parts.push('\n'); return; }
    if (tag === 'h2') { parts.push('\n\n## '); walkChildren(node); parts.push('\n'); return; }
    if (tag === 'h3') { parts.push('\n\n### '); walkChildren(node); parts.push('\n'); return; }
    if (tag === 'p') { parts.push('\n\n'); walkChildren(node); return; }
    if (tag === 'br') { parts.push('\n'); return; }
    if (tag === 'strong' || tag === 'b') { parts.push('**'); walkChildren(node); parts.push('**'); return; }
    if (tag === 'em' || tag === 'i') { parts.push('*'); walkChildren(node); parts.push('*'); return; }
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      parts.push('[');
      walkChildren(node);
      parts.push(`](${href})`);
      return;
    }
    if (tag === 'img') {
      const src = node.getAttribute('src') || '';
      parts.push(`[${labels.image}](${src})`);
      return;
    }
    if (tag === 'li') { parts.push('\n- '); walkChildren(node); return; }
    if (tag === 'blockquote') { parts.push('\n\n> '); walkChildren(node); return; }
    if (tag === 'pre' || tag === 'code') {
      parts.push('\n```\n');
      parts.push(node.textContent);
      parts.push('\n```\n');
      return;
    }
    walkChildren(node);
  };

  const walkChildren = (el) => {
    for (const child of el.childNodes) walk(child);
  };

  walk(root);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @param {object} item — {article, html}
 */
export function exportArticleMarkdown(item) {
  const { article, html } = item;
  const base = article.url || '';
  const clean = prepareReaderHtml(html || '', base);
  const body = htmlToMarkdown(clean, base);
  const lines = [
    `# ${article.title || article.url}`,
    '',
    article.url,
    '',
    body,
  ];
  return lines.join('\n');
}

/**
 * @param {object[]} items
 */
export function exportArticlesMarkdownZipName(count) {
  return `pagebunker-export-${count}-articles.md`;
}
