'use strict';
(async () => {
  const V = globalThis.VSC;
  const $ = (sel, root = document) => root.querySelector(sel);
  const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)(Left|Right)?$/;

  let s = V.sanitizeSettings(await chrome.storage.local.get(null));

  // ------------------------------------------------------------ saving
  let saveTimer = 0;
  let statusTimer = 0;
  const pending = new Set();
  function save(keys) {
    for (const k of keys) pending.add(k);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const clean = V.sanitizeSettings(s);
      const patch = {};
      for (const k of pending) patch[k] = clean[k];
      pending.clear();
      await chrome.storage.local.set(patch);
      const st = $('#status');
      st.textContent = 'Saved';
      st.classList.add('show');
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => st.classList.remove('show'), 1200);
    }, 250);
  }

  // ------------------------------------------------------------ general
  for (const input of document.querySelectorAll('[data-key]')) {
    const key = input.dataset.key;
    if (input.type === 'checkbox') input.checked = s[key];
    else input.value = String(s[key]);
    input.addEventListener(input.type === 'range' ? 'input' : 'change', () => {
      s[key] = input.type === 'checkbox' ? input.checked : Number(input.value);
      save([key]);
    });
  }

  // ------------------------------------------------------------ shortcuts
  const bindingsEl = $('#bindings');
  const actionOptions = Object.entries(V.ACTIONS);

  function markConflicts() {
    const rows = [...bindingsEl.children];
    const sig = (b) => [b.code, b.ctrl, b.alt, b.shift, b.meta].join('|');
    const counts = new Map();
    for (const b of s.bindings) counts.set(sig(b), (counts.get(sig(b)) || 0) + 1);
    rows.forEach((row, i) => {
      const dup = counts.get(sig(s.bindings[i])) > 1;
      const key = $('.key', row);
      key.classList.toggle('conflict', dup);
      key.title = dup ? 'This key is used by more than one shortcut' : 'Click, then press a key';
    });
  }

  function bindingRow(b) {
    const row = $('#binding-row').content.firstElementChild.cloneNode(true);
    const select = $('.action', row);
    for (const [id, def] of actionOptions) select.append(new Option(def.label, id));
    select.value = b.action;

    const key = $('.key', row);
    key.textContent = V.keyLabel(b);

    const valueWrap = $('.value-wrap', row);
    const value = $('.value', row);
    const unit = $('.unit', row);
    const syncValue = () => {
      const def = V.ACTIONS[b.action];
      valueWrap.hidden = !('value' in def);
      unit.textContent = def.unit || '';
      if ('value' in def) {
        if (typeof b.value !== 'number') b.value = def.value;
        value.value = String(b.value);
      }
    };
    syncValue();

    select.addEventListener('change', () => {
      b.action = select.value;
      delete b.value;
      syncValue();
      save(['bindings']);
    });
    value.addEventListener('input', () => {
      const n = Number(value.value);
      if (Number.isFinite(n) && n > 0) {
        b.value = n;
        save(['bindings']);
      }
    });

    key.addEventListener('click', () => {
      key.classList.add('listening');
      key.textContent = 'Press a key…';
      const onKey = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (MODIFIER_CODES.test(e.code)) return;
        if (e.code !== 'Escape' && /^[A-Za-z0-9]{1,24}$/.test(e.code)) {
          Object.assign(b, { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
          save(['bindings']);
        }
        done();
      };
      const done = () => {
        window.removeEventListener('keydown', onKey, true);
        key.removeEventListener('blur', done);
        key.classList.remove('listening');
        key.textContent = V.keyLabel(b);
        markConflicts();
      };
      window.addEventListener('keydown', onKey, true);
      key.addEventListener('blur', done);
    });

    $('.remove', row).addEventListener('click', () => {
      s.bindings.splice(s.bindings.indexOf(b), 1);
      row.remove();
      markConflicts();
      save(['bindings']);
    });
    return row;
  }

  function renderBindings() {
    bindingsEl.replaceChildren(...s.bindings.map(bindingRow));
    markConflicts();
  }

  $('#add-binding').addEventListener('click', () => {
    const b = { action: 'preferred', code: 'KeyQ', ctrl: false, alt: false, shift: false, meta: false, value: 3 };
    s.bindings.push(b);
    const row = bindingRow(b);
    bindingsEl.append(row);
    markConflicts();
    save(['bindings']);
    $('.key', row).click();
    $('.key', row).focus();
  });

  $('#reset-bindings').addEventListener('click', () => {
    s.bindings = V.sanitizeSettings(null).bindings;
    renderBindings();
    save(['bindings']);
  });

  // ------------------------------------------------------------ sites
  const rulesEl = $('#rules');

  function ruleRow(r) {
    const row = $('#rule-row').content.firstElementChild.cloneNode(true);
    const pattern = $('.pattern', row);
    const mode = $('.mode', row);
    const speed = $('.speed', row);
    const wrap = $('.value-wrap', row);

    pattern.value = r.pattern;
    mode.value = r.disabled ? 'off' : 'speed';
    speed.value = r.speed == null ? '' : String(r.speed);
    wrap.hidden = r.disabled;

    const validate = () => {
      const m = /^\/(.+)\/([dgimsuy]*)$/.exec(pattern.value.trim());
      let msg = '';
      if (m) {
        try {
          new RegExp(m[1], m[2]);
        } catch {
          msg = 'Invalid regular expression';
        }
      }
      pattern.setCustomValidity(msg);
      pattern.title = msg;
    };
    validate();

    pattern.addEventListener('input', () => {
      r.pattern = pattern.value;
      validate();
      save(['rules']);
    });
    mode.addEventListener('change', () => {
      r.disabled = mode.value === 'off';
      wrap.hidden = r.disabled;
      save(['rules']);
    });
    speed.addEventListener('input', () => {
      r.speed = speed.value === '' ? null : Number(speed.value);
      save(['rules']);
    });
    $('.remove', row).addEventListener('click', () => {
      s.rules.splice(s.rules.indexOf(r), 1);
      row.remove();
      save(['rules']);
    });
    return row;
  }

  rulesEl.replaceChildren(...s.rules.map(ruleRow));

  $('#add-rule').addEventListener('click', () => {
    const r = { pattern: '', disabled: false, speed: 1.5 };
    s.rules.push(r);
    const row = ruleRow(r);
    rulesEl.append(row);
    $('.pattern', row).focus();
  });

  renderBindings();
})();
