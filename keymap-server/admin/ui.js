'use strict';
// Shared helpers of the admin page (window.Ui): DOM builders, icons, badges, overflow menu, segmented control,
// skeletons, breadcrumbs, toast, modal dialog, theme switch and API calls.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k.startsWith('aria-')) { n.setAttribute(k, String(v)); continue; } // aria-* booleans must be "true"/"false", never empty
      if (v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };

  const svgEl = (tag, attrs = {}, ...kids) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };

  const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);
  const short = (id) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
  const textBytes = (s) => new TextEncoder().encode(s).length;
  const clockTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('vi-VN') : '—');
  const clockDateTime = (iso) => (iso ? new Date(iso).toLocaleString('vi-VN') : '—');
  // text without accents or case, for searching ("do giat" finds "Độ giật")
  const plain = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

  // ---------------------------------------------------------------- icons (24x24, stroke only)
  const ICONS = {
    layers: ['m12 2 10 5-10 5L2 7Z', 'm2 12 10 5 10-5', 'm2 17 10 5 10-5'],
    file: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4'],
    compare: [{ c: [18, 18, 3] }, { c: [6, 6, 3] }, 'M13 6h3a2 2 0 0 1 2 2v7', 'M11 18H8a2 2 0 0 1-2-2V9'],
    clock: [{ c: [12, 12, 10] }, 'M12 6v6l4 2'],
    tablet: [{ rect: [4, 2, 16, 20, 2] }, 'M12 18h.01'],
    search: [{ c: [11, 11, 8] }, 'm21 21-4.3-4.3'],
    more: [{ c: [12, 12, 1] }, { c: [19, 12, 1] }, { c: [5, 12, 1] }],
    trash: ['M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'],
    x: ['M18 6 6 18', 'm6 6 12 12'],
    sun: [{ c: [12, 12, 4] }, 'M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41', 'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41'],
    moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
    monitor: [{ rect: [2, 3, 20, 14, 2] }, 'M8 21h8', 'M12 17v4'],
    download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
    copy: [{ rect: [8, 8, 14, 14, 2] }, 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
    alert: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
    check: ['M20 6 9 17l-5-5'],
    info: [{ c: [12, 12, 10] }, 'M12 16v-4', 'M12 8h.01'],
    refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
    eye: ['M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z', { c: [12, 12, 3] }],
    pencil: ['M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z'],
    folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
    history: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
    command: ['M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3'],
    list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
    grid: [{ rect: [3, 3, 7, 7, 1] }, { rect: [14, 3, 7, 7, 1] }, { rect: [3, 14, 7, 7, 1] }, { rect: [14, 14, 7, 7, 1] }],
    back: ['m12 19-7-7 7-7', 'M19 12H5'],
    plus: ['M12 5v14', 'M5 12h14'],
    chevronsLeft: ['m11 17-5-5 5-5', 'm18 17-5-5 5-5'],
    chevronsRight: ['m6 17 5-5-5-5', 'm13 17 5-5-5-5'],
    filter: ['M22 3H2l8 9.46V19l4 2v-8.54z'],
    arrowUp: ['m5 12 7-7 7 7', 'M12 19V5'],
    arrowDown: ['M12 5v14', 'm19 12-7 7-7-7'],
    sparkles: ['m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z'],
  };

  function icon(name) {
    const svg = svgEl('svg', { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    for (const part of ICONS[name] || []) {
      if (typeof part === 'string') svg.append(svgEl('path', { d: part }));
      else if (part.c) svg.append(svgEl('circle', { cx: part.c[0], cy: part.c[1], r: part.c[2] }));
      else if (part.rect) svg.append(svgEl('rect', { x: part.rect[0], y: part.rect[1], width: part.rect[2], height: part.rect[3], rx: part.rect[4] || 0 }));
    }
    return svg;
  }
  // label next to an icon
  const withIcon = (name, text) => [icon(name), text];

  // ---------------------------------------------------------------- toast
  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.replaceChildren(icon(isError ? 'alert' : 'check'), el('span', {}, msg));
    t.className = isError ? 'show error' : 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, isError ? 6000 : 2600);
  }

  const ERRORS_VI = {
    'Not found': 'Không tìm thấy.',
    'Internal error': 'Lỗi nội bộ của server.',
    'Invalid JSON': 'Dữ liệu gửi lên không phải JSON hợp lệ.',
    'Cross-site or missing X-Admin-Request': 'Yêu cầu bị chặn vì không đến từ chính trang quản trị này.',
    'Method not allowed': 'Phương thức không được phép.',
    Conflict: 'File đã bị thay đổi từ lúc bạn mở (có thể app vừa đồng bộ).',
    'Version not found': 'Không tìm thấy phiên bản lịch sử này.',
    'File not found': 'Không tìm thấy file này trên server.',
    'Backup not found': 'Không có bản sao lưu của ngày này.',
    'Invalid date': 'Ngày không hợp lệ.',
    'Device not found': 'Không tìm thấy thiết bị.',
    'text must be a string': 'Nội dung phải là văn bản.',
    'Item not found': 'Mục này không còn trong file (có thể đã được xóa).',
    'Invalid ids': 'Danh sách mục cần xóa không hợp lệ.',
  };
  const viError = (msg) => ERRORS_VI[msg] || (msg.startsWith('Host not allowed') ? 'Địa chỉ truy cập này không được phép (xem ADMIN_ALLOWED_HOSTS).' : msg.startsWith('Body must be') ? 'Dữ liệu gửi lên sai định dạng.' : msg);

  async function api(method, path, body, { signal } = {}) {
    const opts = { method, headers: {}, signal };
    if (method !== 'GET') opts.headers['X-Admin-Request'] = '1';
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(`/admin/api${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(viError(data.error || `HTTP ${res.status}`));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  async function copyText(text, message = 'Đã sao chép') {
    try { await navigator.clipboard.writeText(text); toast(message); } catch { toast('Trình duyệt không cho sao chép tự động.', true); }
  }

  // ---------------------------------------------------------------- small components
  const badge = (text, tone = 'neutral', { title, dot = false } = {}) =>
    el('span', { class: `badge${tone === 'neutral' ? '' : ` ${tone}`}${dot ? ' with-dot' : ''}`, title }, text);

  // Status dot with words next to it
  const status = (on, text) =>
    el('span', { class: 'inline-flex items-center gap-2' },
      el('span', { class: `dot${on ? ' on' : ''}`, 'aria-hidden': 'true' }),
      el('span', {}, text));

  const alert = (tone, ...kids) =>
    el('div', { class: `alert${tone === 'warn' ? '' : ` ${tone}`}`, role: tone === 'danger' ? 'alert' : undefined },
      icon(tone === 'ok' ? 'check' : tone === 'info' ? 'info' : 'alert'), el('div', { class: 'alert-body' }, kids));

  const emptyState = (iconName, title, hint) =>
    el('div', { class: 'empty' }, icon(iconName), el('b', {}, title), hint ? el('span', { class: 'text-sm' }, hint) : null);

  // Segmented control: one choice out of a few
  function segmented({ label, options, value, onchange }) {
    const buttons = options.map((o) => el('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': o.value === value ? 'true' : 'false',
      tabindex: o.value === value ? '0' : '-1',
      'data-value': o.value,
            onclick: () => { if (o.value !== value) onchange(o.value); },
    }, o.label));
    const group = el('div', {
      class: 'segmented',
      role: 'radiogroup',
      'aria-label': label,
    }, buttons);
    group.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(document.activeElement);
      if (i < 0 || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
      buttons[next].click();
    });
    return group;
  }

  // Overflow menu (the three dots)
  function menuButton(items, { label = 'Thao tác khác' } = {}) {
    let menu = null;
    const btn = el('button', {
      type: 'button',
      class: 'btn icon small ghost menu-btn',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-label': label,
      title: label,
      onclick: (e) => { e.stopPropagation(); if (menu) close(); else open(); },
      onkeydown: (e) => { if (e.key === 'ArrowDown' && !menu) { e.preventDefault(); e.stopPropagation(); open(); } },
    }, icon('more'));

    const onOutside = (e) => { if (menu && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close(false); };
    const onKey = (e) => {
      if (!menu) return;
      const entries = [...menu.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')];
      const i = entries.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') close(false);
      else if (e.key === 'ArrowDown') { e.preventDefault(); entries[(i + 1) % entries.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); entries[(i - 1 + entries.length) % entries.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); entries[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); entries[entries.length - 1].focus(); }
    };
    function close(focusBack = true) {
      if (!menu) return;
      menu.remove();
      menu = null;
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      if (focusBack) btn.focus();
    }
    const onResize = () => close(false);
    function open() {
      document.dispatchEvent(new Event('ft-close-menus'));
      menu = el('div', {
        class: 'menu',
        role: 'menu',
        'aria-label': label,
      }, items.map((it) => (it.separator ? el('hr', { role: 'separator' }) : el('button', {
        type: 'button',
        role: 'menuitem',
        tabindex: '-1',
        class: it.danger ? 'danger' : undefined,
        'aria-disabled': it.disabled ? 'true' : undefined,
        onclick: (e) => { e.stopPropagation(); if (it.disabled) return; close(false); it.onclick(); },
      }, it.icon ? icon(it.icon) : null, it.label))));
      document.body.append(menu);
      btn.setAttribute('aria-expanded', 'true');
      const r = btn.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(window.innerWidth - m.width - 8, r.right - m.width))}px`;
      menu.style.top = `${r.bottom + 4 + m.height > window.innerHeight - 8 ? Math.max(8, r.top - m.height - 4) : r.bottom + 4}px`;
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', onResize);
      const first = menu.querySelector('[role="menuitem"]:not([aria-disabled="true"])');
      if (first) first.focus();
    }
    document.addEventListener('ft-close-menus', () => close(false));
    return btn;
  }

  // A bar that fills from 0 to 100 (the width is set from the script: the page's CSP only blocks style attributes in the markup)
  function progressBar(pct = 0) {
    const bar = el('div', { class: 'progress-bar' });
    const track = el('div', { class: 'progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, bar);
    const set = (p) => {
      const v = Math.max(0, Math.min(100, Number(p) || 0));
      bar.style.width = `${v}%`;
      track.setAttribute('aria-valuenow', String(Math.round(v)));
    };
    set(pct);
    return { node: track, set };
  }

  // A window that cannot be closed while something is being done: a bar with the percent, the steps (done / now / waiting) and a line
  // that says exactly what is going on. update({ step, pct, detail }); finish(text) fills it and closes; fail(message) shows the problem
  // and waits for the user to close it.
  function progressDialog({ title, steps = [] }) {
    const bar = progressBar(0);
    const pctText = el('span', { class: 'progress-pct' }, '0%');
    const detail = el('div', { class: 'muted', role: 'status', 'aria-live': 'polite' }, 'Đang bắt đầu…');
    const items = steps.map((s) => el('li', { class: 'step' }, el('span', { class: 'step-mark', 'aria-hidden': 'true' }), el('span', {}, s)));
    const actions = el('div', { class: 'modal-actions' });
    const card = el('div', { class: 'modal-card progress-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'progress-title', tabindex: '-1' },
      el('h2', { id: 'progress-title' }, title), el('div', { class: 'progress-line' }, bar.node, pctText), detail, el('ol', { class: 'steps' }, items), actions);
    const overlay = el('div', { class: 'modal' }, card);
    const block = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); } };
    document.body.append(overlay);
    document.addEventListener('keydown', block, true);
    card.focus();
    let closed = false;
    const close = () => { if (closed) return; closed = true; document.removeEventListener('keydown', block, true); overlay.remove(); };
    const mark = (step) => items.forEach((li, i) => { li.className = `step${i < step ? ' done' : i === step ? ' active' : ''}`; });
    return {
      update({ step, pct, detail: text }) {
        if (pct != null) { bar.set(pct); pctText.textContent = `${Math.round(pct)}%`; }
        if (text != null) detail.textContent = text;
        if (step != null) mark(step);
      },
      finish(text) {
        bar.set(100); pctText.textContent = '100%'; mark(items.length); if (text) detail.textContent = text;
        return new Promise((resolve) => setTimeout(() => { close(); resolve(); }, 700));
      },
      // a button that asks the job to stop early (null removes it)
      setStop(label, fn) {
        actions.replaceChildren(...(label ? [el('button', { type: 'button', class: 'btn', onclick: (ev) => { ev.currentTarget.disabled = true; fn(); } }, label)] : []));
      },
      // the job is done: lines of what happened and the buttons to choose from ({ label, primary, onclick }); any button closes the window first
      result(lines, buttons) {
        bar.set(100); pctText.textContent = '100%'; mark(items.length);
        detail.replaceChildren(...lines.map((l) => el('div', { class: 'result-line' }, l)));
        return new Promise((resolve) => {
          actions.replaceChildren(...buttons.map((b) => el('button', { type: 'button', class: `btn${b.primary ? ' primary' : ''}`, onclick: () => { close(); if (b.onclick) b.onclick(); resolve(b.label); } }, b.label)));
        });
      },
      fail(message) {
        detail.replaceChildren(alert('danger', el('span', {}, message)));
        return new Promise((resolve) => { actions.replaceChildren(el('button', { type: 'button', class: 'btn primary', onclick: () => { close(); resolve(); } }, 'Đóng')); });
      },
      close,
    };
  }

  // The head of a tab: the title, one quiet line under it, and the page's own buttons on the right
  const pageHead = (title, sub, ...actions) => el('div', { class: 'page-head' },
    el('div', { class: 'titles' }, el('h1', {}, title), sub ? el('p', { class: 'sub' }, sub) : null),
    actions.flat().filter(Boolean).length ? el('div', { class: 'head-actions' }, actions) : null);

  // Skeleton: grey placeholders while a page loads
  function skeleton(kind = 'page') {
    const rows = (n) => el('div', { class: 'sk-rows' }, Array.from({ length: n }, (_, i) => el('span', { class: `sk ${['w90', 'w70', 'w50', 'w90', 'w30'][i % 5]}` })));
    const holder = (...kids) => el('div', { 'aria-hidden': 'true' }, kids);
    if (kind === 'split') return holder(el('div', { class: 'page-head' }, el('span', { class: 'sk w30' })), el('div', { class: 'split' }, el('div', { class: 'card flush' }, rows(8)), el('div', { class: 'card' }, rows(5))));
    return holder(el('div', { class: 'card' }, rows(4)), el('div', { class: 'card' }, rows(6)));
  }

  // Breadcrumbs in the toolbar. items: [{ label, onclick? }]; the last one is the current place
  function setCrumbs(items) {
    const ol = $('#crumbs');
    if (!ol) return;
    ol.replaceChildren(...items.map((it, i) => el('li', {
      'aria-current': i === items.length - 1 ? 'page' : undefined,
    }, it.onclick && i < items.length - 1
      ? el('button', { type: 'button', onclick: it.onclick }, it.label)
      : el('span', {}, it.label))));
  }

  // Tables with class "stack" become one card per row on a phone
  function labelStacked(root) {
    for (const t of root.querySelectorAll('table.stack')) {
      const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      for (const tr of t.querySelectorAll('tbody tr')) {
        let i = 0;
        for (const td of tr.children) {
          td.setAttribute('data-label', heads[i] || '');
          i += td.colSpan || 1;
        }
      }
    }
  }

  // ---------------------------------------------------------------- theme
  const THEMES = ['system', 'light', 'dark'];
  const THEME_VN = { system: 'Theo hệ thống', light: 'Sáng', dark: 'Tối' };
  const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };
  const theme = {
    get() { try { const t = localStorage.getItem('ftAdminTheme'); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; } },
    set(t) {
      try { if (t === 'system') localStorage.removeItem('ftAdminTheme'); else localStorage.setItem('ftAdminTheme', t); } catch { /* private mode */ }
      if (t === 'system') {
        delete document.documentElement.dataset.theme;
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
      } else {
        document.documentElement.dataset.theme = t;
        if (t === 'dark') document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
      }
      document.dispatchEvent(new Event('ft-theme'));
    },
    cycle() { const t = THEMES[(THEMES.indexOf(theme.get()) + 1) % THEMES.length]; theme.set(t); return t; },
    label: (t = theme.get()) => THEME_VN[t],
    icon: (t = theme.get()) => THEME_ICON[t],
  };

  // ---------------------------------------------------------------- modal dialog
  function showModal({ title, tone = 'warn', body, actions, step, className = '', onOpen }) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const done = (id) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); if (prev && prev.focus) prev.focus(); resolve(id); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); return; }
        if (e.key !== 'Tab') return;
        const focusable = [...dialog.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled && n.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      };
      const buttons = (actions || []).map((a) => el('button', {
        type: 'button',
        class: `btn ${a.primary ? 'primary' : ''}${a.danger ? ' danger-fill' : ''}`,
        disabled: Boolean(a.disabled),
        onclick: () => done(a.id),
      }, a.label));

      const dialog = el('div', {
        class: `modal-card ${tone} ${className}`,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'modal-title',
      },
      step ? el('div', { class: 'modal-step' }, step) : null,
      title ? el('h2', { id: 'modal-title' }, title) : null,
      el('div', { class: 'modal-body' }, body),
      buttons.length ? el('div', { class: 'modal-actions' }, buttons) : null);

      const overlay = el('div', {
        class: 'modal',
        onpointerdown: (e) => { if (e.target === overlay) done(null); },
      }, dialog);

      document.body.append(overlay);
      document.addEventListener('keydown', onKey, true);
      (buttons[0] || dialog).focus();
      // lets the caller change the window while it is open (for example enable a button when a result arrives)
      if (onOpen) onOpen({ dialog, close: done, setDisabled: (id, v) => { const i = (actions || []).findIndex((a) => a.id === id); if (i >= 0) buttons[i].disabled = Boolean(v); } });
    });
  }

  const brief = (v) => { if (v === undefined) return '—'; const t = JSON.stringify(v); return t.length > 70 ? `${t.slice(0, 70)}…` : t; };
  const KIND_VN = { added: 'Thêm', removed: 'Xóa', changed: 'Sửa' };
  function changesList(c) {
    return el('div', { class: 'changes mono' },
      c.changes.map((x) => el('div', {}, el('span', { class: `chg ${x.kind}` }, KIND_VN[x.kind]), ' ', el('span', { class: 'k' }, x.path), ': ',
        x.kind === 'added' ? el('span', { class: 's' }, brief(x.after)) : x.kind === 'removed' ? el('span', { class: 'n' }, brief(x.before))
          : [el('span', { class: 'n' }, brief(x.before)), ' → ', el('span', { class: 's' }, brief(x.after))])),
      c.truncated ? el('div', { class: 'muted text-xs' }, `… và ${c.total - c.changes.length} thay đổi nữa.`) : null);
  }

  function downloadText(name, text, type = 'application/xml;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.Ui = {
    $, el, svgEl, icon, withIcon, fmtBytes, short, textBytes, clockTime, clockDateTime, plain, toast, api, guard, copyText,
    labelStacked, pageHead, progressBar, progressDialog, badge, status, alert, emptyState, segmented, menuButton, skeleton, setCrumbs, theme, showModal, brief, changesList, downloadText,
  };
})();
