// 사용자 동작(활성 탭 권한)이 필요 없는 인수 항목을 화면 없는 크롬 테스트판에서 실제 확장으로 돌린다.
// 사용: node tools/accept-headless.mjs <dist/chrome> <항목> [출력 폴더]
// 항목: import-resume | import-cancel | trash | dated | export | loadmore | settings | screens
import { createRequire } from 'node:module';
const FIXTURES = decodeURIComponent(new URL('../fixtures', import.meta.url).pathname);
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(join(process.env.PPTR_DIR || '/tmp/tb-ff', 'package.json'));
const puppeteer = require('puppeteer-core');
const CHROME = process.env.RL_CHROME || `${process.env.HOME}/.cache/chrome-for-testing/chrome/mac_arm-153.0.8010.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const [EXT, ITEM, OUT = '/tmp/rl-acc2/out'] = process.argv.slice(2);
const DL = join(OUT, `dl-${ITEM}`);
mkdirSync(DL, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'rl-acc-'));
const log = (...a) => console.log(JSON.stringify(a.length === 1 ? a[0] : a));

let browser, worker, extId;
async function sw() {
  const t = await browser.waitForTarget(x => x.type() === 'service_worker' && x.url().includes('/background.js'), { timeout: 20000 });
  return t.worker();
}
// 같은 프로필로 브라우저를 띄운다. 재시작 확인은 강제 종료 후 이 함수를 다시 부른다.
async function launch() {
  // CDP 다운로드 설정은 파일 이름을 임의 문자열로 바꾼다. 프로필 기본 설정으로 폴더만 지정해 원래 이름을 유지한다.
  mkdirSync(join(profile, 'Default'), { recursive: true });
  const prefPath = join(profile, 'Default', 'Preferences');
  let pref = {};
  try { pref = JSON.parse(readFileSync(prefPath, 'utf8')); } catch {}
  pref.download = { ...(pref.download || {}), default_directory: DL, prompt_for_download: false, directory_upgrade: true };
  pref.savefile = { default_directory: DL };
  writeFileSync(prefPath, JSON.stringify(pref));
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, defaultViewport: { width: 1100, height: 900 }, args: [`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, ...(process.env.RL_LANG ? [`--lang=${process.env.RL_LANG}`, '-AppleLanguages', `(${process.env.RL_LANG})`] : [])], ignoreDefaultArgs: ['--disable-extensions'], env: { ...process.env, ...(process.env.RL_LANG ? { LANG: process.env.RL_LANG, LANGUAGE: process.env.RL_LANG } : {}) } });
  worker = await sw();
  extId = new URL(worker.url()).host;
  await sleep(2000);
}
async function crashAndRelaunch() {
  browser.process().kill('SIGKILL');
  await sleep(2000);
  await launch();
  await sleep(2500);
}
await launch();
const lib = async () => {
  for (let i = 0; i < 10; i++) {
    const p = await browser.newPage();
    try { await p.goto(`chrome-extension://${extId}/library/library.html`); await sleep(1200); return p; }
    catch (e) { console.error('lib 재시도', i, e.message.slice(0, 40)); await p.close().catch(() => {}); if (i === 9) throw e; await sleep(1000); }
  }
};
const idb = (page, fn, arg) => page.evaluate(fn, arg);
const counts = (page) => idb(page, () => new Promise(res => { const q = indexedDB.open('readlater'); q.onsuccess = () => { const db = q.result; const out = {}; let n = 4; for (const s of ['articles', 'bodies', 'texts', 'meta']) { const g = s === 'meta' ? db.transaction(s).objectStore(s).getAll() : db.transaction(s).objectStore(s).count(); g.onsuccess = () => { out[s] = g.result; if (--n === 0) res(out); }; } }; }));

async function uploadAndPreview(page, file) {
  await page.evaluate(() => document.getElementById('import-dialog').open || document.getElementById('import-dialog').showModal());
  await (await page.$('#import-file')).uploadFile(file);
  await page.waitForFunction(() => /\d/.test(document.getElementById('import-preview')?.innerText || ''), { timeout: 120000 });
  return page.evaluate(() => document.getElementById('import-preview').innerText);
}

