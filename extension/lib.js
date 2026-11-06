/*
 * Video Speed — shared, pure logic (no DOM, no chrome.* APIs).
 * Loaded as a classic script by the content script and extension pages
 * (exposes globalThis.VSC) and as CommonJS by the Node test suite.
 */
(function (root) {
  'use strict';

  const MIN_SPEED = 0.07; // Chromium's lower bound for media playbackRate
  const MAX_SPEED = 16; // Chromium's upper bound

  const ACTIONS = {
    slower: { label: 'Decrease speed', value: 0.1, unit: '×' },
    faster: { label: 'Increase speed', value: 0.1, unit: '×' },
    reset: { label: 'Reset speed', value: 1, unit: '×' },
    preferred: { label: 'Toggle preferred speed', value: 2, unit: '×' },
    rewind: { label: 'Rewind', value: 10, unit: 's' },
    advance: { label: 'Advance', value: 10, unit: 's' },
    display: { label: 'Show / hide controller' },
    mark: { label: 'Set marker' },
    jump: { label: 'Jump to marker' },
    pause: { label: 'Play / pause' },
    mute: { label: 'Mute / unmute' },
  };

  const DEFAULT_BINDINGS = [
    { action: 'slower', code: 'KeyS', value: 0.1 },
    { action: 'faster', code: 'KeyD', value: 0.1 },
    { action: 'reset', code: 'Backquote', value: 1 },
    { action: 'rewind', code: 'KeyZ', value: 10 },
    { action: 'advance', code: 'KeyX', value: 10 },
    { action: 'preferred', code: 'KeyG', value: 2 },
    { action: 'display', code: 'KeyV' },
    { action: 'mark', code: 'KeyM' },
    { action: 'jump', code: 'KeyJ' },
  ];

  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  function clampSpeed(n) {
    if (!isNum(n)) return 1;
    return round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, n)));
  }

  function formatSpeed(n) {
    return clampSpeed(n).toFixed(2);
  }

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  const CODE_RE = /^[A-Za-z0-9]{1,24}$/;

  function sanitizeBinding(b) {
    if (!b || typeof b !== 'object' || !Object.hasOwn(ACTIONS, b.action)) return null;
    if (typeof b.code !== 'string' || !CODE_RE.test(b.code)) return null;
    const out = {
      action: b.action,
      code: b.code,
      ctrl: b.ctrl === true,
      alt: b.alt === true,
      shift: b.shift === true,
      meta: b.meta === true,
    };
    const def = ACTIONS[b.action];
    if ('value' in def) {
      const v = Number(b.value);
      const max = def.unit === 's' ? 3600 : MAX_SPEED;
      out.value = isNum(v) && v > 0 ? Math.min(v, max) : def.value;
      if (def.unit === '×' && b.action !== 'slower' && b.action !== 'faster') {
        out.value = clampSpeed(out.value);
      }
    }
    return out;
  }

  function sanitizeRule(r) {
    if (!r || typeof r !== 'object' || typeof r.pattern !== 'string') return null;
    const pattern = r.pattern.trim().slice(0, 300);
    if (!pattern) return null;
    const speed = r.speed == null || r.speed === '' ? null : Number(r.speed);
    return {
      pattern,
      disabled: r.disabled === true,
      speed: isNum(speed) && speed > 0 ? clampSpeed(speed) : null,
    };
  }

  /** Turn untrusted stored data into a complete, valid settings object. */
  function sanitizeSettings(raw) {
    const s = clone(DEFAULTS);
    if (!raw || typeof raw !== 'object') return s;
    for (const k of ['enabled', 'rememberSpeed', 'audio', 'startHidden', 'blockSiteKeys']) {
      if (typeof raw[k] === 'boolean') s[k] = raw[k];
    }
    if (isNum(raw.lastSpeed)) s.lastSpeed = clampSpeed(raw.lastSpeed);
    if (isNum(raw.opacity)) s.opacity = Math.min(1, Math.max(0.1, raw.opacity));
    if (Array.isArray(raw.bindings)) {
      s.bindings = raw.bindings.slice(0, 64).map(sanitizeBinding).filter(Boolean);
    }
    if (Array.isArray(raw.rules)) {
      s.rules = raw.rules.slice(0, 500).map(sanitizeRule).filter(Boolean);
    }
    return s;
  }

  /** 'example.com' matches example.com and any subdomain. '/re/flags' is a regex on the full URL. */
  function matchPattern(pattern, url) {
    if (typeof pattern !== 'string' || !url) return false;
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    const re = /^\/(.+)\/([dgimsuy]*)$/.exec(pattern);
    if (re) {
      try {
        return new RegExp(re[1], re[2].replace(/[gy]/g, '')).test(u.href);
      } catch {
        return false;
      }
    }
    let p = pattern.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
    if (p.startsWith('*.')) p = p.slice(2);
    if (p.startsWith('www.')) p = p.slice(4);
    const host = u.hostname.toLowerCase();
    return host === p || host.endsWith('.' + p);
  }

  /** First matching rule wins. */
  function siteConfig(settings, url) {
    const rule = settings.rules.find((r) => matchPattern(r.pattern, url));
    return {
      enabled: settings.enabled && !(rule && rule.disabled),
      speed: rule && rule.speed ? rule.speed : null,
      rule: rule || null,
    };
  }

  /** Returns a new rules array with the site at `url` enabled or disabled. */
  function setSiteEnabled(rules, url, enabled) {
    const out = rules.map((r) => ({ ...r }));
    if (enabled) {
      for (const r of out) if (r.disabled && matchPattern(r.pattern, url)) r.disabled = false;
      return out.filter((r) => r.disabled || r.speed);
    }
    let host;
    try {
      host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return out;
    }
    if (!host) return out;
    // Put an exact-host rule first so it wins over any broader rule.
    const i = out.findIndex((r) => r.pattern.toLowerCase().replace(/^www\./, '') === host);
    const rule = i >= 0 ? out.splice(i, 1)[0] : { pattern: host, speed: null };
    out.unshift({ ...rule, disabled: true });
    return out;
  }

  function matchBinding(bindings, e) {
    return (
      bindings.find(
        (b) =>
          b.code === e.code &&
          b.ctrl === !!e.ctrlKey &&
          b.alt === !!e.altKey &&
          b.shift === !!e.shiftKey &&
          b.meta === !!e.metaKey
      ) || null
    );
  }

  const NAMED_KEYS = {
    Backquote: '~',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Space: 'Space',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
  };

  function keyLabel(b) {
    if (!b || !b.code) return '';
    let k = NAMED_KEYS[b.code];
    if (!k) {
      const m = /^(?:Key|Digit|Numpad)(.+)$/.exec(b.code);
      k = m ? (b.code.startsWith('Numpad') ? 'Num ' + m[1] : m[1]) : b.code;
    }
    const mods = [];
    if (b.ctrl) mods.push('Ctrl');
    if (b.alt) mods.push('Alt');
    if (b.shift) mods.push('Shift');
    if (b.meta) mods.push('⌘');
    return [...mods, k].join(' + ');
  }

  /**
   * Speed state machine for the speed-related actions.
   * Returns { speed, prev } — prev is the speed to return to on the next toggle.
   */
  function nextSpeed(action, current, value, prev) {
    current = clampSpeed(current);
    switch (action) {
      case 'slower':
        return { speed: clampSpeed(current - (value || 0.1)), prev };
      case 'faster':
        return { speed: clampSpeed(current + (value || 0.1)), prev };
      case 'reset': {
        const target = clampSpeed(value || 1);
        if (current !== target) return { speed: target, prev: current };
        return { speed: prev ? clampSpeed(prev) : target, prev: target };
      }
      case 'preferred': {
        const target = clampSpeed(value || 2);
        if (current !== target) return { speed: target, prev: current };
        const back = prev && clampSpeed(prev) !== target ? clampSpeed(prev) : 1;
        return { speed: back, prev: target };
      }
      default:
        return { speed: current, prev };
    }
  }

  const DEFAULTS = {
    version: 1,
    enabled: true,
    rememberSpeed: false,
    lastSpeed: 1,
    audio: true,
    startHidden: false,
    blockSiteKeys: false,
    opacity: 0.5,
    bindings: DEFAULT_BINDINGS.map(sanitizeBinding),
    // Each rule: { pattern: 'example.com' | '/regex/i', disabled: bool, speed: number|null }
    rules: [
      { pattern: 'meet.google.com', disabled: true, speed: null },
      { pattern: 'teams.microsoft.com', disabled: true, speed: null },
      { pattern: 'imgur.com', disabled: true, speed: null },
    ],
  };

  const api = {
    MIN_SPEED,
    MAX_SPEED,
    ACTIONS,
    DEFAULTS,
    DEFAULT_BINDINGS,
    clampSpeed,
    formatSpeed,
    sanitizeSettings,
    sanitizeBinding,
    sanitizeRule,
    matchPattern,
    siteConfig,
    setSiteEnabled,
    matchBinding,
    keyLabel,
    nextSpeed,
  };
  Object.freeze(api);

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VSC = api;
})(globalThis);
