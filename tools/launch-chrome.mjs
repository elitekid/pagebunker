// 확장을 올린 크롬 테스트판을 화면 모드로 띄운다. 저장 동작은 실제 키 입력·클릭으로 하고,
// 확인은 이 프로세스가 여는 명령 포트로 한다.
// 사용: node tools/launch-chrome.mjs [dist/chrome 경로] [시작 주소]
// 표준입력 명령: db(저장 글 요약) | eval <확장 페이지에서 실행할 식> | goto <주소> | quit
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const require = createRequire(join(process.env.PPTR_DIR || '/tmp/tb-ff', 'package.json'));
const puppeteer = require('puppeteer-core');
const CHROME = process.env.RL_CHROME || `${process.env.HOME}/.cache/chrome-for-testing/chrome/mac_arm-153.0.8010.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const EXT = process.argv[2] || decodeURIComponent(new URL('../dist/chrome', import.meta.url).pathname);
const START = process.argv[3] || 'http://127.0.0.1:8765/article';
const profile = process.env.RL_PROFILE || mkdtempSync(join(tmpdir(), 'rl-chrome-'));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: false, userDataDir: profile, defaultViewport: null,
  ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
  args: ['--no-first-run', '--use-mock-keychain', '--password-store=basic', '--disable-features=Translate',
    `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, '--window-size=1280,900', '--window-position=40,40'],
});
await new Promise(r => setTimeout(r, 2500));
const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 15000 });
const extId = new URL(swTarget.url()).host;
// 백그라운드 콘솔·오류를 표준출력으로 흘린다(원인 확인용)
async function watchWorker(t) {
  try {
    const w = await t.worker();
    const cdp = w.client;
    cdp.on('Runtime.consoleAPICalled', e => console.log('[sw]', e.type, e.args.map(a => a.value ?? a.description).join(' ')));
    cdp.on('Runtime.exceptionThrown', e => console.log('[sw-exc]', e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
  } catch (e) { console.log('sw 연결 실패', e.message); }
}
await watchWorker(swTarget);
browser.on('targetcreated', t => { if (t.type() === 'service_worker') watchWorker(t); });
const page = (await browser.pages())[0] || await browser.newPage();
await page.goto(START).catch(e => console.log('goto 실패', e.message));
await page.bringToFront();
console.log(JSON.stringify({ ready: true, extId, profile, version: await browser.version() }));

async function extEval(expr) {
  const p = await browser.newPage();
  try {
    await p.goto(`chrome-extension://${extId}/library/library.html`);
    return await p.evaluate(new Function(`return (async () => (${expr}))()`));
  } finally { await p.close(); await page.bringToFront(); }
}

const dbSummary = `new Promise((res, rej) => { const r = indexedDB.open('readlater'); r.onerror = () => rej(String(r.error));
  r.onsuccess = () => { const db = r.result; const names = [...db.objectStoreNames]; const tx = db.transaction(names); const out = {};
    let left = names.length; for (const n of names) { const q = tx.objectStore(n).getAll(); q.onsuccess = () => {
      out[n] = q.result.map(v => { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = typeof x === 'string' && x.length > 80 ? x.slice(0, 80) + '...(' + x.length + ')' : x; return o; });
      if (--left === 0) res(out); }; } }; })`;

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const [cmd, ...rest] = line.trim().split(' ');
  try {
    if (cmd === 'db') console.log(JSON.stringify(await extEval(dbSummary), null, 1));
    else if (cmd === 'eval') console.log(JSON.stringify(await extEval(rest.join(' ')), null, 1));
    else if (cmd === 'goto') { await page.goto(rest.join(' ')); await page.bringToFront(); console.log('ok'); }
    else if (cmd === 'sweval') { const t = browser.targets().find(x => x.type() === 'service_worker' && x.url().includes(extId)); const w = await t.worker(); console.log(JSON.stringify(await w.evaluate(rest.join(' ')))); }
    else if (cmd === 'import') {
      // 보관함 가져오기 입력에 파일을 넣고 미리보기 문구를 읽은 뒤 적용한다. 사용: import <절대경로> [apply]
      const p = await browser.newPage();
      await p.goto(`chrome-extension://${extId}/library/library.html`);
      await new Promise(r => setTimeout(r, 1000));
      const input = await p.$('#import-file');
      await input.uploadFile(rest[0]);
      await new Promise(r => setTimeout(r, 2500));
      const preview = await p.evaluate(() => document.getElementById('import-preview')?.innerText);
      console.log(JSON.stringify({ file: rest[0], preview }));
      if (rest[1] === 'apply') {
        await p.evaluate(() => document.getElementById('btn-import-apply')?.click());
        await new Promise(r => setTimeout(r, 2500));
        console.log(JSON.stringify({ afterApply: await p.evaluate(() => document.getElementById('list')?.innerText.slice(0, 600)) }));
      }
      await p.close(); await page.bringToFront();
    }
    else if (cmd === 'click') {
      // 확장 페이지를 열어 버튼을 누른다. 사용: click <확장 안 경로> <선택자>
      const p = await browser.newPage();
      await p.goto(`chrome-extension://${extId}/${rest[0]}`);
      await new Promise(r => setTimeout(r, 1200));
      await p.click(rest[1]);
      await new Promise(r => setTimeout(r, 4000));
      console.log(JSON.stringify({ clicked: rest[1], text: await p.evaluate(() => document.body.innerText.slice(0, 400)) }));
      await p.close(); await page.bringToFront();
    }
    else if (cmd === 'restore') {
      // 보관함에서 백업 파일을 넣고 병합/교체 복원. 사용: restore <절대경로> merge|replace [undo]
      const p = await browser.newPage();
      p.on('dialog', d => d.accept());
      await p.goto(`chrome-extension://${extId}/library/library.html`);
      await new Promise(r => setTimeout(r, 1000));
      await (await p.$('#import-file')).uploadFile(rest[0]);
      const t0 = Date.now();
      await p.waitForFunction(() => !document.getElementById('btn-restore-merge')?.classList.contains('hidden') || /fail|실패|오류|error/i.test(document.getElementById('import-preview')?.innerText || ''), { timeout: 180000 }).catch(() => {});
      const validateMs = Date.now() - t0;
      const preview = await p.evaluate(() => document.getElementById('import-preview')?.innerText);
      await p.evaluate((m) => document.getElementById(m === 'merge' ? 'btn-restore-merge' : 'btn-restore-replace')?.click(), rest[1]);
      await new Promise(r => setTimeout(r, 1500));
      await p.evaluate(() => document.getElementById('btn-confirm-yes')?.click());
      const t1 = Date.now();
      await p.waitForFunction(() => !document.getElementById('import-dialog')?.open || /fail|실패|오류|error/i.test(document.getElementById('import-preview')?.innerText || ''), { timeout: 180000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1500));
      const out = { validateMs, applyMs: Date.now() - t1, preview, after: await p.evaluate(() => ({ list: document.getElementById('list')?.innerText.slice(0, 300), msg: document.getElementById('import-preview')?.innerText, undoVisible: !document.getElementById('btn-restore-undo')?.classList.contains('hidden') })) };
      if (rest[2] === 'undo') {
        await p.evaluate(() => document.getElementById('btn-restore-undo')?.click());
        await new Promise(r => setTimeout(r, 1500));
        await p.evaluate(() => document.getElementById('btn-confirm-yes')?.click());
        await new Promise(r => setTimeout(r, 5000));
        out.afterUndo = await p.evaluate(() => document.getElementById('list')?.innerText.slice(0, 300));
      }
      console.log(JSON.stringify(out));
      await p.close(); await page.bringToFront();
    }
    else if (cmd === 'readerwatch') {
      // 읽기 화면 요청 감시. 사용: readerwatch <글 id> [offline]. 기본 표시 → 이미지 보기 클릭 순서로 요청을 기록한다.
      const p = await browser.newPage();
      const reqs = [];
      p.on('request', r => { if (!r.url().startsWith('chrome-extension://') && !r.url().startsWith('data:')) reqs.push({ phase: 'x', url: r.url().slice(0, 120), referer: r.headers().referer || r.headers().Referer || '' }); });
      if (rest[1] === 'offline') await p.setOfflineMode(true);
      await p.goto(`chrome-extension://${extId}/reader/reader.html?id=${rest[0]}`);
      await new Promise(r => setTimeout(r, 3000));
      const shown = await p.evaluate(() => ({ title: document.getElementById('title')?.innerText, textLen: document.getElementById('content')?.innerText.length, imgs: document.querySelectorAll('#content img').length, placeholders: document.querySelectorAll('.rl-img-placeholder').length }));
      const before = reqs.splice(0).map(r => ({ ...r, phase: 'default' }));
      await p.evaluate(() => document.getElementById('btn-show-images')?.click());
      await new Promise(r => setTimeout(r, 4000));
      const after = reqs.splice(0).map(r => ({ ...r, phase: 'showImages' }));
      const shownAfter = await p.evaluate(() => ({ imgs: document.querySelectorAll('#content img').length, loaded: [...document.querySelectorAll('#content img')].filter(i => i.complete && i.naturalWidth > 0).length }));
      console.log(JSON.stringify({ offline: rest[1] === 'offline', shown, before, after, shownAfter }, null, 1));
      await p.close(); await page.bringToFront();
    }
    else if (cmd === 'libclick') {
      // 보관함에서 제목이 맞는 글의 버튼(문구 일치)을 누른다. 사용: libclick <제목 일부>|<버튼 문구>
      const [title, label] = rest.join(' ').split('|');
      const p = await browser.newPage();
      await p.goto(`chrome-extension://${extId}/library/library.html`);
      await new Promise(r => setTimeout(r, 1500));
      const ok = await p.evaluate((title, label) => { const li = [...document.querySelectorAll('#list > *')].find(x => x.innerText.includes(title)); const b = li && [...li.querySelectorAll('button')].find(x => x.innerText.trim() === label); if (b) b.click(); return !!b; }, title, label);
      await new Promise(r => setTimeout(r, 1500));
      console.log(JSON.stringify({ libclick: title, label, ok }));
      await p.close();
    }
    else if (cmd === 'quit') break;
  } catch (e) { console.log('오류', e.message); }
}
await browser.close();
if (!process.env.RL_PROFILE) rmSync(profile, { recursive: true, force: true });
process.exit(0);