async function importInterrupt(file) {
  const p = await lib();
  const preview = await uploadAndPreview(p, file);
  await p.evaluate(() => document.getElementById('btn-import-apply').click());
  // 첫 배치가 기록되고 끝나기 전에 확장을 다시 불러온다(서비스워커 강제 종료와 같은 효과)
  let job;
  for (let i = 0; i < 400; i++) {
    job = (await worker.evaluate(() => chrome.storage.local.get('rl_import_job'))).rl_import_job;
    if (job && job.processedIndex >= 1000 && job.processedIndex < job.totalCount) break;
    await sleep(25);
  }
  const at = job?.processedIndex;
  await crashAndRelaunch();
  return { preview, interruptedAt: at, totalCount: job?.totalCount };
}

try {
  if (ITEM === 'import-resume' || ITEM === 'import-cancel') {
    const file = '/tmp/rl-acc2/pocket-10k.csv';
    // 기존 글 3개를 먼저 넣어 두고, 취소·되돌리기가 기존 글을 건드리지 않는지 본다
    let p = await lib();
    await uploadAndPreview(p, FIXTURES + '/pocket-2025.csv');
    await p.evaluate(() => document.getElementById('btn-import-apply').click());
    await sleep(3000);
    const base = await counts(p);
    await p.close();
    const intr = await importInterrupt(file);
    p = await lib();
    const afterInterrupt = await counts(p);
    const job = (await worker.evaluate(() => chrome.storage.local.get(['rl_import_job']))).rl_import_job;
    const banner = await p.evaluate(() => document.getElementById('import-resume')?.innerText);
    log({ step: 'interrupted', base: base.articles, ...intr, afterInterrupt: afterInterrupt.articles, job, banner });
    if (ITEM === 'import-resume') {
      await p.evaluate(() => document.getElementById('btn-resume-import').click());
      await sleep(500);
      const preview2 = await uploadAndPreview(p, file);
      await p.evaluate(() => document.getElementById('btn-import-apply').click());
      for (let i = 0; i < 240; i++) { const j = (await worker.evaluate(() => chrome.storage.local.get('rl_import_job'))).rl_import_job; if (j?.status === 'done') break; await sleep(500); }
      await sleep(1500);
      const final = await counts(p);
      const keys = await idb(p, () => new Promise(res => { const q = indexedDB.open('readlater'); q.onsuccess = () => { const g = q.result.transaction('articles').objectStore('articles').getAll(); g.onsuccess = () => res(g.result.filter(a => a.url.startsWith('https://import.test/')).map(a => a.url)); }; }));
      const set = new Set(keys);
      const missing = []; for (let i = 0; i < 10000; i++) if (!set.has(`https://import.test/a/${i}`)) missing.push(i);
      const defer = (await worker.evaluate(() => chrome.storage.local.get(null)));
      const undoVisible = await p.evaluate(() => !document.getElementById('btn-import-undo').classList.contains('hidden'));
      const jobIds = await idb(p, () => new Promise(res => { const q = indexedDB.open('readlater'); q.onsuccess = () => { const g = q.result.transaction('articles').objectStore('articles').getAll(); g.onsuccess = () => res([...new Set(g.result.filter(a => a.url.startsWith('https://import.test/')).map(a => a.importJobId))]); }; }));
      p.on('dialog', d => d.accept());
      await p.evaluate(() => document.getElementById('btn-import-undo').click());
      await sleep(800);
      await p.evaluate(() => document.getElementById('btn-confirm-yes')?.click());
      await sleep(6000);
      const afterUndo = await counts(p);
      log({ step: 'undo', undoVisible, jobIds, afterUndoArticles: afterUndo.articles, afterUndoBodies: afterUndo.bodies });
      log({ step: 'resumed', preview2, finalArticles: final.articles, importRows: keys.length, unique: set.size, missingCount: missing.length, missingSample: missing.slice(0, 5), backupDeferredKeys: Object.keys(defer).filter(k => /defer/i.test(k)).map(k => [k, defer[k]]), job: defer.rl_import_job });
    } else {
      p.on('dialog', d => d.accept());
      await p.evaluate(() => document.getElementById('btn-cancel-import').click());
      await sleep(800);
      await p.evaluate(() => document.getElementById('btn-confirm-yes')?.click());
      await sleep(4000);
      const final = await counts(p);
      const rest = await idb(p, () => new Promise(res => { const q = indexedDB.open('readlater'); q.onsuccess = () => { const g = q.result.transaction('articles').objectStore('articles').getAll(); g.onsuccess = () => res(g.result.map(a => a.url)); }; }));
      const all = await worker.evaluate(() => chrome.storage.local.get(null));
      log({ step: 'canceled', finalArticles: final.articles, remainingUrls: rest, job: all.rl_import_job || null, deferKeys: Object.keys(all).filter(k => /defer/i.test(k)).map(k => [k, all[k]]) });
    }
  }

  if (ITEM === 'trash') {
    const p = await lib();
    const DAY = 86400000;
    const ages = { t29: 29 * DAY, t30plus: 30 * DAY + 60000, t31: 31 * DAY, inbox40: 40 * DAY };
    await idb(p, (ages) => new Promise(res => { const q = indexedDB.open('readlater'); q.onsuccess = () => { const tx = q.result.transaction(['articles', 'bodies', 'texts', 'meta'], 'readwrite'); const now = Date.now(); for (const [k, age] of Object.entries(ages)) { const trash = !k.startsWith('inbox'); tx.objectStore('articles').put({ id: k, url: `https://trash.test/${k}`, matchKey: `https://trash.test/${k}`, title: k, siteName: '', byline: '', lang: 'en', excerpt: '', publishedTime: '', modifiedTime: '', savedAt: now - age, updatedAt: now - age, readState: 'unread', readAt: null, location: trash ? 'trash' : 'inbox', locationBefore: trash ? 'inbox' : null, trashedAt: trash ? now - age : null, tags: [], textLength: 10, readingMinutes: 1, position: null, bodyState: 'full', source: 'save', importJobId: null, bodyRestore: null }); tx.objectStore('bodies').put({ id: k, html: '<p>x</p>' }); tx.objectStore('texts').put({ id: k, searchText: 'x' }); } tx.objectStore('meta').put({ name: 'dataRevision', value: 10 }); tx.oncomplete = () => res(true); }; }), ages);
    const before = await counts(p);
    await p.close();
    // 브라우저를 강제 종료했다가 같은 프로필로 다시 띄운다. 시작 시 밀린 정리를 수행해야 한다
    await crashAndRelaunch();
    const p2 = await lib();
    const after = await idb(p2, () => new Promise(res => { const q = indexedDB.open('readlater'); q.onsuccess = () => { const db = q.result; const tx = db.transaction(['articles', 'bodies', 'texts', 'meta']); const out = {}; let n = 4; const done = () => { if (--n === 0) res(out); }; tx.objectStore('articles').getAllKeys().onsuccess = e => { out.articles = e.target.result; done(); }; tx.objectStore('bodies').getAllKeys().onsuccess = e => { out.bodies = e.target.result; done(); }; tx.objectStore('texts').getAllKeys().onsuccess = e => { out.texts = e.target.result; done(); }; tx.objectStore('meta').getAll().onsuccess = e => { out.meta = e.target.result; done(); }; }; }));
    const alarm = await worker.evaluate(() => chrome.alarms.get('trash-cleanup'));
    log({ item: 'trash', before, after, alarm: alarm && { periodInMinutes: alarm.periodInMinutes } });
  }

  if (ITEM === 'dated') {
    // 백업 8회: 매번 데이터 버전을 올리고 마지막 날짜 백업 시각을 25시간 전으로 돌려 날짜 파일 조건을 만든다(시계 조작 없음)
    const p = await lib();
    const results = [];
    for (let k = 1; k <= 8; k++) {
      await idb(p, (k) => new Promise(res => { const q = indexedDB.open('readlater'); q.onsuccess = () => { const tx = q.result.transaction(['articles', 'meta'], 'readwrite'); tx.objectStore('articles').put({ id: `d${k}`, url: `https://dated.test/${k}`, matchKey: `https://dated.test/${k}`, title: `dated ${k}`, siteName: '', byline: '', lang: 'en', excerpt: '', publishedTime: '', modifiedTime: '', savedAt: Date.now(), updatedAt: Date.now(), readState: 'unread', readAt: null, location: 'inbox', locationBefore: null, trashedAt: null, tags: [], textLength: 1, readingMinutes: 1, position: null, bodyState: 'link_only', source: 'save', importJobId: null, bodyRestore: null }); tx.objectStore('meta').put({ name: 'dataRevision', value: 100 + k }); tx.oncomplete = () => res(true); }; }), k);
      await worker.evaluate(async () => { const s = (await chrome.storage.local.get('rl_backup_state')).rl_backup_state; if (s && s.lastDatedAt) { s.lastDatedAt -= 25 * 3600 * 1000; await chrome.storage.local.set({ rl_backup_state: s }); } });
      const o = await browser.newPage();
      await o.goto(`chrome-extension://${extId}/options/options.html`); await sleep(800);
      await o.click('#btn-manual-backup');
      await sleep(5000);
      await o.close();
      const st = (await worker.evaluate(() => chrome.storage.local.get('rl_backup_state'))).rl_backup_state;
      const files = readdirSync(join(DL, 'PageBunker')).sort();
      results.push({ k, datedFiles: (st.datedFiles || []).length, datedError: st.datedError, lastError: st.lastError, files });
      log(results.at(-1));
      await sleep(61000 - 5800); // 날짜 파일 이름이 분 단위라 분을 넘긴다
    }
  }

  if (ITEM === 'export') {
    const p = await lib();
    await idb(p, () => new Promise(res => { const q = indexedDB.open('readlater'); q.onsuccess = () => { const tx = q.result.transaction(['articles', 'bodies', 'texts', 'meta'], 'readwrite'); const now = Date.now(); const html = '<div><h2>내보내기 글</h2><p>본문 <a href="https://example.com/x">링크</a></p><img src="https://example.com/remote.png" alt="원격"><p>끝</p></div>'; for (const k of ['e1', 'e2']) { tx.objectStore('articles').put({ id: k, url: `https://export.test/${k}`, matchKey: `https://export.test/${k}`, title: `내보내기 ${k}`, siteName: 'export', byline: '', lang: 'ko', excerpt: '', publishedTime: '', modifiedTime: '', savedAt: now, updatedAt: now, readState: 'unread', readAt: null, location: 'inbox', locationBefore: null, trashedAt: null, tags: [], textLength: 20, readingMinutes: 1, position: null, bodyState: 'full', source: 'save', importJobId: null, bodyRestore: null }); tx.objectStore('bodies').put({ id: k, html }); tx.objectStore('texts').put({ id: k, searchText: '내보내기 글 본문 링크 끝' }); } tx.oncomplete = () => res(true); }; }));
    await p.reload(); await sleep(1500);
    const net = [];
    p.on('request', r => { if (!r.url().startsWith('chrome-extension://') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) net.push(r.url()); });
    for (const fmt of ['html', 'markdown']) {
      await p.evaluate(() => document.getElementById('btn-select-mode').click()); await sleep(400);
      const n = await p.evaluate(() => { const cbs = [...document.querySelectorAll('.item-select')]; cbs.forEach(cb => { if (!cb.checked) cb.click(); }); return cbs.length; });
      await p.evaluate(() => document.getElementById('btn-sel-export').click()); await sleep(400);
      await p.evaluate((fmt) => { document.querySelector(`input[name="export-format"][value="${fmt}"]`).checked = true; }, fmt);
      await p.evaluate(() => document.getElementById('btn-export-apply').click());
      await sleep(4000);
      log({ fmt, selected: n, files: readdirSync(DL, { recursive: true }) });
      await p.evaluate(() => { const b = document.getElementById('btn-sel-cancel'); if (b) b.click(); }).catch(() => {});
      await sleep(500);
    }
    log({ requestsDuringExport: net });
    const htmlFile = readdirSync(join(DL, 'PageBunker')).find(f => f.endsWith('.html'));
    if (htmlFile) {
      const path = join(DL, 'PageBunker', htmlFile);
      const text = readFileSync(path, 'utf8');
      const v = await browser.newPage();
      const reqs = []; const errs = [];
      v.on('request', r => { if (!r.url().startsWith('file:')) reqs.push(r.url()); });
      v.on('console', m => errs.push(m.text().slice(0, 120)));
      await v.goto('file://' + path); await sleep(2500);
      const view = await v.evaluate(() => ({ imgs: document.images.length, scripts: document.scripts.length, csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content, hasImageLink: /\[이미지\]|\[image\]/i.test(document.body.innerText), title: document.title, toc: document.querySelectorAll('a[href^="#"]').length }));
      log({ htmlFile, bytes: text.length, view, requestsWhenOpened: reqs, console: errs.slice(0, 3) });
    }
    const md = readdirSync(join(DL, 'PageBunker')).filter(f => f.endsWith('.md'));
    log({ markdownFiles: md, sample: md[0] ? readFileSync(join(DL, 'PageBunker', md[0]), 'utf8').slice(0, 300) : null });
  }

  if (ITEM === 'loadmore') {
    const p = await lib();
    await idb(p, () => new Promise(res => { const q = indexedDB.open('readlater'); q.onsuccess = () => { const tx = q.result.transaction(['articles'], 'readwrite'); const now = Date.now(); for (let i = 0; i < 120; i++) tx.objectStore('articles').put({ id: `m${i}`, url: `https://more.test/${i}`, matchKey: `https://more.test/${i}`, title: `more ${i}`, siteName: '', byline: '', lang: 'en', excerpt: '', publishedTime: '', modifiedTime: '', savedAt: now - i * 1000, updatedAt: now, readState: 'unread', readAt: null, location: 'inbox', locationBefore: null, trashedAt: null, tags: [], textLength: 1, readingMinutes: 1, position: null, bodyState: 'link_only', source: 'save', importJobId: null, bodyRestore: null }); tx.oncomplete = () => res(true); }; }));
    await p.reload(); await sleep(1500);
    const first = await p.evaluate(() => ({ items: document.getElementById('list').children.length, moreVisible: !document.getElementById('btn-load-more').classList.contains('hidden'), last: document.getElementById('list').lastElementChild?.innerText.split('\n')[0] }));
    await p.evaluate(() => document.getElementById('btn-load-more').click()); await sleep(800);
    const second = await p.evaluate(() => ({ items: document.getElementById('list').children.length, moreVisible: !document.getElementById('btn-load-more').classList.contains('hidden'), last: document.getElementById('list').lastElementChild?.innerText.split('\n')[0] }));
    log({ item: 'loadmore', first, second });
  }

  if (ITEM === 'settings') {
    const seed = (p) => idb(p, () => new Promise(res => { const q = indexedDB.open('readlater'); q.onsuccess = () => { const tx = q.result.transaction(['articles', 'bodies', 'texts'], 'readwrite'); const now = Date.now(); tx.objectStore('articles').put({ id: 'img1', url: 'https://react.dev/learn', matchKey: 'https://react.dev/learn', title: 'img article', siteName: '', byline: '', lang: 'en', excerpt: '', publishedTime: '', modifiedTime: '', savedAt: now, updatedAt: now, readState: 'unread', readAt: null, location: 'inbox', locationBefore: null, trashedAt: null, tags: [], textLength: 10, readingMinutes: 1, position: null, bodyState: 'full', source: 'save', importJobId: null, bodyRestore: null }); tx.objectStore('bodies').put({ id: 'img1', html: '<div><p>text</p><img src="https://react.dev/images/og-home.png" alt="og"></div>' }); tx.objectStore('texts').put({ id: 'img1', searchText: 'text' }); tx.oncomplete = () => res(true); }; }));
    let p = await lib(); await seed(p); await p.close();
    const o = await browser.newPage();
    await o.goto(`chrome-extension://${extId}/options/options.html`); await sleep(1000);
    const before = await o.evaluate(() => ({ autoMarkRead: document.getElementById('autoMarkRead').checked, showImagesDefault: document.getElementById('showImagesDefault').checked, autoFileBackup: document.getElementById('autoFileBackup').checked }));
    await o.evaluate(() => { for (const id of ['autoMarkRead', 'showImagesDefault', 'autoFileBackup']) document.getElementById(id).click(); document.getElementById('btn-save').click(); });
    await sleep(1500);
    const statusText = await o.evaluate(() => document.getElementById('status').innerText);
    await o.close();
    await crashAndRelaunch();
    const o2 = await browser.newPage();
    await o2.goto(`chrome-extension://${extId}/options/options.html`); await sleep(1000);
    const after = await o2.evaluate(() => ({ autoMarkRead: document.getElementById('autoMarkRead').checked, showImagesDefault: document.getElementById('showImagesDefault').checked, autoFileBackup: document.getElementById('autoFileBackup').checked }));
    await o2.close();
    const stored = (await worker.evaluate(() => chrome.storage.local.get('rl_settings'))).rl_settings;
    // 이미지 기본 표시 켬 → 읽기 화면이 누르지 않아도 이미지를 넣는지
    const r = await browser.newPage();
    const reqs = []; r.on('request', q => { if (q.url().startsWith('https://')) reqs.push({ url: q.url().slice(0, 60), referer: q.headers().referer || '' }); });
    await r.goto(`chrome-extension://${extId}/reader/reader.html?id=img1`); await sleep(3000);
    const reader = await r.evaluate(() => ({ imgs: document.querySelectorAll('#content img').length, placeholders: document.querySelectorAll('.rl-img-placeholder').length }));
    await r.close();
    // 자동 파일 백업 끔 → 데이터를 바꿔도 백업 예약·파일이 생기지 않는지(가져오기로 변경)
    p = await lib();
    await uploadAndPreview(p, FIXTURES + '/pocket-2025.csv');
    await p.evaluate(() => document.getElementById('btn-import-apply').click());
    await sleep(4000);
    const alarms = await worker.evaluate(() => chrome.alarms.getAll());
    const state = (await worker.evaluate(() => chrome.storage.local.get('rl_backup_state'))).rl_backup_state || null;
    let files = []; try { files = readdirSync(DL, { recursive: true }); } catch {}
    log({ item: 'settings', before, statusText, after, stored, reader, imageRequests: reqs, alarms: alarms.map(a => a.name), backupState: state && { firstDirtyAt: state.firstDirtyAt, lastFileOkRevision: state.lastFileOkRevision, inflight: state.inflight }, downloadedFiles: files });
  }

  if (ITEM === 'screens') {
    const lang = process.env.RL_LANG || 'default';
    const shots = join(OUT, `screens-${lang}`); mkdirSync(shots, { recursive: true });
    let p = await lib();
    await uploadAndPreview(p, FIXTURES + '/instapaper-2025.csv');
    const importPreview = await p.evaluate(() => document.getElementById('import-dialog').innerText);
    await p.screenshot({ path: join(shots, 'import-preview.png') });
    await p.evaluate(() => document.getElementById('btn-import-apply').click()); await sleep(3000);
    await idb(p, () => new Promise(res => { const q = indexedDB.open('readlater'); q.onsuccess = () => { const tx = q.result.transaction(['articles', 'bodies', 'texts'], 'readwrite'); const now = Date.now(); tx.objectStore('articles').put({ id: 'full1', url: 'https://example.com/full', matchKey: 'https://example.com/full', title: '정리된 글 Full article', siteName: 'example', byline: 'Writer', lang: 'ko', excerpt: '첫 문단', publishedTime: '2026-09-01', modifiedTime: '', savedAt: now, updatedAt: now, readState: 'unread', readAt: null, location: 'inbox', locationBefore: null, trashedAt: null, tags: ['tag1'], textLength: 900, readingMinutes: 2, position: null, bodyState: 'full', source: 'save', importJobId: null, bodyRestore: null }); tx.objectStore('bodies').put({ id: 'full1', html: '<div><h2>소제목</h2><p>첫 문단 본문입니다.</p><img src="https://example.com/a.png" alt="사진"><pre><code>code()</code></pre></div>' }); tx.objectStore('texts').put({ id: 'full1', searchText: '첫 문단' }); tx.oncomplete = () => res(true); }; }));
    await p.reload(); await sleep(1500);
    const texts = {};
    texts.library = await p.evaluate(() => document.body.innerText);
    await p.screenshot({ path: join(shots, 'library.png'), fullPage: true });
    await p.evaluate(() => document.getElementById('btn-select-mode').click()); await sleep(300);
    texts.librarySelect = await p.evaluate(() => document.body.innerText);
    await p.screenshot({ path: join(shots, 'library-select.png') });
    for (const [name, path] of [['reader', 'reader/reader.html?id=full1'], ['options', 'options/options.html']]) {
      const q = await browser.newPage(); await q.goto(`chrome-extension://${extId}/${path}`); await sleep(1500);
      texts[name] = await q.evaluate(() => document.body.innerText);
      await q.screenshot({ path: join(shots, `${name}.png`), fullPage: true }); await q.close();
    }
    texts.importPreview = importPreview;
    // 화면 요소 중 번역 키 없이 고정된 문구 찾기: data-i18n 없는 텍스트 노드(글 내용 영역 제외)
    const fixed = {};
    for (const [name, path] of [['library', 'library/library.html'], ['reader', 'reader/reader.html?id=full1'], ['options', 'options/options.html']]) {
      const q = await browser.newPage(); await q.goto(`chrome-extension://${extId}/${path}`); await sleep(1500);
      fixed[name] = await q.evaluate(() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (w.nextNode()) { const n = w.currentNode; const t = n.textContent.trim(); if (!t || t.length < 2) continue; const el = n.parentElement; if (el.closest('#content, #list, .article-content, #title, #meta-line, script, style')) continue; if (el.closest('[data-i18n]')) continue; out.push(t.slice(0, 60)); } return [...new Set(out)]; });
      await q.close();
    }
    writeFileSync(join(shots, 'texts.json'), JSON.stringify({ texts, fixed }, null, 1));
    log({ item: 'screens', lang, uiLanguage: await worker.evaluate(() => chrome.i18n.getUILanguage()), fixed, shots });
  }
} catch (e) {
  log({ error: e.message, stack: e.stack?.split('\n').slice(0, 3) });
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
