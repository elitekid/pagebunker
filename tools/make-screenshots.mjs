// 스토어 캡처(1280x800). 자유 이용 문서(위키백과·파이썬 문서·MDN)를 실제 추출 코드로 뽑아 보관함을 채우고 화면을 찍는다.
// 사용: node tools/make-screenshots.mjs <dist/chrome> <en|ko>
// 결과: 비공개 저장소 pagebunker-internal/release/store/screens-<lang>/*.png (PB_STORE_DIR로 변경 가능)
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(join(process.env.PPTR_DIR || '/tmp/tb-ff', 'package.json'));
const puppeteer = require('puppeteer-core');
const CHROME = process.env.RL_CHROME || `${process.env.HOME}/.cache/chrome-for-testing/chrome/mac_arm-153.0.8010.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const [EXT, LANG = 'en'] = process.argv.slice(2);
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
const OUT = join(process.env.PB_STORE_DIR || join(ROOT, '../pagebunker-internal/release/store'), `screens-${LANG}`);
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SOURCES = {
  en: [
    ['https://en.wikipedia.org/wiki/Link_rot', ['research', 'web']],
    ['https://en.wikipedia.org/wiki/Web_archiving', ['web']],
    ['https://docs.python.org/3/tutorial/classes.html', ['python', 'docs']],
    ['https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB', ['docs']],
    ['https://en.wikipedia.org/wiki/Offline_reader', ['web']],
    ['https://en.wikipedia.org/wiki/Typography', ['design']],
  ],
  ko: [
    ['https://ko.wikipedia.org/wiki/인터넷_아카이브', ['웹']],
    ['https://ko.wikipedia.org/wiki/디지털_보존', ['웹', '자료']],
    ['https://ko.wikipedia.org/wiki/도서관', ['독서']],
    ['https://docs.python.org/3/tutorial/classes.html', ['python', 'docs']],
    ['https://ko.wikipedia.org/wiki/전자책', ['독서']],
    ['https://ko.wikipedia.org/wiki/활판_인쇄', ['디자인', '역사']],
  ],
};

// 1) 실제 추출 코드로 본문 수집(캐시)
const cache = `/tmp/pb-demo-${LANG}.json`;
let articles;
if (existsSync(cache)) {
  articles = JSON.parse(readFileSync(cache, 'utf8'));
} else {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const p = await b.newPage();
  articles = [];
  for (const [url, tags] of SOURCES[LANG]) {
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
    let r;
    for (const f of ['vendor/Readability.js', 'shared/sanitize-body.js', 'content/extract.js']) r = await p.evaluate(readFileSync(join(EXT, f), 'utf8'));
    if (r?.ok && !r.linkOnly) articles.push({ url: p.url(), tags, ...r });
    console.log('extract', url, r?.ok, r?.text?.length);
  }
  await b.close();
  writeFileSync(cache, JSON.stringify(articles));
}

// 2) 확장을 해당 언어로 띄워 보관함을 채우고 촬영
const profile = mkdtempSync(join(tmpdir(), 'pb-shot-'));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profile, defaultViewport: { width: 1280, height: 800 },
  args: [`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, `--lang=${LANG}`, '-AppleLanguages', `(${LANG})`],
  ignoreDefaultArgs: ['--disable-extensions'],
});
const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 20000 });
const worker = await sw.worker();
const extId = new URL(worker.url()).host;
await sleep(2500);
const open = async (path) => {
  const p = await browser.newPage();
  for (let i = 0; i < 8; i++) { try { await p.goto(`chrome-extension://${extId}/${path}`); break; } catch { await sleep(800); } }
  await sleep(1500);
  return p;
};
let p = await open('library/library.html');
const now = Date.now();
await p.evaluate((articles, now) => new Promise((res) => {
  const q = indexedDB.open('readlater');
  q.onsuccess = () => {
    const tx = q.result.transaction(['articles', 'bodies', 'texts', 'meta'], 'readwrite');
    articles.forEach((a, i) => {
      const id = `demo-${i}`;
      const text = (a.text || '').replace(/\s+/g, ' ');
      const ko = /[가-힣]/.test(text.slice(0, 500));
      const minutes = Math.max(1, ko ? Math.ceil(text.length / 500) : Math.ceil(text.split(' ').length / 230));
      tx.objectStore('articles').put({ id, url: a.url, matchKey: a.url, title: a.title, siteName: a.siteName || new URL(a.url).hostname, byline: a.byline || '', lang: a.lang || '', excerpt: a.excerpt || text.slice(0, 200), publishedTime: a.publishedTime || '', modifiedTime: '', savedAt: now - i * 3600000 * 7, updatedAt: now, readState: i === 3 ? 'read' : 'unread', readAt: null, location: 'inbox', locationBefore: null, trashedAt: null, tags: a.tags, textLength: text.length, readingMinutes: minutes, position: null, bodyState: 'full', source: 'save', importJobId: null, bodyRestore: null });
      tx.objectStore('bodies').put({ id, html: a.html });
      tx.objectStore('texts').put({ id, searchText: text.toLowerCase() });
    });
    tx.objectStore('meta').put({ name: 'dataRevision', value: articles.length });
    tx.oncomplete = () => res(true);
  };
}), articles, now);
// 첫 실행 안내는 닫고, 백업 성공 상태를 만들어 상태 줄이 정상으로 보이게 한다
await worker.evaluate(async () => { await chrome.storage.local.set({ rl_first_run_done: true }); });
await p.close();
const o = await open('options/options.html');
await o.click('#btn-manual-backup'); await sleep(4000);
await o.close();

p = await open('library/library.html');
await p.screenshot({ path: join(OUT, '1-library.png') });
await p.type('#search', LANG === 'ko' ? '아카이브' : 'archive');
await sleep(1500);
await p.screenshot({ path: join(OUT, '2-search.png') });
await p.close();

const reader = await open('reader/reader.html?id=demo-1');
await reader.screenshot({ path: join(OUT, '3-reader.png') });
await reader.evaluate(() => { const t = document.getElementById('theme'); t.value = 'light'; t.dispatchEvent(new Event('input')); t.dispatchEvent(new Event('change')); });
await sleep(800);
await reader.screenshot({ path: join(OUT, '3b-reader-light.png') });
await reader.close();

p = await open('library/library.html');
await p.evaluate(() => document.getElementById('import-dialog').showModal());
await (await p.$('#import-file')).uploadFile(join(ROOT, 'fixtures/pocket-2025.csv'));
await sleep(2500);
await p.screenshot({ path: join(OUT, '4-import.png') });
await p.close();

const s = await open('options/options.html');
await s.screenshot({ path: join(OUT, '5-options.png') });
await s.close();

await browser.close();
rmSync(profile, { recursive: true, force: true });
console.log('done', OUT);
