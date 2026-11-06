/*
 * Video Speed — content script.
 * Runs only in the extension's ISOLATED world: page scripts cannot read its
 * state, call its functions or see its settings. It makes no network
 * requests and exposes no web-accessible resources.
 */
(() => {
  'use strict';
  if (globalThis.__videoSpeedLoaded) return;
  globalThis.__videoSpeedLoaded = true;

  const V = globalThis.VSC;
  const MEDIA = 'video, audio';
  const EPS = 0.001;

  let settings = V.sanitizeSettings(null);
  let site = { enabled: false, speed: null };
  let running = false;

  /** @type {Map<HTMLMediaElement, {el: HTMLMediaElement, pill: HTMLElement|null, speedEl: HTMLElement|null, dx: number, dy: number, hidden: boolean}>} */
  const media = new Map();
  const ownWrites = new WeakMap(); // el -> rate we set ourselves
  const marks = new WeakMap(); // el -> marker time
  let desired = null; // the speed we enforce; null = no opinion yet, leave the page alone
  let prev = null; // speed to return to when toggling reset / preferred
  let hiddenAll = false;
  let flashUntil = 0;
  let lastOwnAction = 0;
  let fights = [];

  let ac = null;
  let mo = null;
  let ro = null;
  let tick = 0;
  let raf = 0;
  let ui = null;
  let saveTimer = 0;

  // ---------------------------------------------------------------- settings

  function resolveSite() {
    const urls = [location.href];
    const ao = location.ancestorOrigins;
    if (ao && ao.length) urls.push(ao[ao.length - 1]); // the top-level site embedding us
    const cfgs = urls.map((u) => V.siteConfig(settings, u));
    return {
      enabled: cfgs.every((c) => c.enabled),
      speed: cfgs.find((c) => c.speed)?.speed ?? null,
    };
  }

  function applySettings() {
    const before = site;
    site = resolveSite();
    if (site.enabled && !running) start();
    else if (!site.enabled && running) stop();
    if (!running) return;
    if (site.speed && site.speed !== before.speed) setDesired(site.speed);
    if (settings.audio) {
      scan(document);
    } else {
      for (const el of [...media.keys()]) if (el.tagName === 'AUDIO') untrack(el);
    }
    if (ui) styleHost(ui.host);
    schedule();
  }

  function onStorage(changes, area) {
    if (area !== 'local') return;
    const raw = { ...settings };
    let relevant = false;
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (k === 'lastSpeed') continue; // each tab keeps its own session speed
      raw[k] = newValue;
      relevant = true;
    }
    if (!relevant) return;
    settings = V.sanitizeSettings(raw);
    applySettings();
  }

  function persistSpeed() {
    if (!settings.rememberSpeed || desired == null) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (alive()) chrome.storage.local.set({ lastSpeed: desired }).catch(() => {});
    }, 400);
  }

  const alive = () => !!globalThis.chrome?.runtime?.id;

  // ---------------------------------------------------------------- lifecycle

  function start() {
    running = true;
    ac = new AbortController();
    const opt = { capture: true, signal: ac.signal };
    const passive = { capture: true, passive: true, signal: ac.signal };

    if (desired == null) desired = site.speed ?? (settings.rememberSpeed ? settings.lastSpeed : null);
    if (desired === 1 && !site.speed) desired = null; // 1× is the page default; don't fight for it
    hiddenAll = settings.startHidden;

    window.addEventListener('keydown', onKey, opt);
    document.addEventListener('scroll', schedule, passive);
    window.addEventListener('resize', schedule, passive);
    document.addEventListener('fullscreenchange', onFullscreen, opt);
    // Discover media that never touched the DOM tree we observe.
    document.addEventListener('loadstart', onDiscover, opt);
    document.addEventListener('play', onDiscover, opt);

    ro = new ResizeObserver(schedule);
    mo = new MutationObserver(onMutations);
    mo.observe(document, { childList: true, subtree: true });
    scan(document);
  }

  function stop() {
    running = false;
    ac?.abort();
    mo?.disconnect();
    ro?.disconnect();
    clearInterval(tick);
    cancelAnimationFrame(raf);
    tick = raf = 0;
    ui?.host.remove();
    ui = null;
    media.clear();
  }

  // ---------------------------------------------------------------- discovery

  function shadowOf(el) {
    try {
      return globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot;
    } catch {
      return el.shadowRoot;
    }
  }

  function scan(root) {
    if (root.querySelectorAll) for (const el of root.querySelectorAll(MEDIA)) track(el);
    // One-time deep walk for media inside shadow roots.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      const sr = n.nodeType === 1 && shadowOf(n);
      if (sr) {
        mo?.observe(sr, { childList: true, subtree: true });
        scan(sr);
      }
    }
  }

  function onMutations(records) {
    let removed = false;
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches(MEDIA)) track(n);
        else if (n.firstElementChild) for (const el of n.querySelectorAll(MEDIA)) track(el);
        const sr = shadowOf(n);
        if (sr) {
          mo.observe(sr, { childList: true, subtree: true });
          scan(sr);
        }
      }
      if (r.removedNodes.length) removed = true;
    }
    if (removed) for (const el of [...media.keys()]) if (!el.isConnected) untrack(el);
  }

  function onDiscover(e) {
    const el = e.target;
    if (el instanceof HTMLMediaElement) track(el);
  }

  function track(el) {
    if (media.has(el) || !running) return;
    if (el.tagName === 'AUDIO' && !settings.audio) return;
    const c = { el, pill: null, speedEl: null, dx: 0, dy: 0, hidden: false };
    media.set(el, c);
    const opt = { signal: ac.signal };
    el.addEventListener('ratechange', onRateChange, opt);
    for (const t of ['loadstart', 'loadedmetadata', 'play', 'seeked']) el.addEventListener(t, onMediaEvent, opt);
    ro.observe(el);
    enforce(el);
    if (el.tagName === 'VIDEO') buildPill(c); // audio is controlled by keys only, never drawn
    if (!tick) tick = setInterval(() => document.hidden || schedule(), 1000);
    schedule();
  }

  function untrack(el) {
    const c = media.get(el);
    if (!c) return;
    media.delete(el);
    c.pill?.remove();
    ro?.unobserve(el);
    el.removeEventListener('ratechange', onRateChange);
    for (const t of ['loadstart', 'loadedmetadata', 'play', 'seeked']) el.removeEventListener(t, onMediaEvent);
  }

  // ---------------------------------------------------------------- speed

  function setRate(el, rate) {
    ownWrites.set(el, rate);
    try {
      el.playbackRate = rate;
    } catch {
      ownWrites.delete(el);
    }
  }

  function enforce(el) {
    if (desired != null && Math.abs(el.playbackRate - desired) > EPS) setRate(el, desired);
  }

  function setDesired(speed) {
    desired = V.clampSpeed(speed);
    for (const el of targets()) enforce(el);
    persistSpeed();
    schedule();
  }

  function onMediaEvent(e) {
    enforce(e.currentTarget);
    schedule();
  }

  function onRateChange(e) {
    const el = e.currentTarget;
    const rate = el.playbackRate;
    const own = ownWrites.get(el);
    if (own !== undefined && Math.abs(rate - own) < EPS) {
      ownWrites.delete(el);
      return schedule();
    }
    if (desired == null || Math.abs(rate - desired) < EPS) return schedule();

    // The user picked a speed in the site's own player UI: follow it.
    if (navigator.userActivation?.isActive && performance.now() - lastOwnAction > 1000) {
      desired = V.clampSpeed(rate);
      for (const other of targets()) enforce(other);
      persistSpeed();
      return schedule();
    }

    // The site reset the speed on its own: put it back, unless it keeps
    // fighting (then give up rather than loop forever).
    const now = performance.now();
    fights = fights.filter((t) => now - t < 2000);
    if (fights.length < 10) {
      fights.push(now);
      setRate(el, desired);
    }
    schedule();
  }

  function isActionable(el) {
    if (!el.isConnected) return false;
    if (el.tagName === 'AUDIO') return true;
    if (!el.paused) return true;
    const r = el.getBoundingClientRect();
    return r.width >= 40 && r.height >= 40;
  }

  function targets() {
    return [...media.keys()].filter(isActionable);
  }

  function runAction(action, value) {
    const list = targets();
    if (!list.length) return false;
    const def = V.ACTIONS[action];
    if (!def) return false;
    if (typeof value !== 'number' || !Number.isFinite(value)) value = def.value;
    lastOwnAction = performance.now();

    switch (action) {
      case 'slower':
      case 'faster':
      case 'reset':
      case 'preferred': {
        const current = desired ?? list[0].playbackRate;
        const r = V.nextSpeed(action, current, value, prev);
        prev = r.prev;
        setDesired(r.speed);
        break;
      }
      case 'rewind':
        for (const el of list) el.currentTime = Math.max(0, el.currentTime - value);
        break;
      case 'advance':
        for (const el of list) {
          const end = Number.isFinite(el.duration) ? el.duration : Infinity;
          el.currentTime = Math.min(end, el.currentTime + value);
        }
        break;
      case 'display':
        hiddenAll = !hiddenAll;
        for (const c of media.values()) c.hidden = false;
        break;
      case 'mark':
        for (const el of list) marks.set(el, el.currentTime);
        break;
      case 'jump':
        for (const el of list) if (marks.has(el)) el.currentTime = marks.get(el);
        break;
      case 'pause':
        for (const el of list) el.paused ? el.play().catch(() => {}) : el.pause();
        break;
      case 'mute':
        for (const el of list) el.muted = !el.muted;
        break;
    }
    if (action !== 'display') flash();
    schedule();
    return true;
  }

  function flash() {
    flashUntil = performance.now() + 1200;
    setTimeout(schedule, 1250);
  }

  // ---------------------------------------------------------------- keyboard

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
  }

  function onKey(e) {
    if (!alive()) return stop(); // extension was updated/removed: go quiet
    if (e.isComposing || !media.size) return;
    if (isEditable(e.composedPath()[0] || e.target)) return;
    const b = V.matchBinding(settings.bindings, e);
    if (!b || !runAction(b.action, b.value)) return;
    if (settings.blockSiteKeys) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  // ---------------------------------------------------------------- overlay

  const CSS = `
:host { --vsc-opacity: 0.5; --vsc-scale: 1; }
[hidden] { display: none !important; }
.pill {
  position: absolute; top: 0; left: 0;
  opacity: var(--vsc-opacity); pointer-events: auto; touch-action: none;
  user-select: none; -webkit-user-select: none; will-change: transform;
  transition: opacity 180ms cubic-bezier(.2, .8, .2, 1);
}
.pill:hover, .pill.flash { opacity: 1; }
.body {
  zoom: var(--vsc-scale);
  display: flex; align-items: center; height: 30px; padding: 0 3px; border-radius: 999px;
  background: linear-gradient(180deg, rgba(44, 44, 52, .74), rgba(14, 14, 18, .74));
  -webkit-backdrop-filter: blur(14px) saturate(1.6); backdrop-filter: blur(14px) saturate(1.6);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12), inset 0 1px 0 rgba(255, 255, 255, .1),
    0 10px 28px -8px rgba(0, 0, 0, .5), 0 2px 6px rgba(0, 0, 0, .22);
  color: #fff; font: 600 13px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-variant-numeric: tabular-nums; letter-spacing: -0.01em;
}
.speed { padding: 0 9px; min-width: 2.2em; text-align: center; cursor: grab; }
.speed:active { cursor: grabbing; }
.speed::after { content: '×'; margin-left: 1px; font-weight: 500; opacity: .55; }
.ctrls {
  display: grid; grid-template-columns: 0fr;
  transition: grid-template-columns 240ms cubic-bezier(.2, .8, .2, 1);
}
.pill:hover .ctrls, .pill:focus-within .ctrls { grid-template-columns: 1fr; }
.ctrls > div { display: flex; align-items: center; gap: 1px; min-width: 0; overflow: hidden; }
.sep { flex: none; width: 1px; height: 14px; margin: 0 3px 0 1px; background: rgba(255, 255, 255, .16); }
button {
  all: unset; box-sizing: border-box; flex: none; width: 24px; height: 24px; border-radius: 999px;
  display: grid; place-items: center; cursor: pointer; color: rgba(255, 255, 255, .82);
  transition: background 120ms ease-out, color 120ms ease-out, transform 120ms ease-out;
}
button:hover { background: rgba(255, 255, 255, .14); color: #fff; }
button:active { transform: scale(.88); }
button:focus-visible { outline: 2px solid #8ab4ff; outline-offset: -2px; }
svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

  const ICONS = {
    rewind: 'M11 17 6 12l5-5M18 17l-5-5 5-5',
    slower: 'M5 12h14',
    faster: 'M12 5v14M5 12h14',
    advance: 'M13 17l5-5-5-5M6 17l5-5-5-5',
    hide: 'M18 6 6 18M6 6l12 12',
  };

  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', ICONS[name]);
    svg.append(p);
    return svg;
  }

  /**
   * Where the overlay lives. While something is fullscreen, Chrome makes
   * everything outside it inert, so the overlay must sit inside it.
   */
  function uiParent() {
    let fs = document.fullscreenElement;
    while (fs?.shadowRoot?.fullscreenElement) fs = fs.shadowRoot.fullscreenElement;
    return fs && !(fs instanceof HTMLMediaElement) ? fs : document.documentElement;
  }

  function ensureUI() {
    if (ui) {
      const parent = uiParent();
      if (ui.host.parentNode !== parent) {
        parent.append(ui.host);
        showTop();
      }
      return ui;
    }
    const host = document.createElement('video-speed-overlay');
    host.setAttribute('popover', 'manual');
    host.style.cssText = [
      'all:initial',
      'display:block',
      'position:fixed',
      'inset:0',
      'width:100vw',
      'height:100vh',
      'margin:0',
      'padding:0',
      'border:0',
      'background:transparent',
      'overflow:visible',
      'pointer-events:none',
      'z-index:2147483647',
    ]
      .map((d) => d + ' !important')
      .join(';');
    styleHost(host);
    const root = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = CSS;
      root.append(style);
    }
    uiParent().append(host);
    ui = { host, root };
    showTop();
    return ui;
  }

  function styleHost(host) {
    host.style.setProperty('--vsc-opacity', String(settings.opacity));
    host.style.setProperty('--vsc-scale', String(settings.scale));
  }

  /** Put the overlay at the top of the top layer (above fullscreen elements). */
  function showTop() {
    const h = ui?.host;
    if (!h || typeof h.showPopover !== 'function') return;
    try {
      if (h.matches(':popover-open')) h.hidePopover();
      h.showPopover();
    } catch {
      /* not supported or detached: fixed positioning + max z-index still applies */
    }
  }

  function onFullscreen() {
    if (!ui) return;
    const parent = uiParent();
    if (ui.host.parentNode !== parent) parent.append(ui.host);
    showTop();
    schedule();
  }

  function buildPill(c) {
    const { root } = ensureUI();
    const pill = document.createElement('div');
    pill.className = 'pill';
    pill.hidden = true;

    const speedEl = document.createElement('span');
    speedEl.className = 'speed';
    speedEl.title = 'Drag to move';

    const ctrls = document.createElement('span');
    ctrls.className = 'ctrls';
    const inner = document.createElement('div');
    const sep = document.createElement('span');
    sep.className = 'sep';
    const btn = (action, name, label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.append(icon(name));
      b.addEventListener('click', () => {
        if (action === 'hide') {
          c.hidden = true;
          return schedule();
        }
        runAction(action, settings.bindings.find((x) => x.action === action)?.value);
      });
      return b;
    };
    ctrls.append(inner);
    inner.append(
      sep,
      btn('rewind', 'rewind', 'Rewind'),
      btn('slower', 'slower', 'Slower'),
      btn('faster', 'faster', 'Faster'),
      btn('advance', 'advance', 'Advance'),
      btn('hide', 'hide', 'Hide controller')
    );
    const body = document.createElement('div');
    body.className = 'body';
    body.append(speedEl, ctrls);
    pill.append(body);

    // Keep our clicks away from the page's player (e.g. click-to-pause).
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      pill.addEventListener(t, (e) => e.stopPropagation());
    }

    // Drag to reposition, relative to the video's corner.
    speedEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX - c.dx;
      const sy = e.clientY - c.dy;
      speedEl.setPointerCapture(e.pointerId);
      const move = (ev) => {
        c.dx = ev.clientX - sx;
        c.dy = ev.clientY - sy;
        render();
      };
      const up = () => {
        speedEl.removeEventListener('pointermove', move);
        speedEl.removeEventListener('pointerup', up);
        speedEl.removeEventListener('pointercancel', up);
      };
      speedEl.addEventListener('pointermove', move);
      speedEl.addEventListener('pointerup', up);
      speedEl.addEventListener('pointercancel', up);
    });

    c.pill = pill;
    c.speedEl = speedEl;
    root.append(pill);
  }

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function schedule() {
    if (!raf && running) raf = requestAnimationFrame(render);
  }

  function render() {
    raf = 0;
    if (!running || !ui) return;
    ensureUI(); // re-attach if the page removed it or fullscreen changed
    const flashing = performance.now() < flashUntil;
    const vw = innerWidth;
    const vh = innerHeight;
    for (const c of media.values()) {
      const { el, pill } = c;
      if (!pill) continue;
      let show = el.isConnected && !c.hidden && !hiddenAll;
      let r;
      if (show) {
        r = el.getBoundingClientRect();
        show = r.width >= 40 && r.height >= 40 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && (el.checkVisibility?.() ?? true);
      }
      pill.hidden = !show;
      if (!show) continue;
      const x = Math.max(0, r.left) + 8 + c.dx;
      const y = Math.max(0, r.top) + 8 + c.dy;
      pill.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      pill.classList.toggle('flash', flashing);
      const text = V.formatSpeed(el.playbackRate);
      if (c.speedEl.textContent !== text) {
        const changed = c.speedEl.textContent !== '';
        c.speedEl.textContent = text;
        if (changed && !reducedMotion.matches) {
          c.speedEl.animate([{ transform: 'scale(1.18)' }, { transform: 'scale(1)' }], {
            duration: 220,
            easing: 'cubic-bezier(.2, .8, .2, 1)',
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------- popup API

  function state() {
    const list = targets();
    return {
      speed: V.clampSpeed(desired ?? list[0]?.playbackRate ?? 1),
      count: list.length,
      hidden: hiddenAll,
    };
  }

  function onMessage(msg, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'vsc:site':
        if (window !== window.top) return;
        sendResponse({ host: location.hostname, url: location.href, enabled: site.enabled, protocol: location.protocol });
        return;
      case 'vsc:state':
        if (!running || !targets().length) return; // let a frame that has media answer
        sendResponse(state());
        return;
      case 'vsc:set':
        if (!running || !targets().length || typeof msg.speed !== 'number') return;
        lastOwnAction = performance.now();
        setDesired(msg.speed);
        flash();
        sendResponse(state());
        return;
      case 'vsc:action':
        if (!running || typeof msg.action !== 'string' || !Object.hasOwn(V.ACTIONS, msg.action)) return;
        if (!runAction(msg.action, msg.value)) return;
        sendResponse(state());
        return;
    }
  }

  // ---------------------------------------------------------------- boot

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorage);
  chrome.storage.local
    .get(null)
    .then((raw) => {
      settings = V.sanitizeSettings(raw);
      applySettings();
    })
    .catch(() => {});
})();
