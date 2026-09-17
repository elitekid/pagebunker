#!/usr/bin/env node
// dist/chrome, dist/firefox 생성 및 zip 패키징

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

const targets = [
  { name: 'chrome', manifest: 'manifest.chrome.json', zip: 'pagebunker-chrome.zip' },
  { name: 'firefox', manifest: 'manifest.firefox.json', zip: 'pagebunker-firefox.zip' },
];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const target of targets) {
  const outDir = join(dist, target.name);
  mkdirSync(outDir, { recursive: true });

  cpSync(src, outDir, { recursive: true });

  const manifestSrc = join(root, target.manifest);
  const manifestJson = readFileSync(manifestSrc, 'utf8');
  writeFileSync(join(outDir, 'manifest.json'), manifestJson);

  JSON.parse(manifestJson);

  const zipPath = join(dist, target.zip);
  execSync(`cd "${outDir}" && zip -r "${zipPath}" .`, { stdio: 'inherit' });

  console.log(`Built ${target.name} -> ${outDir}`);
  console.log(`Zipped -> ${zipPath}`);
}

console.log('Build complete.');
