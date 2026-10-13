'use strict';
// Tab "Phân tích cache": reads gamwing_keymap_cache.xml from the server and shows what is inside it.
// Key maps and AI recognition maps are drawn on a screen, recoil configs are analysed per gun (read-only).
// Items can be deleted: from the file on the server at once, and on the tablet by the app (a command it picks up).
(() => {
  const { $, el, svgEl, icon, fmtBytes, short, textBytes, clockDateTime, toast, api, guard, showModal, badge, alert, emptyState, segmented, menuButton, skeleton, setCrumbs, copyText, labelStacked } = window.Ui;
  const CX = window.CacheXml;
  const LL = window.LayoutLib;
  const RL = window.RecoilLib;
  const CACHE_FILE = 'gamwing_keymap_cache.xml';
  const REFS_FILE = 'ft_map_server_v1.xml'; // also writes the ids of the documents it knows
  const KIND_VN = { keymap: 'Sơ đồ phím', recognition: 'Nhận diện AI', recoil: 'Độ giật / Cấu hình', unknown: 'Không rõ' };

  // data: the loaded file and its analysis; pick: the row selected in the list (shown in the inspector);
  // sel: the item opened in the viewer { id, kind, ns, label }; refs: id -> where else the id is written
  const S = { src: '', days: [], data: null, error: '', pick: '', sel: null, refs: new Map(), cmds: [], pending: '' };
  const lay = { screenId: null, origin: 'topleft', custom: { w: 2960, h: 1848 }, bg: { url: null, opacity: 0.5 }, selected: null };
  const rc = { mode: 'touch', weapon: RL.WEAPONS.indexOf('AUG'), scope: 1, gesture: 0, showAll: false, picked: null, docId: null, idx: null };

  let active = false; // false once another tab is open: a slow reload must not draw over it
  let pollTimer = null;
  const redraw = () => {
    if (!active) return;
    const y = window.scrollY;
    const app = $('#app');
    app.replaceChildren(draw());
    labelStacked(app);
    window.scrollTo(0, y);
  };
  const latest = () => S.src === '';

  async function loadRefs(day) {
    S.refs = new Map();
    try {
      const name = encodeURIComponent(REFS_FILE);
      const f = await api('GET', day ? `/sync/backups/${day}/databases/${name}` : `/sync/databases/${name}`);
      for (const e of CX.parse(f.text).entries) {
        const m = e.tag === 'string' ? /^document\|[^|]*\|(.+)$/.exec(e.name) : null;
        if (!m) continue;
        if (!S.refs.has(m[1])) S.refs.set(m[1], []);
        S.refs.get(m[1]).push({ entry: e.name, ns: e.value });
      }
    } catch { /* the file may simply not exist */ }
  }

  async function loadCommands() {
    try { S.cmds = (await api('GET', '/cache/commands')).commands; } catch { S.cmds = []; }
  }

  async function load() {
    S.error = '';
    S.data = null;
    S.days = (await api('GET', '/sync/backups')).days.filter((d) => d.databases > 0);
    if (S.src && !S.days.some((d) => d.date === S.src)) S.src = '';
    const name = encodeURIComponent(CACHE_FILE);
    try {
      const file = await api('GET', S.src ? `/sync/backups/${S.src}/databases/${name}` : `/sync/databases/${name}`);
      const t0 = performance.now();
      const parsed = CX.parse(file.text);
      S.data = { file, parsed, analysis: CX.analyze(parsed), ms: Math.round(performance.now() - t0) };
      await Promise.all([loadRefs(S.src), loadCommands()]);
    } catch (e) {
      if (e.status === 404) S.error = S.src ? `Ngày ${S.src} không có file ${CACHE_FILE}.` : `Server chưa có file ${CACHE_FILE}. Mở app KeyMap Sync, kiểm tra thư mục Documents/jya2/databases rồi bấm "Đẩy lên server".`;
      else S.error = e.message;
    }
    if (S.sel && !(S.data && (S.data.analysis.docs.has(S.sel.id)))) S.sel = null;
    if (S.pending && S.data) { S.pick = S.pending; S.sel = null; }
    S.pending = '';
    if (S.pick && !(S.data && itemInfo(S.pick))) S.pick = '';
  }

  // ---------------------------------------------------------------- where an item is stored
  const folderOf = () => (S.data && S.data.file.folder) || '';
  const NO_FOLDER = '— (chưa rõ: sẽ có sau lần đẩy kế tiếp của app 2.0)';

  // Everything the page knows about one item, or null
  function itemInfo(id) {
    const a = S.data && S.data.analysis;
    if (!a) return null;
    for (const n of a.namespaces) {
      const it = n.items.find((x) => x.id === id);
      if (!it) continue;
      const others = n.items.filter((x) => x.id !== id);
      return { id, label: it.dataName || it.listName || '(không tên)', listName: it.listName, kind: n.kind, ns: n.ns, listed: true, selected: n.selected === id, addTime: it.addTime, hasMap: it.hasMap, bytes: it.bytes, nameMismatch: it.nameMismatch,
        nextSelected: others[0] ? (others[0].dataName || others[0].listName || short(others[0].id)) : '' };
    }
    const o = a.orphans.find((x) => x.id === id);
    if (!o) return null;
    return { id, label: o.name || short(id), listName: '', kind: o.kind, ns: '', listed: false, selected: false, addTime: '', hasMap: true, bytes: o.bytes, nameMismatch: false, nextSelected: '' };
  }

  const itemFlags = (it) => {
    const flags = [];
    if (it.listed && !it.hasMap) flags.push(badge('thiếu nội dung', 'warn', { title: 'Có trong danh sách nhưng không có nội dung map|…' }));
    if (it.nameMismatch) flags.push(badge('tên lệch', 'warn', { title: `Tên trong danh sách: ${it.listName}` }));
    if (!it.listed) flags.push(badge('mồ côi', 'warn', { title: 'Có nội dung nhưng không nằm trong danh sách nào' }));
    if (S.refs.has(it.id)) flags.push(badge(`có ở ${REFS_FILE}`, 'info', { title: S.refs.get(it.id).map((r) => `${REFS_FILE} › ${r.entry}`).join('\n') }));
    return flags;
  };

  // ---------------------------------------------------------------- deleting items (here and, through the app, on the tablet)
  async function startDelete(ids) {
    if (!latest()) { toast('Chỉ xóa được khi đang xem "Mới nhất", không xóa trong bản sao lưu cũ.', true); return; }
    const items = ids.map(itemInfo).filter(Boolean);
    if (!items.length) return;
    const { devices } = await api('GET', '/sync/devices');
    const refs = items.flatMap((i) => (S.refs.get(i.id) || []).map((r) => ({ ...r, id: i.id })));
    const targets = devices.length
      ? el('p', {}, 'Máy tính bảng nhận lệnh: ', devices.map((d) => `${d.name} (${d.online ? 'đang kết nối' : 'đang ngắt, sẽ nhận khi app chạy lại'})`).join('; '))
      : alert('danger', el('span', {}, 'Server chưa biết thiết bị nào, nên chỉ xóa được trên server. Máy tính bảng sẽ KHÔNG bị xóa.'));
    const list = el('ul', {}, items.map((i) => el('li', {},
      el('b', {}, i.label), ` — ${KIND_VN[i.kind] || 'Không rõ'} · `, el('span', { class: 'mono' }, `map|${i.id}`), ` · ${fmtBytes(i.bytes)}`,
      el('div', { class: 'muted' }, i.listed ? `đang nằm trong danh sách list|${i.ns}: sẽ bị bỏ khỏi danh sách` : 'mục mồ côi: không nằm trong danh sách nào'),
      i.selected ? alert('danger', el('span', {}, i.nextSelected ? `Đang là bản được chọn trong app. Sau khi xóa, danh sách sẽ chọn «${i.nextSelected}».` : 'Đang là bản được chọn và là bản duy nhất của loại này: sau khi xóa danh sách sẽ trống, không còn bản nào được chọn.')) : null)));
    const what = el('details', { class: 'disclosure', open: true }, el('summary', {}, 'Việc sẽ xảy ra'),
      el('div', { class: 'disclosure-body' }, el('ol', {},
        el('li', {}, 'Server: cắt các mục trên khỏi ', el('span', { class: 'mono' }, CACHE_FILE), ' ngay bây giờ. Bản trước được giữ trong lịch sử của file (10 bản gần nhất).'),
        el('li', {}, `Máy tính bảng: app KeyMap Sync nhận lệnh trong khoảng 15 giây (khi app đang mở hoặc đang bật Tự đẩy), tự sửa file ${CACHE_FILE} trên máy, `
          + 'sau khi chép file cũ vào Documents/FTKeymapSync/backup/<thời gian>/databases/. Không hỏi lại trên máy.'))));
    const first = await showModal({
      title: `Xóa ${items.length} mục?`, tone: 'warn', step: 'Bước 1/2 · Kiểm tra',
      body: [list, what, targets,
        alert('warn', el('span', {}, 'Hãy ĐÓNG HẲN Gamwing trên máy tính bảng trước. Nếu Gamwing đang chạy nó có thể ghi đè lại file và mục bị xóa sẽ hiện lại; app sẽ kiểm tra lại sau vài giây và báo ở đây nếu điều đó xảy ra.')),
        el('p', { class: 'muted' }, 'Không xóa các dòng khác: '
          + (refs.length ? `${refs.length} dòng ghi id này ở ${REFS_FILE} (${refs.map((r) => `document|…|${short(r.id)}`).join(', ')}) vẫn được giữ; ` : '')
          + 'bản chép dạng .json (nếu có) ở Documents/Gamwing/keymap_cache cũng không bị xóa. Gamwing có thể tải lại mục nếu nó đồng bộ lại từ server keymap của nó.')],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'next', label: 'Tiếp tục…', primary: true }],
    });
    if (first !== 'next') return;
    const last = await showModal({
      title: `Xóa vĩnh viễn ${items.length} mục?`, tone: 'error', step: 'Bước 2/2 · Xác nhận lần cuối',
      body: [el('p', {}, 'Bạn sắp xóa ', items.map((i) => `«${i.label}»`).join(', '), ' khỏi server VÀ khỏi máy tính bảng.'),
        alert('danger', el('span', {}, 'Trên máy tính bảng không có nút hoàn tác: chỉ lấy lại được từ file cũ app đã chép vào Documents/FTKeymapSync/backup. Trên server còn bản cũ trong lịch sử của file.'))],
      actions: [{ id: 'cancel', label: 'Hủy, giữ lại' }, { id: 'go', label: `Xóa vĩnh viễn ${items.length} mục`, danger: true }],
    });
    if (last !== 'go') return;
    try {
      const r = await api('POST', '/cache/delete', { file: CACHE_FILE, ids, etag: S.data.file.etag, labels: items.map((i) => i.label) });
      toast(`Đã xóa trên server${r.command.targets ? `; đã gửi lệnh tới ${r.command.targets} thiết bị` : '; chưa có thiết bị nào để gửi lệnh'}.`);
    } catch (e) {
      if (e.status === 409) { toast('File vừa được cập nhật ở nơi khác (có thể app vừa đồng bộ). Đã tải lại, hãy kiểm tra rồi xóa lại.', true); }
      else throw e;
    }
    S.sel = null;
    S.pick = '';
    await refresh();
  }

  const deleteButton = (ids, label = 'Xóa', cls = 'btn small danger') => el('button', {
    type: 'button', class: cls, disabled: !latest(), title: latest() ? 'Xóa trên server và trên máy tính bảng' : 'Chỉ xóa được ở "Mới nhất"',
    onclick: guard((e) => { e.stopPropagation(); return startDelete(ids); }),
  }, icon('trash'), label);

  // ---------------------------------------------------------------- the commands left for the tablet (a timeline)
  const CMD_VN = { pending: 'Chờ máy tính bảng nhận', done: 'Đã xóa trên máy tính bảng', attention: 'Cần xem lại', server_only: 'Chỉ xóa trên server', expired: 'Hết hạn' };
  const CMD_TONE = { pending: 'accent', done: 'ok', attention: 'warn', server_only: 'neutral', expired: 'neutral' };

  // what one device answered (or "not yet")
  function resultLine(t, r) {
    if (!r) return el('div', { class: 't-meta' }, `${t.name || t.id}: chưa nhận`);
    const bits = [`đã xóa ${r.removed.length}`];
    if (r.missing.length) bits.push(`${r.missing.length} không còn trên máy`);
    if (r.skipped.length) bits.push(`bỏ qua ${r.skipped.length} (${r.skipped.map((s) => s.reason).join('; ')})`);
    if (r.reappeared.length) bits.push(`⚠ ${r.reappeared.length} mục HIỆN LẠI sau khi xóa: Gamwing có thể đã ghi đè file, hãy đóng Gamwing rồi xóa lại`);
    if (r.error) bits.push(`lỗi: ${r.error}`);
    return el('div', { class: `t-meta${r.reappeared.length || r.error ? ' bad' : ''}` }, `${t.name || t.id} · ${clockDateTime(r.at)}: ${bits.join(', ')}`);
  }

  function commandItem(c) {
    const names = (c.labels && c.labels.length ? c.labels : c.ids.map(short)).join(', ');
    return el('li', { class: 't-item' }, el('span', { class: `t-dot ${CMD_TONE[c.status] === 'neutral' ? '' : CMD_TONE[c.status]}`, 'aria-hidden': 'true' }),
      el('div', { class: 't-head' }, badge(CMD_VN[c.status] || c.status, CMD_TONE[c.status] || 'neutral'), el('span', { class: 't-meta' }, clockDateTime(c.created_at))),
      el('div', { class: 't-title' }, names),
      el('div', { class: 't-body' }, c.targets.map((t) => resultLine(t, c.results[t.id]))));
  }

  function commandsNode() {
    const cmds = S.cmds.slice(0, 5);
    return el('section', { class: 'card', 'aria-label': 'Lệnh xóa gần đây' }, el('h2', {}, 'Lệnh xóa gần đây'),
      cmds.length ? el('ol', { class: 'timeline' }, cmds.map(commandItem))
        : emptyState('clock', 'Chưa có lệnh nào', 'Khi bạn xóa một mục, lệnh gửi cho máy tính bảng sẽ hiện ở đây.'),
      cmds.length ? el('p', { class: 'muted' }, 'App KeyMap Sync nhận lệnh khi gửi nhịp 15 giây (cần app đang mở hoặc đang bật Tự đẩy).') : null);
  }

  function pollCommands(slot) {
    clearInterval(pollTimer);
    pollTimer = null;
    if (!S.cmds.some((c) => c.status === 'pending')) return;
    pollTimer = setInterval(async () => {
      if (!active || document.querySelector('.modal')) return;
      await loadCommands();
      if (slot.isConnected) slot.replaceChildren(commandsNode());
      if (!S.cmds.some((c) => c.status === 'pending')) { clearInterval(pollTimer); pollTimer = null; }
    }, 4000);
  }

  // ---------------------------------------------------------------- list: groups of rows and the inspector
  function sourceControl() {
    const options = [{ value: '', label: 'Mới nhất' }, ...S.days.map((x) => ({ value: x.date, label: x.date.slice(5).replace('-', '/') }))];
    const change = guard(async (v) => { S.src = v; S.sel = null; S.pick = ''; await refresh(); });
    if (options.length <= 5) return segmented({ label: 'Nguồn dữ liệu', options, value: S.src, onchange: change });
    return el('select', { 'aria-label': 'Nguồn dữ liệu', onchange: (e) => change(e.target.value) }, options.map((o) => el('option', { value: o.value, selected: o.value === S.src }, o.value ? `Sao lưu ngày ${o.value}` : 'Bản mới nhất trên server')));
  }

  function pageHead() {
    const d = S.data;
    const srcLabel = el('span', { class: 'muted' }, 'Nguồn:');
    const refreshBtn = el('button', { type: 'button', class: 'btn small', onclick: guard(refresh) }, icon('refresh'), 'Tải lại');
    if (!d) return el('div', { class: 'page-head' }, el('h1', {}, 'Phân tích cache'), srcLabel, sourceControl(), refreshBtn);
    const a = d.analysis;
    const total = a.namespaces.reduce((n, x) => n + x.items.length, 0);
    return el('div', {},
      el('div', { class: 'page-head' }, el('h1', {}, 'Phân tích cache'), srcLabel, sourceControl(), refreshBtn,
        el('div', { class: 'summary' }, badge(fmtBytes(d.file.bytes ?? textBytes(d.file.text))), badge(`${total} mục`), badge(`${a.orphans.length} mồ côi`, a.orphans.length ? 'warn' : 'neutral'))),
      el('p', { class: 'muted' }, el('span', { class: 'mono' }, CACHE_FILE), ' · thư mục trên máy tính bảng: ', el('span', { class: 'mono' }, folderOf() || NO_FOLDER),
        d.file.updated_at ? ` · cập nhật ${clockDateTime(d.file.updated_at)}` : ''));
  }

  function warningsNode() {
    const a = S.data.analysis;
    const mismatches = a.namespaces.flatMap((n) => n.items).filter((i) => i.nameMismatch).length;
    const warns = [];
    if (a.orphans.length) warns.push(`${a.orphans.length} bản keymap/độ giật nằm trong file nhưng KHÔNG có trong danh sách (mục mồ côi: thường là bản cũ app còn giữ lại; app không hiện chúng).`);
    if (a.missingMaps.length) warns.push(`${a.missingMaps.length} mục có trong danh sách nhưng thiếu nội dung (map|…).`);
    if (mismatches) warns.push(`${mismatches} mục có tên trong danh sách khác với tên trong dữ liệu.`);
    for (const p of a.problems) warns.push(p.message);
    return warns.length ? alert('warn', el('div', {}, warns.map((w) => el('div', {}, w)))) : alert('ok', el('span', {}, 'Không thấy bất thường giữa danh sách và nội dung.'));
  }

  const colHead = () => ['Tên và nơi lưu', 'Dung lượng', 'Ghi chú', ''].map((h, i) => el('th', { class: i === 0 ? 'col-name' : i === 1 ? 'col-size' : '' }, h)); // new elements each time: a node has only one parent

  function openItem(it) {
    S.sel = { id: it.id, kind: it.kind, ns: it.ns, label: it.label };
    lay.selected = null;
    rc.picked = null;
    window.scrollTo(0, 0);
    redraw();
  }

  function itemRow(it) {
    const src = CX.sourceOf(S.data.parsed, it.id);
    const pickIt = () => { S.pick = it.id; redraw(); };
    const menu = menuButton([
      { label: 'Mở phân tích', icon: 'layers', disabled: !it.hasMap, onclick: () => openItem(it) },
      { label: 'Sao chép ID', icon: 'copy', onclick: () => copyText(it.id, 'Đã sao chép ID') },
      { label: 'Sao chép tên mục (map|…)', icon: 'copy', onclick: () => copyText(`map|${it.id}`, 'Đã sao chép tên mục') },
    ], { label: `Thao tác với ${it.label}` });
    return el('tr', { class: `pick${S.pick === it.id ? ' active' : ''}`, tabindex: '0', 'aria-selected': S.pick === it.id ? 'true' : 'false',
      onclick: pickIt, ondblclick: () => { if (it.hasMap) openItem(it); },
      onkeydown: (e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickIt(); } } },
      el('td', { class: 'col-name' }, el('div', { class: 'name-cell' },
        el('span', { class: 'name' }, el('span', {}, it.label), it.selected ? badge('Đang dùng trong app', 'ok', { dot: true }) : null),
        it.nameMismatch ? el('span', { class: 'sub' }, `danh sách: ${it.listName}`) : null,
        el('span', { class: 'sub mono', title: `${CACHE_FILE} › ${src.mapEntry || '(không có mục map|)'}` }, `${CACHE_FILE} › ${src.mapEntry ? `map|${short(it.id)}` : '(thiếu map|…)'}`),
        el('span', { class: 'sub' }, src.listEntry ? `trong danh sách ${src.listEntry}` : `không nằm trong danh sách nào · ${KIND_VN[it.kind] || 'Không rõ'} (đoán từ nội dung)`),
        it.addTime ? el('span', { class: 'sub mono' }, it.addTime) : null)),
      el('td', { class: 'num col-size' }, it.hasMap ? fmtBytes(it.bytes) : '—'),
      el('td', {}, el('div', { class: 'flags' }, itemFlags(it))),
      el('td', { class: 'act' }, deleteButton([it.id]), ' ', menu));
  }

  function groupRow(title, ns, count, extra) {
    return el('tr', { class: 'group' }, el('td', { colspan: 4 }, el('div', { class: 'row' }, el('span', {}, title), ns ? el('span', { class: 'mono muted' }, ns) : null, badge(String(count)), extra || null)));
  }

  function listCard() {
    const a = S.data.analysis;
    const body = [];
    for (const n of a.namespaces) {
      body.push(groupRow(KIND_VN[n.kind], n.ns, n.items.length));
      if (!n.items.length) body.push(el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'Danh sách trống.')));
      for (const it of n.items) body.push(itemRow(itemInfo(it.id)));
    }
    if (a.orphans.length) {
      body.push(groupRow('Mục mồ côi', '', a.orphans.length, deleteButton(a.orphans.map((o) => o.id), `Xóa cả ${a.orphans.length} mục mồ côi`, 'btn small danger')));
      for (const o of a.orphans) body.push(itemRow(itemInfo(o.id)));
    }
    if (!body.length) return el('section', { class: 'card' }, emptyState('inbox', 'File chưa có mục nào', 'gamwing_keymap_cache.xml không chứa danh sách keymap.'));
    return el('section', { class: 'card flush table-card' }, el('table', { class: 'stack' }, el('thead', {}, el('tr', {}, colHead())), el('tbody', {}, body)));
  }

  function inspectorNode(slot) {
    const it = S.pick ? itemInfo(S.pick) : null;
    const parts = [];
    if (it) {
      const src = CX.sourceOf(S.data.parsed, it.id);
      const refs = S.refs.get(it.id) || [];
      const copyBtn = (text, label) => el('button', { type: 'button', class: 'btn icon small ghost', title: label, 'aria-label': label, onclick: () => copyText(text) }, icon('copy'));
      parts.push(el('section', { class: 'card' },
        el('div', { class: 'row' }, el('h2', {}, it.label), badge(KIND_VN[it.kind] || 'Không rõ', 'accent'), it.selected ? badge('Đang dùng trong app', 'ok', { dot: true }) : null),
        el('dl', { class: 'kv' },
          el('dt', {}, 'ID'), el('dd', { class: 'mono' }, it.id, ' ', copyBtn(it.id, 'Sao chép ID')),
          el('dt', {}, 'File XML'), el('dd', { class: 'mono' }, CACHE_FILE),
          el('dt', {}, 'Mục trong file'), el('dd', { class: 'mono' }, src.mapEntry || '— (không có nội dung map|…)'),
          el('dt', {}, 'Danh sách'), el('dd', { class: 'mono' }, src.listEntry || '— (không nằm trong danh sách nào: mục mồ côi)'),
          el('dt', {}, 'Thư mục trên máy tính bảng'), el('dd', { class: 'mono' }, folderOf() || NO_FOLDER),
          el('dt', {}, `Còn được ghi ở ${REFS_FILE}`), el('dd', { class: 'mono' }, refs.length ? refs.map((r) => `${r.entry} = ${r.ns}`).join('; ') : '—'),
          el('dt', {}, 'Dung lượng'), el('dd', {}, it.hasMap ? fmtBytes(it.bytes) : '—'),
          it.addTime ? [el('dt', {}, 'Ngày'), el('dd', { class: 'mono' }, it.addTime)] : null),
        el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn primary', disabled: !it.hasMap, onclick: () => openItem(it) }, icon('layers'), 'Mở phân tích')),
        el('div', { class: 'danger-zone' }, el('h3', {}, 'Vùng nguy hiểm'),
          el('span', { class: 'muted' }, 'Xóa mục này khỏi server và khỏi máy tính bảng (qua app KeyMap Sync). Có hai bước xác nhận.'),
          el('div', {}, deleteButton([it.id], 'Xóa mục này…', 'btn danger')))));
    } else {
      parts.push(el('section', { class: 'card' }, emptyState('layers', 'Chọn một mục trong danh sách', 'để xem nó nằm ở đâu (file, mục, thư mục trên máy) và các thao tác.')));
    }
    parts.push(slot);
    return el('aside', { class: 'inspector', 'aria-label': 'Chi tiết mục đang chọn' }, parts);
  }

  // ---------------------------------------------------------------- the whole tab
  function draw() {
    if (!S.data) {
      setCrumbs([{ label: 'Phân tích cache' }]);
      return el('div', {}, pageHead(), S.error ? alert('danger', el('span', {}, S.error)) : skeleton('split'));
    }
    const slot = el('div', {});
    slot.append(commandsNode());
    pollCommands(slot);
    if (!S.sel) {
      setCrumbs([{ label: 'Phân tích cache' }]);
      return el('div', {}, pageHead(), warningsNode(), el('div', { class: 'split' }, listCard(), inspectorNode(slot)));
    }
    return viewerPage(slot);
  }

  function viewerPage(slot) {
    const doc = S.data.analysis.docs.get(S.sel.id);
    const info = itemInfo(S.sel.id);
    const back = () => { S.sel = null; redraw(); };
    setCrumbs([{ label: 'Phân tích cache', onclick: back }, { label: KIND_VN[S.sel.kind] || 'Không rõ', onclick: back }, { label: S.sel.label }]);
    const src = CX.sourceOf(S.data.parsed, S.sel.id);
    const refs = S.refs.get(S.sel.id) || [];
    const head = el('section', { class: 'card' },
      el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn small', onclick: back }, icon('back'), 'Danh sách'), el('h2', {}, S.sel.label), badge(KIND_VN[S.sel.kind] || 'Không rõ', 'accent'),
        info && info.selected ? badge('Đang dùng trong app', 'ok', { dot: true }) : null, !S.src ? null : badge(`sao lưu ngày ${S.src}`), deleteButton([S.sel.id], 'Xóa mục này…', 'btn small danger')),
      el('details', { class: 'disclosure' }, el('summary', {}, 'Nơi lưu của mục này'),
        el('div', { class: 'disclosure-body' }, el('dl', { class: 'kv' },
          el('dt', {}, 'ID'), el('dd', { class: 'mono' }, S.sel.id),
          el('dt', {}, 'File XML'), el('dd', { class: 'mono' }, CACHE_FILE),
          el('dt', {}, 'Mục trong file'), el('dd', { class: 'mono' }, src.mapEntry || '— (không có nội dung map|…)'),
          el('dt', {}, 'Danh sách'), el('dd', { class: 'mono' }, src.listEntry || '— (không nằm trong danh sách nào: mục mồ côi)'),
          el('dt', {}, 'Thư mục trên máy'), el('dd', { class: 'mono' }, folderOf() || NO_FOLDER),
          el('dt', {}, `Còn được ghi ở ${REFS_FILE}`), el('dd', { class: 'mono' }, refs.length ? refs.map((r) => `${r.entry} = ${r.ns}`).join('; ') : '—')))));
    if (!doc) return el('div', {}, head, alert('danger', el('span', {}, 'Nội dung bị hỏng (không phải JSON hợp lệ).')), slot);
    let body;
    if (S.sel.kind === 'recoil') body = recoilView(doc);
    else if ((S.sel.kind === 'keymap' || S.sel.kind === 'recognition') && Array.isArray(doc.components)) body = layoutView(S.sel.kind, doc);
    else body = summaryView(doc);
    return el('div', {}, head, body, slot);
  }

  const describe = (v) => (Array.isArray(v) ? `mảng ${v.length} phần tử` : v && typeof v === 'object' ? `đối tượng ${Object.keys(v).length} khóa` : JSON.stringify(v));
  function summaryView(doc) {
    return el('section', { class: 'card' }, el('h2', {}, 'Các trường cấp cao nhất'),
      el('table', {}, el('tbody', {}, Object.entries(doc).map(([k, v]) => el('tr', {}, el('td', { class: 'mono' }, k), el('td', {}, describe(v)))))));
  }

  // ---------------------------------------------------------------- on-screen layout (key maps, AI recognition maps)
  const loadPrefs = () => { try { return JSON.parse(localStorage.getItem('ftAdminLayout')) || {}; } catch { return {}; } };
  const savePrefs = () => { try { localStorage.setItem('ftAdminLayout', JSON.stringify({ screen: lay.screenId, origin: lay.origin, w: lay.custom.w, h: lay.custom.h })); } catch { /* private mode */ } };
  const screenSize = () => (lay.screenId === 'custom' ? lay.custom : (LL.SCREEN_PRESETS.find((p) => p.id === lay.screenId) || LL.SCREEN_PRESETS[0]));

  function layoutView(kind, doc) {
    if (!lay.screenId) { const p = loadPrefs(); lay.screenId = p.screen || LL.SCREEN_PRESETS[0].id; lay.origin = p.origin === 'center' ? 'center' : 'topleft'; lay.custom = { w: p.w || 2960, h: p.h || 1848 }; }
    const comps = doc.components;
    const scr = screenSize();
    const canvas = LL.canvasSize(comps.filter((c) => c && typeof c === 'object'), scr, lay.origin);
    const svg = svgEl('svg', { viewBox: `0 0 ${canvas.w} ${canvas.h}`, class: 'screen', role: 'img', 'aria-label': 'Màn hình mô phỏng vị trí các phím' });
    svg.append(svgEl('rect', { class: 'frame', x: 0, y: 0, width: scr.w, height: scr.h }));
    if (lay.bg.url) svg.append(svgEl('image', { href: lay.bg.url, x: 0, y: 0, width: scr.w, height: scr.h, preserveAspectRatio: 'none', opacity: lay.bg.opacity }));
    for (let gx = 100; gx < canvas.w; gx += 100) svg.append(svgEl('line', { class: gx % 500 === 0 ? 'grid major' : 'grid', x1: gx, x2: gx, y1: 0, y2: canvas.h }));
    for (let gy = 100; gy < canvas.h; gy += 100) svg.append(svgEl('line', { class: gy % 500 === 0 ? 'grid major' : 'grid', x1: 0, x2: canvas.w, y1: gy, y2: gy }));
    for (const o of LL.overlays(kind, doc)) {
      svg.append(svgEl('rect', { class: 'overlay', x: o.rect.x, y: o.rect.y, width: o.rect.w, height: o.rect.h }, svgEl('title', {}, o.name)),
        svgEl('text', { class: 'overlay-label', x: o.rect.x + 12, y: o.rect.y + 34 }, o.name));
    }
    const rects = comps.map((c) => LL.rectOf(c || {}, lay.origin));
    const order = comps.map((c, i) => i).sort((a, b) => rects[b].w * rects[b].h - rects[a].w * rects[a].h); // big ones first, so small ones stay clickable
    const nodes = {};
    for (const i of order) {
      const c = comps[i] || {};
      const d = LL.describe(kind, c);
      const r = rects[i];
      const round = c['base:componentIdentifier'] === 'com.zjx.app:joystick';
      const shape = round ? svgEl('ellipse', { class: 'shape', cx: r.x + r.w / 2, cy: r.y + r.h / 2, rx: r.w / 2, ry: r.h / 2 }) : svgEl('rect', { class: 'shape', rx: 8, x: r.x, y: r.y, width: r.w, height: r.h });
      const label = kind === 'recognition' ? String(c.type) : (d.keys[0] || LL.componentInfo(c['base:componentIdentifier']).short);
      const text = svgEl('text', { class: 'label', x: r.x + r.w / 2, y: r.y + r.h / 2 }, label.length > 9 ? `${label.slice(0, 8)}…` : label);
      const g = svgEl('g', { class: `comp c-${d.cls}${lay.selected === i ? ' sel' : ''}`, 'data-i': i },
        svgEl('title', {}, `${d.title}${d.keys.length ? ` [${d.keys.join(' ')}]` : ''} — (${Math.round(r.x)}, ${Math.round(r.y)}) ${Math.round(r.w)}×${Math.round(r.h)}`), shape, text);
      svg.append(g);
      nodes[i] = g;
    }
    const panel = el('div', {});
    const showPanel = () => {
      const i = lay.selected;
      if (i === null) { panel.replaceChildren(); return; }
      const d = LL.describe(kind, comps[i] || {});
      panel.replaceChildren(el('div', { class: 'card' }, el('h2', {}, d.title),
        el('p', { class: 'muted' }, `${d.subtitle}${d.sure ? '' : ' · tên suy ra từ code'}`),
        d.keys.length ? el('div', { class: 'keychips' }, d.keys.map((k) => el('span', { class: 'keychip' }, k))) : null,
        el('table', {}, el('tbody', {}, d.rows.map((r) => el('tr', {}, el('td', { title: r.raw }, r.label), el('td', { class: 'mono wrap' }, r.display)))))));
    };
    svg.addEventListener('click', (e) => {
      const g = e.target.closest && e.target.closest('g.comp');
      const next = g ? Number(g.dataset.i) : null;
      if (lay.selected !== null && nodes[lay.selected]) nodes[lay.selected].classList.remove('sel');
      lay.selected = next;
      if (next !== null) nodes[next].classList.add('sel');
      showPanel();
    });
    const coords = el('span', { class: 'muted mono' }, 'Rê chuột vào màn hình để xem toạ độ');
    svg.addEventListener('pointermove', (e) => { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const p = pt.matrixTransform(svg.getScreenCTM().inverse()); coords.textContent = `x=${Math.round(p.x)}  y=${Math.round(p.y)}`; });
    showPanel();

    const screenSel = el('select', { 'aria-label': 'Kích thước màn hình', onchange: (e) => { lay.screenId = e.target.value; savePrefs(); redraw(); } },
      LL.SCREEN_PRESETS.map((p) => el('option', { value: p.id, selected: p.id === lay.screenId }, p.label)), el('option', { value: 'custom', selected: lay.screenId === 'custom' }, 'Tùy chỉnh…'));
    const custom = lay.screenId === 'custom' ? ['w', 'h'].map((f) => el('label', { class: 'numfield' }, f === 'w' ? 'Rộng' : 'Cao', el('input', { type: 'number', value: String(lay.custom[f]), min: '100', onchange: (e) => { const n = Math.round(Number(e.target.value)); if (n >= 100) { lay.custom[f] = n; savePrefs(); redraw(); } } }))) : null;
    const originSel = el('select', { 'aria-label': 'Gốc toạ độ', title: 'Chưa xác nhận base:x/base:y là góc trên-trái hay tâm ô; dùng ảnh nền để kiểm tra', onchange: (e) => { lay.origin = e.target.value; savePrefs(); redraw(); } },
      el('option', { value: 'topleft', selected: lay.origin === 'topleft' }, 'Toạ độ = góc trên-trái ô'), el('option', { value: 'center', selected: lay.origin === 'center' }, 'Toạ độ = tâm ô'));
    const file = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => { const f = e.target.files[0]; if (!f) return; if (lay.bg.url) URL.revokeObjectURL(lay.bg.url); lay.bg.url = URL.createObjectURL(f); redraw(); } });
    const opacity = el('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(lay.bg.opacity), 'aria-label': 'Độ mờ ảnh nền', onchange: (e) => { lay.bg.opacity = Number(e.target.value); redraw(); } });
    return el('div', { class: 'layout' },
      el('div', { class: 'card' }, el('h2', {}, `Màn hình hiển thị vị trí (${comps.length} ${kind === 'recognition' ? 'ô' : 'phím'})`),
        el('div', { class: 'row' }, screenSel, custom, originSel),
        el('div', { class: 'row' }, el('label', { class: 'btn small' }, 'Chọn ảnh chụp game làm nền…', file),
          lay.bg.url ? [opacity, el('button', { class: 'btn small', onclick: () => { URL.revokeObjectURL(lay.bg.url); lay.bg.url = null; redraw(); } }, 'Bỏ ảnh nền')] : el('span', { class: 'muted' }, 'Ảnh chỉ xử lý trong trình duyệt, không tải lên server.')),
        svg, el('div', { class: 'row' }, coords, el('span', { class: 'muted' }, 'Bấm một ô để xem thông số · chỉ xem, không sửa')),
        el('p', { class: 'muted' }, 'Khung xám là màn hình; nội dung vượt ngoài khung vẫn được vẽ. Chưa xác nhận gốc toạ độ (góc trên-trái hay tâm ô): hãy đối chiếu bằng ảnh chụp game rồi chọn đúng.')),
      panel);
  }

  // ---------------------------------------------------------------- recoil analysis (read-only)
  const POSTURE_VN = RL.LABELS.POSTURES;
  const MODE_VN = { touch: 'Chạm thường', gyro: 'Con quay (gyro)', raw: 'Dữ liệu gốc (recoil_data)' };
  const NONE_KINDS = new Set(['GRIPS', 'MUZZLES', 'STOCKS']);
  const opt = (kind, i) => (i === 0 && NONE_KINDS.has(kind) ? el('span', { title: 'None (không gắn)' }, '—') : el('span', { title: RL[kind][i] }, RL.LABELS[kind][i]));
  const optText = (kind, i) => (i === 0 && NONE_KINDS.has(kind) ? 'không' : RL.LABELS[kind][i]);
  const num = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');

  function recoilIndex(doc) {
    const key = `${S.sel.id}|${rc.mode}|${S.src}`;
    if (!rc.idx || rc.idx.key !== key) {
      const ds = RL.pickDataset(doc, rc.mode);
      rc.idx = { key, ds, idx: ds ? RL.indexData(ds.data) : null, sums: null };
      if (ds) rc.idx.sums = ds.data.map((_, w) => RL.weaponSummary(rc.idx.idx, w));
    }
    return rc.idx;
  }

  const sourceTag = (r) => {
    if (r.source === 'exact') return el('span', { class: 'tag ok' }, 'Có mục riêng');
    if (r.source === 'zero') return el('span', { class: 'tag' }, 'Luôn 0');
    return el('span', { class: 'tag warn' }, r.baseMissing ? 'Nền thiếu → 0' : `Tính ×${r.multiplier.toFixed(3)}`);
  };

  function chart(curve) {
    const W = 640; const H = 240; const L = 56; const R = 14; const T = 14; const B = 30;
    const tMax = Math.max(...curve.map((p) => p[0]), 1);
    const vs = curve.map((p) => p[1]);
    const vMin = Math.min(0, ...vs);
    let vMax = Math.max(...vs);
    if (vMax === vMin) vMax = vMin + 1;
    vMax += (vMax - vMin) * 0.08;
    const x = (t) => L + (t / tMax) * (W - L - R);
    const y = (v) => T + (1 - (v - vMin) / (vMax - vMin)) * (H - T - B);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Đường cong độ giật theo thời gian' });
    for (let i = 0; i <= 4; i++) {
      const v = vMin + ((vMax - vMin) * i) / 4;
      svg.append(svgEl('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }), svgEl('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, v.toFixed(0)));
      const t = (tMax * i) / 4;
      svg.append(svgEl('text', { x: x(t), y: H - 10, 'text-anchor': i === 4 ? 'end' : 'middle' }, `${Math.round(t)} ms`));
    }
    svg.append(curve.length === 1
      ? svgEl('line', { class: 'curve flat', x1: L, x2: W - R, y1: y(curve[0][1]), y2: y(curve[0][1]) })
      : svgEl('polyline', { class: 'curve', fill: 'none', points: curve.map(([t, v]) => `${x(t)},${y(v)}`).join(' ') }));
    curve.forEach(([t, v], i) => svg.append(svgEl('circle', { class: 'dot', cx: x(t), cy: y(v), r: 3.5 }, svgEl('title', {}, `mốc ${i}: t=${t} ms, giá trị=${v}`))));
    return svg;
  }

  function recoilView(doc) {
    const ix = recoilIndex(doc);
    const modeSel = el('select', { 'aria-label': 'Bộ dữ liệu', onchange: (e) => { rc.mode = e.target.value; rc.picked = null; redraw(); } },
      Object.entries(MODE_VN).map(([m, label]) => el('option', { value: m, selected: m === rc.mode }, label)));
    const headRow = el('div', { class: 'row' }, el('label', {}, 'Bộ dữ liệu: '), modeSel);
    if (!ix.ds) return el('div', { class: 'card' }, headRow, el('p', {}, 'Bản này không có trường recoil_data.'));
    const sums = ix.sums;
    const weaponSel = el('select', { 'aria-label': 'Súng', onchange: (e) => { rc.weapon = Number(e.target.value); rc.picked = null; redraw(); } },
      sums.map((s, w) => el('option', { value: w, selected: w === rc.weapon }, `${RL.weaponLabel(w)} — ${s.keys} khóa${s.entries > s.keys ? `, ${s.entries} mục` : ''}`)));
    const sum = sums[rc.weapon] || { keys: 0, entries: 0, byGesture: [0, 0, 0], byScope: [] };
    const postureChips = el('div', { class: 'chips' }, POSTURE_VN.map((label, g) => el('button', { class: 'chip', 'aria-pressed': rc.gesture === g, onclick: () => { rc.gesture = g; rc.picked = null; redraw(); } }, `${label} (${sum.byGesture[g] || 0})`)));
    const scopeChips = el('div', { class: 'chips' }, RL.SCOPES.map((raw, s) => el('button', { class: 'chip', title: raw, 'aria-pressed': rc.scope === s, onclick: () => { rc.scope = s; rc.picked = null; redraw(); } }, `${RL.LABELS.SCOPES[s]} (${sum.byScope[s] || 0})`)));

    let combos = RL.exactCombos(ix.idx, rc.weapon, rc.scope, rc.gesture);
    if (rc.showAll) {
      combos = [];
      for (let g = 0; g < RL.GRIPS.length; g++) for (let m = 0; m < RL.MUZZLES.length; m++) for (let st = 0; st < RL.STOCKS.length; st++) combos.push({ grip: g, muzzle: m, stock: st });
    } else if (!combos.some((c) => !c.grip && !c.muzzle && !c.stock)) combos.unshift({ grip: 0, muzzle: 0, stock: 0 });
    const comboOf = (c) => ({ weapon: rc.weapon, scope: rc.scope, gesture: rc.gesture, grip: c.grip, muzzle: c.muzzle, stock: c.stock });
    const rows = combos.map((c) => {
      const r = RL.resolve(ix.idx, comboOf(c));
      const st = RL.curveStats(r.curve);
      const active = rc.picked && rc.picked.grip === c.grip && rc.picked.muzzle === c.muzzle && rc.picked.stock === c.stock;
      return el('tr', { class: `pick${active ? ' active' : ''}`, onclick: () => { rc.picked = c; redraw(); } },
        el('td', {}, opt('GRIPS', c.grip)), el('td', {}, opt('MUZZLES', c.muzzle)), el('td', {}, opt('STOCKS', c.stock)),
        el('td', {}, sourceTag(r), r.copies > 1 ? el('span', { class: 'tag', title: `${r.copies} mục trùng khóa, ${r.distinct} nội dung khác nhau; app dùng mục cuối` }, ` ×${r.copies}`) : null),
        el('td', { class: 'num' }, num(st.v0)), el('td', { class: 'num' }, num(st.vEnd)), el('td', { class: 'num' }, `${st.duration} ms`), el('td', { class: 'num' }, st.points));
    });
    const table = el('table', {}, el('thead', {}, el('tr', {}, ['Tay cầm', 'Nòng', 'Báng', 'Nguồn', 'Giá trị t=0', 'Giá trị cuối', 'Thời lượng', 'Mốc'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colspan: 8, class: 'muted' }, 'Không có tổ hợp nào.'))));
    const left = el('div', {},
      el('div', { class: 'card' }, headRow,
        el('div', { class: 'row' }, el('label', {}, 'Súng: '), weaponSel, el('span', { class: 'muted' }, `${ix.ds.key} · ${sum.keys} khóa, ${sum.entries} mục`)),
        el('div', { class: 'muted' }, 'Tư thế'), postureChips, el('div', { class: 'muted' }, 'Ống ngắm (số khóa có dữ liệu)'), scopeChips,
        el('label', { class: 'row' }, el('input', { type: 'checkbox', checked: rc.showAll, onchange: (e) => { rc.showAll = e.target.checked; redraw(); } }), 'Hiện mọi tổ hợp, kể cả tổ hợp tính từ hệ số')),
      el('div', { class: 'card' }, el('h2', {}, `${RL.weaponLabel(rc.weapon)} · ${POSTURE_VN[rc.gesture]} · ${RL.LABELS.SCOPES[rc.scope]}`), table,
        el('p', { class: 'muted' }, 'Bấm một dòng để xem đường cong chi tiết. Đơn vị của "giá trị" chưa xác định. Thời gian tính từ lúc bắt đầu bắn.')));
    return el('div', { class: 'layout' }, left, el('div', {}, rc.picked ? recoilDetail(ix, comboOf(rc.picked)) : el('div', { class: 'card muted' }, 'Bấm một dòng trong bảng để xem đường cong chi tiết.')));
  }

  function recoilDetail(ix, o) {
    const r = RL.resolve(ix.idx, o);
    const st = RL.curveStats(r.curve);
    const label = `${RL.weaponLabel(o.weapon)} · ${POSTURE_VN[o.gesture]} · ${RL.LABELS.SCOPES[o.scope]} · tay cầm: ${optText('GRIPS', o.grip)} · nòng: ${optText('MUZZLES', o.muzzle)} · báng: ${optText('STOCKS', o.stock)}`;
    const pts = el('table', {}, el('thead', {}, el('tr', {}, ['#', 'Thời gian (ms)', 'Giá trị', 'Δ so với mốc trước'].map((h) => el('th', {}, h)))),
      el('tbody', {}, r.curve.map(([t, v], i) => {
        const disordered = i > 0 && t <= r.curve[i - 1][0];
        const delta = i ? `${v - r.curve[i - 1][1] >= 0 ? '+' : ''}${(v - r.curve[i - 1][1]).toFixed(2)} / ${t - r.curve[i - 1][0]} ms` : '';
        return el('tr', { class: disordered ? 'warnrow' : '', title: disordered ? 'Thời gian không lớn hơn mốc trước: đường cong nên tăng dần theo thời gian.' : undefined },
          el('td', {}, i), el('td', { class: 'num' }, t), el('td', { class: 'num' }, num(v)), el('td', { class: 'num muted' }, delta));
      })));
    const compare = el('table', {}, el('thead', {}, el('tr', {}, ['Tư thế', 'Nguồn', 'Giá trị t=0', 'Giá trị cuối', 'Thời lượng'].map((h) => el('th', {}, h)))),
      el('tbody', {}, POSTURE_VN.map((name, g) => {
        const rr = RL.resolve(ix.idx, { ...o, gesture: g });
        const s2 = RL.curveStats(rr.curve);
        return el('tr', { class: g === o.gesture ? 'active' : '' }, el('td', {}, name), el('td', {}, sourceTag(rr)), el('td', { class: 'num' }, num(s2.v0)), el('td', { class: 'num' }, num(s2.vEnd)), el('td', { class: 'num' }, `${s2.duration} ms`));
      })));
    const coef = RL.coefficientsFor(ix.idx, o.weapon, o.scope);
    const used = new Set(r.parts.map((p) => p.key));
    const coefTable = coef ? el('table', {}, el('tbody', {}, Object.entries(coef).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) =>
      el('tr', { class: used.has(k) ? 'active' : '' }, el('td', { title: k }, RL.coefLabel(k)), el('td', { class: 'num' }, typeof v === 'number' ? Number(v.toFixed(4)).toString() : String(v)))))) : el('p', { class: 'muted' }, 'Không có bảng hệ số.');
    return el('div', { class: 'card' }, el('h2', {}, label),
      el('dl', { class: 'kv' },
        el('dt', {}, 'Nguồn'), el('dd', {}, sourceTag(r), r.source === 'exact' ? ' app dùng đúng mục này' : r.source === 'computed' ? ' = đường cong nền (đứng, không phụ kiện) × hệ số' : ''),
        r.multiplier != null ? [el('dt', {}, 'Hệ số nhân'), el('dd', {}, r.parts.length ? `${r.parts.map((p) => `${p.label} ${Number(p.value.toFixed(4))}`).join(' × ')} = ${r.multiplier.toFixed(4)}` : '1 (không có hệ số áp dụng)')] : null,
        r.copies > 1 ? [el('dt', {}, 'Trùng khóa'), el('dd', {}, `${r.copies} mục cùng khóa, ${r.distinct} nội dung khác nhau. App dùng mục xuất hiện cuối cùng.`)] : null,
        el('dt', {}, 'Tóm tắt'), el('dd', {}, `${st.points} mốc, ${st.duration} ms, giá trị ${num(st.min)} … ${num(st.max)}`)),
      r.notes.length ? el('ul', { class: 'muted' }, r.notes.map((n) => el('li', {}, n))) : null,
      chart(r.curve), el('h2', {}, 'Từng mốc'), pts,
      el('h2', {}, 'So sánh tư thế (cùng phụ kiện, ống ngắm)'), compare,
      el('h2', {}, `Hệ số của ${RL.weaponLabel(o.weapon)} / ${RL.LABELS.SCOPES[o.scope]}`), coefTable,
      el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => { if (navigator.clipboard) navigator.clipboard.writeText(JSON.stringify(r.curve)); toast('Đã sao chép đường cong (JSON)'); } }, 'Sao chép đường cong JSON')));
  }

  async function refresh() { await load(); redraw(); }

  // the command palette can jump to an item of the cache
  window.Palette.register(() => {
    if (!S.data) return [];
    const a = S.data.analysis;
    const all = [...a.namespaces.flatMap((n) => n.items.map((i) => i.id)), ...a.orphans.map((o) => o.id)];
    return all.map(itemInfo).filter(Boolean).map((i) => ({
      group: 'Mục của cache', label: i.label, hint: `${KIND_VN[i.kind] || 'Không rõ'}${i.listed ? '' : ' · mồ côi'} · ${short(i.id)}${i.addTime ? ` · ${i.addTime.slice(0, 10)}` : ''}`, icon: 'layers', keywords: `${i.id} ${i.ns} ${i.listName}`,
      run: () => { S.pending = i.id; S.sel = null; document.dispatchEvent(new CustomEvent('ft-goto', { detail: 'analysis' })); },
    }));
  });

  window.Analysis = {
    // called when the tab opens: fetches the file again, then returns the page
    async view() { active = true; S.sel = null; await load(); return draw(); },
    leave() { active = false; clearInterval(pollTimer); pollTimer = null; if (lay.bg.url) { URL.revokeObjectURL(lay.bg.url); lay.bg.url = null; } },
  };
})();
