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
    const sanitized = globalThis.ReadLaterSanitize.sanitizeHtml(article.content, baseURI);
    const text = article.textContent || '';
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
