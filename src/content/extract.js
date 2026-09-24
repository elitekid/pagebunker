// Readability 추출 + 1차 정리 (plan 4-1). 주입용 즉시 실행 함수

// 마지막 식의 값이 주입 결과가 된다. 반복 주입 충돌을 피하려고 전역 선언을 두지 않는다
(() => {
  const NODE_LIMIT = 200_000;
  const HTML_BYTE_LIMIT = 5 * 1024 * 1024;
  const MIN_TEXT_LEN = 80;

  function countNodes(root) {
    let n = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      n++;
      if (n > NODE_LIMIT) return n;
    }
    return n;
  }

  function metaContent(doc, selectors) {
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      const v = el?.getAttribute('content') || el?.content;
      if (v) return String(v).trim();
    }
    return '';
  }

  function jsonLdDate(doc) {
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const d = item?.datePublished || item?.dateModified;
          if (d) return String(d);
        }
      } catch {
        /* skip */
      }
    }
    return '';
  }

  function publishedTime(doc, article) {
    if (article?.publishedTime) return article.publishedTime;
    const og = metaContent(doc, [
      'meta[property="article:published_time"]',
      'meta[property="og:published_time"]',
    ]);
    if (og) return og;
    return jsonLdDate(doc) || '';
  }

  function utf8Bytes(str) {
    return new TextEncoder().encode(str).length;
  }

  function paragraphCount(text) {
    if (!text) return 0;
    return text.split(/\n\s*\n/).filter((p) => p.trim()).length;
  }

  // 본문 맨 앞 블록이 머리 제목·글쓴이와 공백만 다르면 뺀다. 라이브러리의 제목 비교는 영문자 단위라
  // 한글 제목을 같은 제목으로 못 알아보고, 500자 미만 글은 다시 추출하면서 이미 찾은 글쓴이 줄을 남긴다
  const WRAPPER_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'HEADER', 'HGROUP', 'MAIN']);
  const BLOCK_TAGS = new Set([...WRAPPER_TAGS, 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'ADDRESS', 'BLOCKQUOTE',
    'PRE', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'TABLE', 'FIGURE', 'FIGCAPTION', 'HR', 'ASIDE', 'FOOTER', 'NAV']);

  function squash(s) {
    return String(s || '').normalize('NFC').replace(/\s+/g, '').toLowerCase();
  }

  function hasText(n) {
    return (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE) && n.textContent.trim();
  }

  const LEADING_LINES = 3;

  function nextWithText(node) {
    let next = node.nextSibling;
    while (next && !hasText(next)) next = next.nextSibling;
    return next;
  }

  // 한 줄을 혼자 차지하는 요소만 뺀다. 문장 앞 글쓴이 링크처럼 뒤에 글이 이어지는 인라인 요소는 남긴다
  function standsAlone(el) {
    if (BLOCK_TAGS.has(el.tagName)) return true;
    const next = nextWithText(el);
    return !next || (next.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(next.tagName));
  }

  // 글쓴이 카드(사진·이름·소개 글)의 이름 줄은 남긴다. 이름 뒤에 글이 이어지는 작은 상자면 카드로 본다
  function inAuthorCard(el, totalLen) {
    return !!nextWithText(el) && squash(el.parentNode.textContent).length < totalLen / 2;
  }

  // 본문 앞쪽 줄을 문서 순서로 돌려준다. 감싸는 요소는 안으로 들어가되, 머리와 같은 글이면 통째로 돌려준다
  function* leadingLines(el, targets) {
    for (const n of [...el.childNodes]) {
      if (!hasText(n)) continue;
      if (n.nodeType === Node.ELEMENT_NODE && WRAPPER_TAGS.has(n.tagName) && !targets.includes(squash(n.textContent))) {
        yield* leadingLines(n, targets);
      } else {
        yield n;
      }
    }
  }

  // 앞쪽 몇 줄 안에서 머리 제목과 같은 줄, 머리 글쓴이와 같은 줄을 한 번씩 뺀다(분류 표시 뒤에 제목이 오는 뉴스 화면 포함)
  function stripLeadingDuplicates(html, title, byline) {
    const t = squash(title);
    const b = squash(byline);
    if (!t && !b) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const totalLen = squash(doc.body.textContent).length;
    const lines = [];
    for (const line of leadingLines(doc.body, [t, b].filter(Boolean))) {
      lines.push(line);
      if (lines.length >= LEADING_LINES) break;
    }
    let titleLeft = !!t;
    let bylineLeft = !!b;
    let removed = 0;
    for (const line of lines) {
      if (line.nodeType !== Node.ELEMENT_NODE || !standsAlone(line)) continue;
      const s = squash(line.textContent);
      if (titleLeft && s === t) {
        titleLeft = false;
      } else if (bylineLeft && s === b && !inAuthorCard(line, totalLen)) {
        bylineLeft = false;
      } else {
        continue;
      }
      line.remove();
      removed++;
    }
    return removed ? { html: doc.body.innerHTML, text: doc.body.textContent } : null;
  }

  function fail(reason, extra = {}) {
    return {
      ok: false,
      reason,
      finalUrl: location.href,
      docTitle: document.title || '',
      linkOnly: true,
      ...extra,
    };
  }

  try {
    const nodeCount = countNodes(document.documentElement);
    if (nodeCount > NODE_LIMIT) {
      return fail('too_many_nodes', { nodeCount });
    }

    const clone = document.cloneNode(true);
    const reader = new Readability(clone);
    const article = reader.parse();

    const docTitle = document.title || '';
    const lang =
      article?.lang ||
      document.documentElement.getAttribute('lang') ||
      '';

    const hasIframes = document.querySelectorAll('iframe[src]').length > 0;

    if (!article || !article.content) {
      if (hasIframes) {
        return fail('iframe', {
          docTitle,
          title: docTitle,
          lang,
          nodeCount,
        });
      }
      return fail('no_content', {
        docTitle,
        title: docTitle,
        lang,
        nodeCount,
      });
    }

    const baseURI = document.baseURI || location.href;
    const deduped = stripLeadingDuplicates(article.content, article.title || docTitle, article.byline);
    const sanitized = globalThis.ReadLaterSanitize.sanitizeHtml(deduped ? deduped.html : article.content, baseURI);
    const text = deduped ? deduped.text : article.textContent || '';
    const htmlBytes = utf8Bytes(sanitized);

    if (htmlBytes > HTML_BYTE_LIMIT) {
      return fail('too_large', {
        docTitle,
        title: article.title || docTitle,
        byline: article.byline || '',
        siteName: article.siteName || '',
        lang,
        htmlBytes,
        nodeCount,
      });
    }

    const paras = paragraphCount(text);
    const linkOnly = text.length < MIN_TEXT_LEN && paras <= 1;

    if (linkOnly && hasIframes) {
      return fail('iframe', {
        docTitle,
        title: article.title || docTitle,
        byline: article.byline || '',
        siteName: article.siteName || '',
        lang,
        nodeCount,
      });
    }

    return {
      ok: true,
      finalUrl: location.href,
      docTitle,
      title: article.title || docTitle,
      byline: article.byline || '',
      siteName: article.siteName || '',
      lang,
      publishedTime: publishedTime(document, article),
      modifiedTime: article.publishedTime ? '' : '',
      html: sanitized,
      text,
      excerpt: article.excerpt || text.slice(0, 200),
      nodeCount,
      htmlBytes,
      linkOnly,
    };
  } catch (err) {
    return fail('error', {
      message: err?.message || String(err),
      docTitle: document.title || '',
    });
  }
})();
