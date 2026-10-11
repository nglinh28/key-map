'use strict';
// Admin page: navigation and the tabs "Tệp cài đặt", "So sánh ngày", "Sao lưu theo ngày", "Thiết bị".
// The tab "Phân tích cache" lives in analysis.js.
(() => {
  const { $, el, fmtBytes, textBytes, clockTime, clockDateTime, toast, api, guard, showModal, brief, changesList, downloadText } = window.Ui;
  const CX = window.CacheXml;
  const EL = window.EditLib;

  const CACHE_FILE = 'gamwing_keymap_cache.xml';
  const EDIT_MAX_BYTES = 256 * 1024; // larger files (the keymap cache) are shown and downloaded, not edited here
  const PREVIEW_CHARS = 300000;
  const enc = encodeURIComponent;
  const state = { view: 'analysis', dbEdit: null, cmp: { file: CACHE_FILE, a: null, b: '' } };

  // ---------------------------------------------------------------- navigation
  const VIEWS = [['analysis', 'Phân tích cache'], ['files', 'Tệp cài đặt'], ['compare', 'So sánh ngày'], ['backups', 'Sao lưu theo ngày'], ['devices', 'Thiết bị']];
  const dbDirty = () => !!state.dbEdit && state.dbEdit.text !== state.dbEdit.original;
  const dbEditDiscardOk = () => !dbDirty() || confirm('Bỏ các thay đổi chưa lưu của file cài đặt?');

  function renderNav() {
    const nav = $('#nav');
    nav.replaceChildren(...VIEWS.map(([id, label]) => el('button', {
      'aria-current': state.view === id ? 'page' : false,
      onclick: () => { if (!dbEditDiscardOk()) return; state.dbEdit = null; window.Analysis.leave(); state.view = id; render(); },
    }, label)));
    const current = nav.querySelector('[aria-current="page"]');
    if (current) nav.scrollLeft = Math.max(0, current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2); // keep the open tab visible on a narrow screen
  }

  // Tables with class "stack" become one card per row on a phone; this copies each column title into its cells for that layout.
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

  let renderSeq = 0;
  async function render() {
    renderNav();
    const mine = ++renderSeq; // a slow tab (the 6 MB cache) must not overwrite the tab opened after it
    const app = $('#app');
    let node;
    try {
      const view = { analysis: () => window.Analysis.view(), files: viewFiles, compare: viewCompare, backups: viewBackups, devices: viewDevices }[state.view];
      node = await view();
    } catch (e) { node = el('p', { class: 'muted' }, `Lỗi: ${e.message}`); }
    if (mine !== renderSeq) return;
    app.replaceChildren(node);
    labelStacked(app);
    updateMeta();
  }

  async function updateMeta() {
    try {
      const i = await api('GET', '/sync/info');
      $('#meta').textContent = `${i.files} file cài đặt · ${i.backup_days} ngày sao lưu · v${i.version}`;
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
        chip.textContent = `● ${d.name}${online.length > 1 ? ` +${online.length - 1}` : ''} đang kết nối · ${d.auto_push ? 'tự đẩy bật' : 'tự đẩy tắt'} · đồng bộ lúc ${clockTime(last)}`;
        chip.title = chip.textContent;
      } else if (devices.length) {
        chip.className = 'conn off';
        chip.textContent = `○ Không có thiết bị nào đang kết nối (lần cuối: ${devices[0].name}, ${clockDateTime(devices[0].last_seen)})`;
      } else {
        chip.className = 'conn off';
        chip.textContent = '○ Chưa có thiết bị nào kết nối';
      }
    } catch {
      chip.className = 'conn off';
      chip.textContent = '○ Không liên lạc được với server';
    }
  }

  async function viewDevices() {
    const { devices, web } = await api('GET', '/sync/devices');
    const head = el('div', { class: 'card' }, el('h2', {}, 'Thiết bị đang kết nối'),
      el('p', { class: 'muted' }, 'Ứng dụng Android gửi nhịp "còn sống" mỗi 15 giây. Quá 40 giây không có nhịp thì coi là ngắt kết nối. '
        + `Trang web này cũng báo cho app biết (hiện có ${web.sessions} trang web đang mở).`),
      devices.length ? null : el('p', {}, 'Chưa có thiết bị nào. Mở app "KeyMap Sync" trên điện thoại, nhập địa chỉ server này là nó sẽ xuất hiện ở đây.'));
    const cards = devices.map((d) => el('div', { class: `card device ${d.online ? 'on' : 'off'}` },
      el('h2', {}, el('span', { class: `dot ${d.online ? 'on' : 'off'}` }, '●'), ` ${d.name} `, el('span', { class: 'muted' }, d.model ? `(${d.model})` : '')),
      el('p', { class: d.online ? 'ok-text' : 'muted' }, d.online ? 'Đang kết nối' : `Ngắt kết nối · lần cuối ${clockDateTime(d.last_seen)}`),
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
      el('button', { class: 'btn small danger', onclick: guard(async () => { if (!confirm(`Quên thiết bị "${d.name}"? Nó sẽ hiện lại nếu app kết nối lần nữa.`)) return; await api('DELETE', `/sync/devices/${d.id}`); await render(); refreshConn(); }) }, 'Quên thiết bị')));
    return el('div', {}, head, ...cards);
  }

  // ---------------------------------------------------------------- the preference files
  const isSecret = (name) => /adbkey/i.test(name);

  async function showFile(name, day) {
    const f = day ? await api('GET', `/sync/backups/${day}/databases/${enc(name)}`) : await api('GET', `/sync/databases/${enc(name)}`);
    const cut = f.text.length > PREVIEW_CHARS;
    const id = await showModal({
      title: `${name}${day ? ` — ngày ${day}` : ''}`, tone: isSecret(name) ? 'warn' : 'info',
      body: [isSecret(name) ? el('p', { class: 'warnbox' }, 'File này nhiều khả năng chứa khóa riêng của app (ADB). Server không có đăng nhập: ai trong mạng nội bộ cũng xem được trang này.') : null,
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
  function mapName(parsed, analysis, name) {
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
    if (textA === textB) return el('p', { class: 'ok-text' }, 'Hai bản giống hệt nhau.');
    let pa;
    let pb;
    try { pa = CX.parse(textA); pb = CX.parse(textB); } catch (e) {
      return el('p', { class: 'warnbox' }, `Hai bản khác nhau nhưng không đọc được theo dạng SharedPreferences nên không liệt kê chi tiết (${e.message}).`);
    }
    const d = CX.diffEntries(pa, pb);
    if (!d.added.length && !d.removed.length && !d.changed.length) return el('p', { class: 'ok-text' }, 'Các mục giống nhau (chỉ khác định dạng hoặc thứ tự).');
    const needNames = [...d.added, ...d.removed, ...d.changed].some((n) => n.startsWith('map|'));
    const an = needNames ? CX.analyze(pa) : null;
    const bn = needNames ? CX.analyze(pb) : null;
    const labelOf = (name) => { const n = mapName(pb, bn, name) || mapName(pa, an, name); return n ? `${name} — ${n}` : name; };
    const val = (p, n) => CX.entryValue(p, n);
    const isJson = (n) => n.startsWith('map|') || n.startsWith('list|');
    const short80 = (v) => { const t = Array.isArray(v) ? v.join(', ') : String(v); return t.length > 80 ? `${t.slice(0, 80)}… (${t.length} ký tự)` : t; };
    const row = (kind, name, extra) => el('tr', {}, el('td', {}, el('span', { class: `chg ${kind}` }, { added: 'Thêm', removed: 'Mất', changed: 'Đổi' }[kind])), el('td', { class: 'mono' }, labelOf(name)), el('td', {}, extra));
    const detailBtn = (n) => el('button', { class: 'btn small', onclick: () => jsonDetail(n, val(pa, n), val(pb, n)) }, 'Chi tiết');
    const rows = [
      ...d.added.map((n) => row('added', n, isJson(n) ? fmtBytes(String(val(pb, n)).length) : short80(val(pb, n)))),
      ...d.removed.map((n) => row('removed', n, isJson(n) ? fmtBytes(String(val(pa, n)).length) : short80(val(pa, n)))),
      ...d.changed.map((n) => row('changed', n, isJson(n) ? [`${fmtBytes(String(val(pa, n)).length)} → ${fmtBytes(String(val(pb, n)).length)} `, detailBtn(n)] : `${short80(val(pa, n))} → ${short80(val(pb, n))}`)),
    ];
    return el('div', {}, el('p', {}, `${d.added.length} thêm · ${d.removed.length} mất · ${d.changed.length} đổi · ${d.same} giữ nguyên`),
      el('table', { class: 'stack' }, el('thead', {}, el('tr', {}, ['', 'Mục', 'Nội dung'].map((h) => el('th', {}, h)))), el('tbody', {}, rows)));
  }

  // ---- editing one preference file on the server (the phone only changes when it is restored from the app)
  async function openDbEditor(name) {
    const f = await api('GET', `/sync/databases/${enc(name)}`);
    if (textBytes(f.text) > EDIT_MAX_BYTES) { toast(`File lớn (${fmtBytes(textBytes(f.text))}) chỉ để xem và tải về, không sửa trên web.`, true); return; }
    state.dbEdit = { name, original: f.text, text: f.text, etag: f.etag };
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
        el('p', { class: 'warnbox' }, 'Máy tính bảng KHÔNG đổi theo. Muốn đưa về máy, mở app KeyMap Sync → "Khôi phục theo ngày…" và chọn ngày hôm nay. Khi đó app Gamwing có thể ghi đè lại hoặc không đọc lại file; tôi chưa kiểm chứng.'),
        isSecret(e.name) ? el('p', { class: 'warnbox strong' }, 'File này có thể là khóa riêng của app (ADB). Sửa sai có thể làm app mất quyền kết nối ADB.') : null],
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
    const status = el('p', { class: 'status', role: 'status' });
    const save = el('button', { class: 'btn primary', onclick: guard(saveDbEdit) }, 'Lưu vào server');
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
    return el('div', { class: 'card' }, el('h2', {}, `Sửa ${e.name}`),
      el('p', { class: 'warnbox' }, 'Bạn đang sửa bản lưu trên server, không phải file trên máy tính bảng. Máy chỉ đổi khi bạn khôi phục từ app KeyMap Sync. '
        + 'Server chặn lưu khi XML sai cú pháp và giữ 10 bản cũ để quay lại.'),
      e.stale ? el('p', { class: 'warnbox strong' }, 'File đã đổi trên server từ lúc bạn mở.', ' ', el('button', { class: 'btn small', onclick: guard(() => openDbEditor(e.name)) }, 'Tải lại bản mới (bỏ thay đổi hiện tại)')) : null,
      area, status,
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: guard(async () => { if (!dbEditDiscardOk()) return; state.dbEdit = null; await render(); }) }, 'Hủy'),
        el('button', { class: 'btn', onclick: guard(dbHistory) }, 'Bản cũ…'),
        el('button', { class: 'btn', disabled: !dbDirty(), onclick: () => showModal({ title: 'Thay đổi so với bản đang lưu', tone: 'info', body: diffNode(e.original, e.text), actions: [{ id: 'close', label: 'Đóng' }] }) }, 'Xem thay đổi'),
        el('button', { class: 'btn', onclick: guard(async () => { e.text = e.original; await render(); }) }, 'Hoàn tác về bản đang lưu'),
        save));
  }

  async function viewFiles() {
    if (state.dbEdit) return viewDbEditor();
    const { files } = await api('GET', '/sync/databases');
    const rows = files.length ? files.map((f) => el('tr', {},
      el('td', { class: 'mono' }, f.name), el('td', { class: 'num' }, fmtBytes(f.bytes)), el('td', { class: 'mono' }, clockDateTime(f.updated_at)),
      el('td', { class: 'act' },
        el('button', { class: 'btn small', onclick: guard(() => showFile(f.name)) }, 'Xem'), ' ',
        f.name === CACHE_FILE
          ? el('button', { class: 'btn small', onclick: () => { state.view = 'analysis'; render(); } }, 'Phân tích')
          : el('button', { class: 'btn small', disabled: f.bytes > EDIT_MAX_BYTES, title: f.bytes > EDIT_MAX_BYTES ? 'File lớn: chỉ xem và tải về' : '', onclick: guard(() => openDbEditor(f.name)) }, 'Sửa'), ' ',
        el('button', { class: 'btn small', onclick: guard(async () => { downloadText(f.name, (await api('GET', `/sync/databases/${enc(f.name)}`)).text); }) }, 'Tải về'))))
      : el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'Chưa có file nào. Mở app KeyMap Sync, đặt thư mục (mặc định Documents/jya2/databases) rồi bấm "Đẩy lên server".'));
    return el('div', { class: 'card' }, el('h2', {}, 'Tệp cài đặt của Gamwing (Documents/jya2/databases)'),
      el('p', { class: 'muted' }, 'Các file XML mà app Gamwing lưu trên máy. App KeyMap Sync gửi lên; server giữ bản mới nhất, 10 bản cũ của mỗi file, và chép cả bộ vào thư mục của ngày sao lưu. '
        + 'File giấy phép/phiên đăng nhập bị từ chối. Sửa chỉ áp dụng cho bản trên server (file nhỏ); đưa về máy làm từ app Android: "Khôi phục theo ngày…".'),
      el('table', { class: 'stack' }, el('thead', {}, el('tr', {}, ['File', 'Dung lượng', 'Cập nhật lúc', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rows)));
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
    const result = el('div', {});
    const sources = (value, onchange, label) => el('select', { 'aria-label': label, onchange }, el('option', { value: '', selected: value === '' }, 'Bản mới nhất trên server'),
      withFiles.map((d) => el('option', { value: d.date, selected: d.date === value }, `Sao lưu ngày ${d.date}`)));
    const fileSel = el('select', { 'aria-label': 'File', onchange: (e) => { c.file = e.target.value; render(); } }, files.map((f) => el('option', { value: f.name, selected: f.name === c.file }, f.name)));
    const run = guard(async () => {
      result.replaceChildren(el('p', { class: 'muted' }, 'Đang so sánh…'));
      const [ta, tb] = await Promise.all([readSource(c.a, c.file), readSource(c.b, c.file)]);
      result.replaceChildren(diffNode(ta, tb));
      labelStacked(result);
    });
    const card = el('div', { class: 'card' }, el('h2', {}, 'So sánh một file giữa hai thời điểm'),
      el('p', { class: 'muted' }, 'Liệt kê mục nào thêm, mất hoặc đổi. Với file cache keymap, mục đổi có nút "Chi tiết" để xem từng giá trị JSON thay đổi.'),
      withFiles.length || files.length ? el('div', { class: 'row' }, el('label', {}, 'File: '), fileSel) : el('p', { class: 'muted' }, 'Chưa có file nào trên server.'),
      el('div', { class: 'row' }, el('label', {}, 'Cũ: '), sources(c.a, (e) => { c.a = e.target.value; }, 'Bản cũ'), el('label', {}, 'Mới: '), sources(c.b, (e) => { c.b = e.target.value; }, 'Bản mới'),
        el('button', { class: 'btn primary', disabled: !c.file, onclick: run }, 'So sánh')),
      result);
    return card;
  }

  // ---------------------------------------------------------------- daily backups
  async function viewBackups() {
    const { days } = await api('GET', '/sync/backups');
    const rows = days.length ? days.map((d) => el('tr', {},
      el('td', { class: 'mono' }, d.date), el('td', { class: 'num' }, d.databases), el('td', { class: 'num' }, fmtBytes(d.bytes)),
      el('td', { class: 'mono' }, clockDateTime(d.updated_at)), el('td', {}, d.last_actor || '—'),
      el('td', { class: 'act' }, d.databases ? el('button', { class: 'btn small', onclick: guard(() => showDay(d.date)) }, 'Xem file') : null)))
      : el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Chưa có bản sao lưu nào. Bản đầu tiên được tạo khi app gửi file lên.'));
    return el('div', { class: 'card' }, el('h2', {}, 'Sao lưu theo ngày'),
      el('p', { class: 'muted' }, 'Mỗi ngày một thư mục (data/backups/<ngày>/databases) chứa cả bộ file như trên điện thoại. Trong ngày thì ghi đè bằng trạng thái mới nhất, sang ngày mới thì tạo thư mục mới. '
        + 'Ngày tính theo giờ Việt Nam. Khôi phục về máy: mở app Android → "Khôi phục theo ngày…" rồi chọn ngày.'),
      el('table', { class: 'stack' }, el('thead', {}, el('tr', {}, ['Ngày', 'Số file', 'Dung lượng', 'Cập nhật lúc', 'Cập nhật bởi', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rows)));
  }

  async function showDay(day) {
    const { files } = await api('GET', `/sync/backups/${day}/databases`);
    const view = el('table', {}, el('thead', {}, el('tr', {}, ['File', 'Dung lượng', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, files.map((f) => el('tr', {}, el('td', { class: 'mono' }, f.name), el('td', { class: 'num' }, fmtBytes(textBytes(f.text))),
        el('td', { class: 'act' }, el('button', { class: 'btn small', onclick: guard(() => showFile(f.name, day)) }, 'Xem'), ' ',
          el('button', { class: 'btn small', onclick: () => downloadText(f.name, f.text) }, 'Tải về'))))));
    await showModal({ title: `Sao lưu ngày ${day} (${files.length} file)`, tone: 'info', body: view, actions: [{ id: 'close', label: 'Đóng' }] });
  }

  pingPresence();
  setInterval(() => { if (document.visibilityState === 'visible') pingPresence(); }, 10_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { pingPresence(); refreshConn(); } });
  refreshConn();
  setInterval(refreshConn, 5_000);
  // the Devices tab refreshes itself (unless a dialog is open)
  setInterval(() => { if (state.view === 'devices' && !document.querySelector('.modal')) render(); }, 5_000);

  render();
})();
