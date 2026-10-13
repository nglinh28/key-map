'use strict';
// Admin page: the shell (sidebar, toolbar, command palette, theme) and the tabs "Tệp cài đặt", "So sánh ngày",
// "Sao lưu theo ngày", "Thiết bị". The tab "Phân tích cache" lives in analysis.js.
(() => {
  const { $, el, icon, fmtBytes, textBytes, clockTime, clockDateTime, toast, api, guard, showModal, changesList, downloadText,
    badge, alert, emptyState, menuButton, skeleton, setCrumbs, theme, copyText, labelStacked } = window.Ui;
  const CX = window.CacheXml;
  const EL = window.EditLib;

  const CACHE_FILE = 'gamwing_keymap_cache.xml';
  const EDIT_MAX_BYTES = 256 * 1024; // larger files (the keymap cache) are shown and downloaded, not edited here
  const PREVIEW_CHARS = 300000;
  const enc = encodeURIComponent;
  const state = { view: 'analysis', dbEdit: null, filePick: '', cmp: { file: CACHE_FILE, a: null, b: '' } };

  // ---------------------------------------------------------------- shell: sidebar navigation, toolbar, theme, command palette
  const VIEWS = [['analysis', 'Phân tích cache', 'layers'], ['files', 'Tệp cài đặt', 'file'], ['compare', 'So sánh ngày', 'compare'], ['backups', 'Sao lưu theo ngày', 'clock'], ['devices', 'Thiết bị', 'tablet']];
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
      type: 'button', 'aria-current': state.view === id ? 'page' : false, onclick: () => goTo(id),
    }, icon(ic), label)));
  }

  function setupShell() {
    $('#brand').replaceChildren(el('div', { class: 'logo' }, icon('grid')), el('span', {}, 'KeyMap'));
    const themeBtn = el('button', { type: 'button', class: 'btn icon', onclick: () => { const t = theme.cycle(); toast(`Giao diện: ${theme.label(t)}`); } });
    const paintTheme = () => { themeBtn.replaceChildren(icon(theme.icon())); themeBtn.title = `Giao diện: ${theme.label()} (bấm để đổi)`; themeBtn.setAttribute('aria-label', `Giao diện: ${theme.label()}. Bấm để đổi.`); };
    document.addEventListener('ft-theme', paintTheme);
    document.addEventListener('ft-goto', (e) => goTo(e.detail));
    paintTheme();
    $('#tools').replaceChildren(
      el('button', { type: 'button', class: 'btn', onclick: () => window.Palette.open(), 'aria-label': 'Tìm nhanh (Ctrl+K)' }, icon('search'), el('span', {}, 'Tìm nhanh'), el('kbd', {}, 'Ctrl K')),
      themeBtn);
    // what the palette can do apart from the cache items (analysis.js adds those)
    let fileCache = { at: 0, list: [] };
    window.Palette.register(() => VIEWS.map(([id, label, ic]) => ({ group: 'Chuyển tab', label, icon: ic, run: () => goTo(id) })));
    window.Palette.register(() => [
      { group: 'Thao tác', label: 'Đổi giao diện sáng / tối', hint: theme.label(), icon: theme.icon(), keywords: 'theme dark light', run: () => { const t = theme.cycle(); toast(`Giao diện: ${theme.label(t)}`); } },
      { group: 'Thao tác', label: 'Tải lại trang hiện tại', icon: 'refresh', keywords: 'reload refresh', run: () => render() },
    ]);
    window.Palette.register(async () => {
      if (Date.now() - fileCache.at > 20000) fileCache = { at: Date.now(), list: (await api('GET', '/sync/databases')).files };
      return fileCache.list.map((f) => ({ group: 'Tệp cài đặt', label: f.name, hint: fmtBytes(f.bytes), icon: 'file', keywords: f.folder || '', run: () => { state.filePick = f.name; goTo('files'); } }));
    });
  }

  let renderSeq = 0;
  async function render() {
    renderNav();
    const mine = ++renderSeq; // a slow tab (the 6 MB cache) must not overwrite the tab opened after it
    const app = $('#app');
    setCrumbs([{ label: labelOf(state.view) }]);
    app.setAttribute('aria-busy', 'true');
    const wait = setTimeout(() => { if (mine === renderSeq) app.replaceChildren(skeleton(state.view === 'analysis' || state.view === 'files' ? 'split' : 'page')); }, 150);
    let node;
    try {
      const view = { analysis: () => window.Analysis.view(), files: viewFiles, compare: viewCompare, backups: viewBackups, devices: viewDevices }[state.view];
      node = await view();
    } catch (e) { node = alert('danger', el('b', {}, 'Không tải được trang này'), el('span', {}, e.message)); }
    clearTimeout(wait);
    if (mine !== renderSeq) return;
    app.replaceChildren(node);
    app.removeAttribute('aria-busy');
    labelStacked(app);
    updateMeta();
  }

  async function updateMeta() {
    try {
      const i = await api('GET', '/sync/info');
      $('#meta').textContent = `${i.files} file · ${i.backup_days} ngày sao lưu · v${i.version}`;
    } catch { $('#meta').textContent = ''; }
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
    try {
      const { devices } = await api('GET', '/sync/devices');
      const online = devices.filter((d) => d.online);
      if (online.length) {
        const d = online[0];
        const last = (d.last_push && d.last_push.at) || d.last_seen;
        chip.className = 'conn on';
        chip.textContent = `${d.name}${online.length > 1 ? ` +${online.length - 1}` : ''} đang kết nối · ${d.auto_push ? 'tự đẩy bật' : 'tự đẩy tắt'} · đồng bộ lúc ${clockTime(last)}`;
      } else if (devices.length) {
        chip.className = 'conn off';
        chip.textContent = `Không có thiết bị nào đang kết nối (lần cuối: ${devices[0].name}, ${clockDateTime(devices[0].last_seen)})`;
      } else {
        chip.className = 'conn off';
        chip.textContent = 'Chưa có thiết bị nào kết nối';
      }
    } catch {
      chip.className = 'conn off';
      chip.textContent = 'Không liên lạc được với server';
    }
    chip.title = chip.textContent;
  }

  async function viewDevices() {
    const { devices, web } = await api('GET', '/sync/devices');
    const intro = el('p', { class: 'muted' }, 'Ứng dụng Android gửi nhịp "còn sống" mỗi 15 giây. Quá 40 giây không có nhịp thì coi là ngắt kết nối. '
      + `Trang web này cũng báo cho app biết (hiện có ${web.sessions} trang web đang mở).`);
    const cards = devices.map((d) => el('section', { class: `card device ${d.online ? 'on' : 'off'}` },
      el('div', { class: 'device-head row' }, el('span', { class: `dot ${d.online ? 'on' : 'off'}`, 'aria-hidden': 'true' }), el('h2', {}, d.name), d.model ? badge(d.model) : null,
        d.online ? badge('Đang kết nối', 'ok') : badge(`Ngắt kết nối · lần cuối ${clockDateTime(d.last_seen)}`), d.error ? badge('Có lỗi', 'danger') : null),
      el('dl', { class: 'kv' },
        el('dt', {}, 'Trạng thái'), el('dd', {}, STATE_VN[d.state] || d.state),
        el('dt', {}, 'Tự đẩy khi thư mục đổi'), el('dd', {}, d.auto_push ? 'Bật' : 'Tắt'),
        el('dt', {}, 'Thư mục theo dõi'), el('dd', { class: 'mono' }, d.folder || '—'),
        el('dt', {}, 'Địa chỉ mạng'), el('dd', { class: 'mono' }, d.ip || d.remote || '—'),
        el('dt', {}, 'Android / phiên bản app'), el('dd', {}, `${d.android || '—'} / ${d.app_version || '—'}`),
        el('dt', {}, 'Lần đẩy lên gần nhất'), el('dd', {}, d.last_push ? `${clockDateTime(d.last_push.at)} — lưu ${d.last_push.saved ?? 0} file mới/đổi, giữ nguyên ${d.last_push.unchanged ?? 0}, bỏ qua ${d.last_push.skipped ?? 0}` : 'chưa có'),
        el('dt', {}, 'Lần lấy bản sao lưu gần nhất'), el('dd', {}, d.last_pull ? `${clockDateTime(d.last_pull.at)} — ${d.last_pull.files} file` : 'chưa có'),
        el('dt', {}, 'Lỗi gần nhất'), el('dd', {}, d.error || '—'),
        el('dt', {}, 'Thấy lần đầu'), el('dd', {}, clockDateTime(d.first_seen))),
      el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn small danger', onclick: guard(async () => { if (!confirm(`Quên thiết bị "${d.name}"? Nó sẽ hiện lại nếu app kết nối lần nữa.`)) return; await api('DELETE', `/sync/devices/${d.id}`); await render(); refreshConn(); }) }, icon('trash'), 'Quên thiết bị'))));
    return el('div', {}, el('div', { class: 'page-head' }, el('h1', {}, 'Thiết bị')), intro,
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
        alert('warn', el('span', {}, 'Máy tính bảng KHÔNG đổi theo. Muốn đưa về máy, mở app KeyMap Sync → "Khôi phục theo ngày…" và chọn ngày hôm nay. Khi đó app Gamwing có thể ghi đè lại hoặc không đọc lại file; tôi chưa kiểm chứng.')),
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
      alert('warn', el('span', {}, 'Bạn đang sửa bản lưu trên server, không phải file trên máy tính bảng. Máy chỉ đổi khi bạn khôi phục từ app KeyMap Sync. Server chặn lưu khi XML sai cú pháp và giữ 10 bản cũ để quay lại.')),
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
  async function restoreFromHistory(name) {
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
      body: [alert('warn', el('span', {}, 'File trên SERVER sẽ được thay bằng bản cũ này (bản hiện tại vẫn được giữ trong lịch sử). Máy tính bảng KHÔNG đổi theo: muốn đưa về máy, dùng "Khôi phục theo ngày…" trong app.')),
        el('h2', {}, 'Thay đổi so với bản đang lưu'), diffNode(cur.text, old.text)],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'go', label: 'Khôi phục bản này', primary: true }],
    });
    if (go !== 'go') return;
    try {
      await api('PUT', `/sync/databases/${enc(name)}`, { text: old.text, etag: cur.etag });
    } catch (e) {
      if (e.status === 409) { toast('File vừa đổi ở nơi khác (có thể app vừa đồng bộ). Hãy thử lại.', true); await render(); return; }
      throw e;
    }
    toast(`Đã khôi phục bản cũ của ${name} trên server`);
    await render();
  }

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
          el('td', {}, el('div', { class: 'name-cell' }, el('span', { class: 'name mono' }, f.name), f.folder ? null : el('span', { class: 'sub' }, 'thư mục trên máy: chưa rõ'))),
          el('td', { class: 'mono col-where', title: f.folder || 'Chưa rõ: app KeyMap Sync 2.0 sẽ báo thư mục ở lần đẩy kế tiếp' }, folderText(f)),
          el('td', { class: 'num col-size' }, fmtBytes(f.bytes)), el('td', { class: 'mono col-when' }, clockDateTime(f.updated_at)),
          el('td', { class: 'act' }, menuButton(actionsFor(f), { label: `Thao tác với ${f.name}` })));
      });
      const table = files.length
        ? el('table', { class: 'stack' }, el('thead', {}, el('tr', {}, ['File', 'Thư mục trên máy', 'Dung lượng', 'Cập nhật lúc', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rows))
        : emptyState('inbox', 'Chưa có file nào', 'Mở app KeyMap Sync, đặt thư mục (mặc định Documents/jya2/databases) rồi bấm "Đẩy lên server".');
      const inspector = pick ? fileInspector(pick, actionsFor(pick)) : el('section', { class: 'card' }, emptyState('file', 'Chọn một file', 'để xem nơi lưu trên máy tính bảng và các thao tác.'));
      return el('div', {},
        el('div', { class: 'page-head' }, el('h1', {}, 'Tệp cài đặt'), badge(`${files.length} file`), el('span', { class: 'muted' }, 'Documents/jya2/databases')),
        el('p', { class: 'muted' }, 'Các file XML mà app Gamwing lưu trên máy. App KeyMap Sync gửi lên; server giữ bản mới nhất, 10 bản cũ của mỗi file, và chép cả bộ vào thư mục của ngày sao lưu. '
          + 'File giấy phép/phiên đăng nhập bị từ chối. Sửa chỉ áp dụng cho bản trên server (file nhỏ).'),
        el('div', { class: 'split' }, el('section', { class: 'card flush table-card' }, table), el('aside', { class: 'inspector', 'aria-label': 'Chi tiết file' }, inspector)));
    };
    return build();
  }

  function fileInspector(f, items) {
    const by = (label) => items.find((i) => i.label && i.label.startsWith(label));
    const btn = (it, primary = false) => it && el('button', { type: 'button', class: `btn small${primary ? ' primary' : ''}`, disabled: it.disabled, onclick: it.onclick }, it.icon ? icon(it.icon) : null, it.label.replace(/ \(file lớn.*\)/, ''));
    return el('section', { class: 'card' },
      el('div', { class: 'row' }, el('h2', { class: 'mono' }, f.name), isSecret(f.name) ? badge('Có thể là khóa riêng', 'danger') : null, f.bytes > EDIT_MAX_BYTES ? badge('File lớn: chỉ xem') : null),
      el('dl', { class: 'kv' },
        el('dt', {}, 'Thư mục trên máy tính bảng'), el('dd', { class: 'mono' }, f.folder || '— (chưa rõ: sẽ có sau lần đẩy kế tiếp của app 2.0)'),
        el('dt', {}, 'Gửi từ thiết bị'), el('dd', {}, f.device || '—'),
        el('dt', {}, 'Dung lượng'), el('dd', {}, fmtBytes(f.bytes)),
        el('dt', {}, 'Cập nhật lúc'), el('dd', {}, clockDateTime(f.updated_at))),
      el('div', { class: 'row' }, btn(by('Xem'), true), btn(by('Phân tích') || by('Sửa')), btn(by('Tải về')), btn(by('Lịch sử'))));
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
      el('div', { class: 'page-head' }, el('h1', {}, 'So sánh ngày')),
      el('section', { class: 'card' },
        el('p', { class: 'muted' }, 'Liệt kê mục nào thêm, mất hoặc đổi giữa hai thời điểm của một file. Với file cache keymap, mục đổi có nút "Chi tiết" để xem từng giá trị JSON thay đổi.'),
        files.length ? el('div', { class: 'row' }, field('File', fileSel), field('Bản cũ', sources(c.a, (e) => { c.a = e.target.value; }, 'Bản cũ')), field('Bản mới', sources(c.b, (e) => { c.b = e.target.value; }, 'Bản mới')),
          el('button', { type: 'button', class: 'btn primary', disabled: !c.file, onclick: run }, icon('compare'), 'So sánh')) : emptyState('inbox', 'Chưa có file nào trên server')),
      el('section', { class: 'card' }, result));
  }

  // ---------------------------------------------------------------- daily backups (a timeline)
  async function viewBackups() {
    const { days } = await api('GET', '/sync/backups');
    const item = (d, i) => el('li', { class: 't-item' }, el('span', { class: `t-dot ${i === 0 ? 'ok' : ''}`, 'aria-hidden': 'true' }),
      el('div', { class: 't-head' }, el('span', { class: 't-title mono' }, d.date), i === 0 ? badge('Mới nhất', 'ok') : null, badge(`${d.databases} file`), badge(fmtBytes(d.bytes)),
        d.databases ? el('button', { type: 'button', class: 'btn small', onclick: guard(() => showDay(d.date)) }, icon('eye'), 'Xem file') : null),
      el('div', { class: 't-meta' }, `Cập nhật ${clockDateTime(d.updated_at)}${d.last_actor ? ` bởi ${d.last_actor}` : ''}`));
    return el('div', {},
      el('div', { class: 'page-head' }, el('h1', {}, 'Sao lưu theo ngày'), badge(`${days.length} ngày`)),
      el('p', { class: 'muted' }, 'Mỗi ngày một thư mục (data/backups/<ngày>/databases) chứa cả bộ file như trên điện thoại. Trong ngày thì ghi đè bằng trạng thái mới nhất, sang ngày mới thì tạo thư mục mới. '
        + 'Ngày tính theo giờ Việt Nam. Khôi phục về máy: mở app Android → "Khôi phục theo ngày…" rồi chọn ngày.'),
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
