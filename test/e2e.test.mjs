// End-to-end tests: load the real extension into Chromium and drive real pages.
// Run: npm run test:e2e   (first time: npx playwright install chromium)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(root, 'extension');
const CLIP = fs.readFileSync(path.join(root, 'test/fixtures/clip.webm'));

// Unpacked extension IDs are derived from the extension's absolute path.
const EXT_ID = crypto
  .createHash('sha256')
  .update(fs.realpathSync(EXT))
  .digest('hex')
  .slice(0, 32)
  .replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

const PAGES = {
  '/video': `<input id="text"><button id="fs">fullscreen</button>
    <div id="wrap" style="width:480px;height:270px"><video id="v" src="/clip.webm" muted style="width:480px;height:270px"></video></div>
    <script>fs.onclick = () => wrap.requestFullscreen()</script>`,
  '/fight': `<video id="v" src="/clip.webm" muted style="width:480px;height:270px"></video>
    <button id="site-speed">site 1.5x</button>
    <script>
      // A hostile player that keeps resetting the speed on its own.
      setInterval(() => { if (window.fight) v.playbackRate = 1; }, 50);
      document.getElementById('site-speed').onclick = () => { v.playbackRate = 1.5; };
    </script>`,
  '/shadow': `<div id="host"></div>
    <script>
      const r = host.attachShadow({ mode: 'open' });
      setTimeout(() => { r.innerHTML = '<video src="/clip.webm" muted style="width:400px;height:220px"></video>'; }, 100);
    </script>`,
  '/frame': `<iframe id="f" src="/video" style="width:600px;height:400px;border:0"></iframe>`,
  '/empty': `<p>No media here.</p>`,
  '/audio': `<audio id="a" src="/clip.webm" controls></audio>`,
};

let server;
let base;
let ctx;
let userDir;
const offsite = [];

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/clip.webm') {
      // Range support is required for seeking.
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (!m) {
        res.writeHead(200, { 'content-type': 'video/webm', 'content-length': CLIP.length, 'accept-ranges': 'bytes' });
        return res.end(CLIP);
      }
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : CLIP.length - 1;
      res.writeHead(206, {
        'content-type': 'video/webm',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${CLIP.length}`,
        'content-length': end - start + 1,
      });
      return res.end(CLIP.subarray(start, end + 1));
    }
    const body = PAGES[url.pathname];
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><body>${body}</body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsc-e2e-'));
  ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  // "No call home": record every request that leaves the test server.
  ctx.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(base) && !u.startsWith('chrome-extension://') && !u.startsWith('data:')) offsite.push(u);
  });
});

after(async () => {
  await ctx?.close();
  server?.close();
  fs.rmSync(userDir, { recursive: true, force: true });
});

async function extPage(file = 'popup.html') {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${EXT_ID}/${file}`);
  return p;
}

async function setStorage(values) {
  const p = await extPage('options.html');
  await p.evaluate(async (v) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(v);
  }, { rememberSpeed: false, ...values });
  await p.close();
}

async function open(route) {
  const page = await ctx.newPage();
  await page.goto(base + route);
  return page;
}

const rate = (target) => target.locator('video').first().evaluate((v) => v.playbackRate);
const time = (target) => target.locator('video').first().evaluate((v) => v.currentTime);
const waitRate = (target, expected) =>
  target.locator('video').first().evaluate(
    (v, e) =>
      new Promise((res, rej) => {
        const t0 = Date.now();
        (function poll() {
          if (Math.abs(v.playbackRate - e) < 0.001) return res(true);
          if (Date.now() - t0 > 3000) return rej(new Error(`playbackRate ${v.playbackRate} != ${e}`));
          setTimeout(poll, 20);
        })();
      }),
    expected
  );
const ready = (target) =>
  target.locator('video').first().evaluate((v) => v.readyState >= 1 || new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true })));
const overlayAttached = (page) =>
  page.waitForFunction(() => {
    const h = document.querySelector('video-speed-overlay');
    return h && h.matches(':popover-open');
  });

test('injects a controller and changes speed with the default keys', async () => {
  await setStorage({});
  const page = await open('/video');
  await overlayAttached(page);
  await ready(page);

  await page.keyboard.press('d');
  assert.equal(await rate(page), 1.1);
  await page.keyboard.press('s');
  await page.keyboard.press('s');
  assert.equal(await rate(page), 0.9);

  await page.keyboard.press('Backquote'); // ~ resets to 1×
  assert.equal(await rate(page), 1);
  await page.keyboard.press('Backquote'); // ...and back
  assert.equal(await rate(page), 0.9);

  await page.keyboard.press('g'); // preferred speed
  assert.equal(await rate(page), 2);
  await page.keyboard.press('g');
  assert.equal(await rate(page), 0.9);
  await page.close();
});

