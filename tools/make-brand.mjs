// PageBunker 브랜드 마크(SVG) → 아이콘 16/32/48/128, 로고 300, 홍보 타일 440x280, 큰 홍보 1400x560
// TabBunker와 같은 남색 바탕·벙커 아치를 쓰고, 아치 안에 접힌 모서리 종이와 글줄(청록)을 넣어 한 가족으로 보이게 한다.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

const require = createRequire(process.env.PPTR_DIR ? process.env.PPTR_DIR + '/package.json' : '/tmp/tb-ff/package.json');
const puppeteer = require('puppeteer-core');
const CHROME = process.env.RL_CHROME || `${process.env.HOME}/.cache/chrome-for-testing/chrome/mac_arm-153.0.8010.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const OUT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
// 스토어 이미지는 비공개 저장소(pagebunker-internal)에 둔다. 다른 곳에 쓰려면 PB_STORE_DIR 지정
const STORE = process.env.PB_STORE_DIR || `${OUT}/../pagebunker-internal/release/store`;
mkdirSync(STORE, { recursive: true });

const ACCENT = '#3fc8a8';
// 작은 크기(16·32)에서는 글줄을 줄이고 종이를 크게 그려 뭉개지지 않게 한다
const mark = (size, radius = 0.22) => {
  const small = size <= 32;
  const lines = small
    ? `<rect x="46" y="72" width="36" height="9" rx="4.5" fill="${ACCENT}"/><rect x="46" y="87" width="24" height="9" rx="4.5" fill="${ACCENT}"/>`
    : `<rect x="47" y="70" width="34" height="6" rx="3" fill="${ACCENT}"/><rect x="47" y="80" width="34" height="6" rx="3" fill="${ACCENT}"/><rect x="47" y="90" width="22" height="6" rx="3" fill="${ACCENT}"/>`;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b3a55"/><stop offset="1" stop-color="#16213a"/></linearGradient></defs>
  <rect x="0" y="0" width="128" height="128" rx="${128 * radius}" fill="url(#g)"/>
  <path d="M24 104 V64 a40 40 0 0 1 80 0 V104 Z" fill="#e8ecf3"/>
  <rect x="24" y="96" width="80" height="10" fill="#c9d1de"/>
  <path d="M40 56 H76 L88 68 V104 H40 Z" fill="#ffffff" stroke="#b9c3d3" stroke-width="2"/>
  <path d="M76 56 V68 H88 Z" fill="#c9d1de"/>
  ${lines}
</svg>`;
};

const page = (w, h, body, bg = 'transparent') => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${w}px;height:${h}px;background:${bg};overflow:hidden;font-family:-apple-system,"Segoe UI",Inter,sans-serif}</style></head><body>${body}</body></html>`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] });
const p = await browser.newPage();
async function shot(w, h, html, file, omitBg = true) {
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await p.setContent(html, { waitUntil: 'load' });
  await p.screenshot({ path: file, omitBackground: omitBg, clip: { x: 0, y: 0, width: w, height: h } });
  console.log('wrote', file);
}
for (const s of [16, 32, 48, 128]) await shot(s, s, page(s, s, mark(s)), `${OUT}/src/icons/icon${s}.png`);
await shot(300, 300, page(300, 300, `<div style="width:300px;height:300px;display:grid;place-items:center;background:#fff">${mark(240)}</div>`), `${STORE}/logo-300.png`, false);
const tileBg = 'background:radial-gradient(circle at 20% 20%, #34496e 0, #16213a 60%);';
await shot(440, 280, page(440, 280, `<div style="width:440px;height:280px;display:grid;place-items:center;${tileBg}">${mark(170)}</div>`), `${STORE}/promo-small-440x280.png`, false);
await shot(1400, 560, page(1400, 560, `<div style="width:1400px;height:560px;display:flex;align-items:center;gap:72px;padding:0 140px;box-sizing:border-box;${tileBg}color:#fff">${mark(300)}<div><div style="font-size:92px;font-weight:700;letter-spacing:-2px;line-height:1">PageBunker</div><div style="font-size:38px;margin-top:22px;color:#dbe3f0">Save articles. Read offline. Search later.</div><div style="font-size:26px;margin-top:18px;color:${ACCENT}">No account. Stored on your own computer.</div></div></div>`), `${STORE}/promo-marquee-1400x560.png`, false);
// 확인용 확대 시트: 실제 크기 아이콘을 확대해 한 장에(오른쪽 끝은 TabBunker 비교)
const b64 = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
const imgs = [16, 32, 48, 128].map(s => `<img src="${b64(`${OUT}/src/icons/icon${s}.png`)}" style="width:${Math.min(s * 4, 200)}px;image-rendering:pixelated">`).join('')
  + (existsSync(`${OUT}/../tab-bunker/src/icons/icon128.png`) ? `<img src="${b64(`${OUT}/../tab-bunker/src/icons/icon128.png`)}" style="width:128px">` : '');
await shot(900, 260, page(900, 260, `<div style="display:flex;gap:40px;align-items:center;padding:30px;background:#f4f6fa;height:200px">${imgs}</div>`, '#f4f6fa'), `${STORE}/icon-sheet.png`, false);
await browser.close();
