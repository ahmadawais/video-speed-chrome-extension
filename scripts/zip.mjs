// Package extension/ into dist/videospeed-<version>.zip for the Chrome Web Store.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
const out = path.join(root, 'dist', `videospeed-${version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', '-q', out, '.', '-x', '.*'], { cwd: path.join(root, 'extension'), stdio: 'inherit' });
console.log(`Wrote ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