test('advance, rewind, marker and jump', async () => {
  const page = await open('/video');
  await overlayAttached(page);
  await ready(page);

  await page.keyboard.press('x');
  await page.waitForFunction(() => Math.abs(v.currentTime - 10) < 0.5);
  await page.keyboard.press('m');
  await page.keyboard.press('x');
  await page.waitForFunction(() => Math.abs(v.currentTime - 20) < 0.5);
  await page.keyboard.press('j');
  await page.waitForFunction(() => Math.abs(v.currentTime - 10) < 0.5);
  await page.keyboard.press('z');
  await page.waitForFunction(() => v.currentTime < 0.5);
  assert.ok((await time(page)) < 0.5);
  await page.close();
});

test('ignores shortcuts while typing in a text field', async () => {
  const page = await open('/video');
  await overlayAttached(page);
  await page.click('#text');
  await page.keyboard.type('ddd');
  assert.equal(await rate(page), 1);
  assert.equal(await page.inputValue('#text'), 'ddd');
  await page.close();
});

test('overlay sits on top of the page, and above fullscreen content', async () => {
  const page = await open('/video');
  await overlayAttached(page);
  const topIs = (tag) =>
    page.waitForFunction((t) => {
      const r = v.getBoundingClientRect();
      return document.elementFromPoint(r.left + 20, r.top + 18)?.tagName === t;
    }, tag, { timeout: 3000 });
  await page.waitForTimeout(200);
  await topIs('VIDEO'); // hidden by default
  await page.keyboard.press('v'); // show
  await topIs('VIDEO-SPEED-OVERLAY');

  await page.click('#fs');
  await page.waitForFunction(() => document.fullscreenElement?.id === 'wrap');
  await topIs('VIDEO-SPEED-OVERLAY');

  await page.keyboard.press('v'); // hide
  await topIs('VIDEO');
  await page.keyboard.press('v'); // show
  await topIs('VIDEO-SPEED-OVERLAY');
  await page.close();
});

test('fights back when the site resets the speed, but follows the site’s own speed menu', async () => {
  const page = await open('/fight');
  await overlayAttached(page);
  await page.keyboard.press('d');
  await page.keyboard.press('d');
  await page.evaluate(() => {
    window.fight = true;
  });
  await page.waitForTimeout(300);
  await waitRate(page, 1.2);
  await page.evaluate(() => {
    window.fight = false;
  });

  await page.waitForTimeout(1100);
  await page.click('#site-speed'); // user picks 1.5× in the site's UI
  await waitRate(page, 1.5);
  await page.waitForTimeout(100);
  assert.equal(await rate(page), 1.5);
  await page.keyboard.press('d');
  assert.equal(await rate(page), 1.6);
  await page.close();
});

test('finds media inside shadow DOM', async () => {
  const page = await open('/shadow');
  await page.waitForFunction(() => host.shadowRoot.querySelector('video'));
  await overlayAttached(page);
  await page.keyboard.press('d');
  const r = await page.evaluate(() => host.shadowRoot.querySelector('video').playbackRate);
  assert.equal(r, 1.1);
  await page.close();
});

test('works inside iframes', async () => {
  const page = await open('/frame');
  const frame = page.frameLocator('#f');
  await frame.locator('video').waitFor();
  await frame.locator('video').click();
  await page.waitForTimeout(150);
  await page.keyboard.press('d');
  await waitRate(frame, 1.1);
  await page.close();
});

test('popup messaging: state and set speed', async () => {
  const page = await open('/video');
  await overlayAttached(page);
  const ext = await extPage('popup.html');
  const res = await ext.evaluate(async () => {
    // We hold no "tabs" permission, so find the video tab by asking each tab.
    let target;
    for (const t of await chrome.tabs.query({})) {
      const s = await chrome.tabs.sendMessage(t.id, { type: 'vsc:site' }, { frameId: 0 }).catch(() => null);
      if (s?.host === '127.0.0.1') target = t;
    }
    const set = await chrome.tabs.sendMessage(target.id, { type: 'vsc:set', speed: 2.5 });
    const site = await chrome.tabs.sendMessage(target.id, { type: 'vsc:site' }, { frameId: 0 });
    const bad = await chrome.tabs.sendMessage(target.id, { type: 'vsc:action', action: '__proto__' }).catch(() => 'rejected');
    return { set, site, bad };
  });
  assert.deepEqual(res.set, { speed: 2.5, count: 1, hidden: true });
  assert.equal(res.site.host, '127.0.0.1');
  assert.equal(res.site.enabled, true);
  assert.ok(res.bad === undefined || res.bad === 'rejected');
  assert.equal(await rate(page), 2.5);
  await ext.close();
  await page.close();
});

