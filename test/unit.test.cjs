'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../extension/lib.js');

test('clampSpeed keeps speeds inside Chromium limits and rounds to 2 decimals', () => {
  assert.equal(V.clampSpeed(0), 0.07);
  assert.equal(V.clampSpeed(99), 16);
  assert.equal(V.clampSpeed(1.234), 1.23);
  assert.equal(V.clampSpeed(NaN), 1);
  assert.equal(V.clampSpeed('2'), 1);
  assert.equal(V.formatSpeed(1), '1');
  assert.equal(V.formatSpeed(1.5), '1.5');
  assert.equal(V.formatSpeed(1.25), '1.25');
  assert.equal(V.formatSpeed(2.0000001), '2');
});

test('default shortcuts', () => {
  const b = Object.fromEntries(V.DEFAULTS.bindings.map((x) => [x.action, x]));
  assert.equal(b.slower.code, 'KeyS');
  assert.equal(b.faster.code, 'KeyD');
  assert.equal(b.reset.code, 'Backquote');
  assert.equal(V.keyLabel(b.reset), '~');
  assert.equal(b.rewind.code, 'KeyZ');
  assert.equal(b.rewind.value, 10);
  assert.equal(b.advance.code, 'KeyX');
  assert.equal(b.preferred.code, 'KeyG');
  assert.equal(b.preferred.value, 2);
  assert.equal(b.display.code, 'KeyV');
  assert.equal(b.mark.code, 'KeyM');
  assert.equal(b.jump.code, 'KeyJ');
});

test('defaults: remember speed on, controller hidden, normal size', () => {
  const d = V.sanitizeSettings(null);
  assert.equal(d.rememberSpeed, true);
  assert.equal(d.startHidden, true);
  assert.equal(d.scale, 1);
  assert.equal(V.sanitizeSettings({ scale: 0.5 }).scale, 0.5);
  assert.equal(V.sanitizeSettings({ scale: 0.3 }).scale, 1);
});

test('sanitizeSettings fills defaults and rejects junk', () => {
  assert.deepEqual(V.sanitizeSettings(null), V.sanitizeSettings({}));
  const s = V.sanitizeSettings({
    enabled: 'yes',
    rememberSpeed: true,
    lastSpeed: 100,
    opacity: 7,
    bindings: [
      { action: 'faster', code: 'KeyF', value: 0.25 },
      { action: 'evil', code: 'KeyE' },
      { action: 'slower', code: '<img src=x>' },
      { action: 'rewind', code: 'KeyA', value: -5 },
      null,
    ],
    rules: [{ pattern: '  youtube.com ', speed: '2' }, { pattern: '' }, { pattern: 'x.com', speed: 500 }, 3],
    __proto__: { polluted: true },
  });
  assert.equal(s.enabled, true);
  assert.equal(s.rememberSpeed, true);
  assert.equal(s.lastSpeed, 16);
  assert.equal(s.opacity, 1);
  assert.equal(s.bindings.length, 2);
  assert.equal(s.bindings[0].value, 0.25);
  assert.equal(s.bindings[1].value, 10, 'invalid value falls back to the action default');
  assert.deepEqual(s.rules, [
    { pattern: 'youtube.com', disabled: false, speed: 2 },
    { pattern: 'x.com', disabled: false, speed: 16 },
  ]);
  assert.equal(s.polluted, undefined);
  assert.equal(Object.keys(s).includes('polluted'), false);
});

test('sanitizeSettings does not share references with DEFAULTS', () => {
  const s = V.sanitizeSettings(null);
  s.bindings[0].code = 'KeyQ';
  s.rules.push({ pattern: 'a.com' });
  assert.equal(V.DEFAULTS.bindings[0].code, 'KeyS');
  assert.equal(V.DEFAULTS.rules.length, 3);
});

test('matchPattern: domains match themselves and subdomains only', () => {
  assert.ok(V.matchPattern('youtube.com', 'https://www.youtube.com/watch?v=1'));
  assert.ok(V.matchPattern('youtube.com', 'https://youtube.com/'));
  assert.ok(V.matchPattern('www.youtube.com', 'https://m.youtube.com/'));
  assert.ok(V.matchPattern('*.example.com', 'https://a.b.example.com/'));
  assert.ok(V.matchPattern('https://example.com/path', 'http://example.com/'));
  assert.ok(!V.matchPattern('youtube.com', 'https://notyoutube.com/'));
  assert.ok(!V.matchPattern('youtube.com', 'https://youtube.com.evil.io/'));
  assert.ok(!V.matchPattern('example.com', 'not a url'));
});

test('matchPattern: regex patterns match the full URL and survive bad input', () => {
  assert.ok(V.matchPattern('/\\.edu\\//i', 'https://cs.STANFORD.EDU/x'));
  assert.ok(V.matchPattern('/watch\\?v=/', 'https://www.youtube.com/watch?v=abc'));
  assert.ok(!V.matchPattern('/(/', 'https://a.com/'));
  // A global flag would make .test() stateful; it must be ignored.
  assert.ok(V.matchPattern('/a\\.com/g', 'https://a.com/'));
  assert.ok(V.matchPattern('/a\\.com/g', 'https://a.com/'));
});

