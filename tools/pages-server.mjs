// 인수 확인용 로컬 페이지 서버. 사용: node tools/pages-server.mjs [port]
// 경계 페이지(노드 상한·크기 상한·지연·iframe·악성 요소)와 요청 기록(/log)을 제공한다.
import { createServer } from 'node:http';

const port = Number(process.argv[2] || 8765);
const hits = [];
const para = (n, text) => Array.from({ length: n }, (_, i) => `<p>${text} ${i + 1}. 이 문단은 저장 확인용 본문이다. The quick brown fox jumps over the lazy dog.</p>`).join('\n');
const page = (title, body, head = '') => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><header><nav>메뉴 홈 소개</nav></header><article><h1>${title}</h1>${body}</article><footer>푸터 광고</footer></body></html>`;

const routes = {
  '/article': () => page('정상 기사', `<p class="byline">글 홍길동</p><time datetime="2026-09-01">2026-09-01</time>${para(30, '정상 기사 문단')}<img src="/img/a.png" alt="사진"><pre><code>const x = 1;</code></pre><table><tr><td>표 칸</td></tr></table>`),
  '/short': () => page('짧은 글', '<p>한 줄짜리 짧은 글.</p>'),
  '/nodes': () => page('노드 과다', para(20, '앞 문단') + '<div>' + '<span>x</span>'.repeat(210000) + '</div>'),
  '/big': () => page('크기 과다', para(10, '앞 문단') + `<p>${'가'.repeat(2_000_000)}</p>`),
  '/iframe': () => page('iframe 본문', `<iframe src="/article" width="800" height="600"></iframe>`),
  '/evil': () => page('악성 요소', para(20, '악성 페이지 문단') +
    `<script>fetch('/hit/script')</script>
     <img src="x" onerror="fetch('/hit/onerror')">
     <a href="javascript:fetch('/hit/js-link')">링크</a>
     <svg><script>fetch('/hit/svg')</script></svg>
     <iframe srcdoc="<script>fetch('/hit/srcdoc')</script>"></iframe>
     <form action="/hit/form"><input value="폼"></form>
     <div style="background:url(/hit/css)">스타일</div>
     <img srcset="/hit/srcset 2x" src="/hit/src">
     <object data="/hit/object"></object><embed src="/hit/embed">
     <link rel="stylesheet" href="/hit/link-css">
     <p>악성 페이지 끝 문단.</p>`),
  '/hash': () => page('해시 경로 글', para(25, '해시 경로 문단') + '<p><a href="#sec2">섹션 2</a></p><h2 id="sec2">섹션 2</h2>'),
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  hits.push({ t: new Date().toISOString(), path: url.pathname + url.search, referer: req.headers.referer || '' });
  if (url.pathname === '/log') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(hits, null, 1)); }
  if (url.pathname === '/log/clear') { hits.length = 0; return res.end('cleared'); }
  if (url.pathname === '/slow') {
    // 문서는 곧바로 주되 본문 추출을 느리게 만드는 대신, 응답을 늦춰 탐색 중 저장을 재현한다
    await new Promise(r => setTimeout(r, Number(url.searchParams.get('ms') || 15000)));
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(page('느린 페이지', para(30, '느린 문단')));
  }
  if (url.pathname.startsWith('/img/')) {
    res.setHeader('content-type', 'image/png');
    return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  }
  const fn = routes[url.pathname];
  if (!fn) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(fn());
}).listen(port, '127.0.0.1', () => console.log(`pages http://127.0.0.1:${port}/`));