test('popup renders without errors and handles pages it cannot control', async () => {
  const page = await open('/video');
  await overlayAttached(page);
  await page.bringToFront();
  // The real action popup can't be opened headlessly, so load it in a tab. Its
  // "active tab" is then itself, an extension page it can't control.
  const ext = await extPage('popup.html');
  const errors = [];
  ext.on('pageerror', (e) => errors.push(e.message));
  ext.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await ext.reload();
  await ext.waitForSelector('#message:not([hidden]), #player:not([hidden])');
  // The popup's own tab is active, so it reports that it can't run here.
  assert.match(await ext.textContent('#message'), /can’t run/);
  assert.deepEqual(errors, []);
  await ext.close();
  await page.close();
});

test('options page renders defaults and saves changes', async () => {
  await setStorage({});
  const ext = await extPage('options.html');
  const errors = [];
  ext.on('pageerror', (e) => errors.push(e.message));
  ext.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await ext.reload();
  await ext.waitForSelector('#bindings .item');
  assert.equal(await ext.locator('#bindings .item').count(), 9);
  assert.equal(await ext.locator('#bindings .item .key').nth(2).textContent(), '~');
  assert.equal(await ext.locator('#rules .item').count(), 3);

  await ext.locator('[data-key="rememberSpeed"]').check();
  await ext.locator('#bindings .item .key').nth(1).click();
  await ext.keyboard.press('Shift+KeyF');
  await ext.waitForTimeout(400);
  const stored = await ext.evaluate(() => chrome.storage.local.get(null));
  assert.equal(stored.rememberSpeed, true);
  assert.deepEqual(
    { code: stored.bindings[1].code, shift: stored.bindings[1].shift, action: stored.bindings[1].action },
    { code: 'KeyF', shift: true, action: 'faster' }
  );
  assert.deepEqual(errors, []);
  await ext.close();
  await setStorage({});
});

test('custom bindings apply live without reloading the page', async () => {
  await setStorage({});
  const page = await open('/video');
  await overlayAttached(page);
  await setStorage({ bindings: [{ action: 'faster', code: 'KeyF', shift: true, value: 0.5 }] });
  await page.waitForTimeout(100);
  await page.keyboard.press('d');
  assert.equal(await rate(page), 1);
  await page.keyboard.press('Shift+KeyF');
  assert.equal(await rate(page), 1.5);
  await page.close();
  await setStorage({});
});

test('per-site rules: default speed and disable', async () => {
  await setStorage({ rules: [{ pattern: '127.0.0.1', speed: 1.75 }] });
  let page = await open('/video');
  await overlayAttached(page);
  await waitRate(page, 1.75);

  // Disable live: the controller goes away and keys stop working.
  await setStorage({ rules: [{ pattern: '127.0.0.1', disabled: true }] });
  await page.waitForFunction(() => !document.querySelector('video-speed-overlay'));
  await page.keyboard.press('d');
  assert.equal(await rate(page), 1.75);
  await page.close();

  page = await open('/video');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('video-speed-overlay').count(), 0);
  await page.close();
  await setStorage({});
});

test('remember speed carries over to new pages', async () => {
  await setStorage({ rememberSpeed: true });
  let page = await open('/video');
  await overlayAttached(page);
  await page.keyboard.press('d');
  await page.keyboard.press('d');
  await page.keyboard.press('d');
  await page.waitForTimeout(600); // debounced save
  await page.close();

  page = await open('/video');
  await overlayAttached(page);
  await waitRate(page, 1.3);
  await page.close();
  await setStorage({});
});

test('nothing leaks into the page', async () => {
  const page = await open('/video');
  await overlayAttached(page);
  const leak = await page.evaluate(async (id) => {
    const host = document.querySelector('video-speed-overlay');
    let resource = 'blocked';
    try {
      await fetch(`chrome-extension://${id}/lib.js`);
      resource = 'readable';
    } catch {}
    return {
      globals: [typeof window.VSC, typeof window.__videoSpeedLoaded, typeof window.chrome?.runtime?.sendMessage],
      shadow: host.shadowRoot,
      resource,
    };
  }, EXT_ID);
  assert.deepEqual(leak.globals, ['undefined', 'undefined', 'undefined']);
  assert.equal(leak.shadow, null, 'closed shadow root');
  assert.equal(leak.resource, 'blocked', 'no web-accessible resources');
  await page.close();
});

test('audio is controlled but never gets an overlay', async () => {
  const page = await open('/audio');
  await page.locator('audio').evaluate((a) => a.readyState >= 1 || new Promise((r) => a.addEventListener('loadedmetadata', r, { once: true })));
  await page.waitForTimeout(200);
  await page.keyboard.press('d');
  await page.keyboard.press('v');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('audio').evaluate((a) => a.playbackRate), 1.1);
  assert.equal(await page.locator('video-speed-overlay').count(), 0);
  await page.close();
});

test('pages without media get no overlay', async () => {
  const page = await open('/empty');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('video-speed-overlay').count(), 0);
  await page.close();
});

test('the extension made no network requests', () => {
  assert.deepEqual(offsite, []);
});
