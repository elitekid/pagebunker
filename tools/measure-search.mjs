// T4.2 검색 속도 실측. 사용: node tools/measure-search.mjs <dist/chrome> <글 수>
// 실제 문서(MD_ROOT 환경변수 폴더 아래 마크다운, 기본은 저장소 상위 폴더)로 글을 채우고, 보관함 검색창 입력부터 목록 갱신까지 잰다(250ms 대기 제외).
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire('/tmp/tb-ff/package.json');
const puppeteer = require('puppeteer-core');
const [ext, nArg] = process.argv.slice(2);
const N = Number(nArg || 300);

const REPO = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
const MD_ROOT = process.env.MD_ROOT || join(REPO, '..');
const files = execSync(`find "${MD_ROOT}" -name "*.md" -size +3k -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "${REPO}/*"`, { encoding: 'utf8' }).trim().split('\n').sort();
const seen = new Set();
const docs = [];
for (const f of files) {
  let t;
  try { t = readFileSync(f, 'utf8').slice(0, 12000); } catch { continue; }
  const h = createHash('sha1').update(t).digest('hex');
  if (seen.has(h)) continue;
  seen.add(h);
  docs.push({ f, t });
  if (docs.length >= N) break;
}
const corpusHash = createHash('sha256').update(docs.map(d => d.t).join('|||')).digest('hex');
const lens = docs.map(d => d.t.length).sort((a, b) => a - b);
const now = Date.now();
const rows = docs.map((d, i) => {
  const id = randomUUID();
  const text = d.t.replace(/[#*`>|_-]+/g, ' ');
  const paras = text.split(/\n{2,}/).filter(Boolean);
  return {
    a: { id, url: `https://corpus.test/${i}`, matchKey: `https://corpus.test/${i}`, title: d.f.split('/').slice(-2).join('/'), siteName: 'corpus', byline: '', lang: /[가-힣]/.test(text) ? 'ko' : 'en', excerpt: text.slice(0, 200), publishedTime: '', modifiedTime: '', savedAt: now - i * 60000, updatedAt: now - i * 60000, readState: 'unread', readAt: null, location: 'inbox', locationBefore: null, trashedAt: null, tags: [], textLength: text.length, readingMinutes: 3, position: null, bodyState: 'full', source: 'save', importJobId: null, bodyRestore: null },
    b: { id, html: paras.map(p => `<p>${p.replace(/[<&]/g, ' ')}</p>`).join('') },
    t: { id, searchText: text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim() },
  };
});

const CHROME = `${process.env.HOME}/.cache/chrome-for-testing/chrome/mac_arm-153.0.8010.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const profile = mkdtempSync(join(tmpdir(), 'rl-perf-'));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: [`--load-extension=${ext}`, `--disable-extensions-except=${ext}`], ignoreDefaultArgs: ['--disable-extensions'] });
const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
const page = await browser.newPage();
await page.goto(`chrome-extension://${extId}/library/library.html`);
await new Promise(r => setTimeout(r, 1500));
await page.evaluate((rows) => new Promise((res, rej) => {
  const r = indexedDB.open('readlater');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => {
    const tx = r.result.transaction(['articles', 'bodies', 'texts', 'meta'], 'readwrite');
    for (const x of rows) { tx.objectStore('articles').put(x.a); tx.objectStore('bodies').put(x.b); tx.objectStore('texts').put(x.t); }
    tx.objectStore('meta').put({ name: 'dataRevision', value: rows.length });
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  };
}), rows);

const queries = ['위임', '재기동', '백업 파일', 'extension', '"허브 재기동"', '마케팅 스토어', 'session', '검증 실제 실행', 'chrome web store', '결정'];
const results = [];
for (const run of ['cold', 'warm']) {
  if (run === 'cold') { await page.reload(); await new Promise(r => setTimeout(r, 1500)); }
  for (const q of queries) {
    await page.evaluate(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); });
    await new Promise(r => setTimeout(r, 600));
    const m = await page.evaluate((q) => new Promise((res) => {
      const list = document.getElementById('list');
      const s = document.getElementById('search');
      let t0;
      const mo = new MutationObserver(() => { mo.disconnect(); res({ ms: Math.round(performance.now() - t0 - 250), count: list.children.length }); });
      mo.observe(list, { childList: true });
      t0 = performance.now();
      s.value = q;
      s.dispatchEvent(new Event('input'));
      setTimeout(() => { mo.disconnect(); res({ ms: -1, count: -1 }); }, 20000);
    }), q);
    results.push({ run, q, ...m });
  }
}
console.log(JSON.stringify({ N: docs.length, corpusHash, lenMin: lens[0], lenMedian: lens[lens.length >> 1], lenMax: lens.at(-1), totalChars: lens.reduce((a, b) => a + b, 0), browser: await browser.version(), results }));
await browser.close();
rmSync(profile, { recursive: true, force: true });