test('siteConfig: first matching rule wins, global switch overrides', () => {
  const s = V.sanitizeSettings({
    rules: [
      { pattern: 'lectures.example.com', speed: 2 },
      { pattern: 'example.com', disabled: true },
    ],
  });
  assert.deepEqual(
    [V.siteConfig(s, 'https://lectures.example.com/').enabled, V.siteConfig(s, 'https://lectures.example.com/').speed],
    [true, 2]
  );
  assert.equal(V.siteConfig(s, 'https://example.com/').enabled, false);
  assert.equal(V.siteConfig(s, 'https://other.org/').enabled, true);
  assert.equal(V.siteConfig(s, 'https://other.org/').speed, null);
  assert.equal(V.siteConfig({ ...s, enabled: false }, 'https://other.org/').enabled, false);
  assert.equal(V.siteConfig(V.sanitizeSettings(null), 'https://meet.google.com/abc').enabled, false);
});

test('setSiteEnabled toggles a site without breaking other rules', () => {
  const base = V.sanitizeSettings({ rules: [{ pattern: 'example.com', speed: 2 }] }).rules;
  const off = V.setSiteEnabled(base, 'https://www.example.com/v', false);
  assert.deepEqual(off[0], { pattern: 'example.com', speed: 2, disabled: true });
  const on = V.setSiteEnabled(off, 'https://www.example.com/v', true);
  assert.deepEqual(on, [{ pattern: 'example.com', speed: 2, disabled: false }]);

  const off2 = V.setSiteEnabled(base, 'https://a.example.com/', false);
  assert.equal(off2[0].pattern, 'a.example.com', 'a narrower rule is added in front');
  assert.equal(V.siteConfig({ enabled: true, rules: off2 }, 'https://a.example.com/').enabled, false);
  assert.equal(V.siteConfig({ enabled: true, rules: off2 }, 'https://b.example.com/').speed, 2);

  const removed = V.setSiteEnabled(V.setSiteEnabled([], 'https://x.org/', false), 'https://x.org/', true);
  assert.deepEqual(removed, [], 'empty rules are dropped when re-enabled');
});

test('matchBinding requires an exact modifier match', () => {
  const bindings = V.sanitizeSettings({
    bindings: [
      { action: 'faster', code: 'KeyD' },
      { action: 'preferred', code: 'KeyD', shift: true, value: 3 },
    ],
  }).bindings;
  assert.equal(V.matchBinding(bindings, { code: 'KeyD' }).action, 'faster');
  assert.equal(V.matchBinding(bindings, { code: 'KeyD', shiftKey: true }).action, 'preferred');
  assert.equal(V.matchBinding(bindings, { code: 'KeyD', ctrlKey: true }), null);
  assert.equal(V.matchBinding(bindings, { code: 'KeyQ' }), null);
});

test('keyLabel', () => {
  assert.equal(V.keyLabel({ code: 'KeyS' }), 'S');
  assert.equal(V.keyLabel({ code: 'Digit1', shift: true, ctrl: true }), 'Ctrl + Shift + 1');
  assert.equal(V.keyLabel({ code: 'Numpad5' }), 'Num 5');
  assert.equal(V.keyLabel({ code: 'Period' }), '.');
  assert.equal(V.keyLabel({ code: 'F2', meta: true }), '⌘ + F2');
});

test('nextSpeed: slower / faster', () => {
  assert.equal(V.nextSpeed('faster', 1, 0.1).speed, 1.1);
  assert.equal(V.nextSpeed('faster', 1.2, 0.1).speed, 1.3, 'no float drift');
  assert.equal(V.nextSpeed('slower', 0.1, 0.1).speed, 0.07);
  assert.equal(V.nextSpeed('faster', 15.95, 0.1).speed, 16);
});

test('nextSpeed: reset toggles between 1× and the previous speed', () => {
  let r = V.nextSpeed('reset', 1.8, 1, null);
  assert.deepEqual(r, { speed: 1, prev: 1.8 });
  r = V.nextSpeed('reset', r.speed, 1, r.prev);
  assert.deepEqual(r, { speed: 1.8, prev: 1 });
  assert.equal(V.nextSpeed('reset', 1, 1, null).speed, 1);
});

test('nextSpeed: preferred toggles between 2× and the previous speed', () => {
  let r = V.nextSpeed('preferred', 1.3, 2, null);
  assert.deepEqual(r, { speed: 2, prev: 1.3 });
  r = V.nextSpeed('preferred', r.speed, 2, r.prev);
  assert.deepEqual(r, { speed: 1.3, prev: 2 });
  assert.equal(V.nextSpeed('preferred', 2, 2, null).speed, 1, 'falls back to 1× with no history');
});

test('the API object is frozen', () => {
  assert.ok(Object.isFrozen(V));
});

test('privacy: no network APIs, no remote code, minimal permissions', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'extension');
  const banned = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|eval|Function)\s*\(|new\s+(WebSocket|EventSource|Worker)\b|\.innerHTML\s*=|setUninstallURL|https?:\/\/(?!www\.w3\.org\/2000\/svg|github\.com\/(igrigorik|ahmadawais)\/videospeed)/;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(js|html|css)$/.test(f)) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const hit = src.match(banned);
    assert.equal(hit, null, `${f} contains "${hit && hit[0]}"`);
  }
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.permissions, ['storage']);
  assert.equal(m.host_permissions, undefined);
  assert.equal(m.web_accessible_resources, undefined);
  assert.equal(m.background, undefined);
  assert.equal(m.externally_connectable, undefined);
  assert.ok(m.content_scripts.every((c) => c.world === 'ISOLATED'));
  assert.match(m.content_security_policy.extension_pages, /default-src 'none'/);
  assert.doesNotMatch(m.content_security_policy.extension_pages, /connect-src/);
});
