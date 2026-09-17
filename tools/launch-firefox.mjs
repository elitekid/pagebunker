// 확장을 임시 설치한 파이어폭스를 화면 모드로 띄운다. 저장 동작은 실제 키 입력·클릭으로 하고,
// 확인은 표준입력 명령으로 한다. 사용: node tools/launch-firefox.mjs [dist/firefox] [시작 주소] [다운로드 폴더]
// 명령: eval <식> | goto <주소> | import <파일> [apply] | click <확장 안 경로> <선택자> | restore <파일> merge|replace [undo] | quit
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const require = createRequire(join(process.env.PPTR_DIR || '/tmp/tb-ff', 'package.json'));
const puppeteer = require('puppeteer-core');
const FIREFOX = process.env.RL_FIREFOX || `${process.env.HOME}/.cache/chrome-for-testing/firefox/mac_arm-stable_156.0/Firefox.app/Contents/MacOS/firefox`;
const EXT = process.argv[2] || decodeURIComponent(new URL('../dist/firefox', import.meta.url).pathname);
const START = process.argv[3] || 'http://127.0.0.1:8765/article';
const DL = process.argv[4] || '/tmp/rl-ff-downloads';
mkdirSync(DL, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'rl-ff-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  browser: 'firefox', executablePath: FIREFOX, headless: false, userDataDir: profile, protocolTimeout: 300000,
  args: ['--remote-allow-system-access', '--width=1280', '--height=900'],
  extraPrefsFirefox: {
    'remote.system-access-check.enabled': false,
    'xpinstall.signatures.required': false,
    'browser.download.folderList': 2,
    'browser.download.dir': DL,
    'browser.download.useDownloadDir': true,
    'browser.download.alwaysOpenPanel': false,
  },
});
await browser.installExtension(EXT);
let uuid = null;
for (let i = 0; i < 20 && !uuid; i++) {
  await sleep(500);
  const pf = join(profile, 'prefs.js');
  if (existsSync(pf)) {
    const m = /extensions\.webextensions\.uuids", "(.*?)"\)/.exec(readFileSync(pf, 'utf8'));
    if (m) uuid = JSON.parse(m[1].replace(/\\"/g, '"'))['pagebunker@elitekid.dev'] || null;
  }
}
const base = `moz-extension://${uuid}/`;
const page = (await browser.pages())[0] || await browser.newPage();
await page.goto(START).catch(e => console.log('goto 실패', e.message));
console.log(JSON.stringify({ ready: true, uuid, profile, DL, version: await browser.version() }));

async function withExtPage(path, fn) {
  const p = await browser.newPage();
  try {
    await p.goto(base + path, { waitUntil: 'load', timeout: 10000 }).catch(() => {});
    await sleep(1200);
    return await fn(p);
  } finally { await p.close(); await page.bringToFront(); }
}


// 파이어폭스 BiDi는 확장 페이지 파일 입력(setFiles)을 지원하지 않는다(156 실측). 파일 내용을 넘겨 페이지 안에서 File을 만들고 change를 보낸다.
async function putFile(p, filePath) {
  const content = readFileSync(filePath, 'utf8');
  await p.evaluate((name, text) => {
    const input = document.getElementById('import-file');
    const dt = new DataTransfer();
    dt.items.add(new File([text], name, { type: name.endsWith('.json') ? 'application/json' : 'text/plain' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, basename(filePath), content);
}

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const [cmd, ...rest] = line.trim().split(' ');
  try {
    if (cmd === 'eval') console.log(JSON.stringify(await withExtPage('library/library.html', p => p.evaluate(`(async () => (${rest.join(' ')}))()`)), null, 1));
    else if (cmd === 'goto') { await page.goto(rest.join(' ')); await page.bringToFront(); console.log('ok'); }
    else if (cmd === 'import') {
      await withExtPage('library/library.html', async p => {
        await putFile(p, rest[0]);
        await sleep(2500);
        console.log(JSON.stringify({ file: rest[0], preview: await p.evaluate(() => document.getElementById('import-preview')?.innerText) }));
        if (rest[1] === 'apply') {
          await p.evaluate(() => document.getElementById('btn-import-apply')?.click());
          await sleep(3000);
          console.log(JSON.stringify({ afterApply: await p.evaluate(() => document.getElementById('list')?.innerText.slice(0, 400)) }));
        }
      });
    } else if (cmd === 'click') {
      await withExtPage(rest[0], async p => {
        await p.evaluate((sel) => document.querySelector(sel)?.click(), rest[1]);
        await sleep(5000);
        console.log(JSON.stringify({ clicked: rest[1], text: await p.evaluate(() => document.body.innerText.slice(-200)) }));
      });
    } else if (cmd === 'restore') {
      await withExtPage('library/library.html', async p => {
        await putFile(p, rest[0]);
        await sleep(3000);
        const preview = await p.evaluate(() => document.getElementById('import-preview')?.innerText);
        await p.evaluate((m) => document.getElementById(m === 'merge' ? 'btn-restore-merge' : 'btn-restore-replace')?.click(), rest[1]);
        await sleep(1500);
        await p.evaluate(() => document.getElementById('btn-confirm-yes')?.click());
        await sleep(5000);
        const out = { preview, list: await p.evaluate(() => document.getElementById('list')?.innerText.slice(0, 300)) };
        if (rest[2] === 'undo') {
          await p.evaluate(() => document.getElementById('btn-restore-undo')?.click());
          await sleep(1500);
          await p.evaluate(() => document.getElementById('btn-confirm-yes')?.click());
          await sleep(5000);
          out.afterUndo = await p.evaluate(() => document.getElementById('list')?.innerText.slice(0, 300));
        }
        console.log(JSON.stringify(out));
      });
    } else if (cmd === 'quit') break;
  } catch (e) { console.log('오류', e.message); }
}
await browser.close();
rmSync(profile, { recursive: true, force: true });
process.exit(0);
