'use strict';
(async () => {
  const V = globalThis.VSC;
  const $ = (id) => document.getElementById(id);
  const PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const send = (msg, opts) =>
    tab?.id == null ? Promise.resolve(undefined) : chrome.tabs.sendMessage(tab.id, msg, opts || {}).catch(() => undefined);

  let settings = V.sanitizeSettings(null);
  const presets = $('presets');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p + '×';
    b.dataset.speed = String(p);
    b.addEventListener('click', () => act({ type: 'vsc:set', speed: p }));
    presets.append(b);
  }

  function show(state) {
    if (!state) return;
    $('speed').textContent = V.formatSpeed(state.speed) + '×';
    for (const b of presets.children) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === state.speed));
  }

  async function act(msg) {
    show(await send(msg));
  }

  $('slower').addEventListener('click', () => act({ type: 'vsc:action', action: 'slower' }));
  $('faster').addEventListener('click', () => act({ type: 'vsc:action', action: 'faster' }));
  for (const b of document.querySelectorAll('[data-action]')) {
    b.addEventListener('click', () => act({ type: 'vsc:action', action: b.dataset.action }));
  }

  function message(text) {
    $('message').textContent = text;
    $('message').hidden = !text;
  }

  async function refresh() {
    const site = await send({ type: 'vsc:site' }, { frameId: 0 });
    if (!site) {
      $('player').hidden = true;
      $('site').hidden = true;
      return message('Video Speed can’t run on this page.');
    }
    settings = V.sanitizeSettings(await chrome.storage.local.get(null));
    $('site').hidden = false;
    $('host').textContent = site.host || site.protocol.replace(':', '');
    $('site-toggle').checked = !V.siteConfig({ ...settings, enabled: true }, site.url).rule?.disabled;
    $('global-off').hidden = settings.enabled;

    const state = site.enabled ? await send({ type: 'vsc:state' }) : undefined;
    $('player').hidden = !state;
    if (state) {
      message('');
      show(state);
    } else {
      message(site.enabled ? 'No video or audio found on this page.' : 'Video Speed is off for this site.');
    }

    $('site-toggle').onchange = async (e) => {
      const fresh = V.sanitizeSettings(await chrome.storage.local.get(null));
      await chrome.storage.local.set({ rules: V.setSiteEnabled(fresh.rules, site.url, e.target.checked) });
      setTimeout(refresh, 150);
    };
  }

  $('global-on').addEventListener('click', async () => {
    await chrome.storage.local.set({ enabled: true });
    setTimeout(refresh, 150);
  });

  // Keyboard shortcuts inside the popup, mirroring the page shortcuts.
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const b = V.matchBinding(settings.bindings, e);
    if (b && !$('player').hidden) act({ type: 'vsc:action', action: b.action, value: b.value });
  });

  refresh();
})();
