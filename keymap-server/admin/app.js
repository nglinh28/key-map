'use strict';
// Admin page: the shell (sidebar, toolbar, command palette, theme) and the tabs "Tệp cài đặt", "So sánh ngày",
// "Sao lưu theo ngày", "Thiết bị". The tab "Phân tích cache" lives in analysis.js.
(() => {
  const { $, el, icon, pageHead, fmtBytes, textBytes, clockTime, clockDateTime, toast, api, guard, showModal, changesList, downloadText,
    badge, alert, emptyState, menuButton, skeleton, setCrumbs, theme, copyText, labelStacked } = window.Ui;
  const CX = window.CacheXml;
  const EL = window.EditLib;

  const CACHE_FILE = 'gamwing_keymap_cache.xml';
  const EDIT_MAX_BYTES = 256 * 1024; // larger files (the keymap cache) are shown and downloaded, not edited here
  const PREVIEW_CHARS = 300000;
  const enc = encodeURIComponent;
  const state = { view: 'analysis', dbEdit: null, filePick: '', autorun: '', cmp: { file: CACHE_FILE, a: null, b: '' } };

  // ---------------------------------------------------------------- shell: sidebar navigation, toolbar, theme, command palette
  const VIEWS = [['analysis', 'Phân tích cache', 'layers'], ['standards', 'Tiêu chuẩn súng', 'list'], ['files', 'Tệp cài đặt', 'file'], ['compare', 'So sánh ngày', 'compare'], ['backups', 'Sao lưu theo ngày', 'clock'], ['devices', 'Thiết bị', 'tablet']];
  const labelOf = (id) => VIEWS.find((v) => v[0] === id)[1];
  const dbDirty = () => !!state.dbEdit && state.dbEdit.text !== state.dbEdit.original;
  const dbEditDiscardOk = () => !dbDirty() || confirm('Bỏ các thay đổi chưa lưu của file cài đặt?');

  function goTo(id) {
    if (!dbEditDiscardOk()) return;
    state.dbEdit = null;
    window.Analysis.leave();
    state.view = id;
    render();
  }

  function renderNav() {
    $('#nav').replaceChildren(...VIEWS.map(([id, label, ic]) => el('button', {
      type: 'button', title: label, 'aria-label': label,
      class: 'nav-btn',
      'aria-current': state.view === id ? 'page' : false, onclick: () => goTo(id),
    }, icon(ic), el('span', {}, label))));
  }

  // The menu on the left can shrink to a strip of icons (desktop only) to give the work area more room; the choice is remembered.
  const navCollapsed = () => document.documentElement.dataset.nav === 'collapsed';
  function paintNavToggle() {
    const btn = $('#nav-toggle');
    if (!btn) return;
    const collapsed = navCollapsed();
    const text = collapsed ? 'Mở rộng menu' : 'Thu gọn menu';
    btn.replaceChildren(icon(collapsed ? 'chevronsRight' : 'chevronsLeft'), el('span', {}, text));
    btn.title = `${text} (Ctrl+B)`;
    btn.setAttribute('aria-label', text);
    btn.setAttribute('aria-expanded', String(!collapsed));
  }
  function toggleNav() {
    if (navCollapsed()) delete document.documentElement.dataset.nav; else document.documentElement.dataset.nav = 'collapsed';
    try { localStorage.setItem('ftAdminNav', navCollapsed() ? 'collapsed' : 'open'); } catch { /* private mode: not remembered */ }
    paintNavToggle();
  }

  function setupShell() {
    $('#nav-toggle').addEventListener('click', toggleNav);
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b' && !typing) { e.preventDefault(); toggleNav(); }
    });
    paintNavToggle();
    $('#brand').replaceChildren(
      el('div', { class: 'logo' }, icon('grid')),
      el('span', { class: 'brand-name' }, 'KeyMap'));
    const themeBtn = el('button', {
      type: 'button',
      class: 'btn icon ghost',
      onclick: () => { const t = theme.cycle(); toast(`Giao diện: ${theme.label(t)}`); }
    });
    const paintTheme = () => { themeBtn.replaceChildren(icon(theme.icon())); themeBtn.title = `Giao diện: ${theme.label()} (bấm để đổi)`; themeBtn.setAttribute('aria-label', `Giao diện: ${theme.label()}. Bấm để đổi.`); };
    document.addEventListener('ft-theme', paintTheme);
    document.addEventListener('ft-goto', (e) => goTo(e.detail));
    paintTheme();
    $('#tools').replaceChildren(
      el('button', {
        type: 'button',
        class: 'btn',
        onclick: () => window.Palette.open(),
        'aria-label': 'Tìm nhanh (Ctrl+K)'
      }, icon('search'), el('span', { class: 'tool-label' }, 'Tìm nhanh…'), el('kbd', { class: 'tool-kbd' }, 'Ctrl K')),
      themeBtn);
    // what the palette can do apart from the cache items (analysis.js adds those)
    let fileCache = { at: 0, list: [] };
    window.Palette.register(() => VIEWS.map(([id, label, ic]) => ({ group: 'Chuyển tab', label, icon: ic, run: () => goTo(id) })));
    window.Palette.register(() => [
      { group: 'Thao tác', label: 'Đổi giao diện sáng / tối', hint: theme.label(), icon: theme.icon(), keywords: 'theme dark light', run: () => { const t = theme.cycle(); toast(`Giao diện: ${theme.label(t)}`); } },
      { group: 'Thao tác', label: navCollapsed() ? 'Mở rộng menu bên trái' : 'Thu gọn menu bên trái', hint: 'Ctrl+B', icon: navCollapsed() ? 'chevronsRight' : 'chevronsLeft', keywords: 'sidebar menu thu gon mo rong', run: toggleNav },
      { group: 'Thao tác', label: 'Tải lại trang hiện tại', icon: 'refresh', keywords: 'reload refresh', run: () => render() },
      { group: 'Thao tác', label: 'Kiểm tra đồng bộ trên server', icon: 'check', keywords: 'sync verify dong bo ngay moi nhat', run: () => { state.autorun = 'server'; goTo('backups'); } },
      { group: 'Thao tác', label: 'Kiểm tra đồng bộ trên app (máy tính bảng)', icon: 'tablet', keywords: 'sync verify dong bo tablet', run: () => { state.autorun = 'app'; goTo('backups'); } },
    ]);
    window.Palette.register(async () => {
      if (Date.now() - fileCache.at > 20000) fileCache = { at: Date.now(), list: (await api('GET', '/sync/databases')).files };
      return fileCache.list.map((f) => ({ group: 'Tệp cài đặt', label: f.name, hint: fmtBytes(f.bytes), icon: 'file', keywords: f.folder || '', run: () => { state.filePick = f.name; goTo('files'); } }));
    });
  }

  // the user's corrections of the table of accessories ("Tiêu chuẩn súng"), loaded once before any tab is drawn: every check of the page uses them
  let standardsP = null;
  const loadStandards = () => (standardsP || (standardsP = api('GET', '/standards')
    .then((r) => { window.RecoilLib.setRuleOverrides(r.overrides); })
    .catch(() => { standardsP = null; }))); // tried again next time

  let renderSeq = 0;
  async function render() {
    renderNav();
    const mine = ++renderSeq; // a slow tab (the 6 MB cache) must not overwrite the tab opened after it
    const app = $('#app');
    setCrumbs([{ label: labelOf(state.view) }]);
    app.setAttribute('aria-busy', 'true');
    const wait = setTimeout(() => { if (mine === renderSeq) app.replaceChildren(skeleton(['analysis', 'files', 'standards'].includes(state.view) ? 'split' : 'page')); }, 150);
    let node;
    await loadStandards();
    try {
      const view = { analysis: () => window.Analysis.view(), standards: () => window.Standards.view(), files: viewFiles, compare: viewCompare, backups: viewBackups, devices: viewDevices }[state.view];
      node = await view();
    } catch (e) { node = alert('danger', el('b', {}, 'Không tải được trang này'), el('span', {}, e.message)); }
    clearTimeout(wait);
    if (mine !== renderSeq) return;
    app.dataset.view = state.view;
    app.replaceChildren(node);
    app.removeAttribute('aria-busy');
    labelStacked(app);
    updateMeta();
  }

  async function updateMeta() {
    try {
      const i = await api('GET', '/sync/info');
      const brand = $('#brand');
      if (brand) brand.title = `KeyMap Sync server v${i.version} · ${i.files} file · ${i.backup_days} ngày sao lưu`;
    } catch { /* the status line on the left already says the server cannot be reached */ }
  }

  // ---------------------------------------------------------------- who is connected (phone app <-> this page)
  // This page pings the server every 10 s so the Android app can show "web: open"; the app sends a heartbeat every 15 s
  // and this page shows it. "Connected" means a sign of life in the last 40 s (devices) / 30 s (pages), not an open socket.
  const SESSION = `web-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const STATE_VN = { idle: 'Đang chờ', watching: 'Đang theo dõi thư mục', syncing: 'Đang đồng bộ', error: 'Có lỗi' };

  async function pingPresence() {
    try { await api('POST', '/presence', { session: SESSION }); } catch { /* the chip below shows the server is unreachable */ }
  }

  async function refreshConn() {
    const chip = $('#conn');
    if (!chip) return;
    let full;
    try {
      const { devices } = await api('GET', '/sync/devices');
      const online = devices.filter((d) => d.online);
      if (online.length) {
        const d = online[0];
        const last = (d.last_push && d.last_push.at) || d.last_seen;
        chip.className = 'conn on';
        chip.textContent = `${d.name}${online.length > 1 ? ` +${online.length - 1}` : ''} đang kết nối`;
        full = `${chip.textContent} · ${d.auto_push ? 'tự đẩy bật' : 'tự đẩy tắt'} · đồng bộ lúc ${clockTime(last)}`;
      } else if (devices.length) {
        chip.className = 'conn';
        chip.textContent = 'Máy tính bảng chưa kết nối';
        full = `Không có thiết bị nào đang kết nối (lần cuối: ${devices[0].name}, ${clockDateTime(devices[0].last_seen)})`;
      } else {
        chip.className = 'conn';
        chip.textContent = 'Chưa có thiết bị nào';
        full = 'Chưa có thiết bị nào kết nối';
      }
    } catch {
      chip.className = 'conn';
      chip.textContent = 'Không liên lạc được với server';
      full = chip.textContent;
    }
    chip.title = full;
  }

  async function viewDevices() {
    const { devices, web } = await api('GET', '/sync/devices');
    const cards = devices.map((d) => {
      const push = d.last_push ? `${clockDateTime(d.last_push.at)} · lưu ${d.last_push.saved ?? 0} file` : 'chưa có';
      const pull = d.last_pull ? `${clockDateTime(d.last_pull.at)} · ${d.last_pull.files} file` : 'chưa có';
      return el('section', { class: `card device ${d.online ? 'on' : 'off'}` },
        el('div', { class: 'device-head row' }, el('span', { class: `dot${d.online ? ' on' : ''}`, 'aria-hidden': 'true' }), el('h2', {}, d.name), d.model ? badge(d.model) : null,
          d.online ? badge('Đang kết nối', 'ok') : badge(`Ngắt kết nối · ${clockDateTime(d.last_seen)}`), d.error ? badge('Có lỗi', 'danger') : null),
        el('div', { class: 'stats' },
          el('div', { class: 'stat' }, el('span', { class: 'label' }, 'Trạng thái'), el('span', { class: 'value' }, STATE_VN[d.state] || d.state)),
          el('div', { class: 'stat' }, el('span', { class: 'label' }, 'Tự đẩy khi thư mục đổi'), el('span', { class: 'value' }, d.auto_push ? 'Bật' : 'Tắt')),
          el('div', { class: 'stat' }, el('span', { class: 'label' }, 'Lần đẩy gần nhất'), el('span', { class: 'value' }, push)),
          el('div', { class: 'stat' }, el('span', { class: 'label' }, 'Lần lấy bản sao lưu'), el('span', { class: 'value' }, pull))),
        d.error ? alert('danger', el('span', {}, d.error)) : null,
        el('details', { class: 'disclosure' }, el('summary', {}, 'Chi tiết kỹ thuật'),
          el('div', { class: 'disclosure-body' }, el('dl', { class: 'kv' },
            el('dt', {}, 'Thư mục theo dõi'), el('dd', { class: 'mono' }, d.folder || '—'),
            el('dt', {}, 'Địa chỉ mạng'), el('dd', { class: 'mono' }, d.ip || d.remote || '—'),
            el('dt', {}, 'Android / phiên bản app'), el('dd', {}, `${d.android || '—'} / ${d.app_version || '—'}`),
            el('dt', {}, 'Lần đẩy gần nhất'), el('dd', {}, d.last_push ? `${push}, giữ nguyên ${d.last_push.unchanged ?? 0}, bỏ qua ${d.last_push.skipped ?? 0}` : 'chưa có'),
            el('dt', {}, 'Thấy lần đầu'), el('dd', {}, clockDateTime(d.first_seen))))),
        el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn small danger', onclick: guard(async () => { if (!confirm(`Quên thiết bị "${d.name}"? Nó sẽ hiện lại nếu app kết nối lần nữa.`)) return; await api('DELETE', `/sync/devices/${d.id}`); await render(); refreshConn(); }) }, icon('trash'), 'Quên thiết bị')));
    });
    return el('div', {}, pageHead('Thiết bị', 'Máy tính bảng gửi nhịp "còn sống" mỗi 15 giây; quá 40 giây không có nhịp thì coi là ngắt kết nối.', el('span', { class: 'muted' }, `${web.sessions} trang web đang mở`)),
      devices.length ? cards : el('div', { class: 'card' }, emptyState('tablet', 'Chưa có thiết bị nào', 'Mở app "KeyMap Sync" trên máy tính bảng, nhập địa chỉ server này là máy sẽ xuất hiện ở đây.')));
  }

  // ---------------------------------------------------------------- the preference files
  const isSecret = (name) => /adbkey/i.test(name);
  // where the file lives on the tablet; older copies were pushed before the app told the folder
  const folderText = (f) => f.folder || '—';

  async function showFile(name, day) {
    const f = day ? await api('GET', `/sync/backups/${day}/databases/${enc(name)}`) : await api('GET', `/sync/databases/${enc(name)}`);
    const cut = f.text.length > PREVIEW_CHARS;
    const id = await showModal({
      title: `${name}${day ? ` — ngày ${day}` : ''}`, tone: isSecret(name) ? 'warn' : 'info', className: 'wide',
      body: [isSecret(name) ? alert('warn', el('span', {}, 'File này nhiều khả năng chứa khóa riêng của app (ADB). Server không có đăng nhập: ai trong mạng nội bộ cũng xem được trang này.')) : null,
        el('p', {}, el('span', { class: 'muted' }, 'Thư mục trên máy: '), el('span', { class: 'mono' }, folderText(f))),
        el('p', { class: 'muted' }, `${fmtBytes(textBytes(f.text))}${cut ? ` · chỉ hiện ${fmtBytes(PREVIEW_CHARS)} đầu, hãy tải về để xem đủ` : ''}`),
        el('pre', { class: 'mono tree xmlview' }, cut ? f.text.slice(0, PREVIEW_CHARS) : f.text)],
      actions: [{ id: 'close', label: 'Đóng' }, { id: 'download', label: 'Tải về', primary: true }],
    });
    if (id === 'download') downloadText(name, f.text);
  }

  // null when the text is well-formed XML (one root element, tags nested and closed, attributes quoted), otherwise the first problem.
  // Written out by hand because DOMParser's error document carries inline styles that this page's CSP rightly blocks.
  function xmlProblem(text) {
    if (!text.trim()) return 'nội dung trống';
    const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)|(<)/g;
    const lineAt = (i) => text.slice(0, i).split('\n').length;
    const stack = [];
    let roots = 0;
    let m;
    while ((m = token.exec(text))) {
      if (m[6]) return `dòng ${lineAt(m.index)}: thẻ sai cú pháp (thiếu dấu >, thuộc tính thiếu dấu ngoặc kép...)`;
      if (m[5] !== undefined) {
        if (!stack.length && m[5].trim()) return `dòng ${lineAt(m.index)}: có chữ nằm ngoài thẻ gốc`;
        if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(m[5])) return `dòng ${lineAt(m.index)}: ký tự & phải viết là &amp;`;
        continue;
      }
      if (m[2] === undefined) continue; // comment, declaration or CDATA
      if (m[1]) {
        const open = stack.pop();
        if (open !== m[2]) return `dòng ${lineAt(m.index)}: </${m[2]}> không khớp với ${open ? `<${open}>` : 'thẻ mở nào'}`;
      } else {
        if (!stack.length && ++roots > 1) return `dòng ${lineAt(m.index)}: chỉ được có một thẻ gốc`;
        if (!m[4]) stack.push(m[2]);
      }
    }
    if (stack.length) return `thẻ <${stack[stack.length - 1]}> chưa được đóng`;
    return roots === 1 ? null : 'không có thẻ gốc';
  }

  // ---- a human-readable list of what differs between two texts of a preferences file
  function mapName(analysis, name) {
    if (!name.startsWith('map|')) return '';
    const doc = analysis && analysis.docs.get(name.slice(4));
    return doc && typeof doc.name === 'string' ? doc.name : '';
  }

  function jsonDetail(name, va, vb) {
    let a;
    let b;
    try { a = va === undefined ? undefined : JSON.parse(va); b = vb === undefined ? undefined : JSON.parse(vb); } catch { toast('Nội dung không phải JSON hợp lệ.', true); return; }
    const changes = EL.diff(a, b, { limit: 200 });
    showModal({ title: `Chi tiết thay đổi: ${name}`, tone: 'info', body: [el('p', { class: 'muted' }, 'Dòng "Sửa a → b": a là giá trị ở bản cũ, b là giá trị ở bản mới.'), changes.total ? changesList(changes) : el('p', {}, 'Giống nhau.')], actions: [{ id: 'close', label: 'Đóng' }] });
  }

  // textA = older text, textB = newer text
  function diffNode(textA, textB) {
    if (textA === textB) return alert('ok', el('span', {}, 'Hai bản giống hệt nhau.'));
    let pa;
    let pb;
    try { pa = CX.parse(textA); pb = CX.parse(textB); } catch (e) {
      return alert('warn', el('span', {}, `Hai bản khác nhau nhưng không đọc được theo dạng SharedPreferences nên không liệt kê chi tiết (${e.message}).`));
    }
    const d = CX.diffEntries(pa, pb);
    if (!d.added.length && !d.removed.length && !d.changed.length) return alert('ok', el('span', {}, 'Các mục giống nhau (chỉ khác định dạng hoặc thứ tự).'));
    const needNames = [...d.added, ...d.removed, ...d.changed].some((n) => n.startsWith('map|'));
    const an = needNames ? CX.analyze(pa) : null;
    const bn = needNames ? CX.analyze(pb) : null;
    const labelFor = (name) => { const n = mapName(bn, name) || mapName(an, name); return n ? `${name} — ${n}` : name; };
    const val = (p, n) => CX.entryValue(p, n);
    const isJson = (n) => n.startsWith('map|') || n.startsWith('list|');
    const short80 = (v) => { const t = Array.isArray(v) ? v.join(', ') : String(v); return t.length > 80 ? `${t.slice(0, 80)}… (${t.length} ký tự)` : t; };
    const KIND = { added: ['Thêm', 'ok'], removed: ['Mất', 'danger'], changed: ['Đổi', 'warn'] };
    const row = (kind, name, extra) => el('tr', {}, el('td', { 'data-label': '' }, badge(KIND[kind][0], KIND[kind][1])), el('td', { class: 'mono' }, labelFor(name)), el('td', {}, extra));
    const detailBtn = (n) => el('button', { type: 'button', class: 'btn small', onclick: () => jsonDetail(n, val(pa, n), val(pb, n)) }, 'Chi tiết');
    const rows = [
      ...d.added.map((n) => row('added', n, isJson(n) ? fmtBytes(String(val(pb, n)).length) : short80(val(pb, n)))),
      ...d.removed.map((n) => row('removed', n, isJson(n) ? fmtBytes(String(val(pa, n)).length) : short80(val(pa, n)))),
      ...d.changed.map((n) => row('changed', n, isJson(n) ? [`${fmtBytes(String(val(pa, n)).length)} → ${fmtBytes(String(val(pb, n)).length)} `, detailBtn(n)] : `${short80(val(pa, n))} → ${short80(val(pb, n))}`)),
    ];
    return el('div', {}, el('div', { class: 'row' }, badge(`${d.added.length} thêm`, 'ok'), badge(`${d.removed.length} mất`, 'danger'), badge(`${d.changed.length} đổi`, 'warn'), badge(`${d.same} giữ nguyên`)),
      el('table', { class: 'stack' }, el('thead', {}, el('tr', {}, ['', 'Mục', 'Nội dung'].map((h) => el('th', {}, h)))), el('tbody', {}, rows)));
  }

  // ---- editing one preference file on the server (the phone only changes when it is restored from the app)
  async function openDbEditor(name) {
    const f = await api('GET', `/sync/databases/${enc(name)}`);
    if (textBytes(f.text) > EDIT_MAX_BYTES) { toast(`File lớn (${fmtBytes(textBytes(f.text))}) chỉ để xem và tải về, không sửa trên web.`, true); return; }
    state.dbEdit = { name, original: f.text, text: f.text, etag: f.etag, folder: f.folder || '' };
    state.view = 'files';
    await render();
  }

  async function dbHistory() {
    const e = state.dbEdit;
    const { versions } = await api('GET', `/sync/databases/${enc(e.name)}/history`);
    if (!versions.length) { toast('Chưa có bản cũ nào của file này.'); return; }
    const picked = await showModal({
      title: `Bản cũ của ${e.name}`, tone: 'info',
      body: el('p', { class: 'muted' }, `${versions.length} bản gần nhất. Chọn một bản để nạp vào ô soạn thảo (chưa lưu cho tới khi bạn bấm Lưu).`),
      actions: [{ id: null, label: 'Đóng' }, ...versions.map((v) => ({ id: v.version, label: `${clockDateTime(v.saved_at)} · ${fmtBytes(v.bytes)}` }))],
    });
    if (!picked) return;
    e.text = (await api('GET', `/sync/databases/${enc(e.name)}/history/${enc(picked)}`)).text;
    await render();
  }

  async function saveDbEdit() {
    const e = state.dbEdit;
    const bad = xmlProblem(e.text);
    if (bad) { toast(`XML chưa hợp lệ: ${bad}`, true); return; }
    const ok = await showModal({
      title: `Lưu thay đổi vào ${e.name}?`,
      body: [el('p', {}, `Server sẽ giữ bản hiện tại trong lịch sử (tối đa 10 bản) rồi thay bằng nội dung bạn vừa sửa (${fmtBytes(textBytes(e.text))}).`),
        el('h2', {}, 'Các thay đổi'), diffNode(e.original, e.text),
        alert('warn', webEditNote()),
        isSecret(e.name) ? alert('danger', el('span', {}, 'File này có thể là khóa riêng của app (ADB). Sửa sai có thể làm app mất quyền kết nối ADB.')) : null],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'save', label: 'Lưu vào server', primary: true }],
    });
    if (ok !== 'save') return;
    try {
      await api('PUT', `/sync/databases/${enc(e.name)}`, { text: e.text, etag: e.etag });
    } catch (err) {
      if (err.status === 409) { toast('File đã thay đổi từ lúc bạn mở (có thể app vừa đồng bộ). Bấm "Tải lại bản mới" rồi sửa lại.', true); state.dbEdit.stale = true; await render(); return; }
      throw err;
    }
    toast(`Đã lưu ${e.name}`);
    state.dbEdit = null;
    await render();
  }

  function viewDbEditor() {
    const e = state.dbEdit;
    setCrumbs([{ label: 'Tệp cài đặt', onclick: () => goTo('files') }, { label: `Sửa ${e.name}` }]);
    const status = el('p', { class: 'status', role: 'status' });
    const save = el('button', { type: 'button', class: 'btn primary', onclick: guard(saveDbEdit) }, icon('check'), 'Lưu vào server');
    const showStatus = () => {
      const p = xmlProblem(e.text);
      const d = dbDirty();
      status.className = `status ${p ? 'bad' : d ? 'ok' : ''}`;
      status.textContent = p ? `XML chưa hợp lệ: ${p}` : d ? 'XML hợp lệ, có thay đổi chưa lưu.' : 'Chưa có thay đổi.';
      save.disabled = !!p || !d;
    };
    const area = el('textarea', { class: 'editor mono', spellcheck: 'false', 'aria-label': `Nội dung ${e.name}`, oninput: (ev) => { e.text = ev.target.value; showStatus(); } });
    area.value = e.text;
    showStatus();
    return el('section', { class: 'card' }, el('div', { class: 'row' }, el('h2', {}, `Sửa ${e.name}`), isSecret(e.name) ? badge('Có thể là khóa riêng', 'danger') : null),
      el('p', {}, el('span', { class: 'muted' }, 'Thư mục trên máy: '), el('span', { class: 'mono' }, folderText(e))),
      alert('info', el('span', {}, 'Bạn đang sửa bản trên server, không phải file trên máy tính bảng: máy chỉ đổi khi bạn khôi phục từ app KeyMap Sync. XML sai cú pháp sẽ không được lưu; 10 bản cũ được giữ để quay lại.')),
      e.stale ? alert('danger', el('span', {}, 'File đã đổi trên server từ lúc bạn mở. '), el('button', { type: 'button', class: 'btn small', onclick: guard(() => openDbEditor(e.name)) }, 'Tải lại bản mới (bỏ thay đổi hiện tại)')) : null,
      area, status,
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn', onclick: guard(async () => { if (!dbEditDiscardOk()) return; state.dbEdit = null; await render(); }) }, 'Hủy'),
        el('button', { type: 'button', class: 'btn', onclick: guard(dbHistory) }, icon('history'), 'Bản cũ…'),
        el('button', { type: 'button', class: 'btn', disabled: !dbDirty(), onclick: () => showModal({ title: 'Thay đổi so với bản đang lưu', tone: 'info', body: diffNode(e.original, e.text), actions: [{ id: 'close', label: 'Đóng' }] }) }, 'Xem thay đổi'),
        el('button', { type: 'button', class: 'btn', onclick: guard(async () => { e.text = e.original; await render(); }) }, 'Hoàn tác về bản đang lưu'),
        save));
  }

  // Puts an older copy of a file back on the SERVER (any size). The tablet is not touched: use "Khôi phục theo ngày" in the app for that.
  async function restoreFromHistory(name, onDone) {
    const cur = await api('GET', `/sync/databases/${enc(name)}`);
    const { versions } = await api('GET', `/sync/databases/${enc(name)}/history`);
    if (!versions.length) { toast('Chưa có bản cũ nào của file này.'); return; }
    const picked = await showModal({
      title: `Bản cũ của ${name}`, tone: 'info',
      body: el('p', { class: 'muted' }, `${versions.length} bản gần nhất (mỗi lần file đổi, bản trước được giữ lại). Chọn một bản để xem thay đổi rồi khôi phục.`),
      actions: [{ id: null, label: 'Đóng' }, ...versions.map((v) => ({ id: v.version, label: `${clockDateTime(v.saved_at)} · ${fmtBytes(v.bytes)}` }))],
    });
    if (!picked) return;
    const old = await api('GET', `/sync/databases/${enc(name)}/history/${enc(picked)}`);
    const go = await showModal({
      title: `Khôi phục bản cũ của ${name}?`,
      body: [alert('warn', el('span', {}, 'File trên SERVER sẽ được thay bằng bản cũ này (bản hiện tại vẫn được giữ trong lịch sử). ', webEditNote())),
        el('h2', {}, 'Thay đổi so với bản đang lưu'), diffNode(cur.text, old.text)],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'go', label: 'Khôi phục bản này', primary: true }],
    });
    if (go !== 'go') return;
    try {
      await api('PUT', `/sync/databases/${enc(name)}`, { text: old.text, etag: cur.etag });
    } catch (e) {
      if (e.status === 409) { toast('File vừa đổi ở nơi khác (có thể app vừa đồng bộ). Hãy thử lại.', true); if (onDone) await onDone(); else await render(); return; }
      throw e;
    }
    toast(`Đã khôi phục bản cũ của ${name} trên server`);
    if (onDone) await onDone(); else await render();
  }
  // What every save on the page has to say about the tablet: it does not change by itself, and the server protects the edit meanwhile.
  function webEditNote() {
    return el('span', {}, 'Máy tính bảng KHÔNG đổi theo. Muốn đưa về máy, mở app KeyMap Sync → "Khôi phục theo ngày…" và chọn ngày hôm nay. '
      + 'Cho tới khi máy có đúng bản này, server sẽ KHÔNG nhận bản khác của file này từ máy (để bản cũ trên máy không ghi đè bản vừa sửa); app sẽ báo "bỏ qua". '
      + 'Muốn bỏ bản sửa và lấy bản của máy, bấm "Chấp nhận bản từ máy". Chưa kiểm chứng: app Gamwing có đọc lại file khôi phục hay tự ghi đè lại.');
  }

  // The tablet's copy is wanted after all: stop protecting the web edit, so the tablet's next push replaces it.
  async function acceptDeviceCopy(name, onDone) {
    const go = await showModal({
      title: `Chấp nhận bản từ máy cho ${name}?`, tone: 'warn',
      body: [el('p', {}, 'Bản sửa trên web vẫn nằm trong lịch sử của file (10 bản gần nhất). Từ giờ lần đẩy kế tiếp của máy sẽ thay bản trên server, kể cả khi nó cũ hơn bản bạn sửa.')],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'go', label: 'Chấp nhận bản từ máy', danger: true }],
    });
    if (go !== 'go') return;
    await api('DELETE', `/sync/databases/${enc(name)}/web-edit`);
    toast(`${name}: server sẽ nhận bản từ máy ở lần đẩy kế tiếp`);
    if (onDone) await onDone(); else await render();
  }

  window.Ui.webEditNote = webEditNote;
  window.Ui.acceptDeviceCopy = acceptDeviceCopy;
  window.Ui.restoreFromHistory = restoreFromHistory;
  window.Ui.diffNode = diffNode;

  // list of files with an inspector for the one picked
  async function viewFiles() {
    if (state.dbEdit) return viewDbEditor();
    const { files } = await api('GET', '/sync/databases');
    if (state.filePick && !files.some((f) => f.name === state.filePick)) state.filePick = '';

    const actionsFor = (f) => {
      const editable = f.bytes <= EDIT_MAX_BYTES;
      return [
        { label: 'Xem nội dung', icon: 'eye', onclick: guard(() => showFile(f.name)) },
        f.name === CACHE_FILE ? { label: 'Phân tích file này', icon: 'layers', onclick: () => goTo('analysis') }
          : { label: editable ? 'Sửa' : 'Sửa (file lớn: chỉ xem và tải)', icon: 'pencil', disabled: !editable, onclick: guard(() => openDbEditor(f.name)) },
        { label: 'Tải về', icon: 'download', onclick: guard(async () => { downloadText(f.name, (await api('GET', `/sync/databases/${enc(f.name)}`)).text); }) },
        { label: 'Lịch sử và khôi phục', icon: 'history', onclick: guard(() => restoreFromHistory(f.name)) },
        { separator: true },
        { label: 'Sao chép tên file', icon: 'copy', onclick: () => copyText(f.name, 'Đã sao chép tên file') },
      ];
    };
    const build = () => {
      const pick = files.find((f) => f.name === state.filePick);
      const rows = files.map((f) => {
        const select = () => { state.filePick = f.name; $('#app').replaceChildren(build()); labelStacked($('#app')); };
        return el('tr', { class: `pick${pick && pick.name === f.name ? ' active' : ''}`, tabindex: '0', onclick: select, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } } },
          el('td', {}, el('div', { class: 'name-cell' }, el('span', { class: 'name' }, f.name, f.web_edit ? badge('Sửa trên web, chưa xuống máy', 'warn', { title: `Sửa lúc ${clockDateTime(f.web_edit.at)}; server đang giữ bản này` }) : null))),
          el('td', { class: 'num col-size' }, fmtBytes(f.bytes)), el('td', { class: 'col-when muted' }, clockDateTime(f.updated_at)),
          el('td', { class: 'act' }, menuButton(actionsFor(f), { label: `Thao tác với ${f.name}` })));
      });
      const table = files.length
        ? el('table', { class: 'stack' }, el('thead', {}, el('tr', {}, ['File', 'Dung lượng', 'Cập nhật lúc', ''].map((h, i) => el('th', { class: i === 1 ? 'num' : '' }, h)))), el('tbody', {}, rows))
        : emptyState('inbox', 'Chưa có file nào', 'Mở app KeyMap Sync, đặt thư mục (mặc định Documents/jya2/databases) rồi bấm "Đẩy lên server".');
      const inspector = pick ? fileInspector(pick, actionsFor(pick)) : el('section', { class: 'card' }, emptyState('file', 'Chọn một file', 'để xem nơi lưu trên máy tính bảng và các thao tác.'));
      return el('div', {},
        pageHead('Tệp cài đặt', 'Các file XML app Gamwing lưu trên máy tính bảng. Server giữ bản mới nhất và 10 bản cũ của mỗi file.', el('span', { class: 'muted' }, `${files.length} file`)),
        el('div', { class: 'split' },
          el('div', {}, el('section', { class: 'card flush table-card' }, table),
            el('details', { class: 'disclosure' }, el('summary', {}, 'Lưu ý'),
              el('div', { class: 'disclosure-body muted' }, 'App KeyMap Sync gửi các file lên; server chép cả bộ vào thư mục của ngày sao lưu. File giấy phép / phiên đăng nhập bị từ chối. Sửa chỉ áp dụng cho bản trên server (file nhỏ), máy tính bảng chỉ đổi khi bạn khôi phục từ app.'))),
          el('aside', { class: 'inspector', 'aria-label': 'Chi tiết file' }, inspector)));
    };
    return build();
  }

  function fileInspector(f, items) {
    const by = (label) => items.find((i) => i.label && i.label.startsWith(label));
    const btn = (it, primary = false) => it && el('button', { type: 'button', class: `btn small${primary ? ' primary' : ''}`, disabled: it.disabled, onclick: it.onclick }, it.icon ? icon(it.icon) : null, it.label.replace(/ \(file lớn.*\)/, ''));
    return el('section', { class: 'card' },
      el('div', { class: 'row' }, el('h2', {}, f.name), isSecret(f.name) ? badge('Có thể là khóa riêng', 'danger') : null, f.bytes > EDIT_MAX_BYTES ? badge('File lớn: chỉ xem') : null),
      el('dl', { class: 'kv' },
        el('dt', {}, 'Dung lượng'), el('dd', {}, fmtBytes(f.bytes)),
        el('dt', {}, 'Cập nhật lúc'), el('dd', {}, clockDateTime(f.updated_at)),
        el('dt', {}, 'Gửi từ thiết bị'), el('dd', {}, f.device || '—'),
        el('dt', {}, 'Thư mục trên máy tính bảng'), el('dd', { class: 'mono' }, f.folder || '— (sẽ có sau lần đẩy kế tiếp của app 2.0)')),
      f.web_edit ? alert('warn', el('span', {}, `Bản trên server là bản sửa trên web lúc ${clockDateTime(f.web_edit.at)}, máy chưa có. Server không nhận bản khác từ máy cho tới khi máy khôi phục đúng bản này. `,
        el('button', { type: 'button', class: 'btn small', onclick: guard(() => acceptDeviceCopy(f.name)) }, 'Chấp nhận bản từ máy'))) : null,
      el('div', { class: 'row mt-4' }, btn(by('Xem'), true), btn(by('Phân tích') || by('Sửa')), btn(by('Tải về')), btn(by('Lịch sử'))));
  }

  // ---------------------------------------------------------------- compare two days (or a day and the latest copy)
  async function readSource(src, name) {
    return (src ? await api('GET', `/sync/backups/${src}/databases/${enc(name)}`) : await api('GET', `/sync/databases/${enc(name)}`)).text;
  }

  async function viewCompare() {
    const c = state.cmp;
    const [{ days }, { files }] = await Promise.all([api('GET', '/sync/backups'), api('GET', '/sync/databases')]);
    const withFiles = days.filter((d) => d.databases > 0);
    if (!files.some((f) => f.name === c.file)) c.file = (files.find((f) => f.name === CACHE_FILE) || files[0] || {}).name || '';
    if (c.a === null) c.a = (withFiles[1] || withFiles[0] || {}).date || '';
    if (c.a && !withFiles.some((d) => d.date === c.a)) c.a = '';
    if (c.b && !withFiles.some((d) => d.date === c.b)) c.b = '';
    const result = el('div', { 'aria-live': 'polite' }, emptyState('compare', 'Chưa so sánh', 'Chọn file và hai thời điểm rồi bấm "So sánh".'));
    const sources = (value, onchange, label) => el('select', { 'aria-label': label, onchange }, el('option', { value: '', selected: value === '' }, 'Bản mới nhất trên server'),
      withFiles.map((d) => el('option', { value: d.date, selected: d.date === value }, `Sao lưu ngày ${d.date}`)));
    const fileSel = el('select', { 'aria-label': 'File', onchange: (e) => { c.file = e.target.value; render(); } }, files.map((f) => el('option', { value: f.name, selected: f.name === c.file }, f.name)));
    const run = guard(async () => {
      result.replaceChildren(skeleton('page'));
      const [ta, tb] = await Promise.all([readSource(c.a, c.file), readSource(c.b, c.file)]);
      result.replaceChildren(diffNode(ta, tb));
      labelStacked(result);
    });
    const field = (label, control) => el('label', { class: 'numfield' }, label, control);
    return el('div', {},
      pageHead('So sánh ngày', 'Xem mục nào được thêm, mất hoặc đổi giữa hai thời điểm của một file.'),
      el('section', { class: 'card' },
        files.length ? el('div', { class: 'row' }, field('File', fileSel), field('Bản cũ', sources(c.a, (e) => { c.a = e.target.value; }, 'Bản cũ')), field('Bản mới', sources(c.b, (e) => { c.b = e.target.value; }, 'Bản mới')),
          el('button', { type: 'button', class: 'btn primary', disabled: !c.file, onclick: run }, icon('compare'), 'So sánh')) : emptyState('inbox', 'Chưa có file nào trên server')),
      el('section', { class: 'card' }, result));
  }

  // ---------------------------------------------------------------- daily backups (a timeline)
  // ---------------------------------------------------------------- "Kiểm tra đồng bộ": the server against its newest day, and the tablet against the server
  const SYNC_KIND = { different: ['Khác bản sao lưu', 'danger'], missing_in_day: ['Thiếu trong bản sao lưu', 'warn'], extra_in_day: ['Thừa trong bản sao lưu', 'warn'] };
  const sha8 = (h) => (h ? h.slice(0, 8) : '—');
  const sync = { server: null, app: null, timer: null };

  function serverResultNode(r) {
    if (r.reason === 'no_backup_day') return alert('warn', el('span', {}, 'Server chưa có ngày sao lưu nào để so sánh. Hãy đẩy file lên từ app trước.'));
    const head = r.ok
      ? alert('ok', el('span', {}, `Server đã đồng bộ: ${r.same}/${r.checked} file của bản mới nhất giống hệt bản sao lưu ngày ${r.day}. Kiểm tra lúc ${clockDateTime(r.at)}.`))
      : alert('danger', el('span', {}, `Server CHƯA đồng bộ với bản sao lưu ngày ${r.day}: ${r.same}/${r.checked} file giống, ${r.problems.length} vấn đề. Kiểm tra lúc ${clockDateTime(r.at)}.`));
    if (r.ok) return head;
    const rows = r.problems.map((p) => el('tr', {}, el('td', { class: 'mono' }, p.name), el('td', {}, badge(...SYNC_KIND[p.kind] || [p.kind, 'neutral'])),
      el('td', { class: 'mono' }, `bản mới nhất ${sha8(p.latest_sha256)} · ngày ${sha8(p.day_sha256)}`)));
    return el('div', {}, head, el('table', { class: 'stack' }, el('thead', {}, el('tr', {}, ['File', 'Vấn đề', 'Dấu vân tay (sha-256, 8 ký tự đầu)'].map((h) => el('th', {}, h)))), el('tbody', {}, rows)));
  }

  function appResultNode(cmd, devices) {
    if (!cmd.targets.length) return alert('warn', el('span', {}, 'Server chưa biết thiết bị nào, nên không có máy tính bảng để kiểm tra. Mở app KeyMap Sync trên máy tính bảng trước.'));
    const names = (l) => l.join(', ');
    const lines = cmd.targets.map((t) => {
      const r = cmd.results[t.id];
      const v = r && r.verify;
      const dev = devices.find((d) => d.id === t.id);
      if (!r) return alert('info', el('span', {}, `${t.name || t.id}: đang chờ máy trả lời${dev && !dev.online ? ' (máy đang ngắt kết nối: app KeyMap Sync cần đang bật Chạy ngầm)' : ' (khoảng 15 giây)'}…`));
      if (!v) return alert('warn', el('span', {}, `${t.name || t.id}: máy trả lời nhưng không có kết quả kiểm tra${r.error ? ` (${r.error})` : ''}.`));
      if (v.error) return alert('danger', el('span', {}, `${t.name || t.id}: không kiểm tra được: ${v.error}`));
      const ok = !v.different.length && !v.only_tablet.length && !v.only_server.length && !v.day_different.length;
      return alert(ok ? 'ok' : 'danger', el('div', {},
        el('b', {}, `${t.name || t.id}: ${ok ? 'đã đồng bộ' : 'CHƯA đồng bộ'}`), ` — ${v.same}/${v.checked} file trên máy giống bản mới nhất trên server; so với bản sao lưu ngày ${v.day || '(chưa có)'}. Lúc ${clockDateTime(r.at)}.`,
        v.different.length ? el('div', {}, 'Khác bản mới nhất trên server: ', el('span', { class: 'mono' }, names(v.different))) : null,
        v.only_tablet.length ? el('div', {}, 'Chỉ có trên máy: ', el('span', { class: 'mono' }, names(v.only_tablet))) : null,
        v.only_server.length ? el('div', {}, 'Chỉ có trên server: ', el('span', { class: 'mono' }, names(v.only_server))) : null,
        v.day_different.length ? el('div', {}, `Khác bản sao lưu ngày ${v.day}: `, el('span', { class: 'mono' }, names(v.day_different))) : null));
    });
    return el('div', {}, lines);
  }

  // The two buttons and their results (results stay on the page while it is open)
  function syncCard(autorun) {
    const serverOut = el('div', { 'aria-live': 'polite' });
    const appOut = el('div', { 'aria-live': 'polite' });
    const serverBtn = el('button', { type: 'button', class: 'btn' }, icon('check'), 'Kiểm tra đồng bộ trên server');
    const appBtn = el('button', { type: 'button', class: 'btn' }, icon('tablet'), 'Kiểm tra đồng bộ trên app');
    const runServer = guard(async () => {
      serverBtn.disabled = true;
      serverOut.replaceChildren(skeleton('page'));
      try { sync.server = await api('GET', '/sync/verify'); serverOut.replaceChildren(serverResultNode(sync.server)); labelStacked(serverOut); } finally { serverBtn.disabled = false; }
    });
    const showApp = async () => {
      const [{ commands }, { devices }] = await Promise.all([api('GET', '/cache/commands'), api('GET', '/sync/devices')]);
      const cmd = commands.find((c) => c.id === (sync.app && sync.app.id));
      if (!cmd) return null;
      appOut.replaceChildren(appResultNode(cmd, devices));
      return cmd;
    };
    const poll = (startedAt) => {
      clearInterval(sync.timer);
      sync.timer = setInterval(async () => {
        if (state.view !== 'backups' || !appOut.isConnected) { clearInterval(sync.timer); return; }
        const cmd = await showApp().catch(() => null);
        const waiting = cmd && cmd.targets.some((t) => !cmd.results[t.id]);
        if (!waiting || Date.now() - startedAt > 120000) clearInterval(sync.timer);
      }, 3000);
    };
    const runApp = guard(async () => {
      appBtn.disabled = true;
      try {
        const r = await api('POST', '/sync/verify-request', {});
        sync.app = { id: r.command.id };
        toast(r.command.targets ? `Đã gửi lệnh kiểm tra tới ${r.command.targets} thiết bị` : 'Chưa có thiết bị nào để kiểm tra', !r.command.targets);
        await showApp();
        if (r.command.targets) poll(Date.now());
      } finally { appBtn.disabled = false; }
    });
    serverBtn.addEventListener('click', runServer);
    appBtn.addEventListener('click', runApp);
    if (sync.server) serverOut.replaceChildren(serverResultNode(sync.server));
    if (sync.app) showApp().then((c) => { if (c && c.targets.some((t) => !c.results[t.id])) poll(Date.now()); });
    if (autorun === 'server') runServer();
    if (autorun === 'app') runApp();
    serverBtn.title = 'So bản mới nhất của từng file trên server với bản sao lưu của ngày mới nhất (dấu vân tay sha-256).';
    appBtn.title = 'Nhờ máy tính bảng tự so các file của nó với server. App KeyMap Sync trên máy phải đang bật Chạy ngầm.';
    return el('section', { class: 'card', 'aria-label': 'Kiểm tra đồng bộ' },
      el('div', { class: 'row' }, el('h2', {}, 'Kiểm tra đồng bộ'), serverBtn, appBtn),
      el('p', { class: 'muted' }, 'Kiểm tra bản mới nhất của các file có khớp với bản sao lưu hôm nay không, trên server hoặc trên máy tính bảng.'),
      serverOut, appOut);
  }

  async function viewBackups() {
    const { days } = await api('GET', '/sync/backups');
    const autorun = state.autorun || '';
    state.autorun = '';
    const item = (d, i) => el('li', { class: 't-item' }, el('span', { class: `t-dot ${i === 0 ? 'ok' : ''}`, 'aria-hidden': 'true' }),
      el('div', { class: 't-head' }, el('span', { class: 't-title' }, d.date), i === 0 ? badge('Mới nhất', 'ok') : null,
        d.databases ? el('button', { type: 'button', class: 'btn small ghost', onclick: guard(() => showDay(d.date)) }, icon('eye'), 'Xem file') : null),
      el('div', { class: 't-meta' }, `${d.databases} file · ${fmtBytes(d.bytes)} · cập nhật ${clockDateTime(d.updated_at)}${d.last_actor ? ` bởi ${d.last_actor}` : ''}`));
    return el('div', {},
      pageHead('Sao lưu theo ngày', 'Mỗi ngày một bản chứa cả bộ file. Khôi phục về máy: app Android → "Khôi phục theo ngày…".', el('span', { class: 'muted' }, `${days.length} ngày`)),
      syncCard(autorun),
      el('section', { class: 'card' }, days.length ? el('ol', { class: 'timeline' }, days.map(item)) : emptyState('clock', 'Chưa có bản sao lưu nào', 'Bản đầu tiên được tạo khi app gửi file lên.')));
  }

  async function showDay(day) {
    const { files } = await api('GET', `/sync/backups/${day}/databases`);
    const view = el('table', {}, el('thead', {}, el('tr', {}, ['File', 'Thư mục trên máy', 'Dung lượng', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, files.map((f) => el('tr', {}, el('td', { class: 'mono' }, f.name), el('td', { class: 'mono' }, folderText(f)), el('td', { class: 'num' }, fmtBytes(textBytes(f.text))),
        el('td', { class: 'act' }, el('button', { type: 'button', class: 'btn small', onclick: guard(() => showFile(f.name, day)) }, 'Xem'), ' ',
          el('button', { type: 'button', class: 'btn small', onclick: () => downloadText(f.name, f.text) }, 'Tải về'))))));
    await showModal({ title: `Sao lưu ngày ${day} (${files.length} file)`, tone: 'info', className: 'wide', body: view, actions: [{ id: 'close', label: 'Đóng' }] });
  }

  setupShell();
  pingPresence();
  setInterval(() => { if (document.visibilityState === 'visible') pingPresence(); }, 10_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { pingPresence(); refreshConn(); } });
  refreshConn();
  setInterval(refreshConn, 5_000);
  // the Devices tab refreshes itself (unless a dialog is open)
  setInterval(() => { if (state.view === 'devices' && !document.querySelector('.modal')) render(); }, 5_000);

  render();
})();
