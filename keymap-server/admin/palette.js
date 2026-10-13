'use strict';
// Command palette (Ctrl+K or "/"): type a few letters, jump to a tab, a cache item or a file, or run a small action.
// Parts of the page register a provider: a function returning (or resolving to) [{ group, label, hint, icon, keywords, run }].
(() => {
  const { el, icon, plain } = window.Ui;
  const providers = [];
  let openNow = false;

  const register = (fn) => { providers.push(fn); };

  async function gather() {
    const all = [];
    for (const p of providers) {
      try { all.push(...await p()); } catch { /* a provider that fails just adds nothing */ }
    }
    return all;
  }

  // every word typed must appear somewhere in the label, hint, keywords or group (accents and case ignored)
  const filter = (items, query) => {
    const words = plain(query).split(/\s+/).filter(Boolean);
    if (!words.length) return items.slice(0, 40);
    return items.filter((it) => { const hay = plain(`${it.label} ${it.hint || ''} ${it.keywords || ''} ${it.group || ''}`); return words.every((w) => hay.includes(w)); }).slice(0, 40);
  };

  async function open() {
    if (openNow) return;
    openNow = true;
    document.dispatchEvent(new Event('ft-close-menus'));
    const prev = document.activeElement;
    const items = await gather();
    let shown = [];
    let active = 0;
    const list = el('ul', { class: 'palette-list', role: 'listbox', id: 'palette-list', 'aria-label': 'Kết quả' });
    const input = el('input', {
      type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Gõ để tìm tab, mục, tệp hoặc thao tác…', 'aria-label': 'Tìm nhanh',
    });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); openNow = false; if (prev && prev.focus) prev.focus(); };
    const run = (it) => { close(); setTimeout(() => it.run(), 0); };
    function paint() {
      shown = filter(items, input.value);
      active = Math.min(active, Math.max(0, shown.length - 1));
      list.replaceChildren();
      if (!shown.length) { list.append(el('li', { class: 'palette-group', role: 'presentation' }, 'Không có kết quả khớp')); input.removeAttribute('aria-activedescendant'); return; }
      let group = null;
      shown.forEach((it, i) => {
        if (it.group !== group) { group = it.group; list.append(el('li', { class: 'palette-group', role: 'presentation' }, group)); }
        list.append(el('li', {
          class: 'palette-item', role: 'option', id: `palette-opt-${i}`, 'aria-selected': i === active ? 'true' : 'false',
          onpointermove: () => { if (active !== i) { active = i; mark(); } }, onclick: () => run(it),
        }, icon(it.icon || 'search'), el('span', {}, it.label), it.hint ? el('span', { class: 'hint' }, it.hint) : null));
      });
      mark();
    }
    function mark() {
      list.querySelectorAll('[role="option"]').forEach((n, i) => n.setAttribute('aria-selected', i === active ? 'true' : 'false'));
      const cur = list.querySelector(`#palette-opt-${active}`);
      if (cur) { input.setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView({ block: 'nearest' }); }
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (shown.length) { active = (active + 1) % shown.length; mark(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) { active = (active - 1 + shown.length) % shown.length; mark(); } }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) run(shown[active]); }
      else if (e.key === 'Tab') { e.preventDefault(); }
    }
    input.addEventListener('input', () => { active = 0; paint(); });
    const card = el('div', { class: 'modal-card palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tìm nhanh' },
      el('div', { class: 'palette-input' }, icon('search'), input),
      list,
      el('div', { class: 'palette-foot' }, el('span', {}, el('kbd', {}, '↑'), ' ', el('kbd', {}, '↓'), ' chọn'), el('span', {}, el('kbd', {}, 'Enter'), ' mở'), el('span', {}, el('kbd', {}, 'Esc'), ' đóng')));
    const overlay = el('div', { class: 'modal', onpointerdown: (e) => { if (e.target === overlay) close(); } }, card);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    paint();
    input.focus();
  }

  // Ctrl+K (or Cmd+K), and "/" when nothing is being typed
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName) || (document.activeElement && document.activeElement.isContentEditable);
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      if (document.querySelector('.modal') && !openNow) return; // another dialog is open
      e.preventDefault();
      open();
    }
  });

  window.Palette = { open, register };
})();
