'use strict';
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
  const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);
  const short = (id) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `show${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, isError ? 6000 : 2500);
  }

  const ERRORS_VI = {
    'Keymap not found': 'Không tìm thấy mục này.',
    'Share code not found': 'Không tìm thấy mã chia sẻ.',
    'Invalid account id': 'Mã tài khoản không hợp lệ.',
    'Invalid JSON': 'Dữ liệu gửi lên không phải JSON hợp lệ.',
    'Not found': 'Không tìm thấy.',
    'Internal error': 'Lỗi nội bộ của server.',
    'Cross-site or missing X-Admin-Request': 'Yêu cầu bị chặn vì không đến từ chính trang quản trị này.',
    'Method not allowed': 'Phương thức không được phép.',
    Conflict: 'File đã bị thay đổi từ lúc bạn mở (có thể app vừa đồng bộ).',
    'etag is required': 'Thiếu mã phiên bản của file.',
    'Nothing to change': 'Không có gì để lưu.',
    'keymap must be an object': 'Nội dung phải là một đối tượng JSON.',
    'metadata must be an object': 'Siêu dữ liệu phải là một đối tượng JSON.',
    'Version not found': 'Không tìm thấy phiên bản lịch sử này.',
    'Invalid version': 'Mã phiên bản không hợp lệ.',
    'Snapshot is damaged': 'Bản lịch sử bị hỏng, không khôi phục được.',
    'File not found': 'Không tìm thấy file này trên server.',
    'text must be a string': 'Nội dung phải là văn bản.',
  };
  const viError = (msg) => ERRORS_VI[msg] || (msg.startsWith('Host not allowed') ? 'Địa chỉ truy cập này không được phép (xem ADMIN_ALLOWED_HOSTS).' : msg.startsWith('Body must be') ? 'Dữ liệu gửi lên sai định dạng.' : msg);

  async function api(method, path, body) {
    const opts = { method, headers: {} };
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

  const state = { view: 'keymaps', overview: null, account: null, ns: '', docs: [], doc: null, tab: 'summary', edit: null, hist: null, lay: null };

  // ---------------------------------------------------------------- navigation
  const VIEWS = [['keymaps', 'Sơ đồ phím'], ['recognition', 'Nhận diện AI'], ['configs', 'Độ giật / Cấu hình'], ['recoil', 'Phân tích độ giật'], ['shares', 'Mã chia sẻ'], ['import', 'Nhập backup'], ['devices', 'Thiết bị'], ['backups', 'Sao lưu theo ngày'], ['databases', 'Cài đặt app (jya2)']];
  function renderNav() {
    const nav = $('#nav');
    nav.replaceChildren(...VIEWS.map(([id, label]) => el('button', {
      'aria-current': state.view === id ? 'page' : false,
      onclick: () => { if (!discardOk() || !dbEditDiscardOk()) return; state.dbEdit = null; clearRecoilPending(); state.view = id; state.doc = null; state.edit = null; state.hist = null; state.lay = null; state.ns = ''; render(); },
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

  async function loadOverview() {
    state.overview = await api('GET', '/overview');
    const ids = state.overview.accounts.map((a) => a.id);
    if (!ids.includes(state.account)) state.account = ids[0] || null;
    $('#meta').textContent = `${state.overview.accounts.length} tài khoản · ${state.overview.shares} mã chia sẻ · ${state.overview.dataDir}`;
  }

  async function loadDocs() {
    state.docs = state.account ? (await api('GET', `/accounts/${state.account}/docs`)).docs : [];
    if (state.doc && !state.docs.some((d) => d.id === state.doc.id)) state.doc = null;
  }

  async function render() {
    renderNav();
    const app = $('#app');
    try {
      if (KIND_OF_VIEW[state.view]) { await loadOverview(); await loadDocs(); app.replaceChildren(viewKeymaps()); }
      else if (state.view === 'recoil') { await loadOverview(); await loadDocs(); await ensureRecoilDoc(); app.replaceChildren(drawRecoil()); }
      else if (state.view === 'devices') { await loadOverview(); app.replaceChildren(await viewDevices()); }
      else if (state.view === 'backups') { await loadOverview(); app.replaceChildren(await viewBackups()); }
      else if (state.view === 'databases') { await loadOverview(); app.replaceChildren(await viewDatabases()); }
      else if (state.view === 'shares') { await loadOverview(); app.replaceChildren(await viewShares()); }
      else { await loadOverview(); app.replaceChildren(viewImport()); }
    } catch (e) { app.replaceChildren(el('p', { class: 'muted' }, `Lỗi: ${e.message}`)); }
    labelStacked(app);
  }

  // ---------------------------------------------------------------- keymaps
  const KIND_OF_VIEW = { keymaps: 'keymap', recognition: 'recognition', configs: 'recoil' };
  const KIND_INFO = {
    keymap: { title: 'Sơ đồ phím', unit: 'sơ đồ phím', hint: 'Sơ đồ phím/chuột: joystick, nút bắn, nhìn quanh, đổi ống ngắm… Không gian tên theo từng game (ví dụ com.vng.pubgmobile) hoặc com.zjx.generalrc.rcConfig2.' },
    recognition: { title: 'Nhận diện AI', unit: 'bản nhận diện', hint: 'Vị trí các biểu tượng (súng, ống ngắm, xe, tư thế…) trên màn hình để AI nhận diện. Không gian tên com.zjx.pubg.recognition.<game>.' },
    recoil: { title: 'Độ giật / Cấu hình', unit: 'bản cấu hình', hint: 'Bảng bù giật theo súng, phụ kiện, ống ngắm, tư thế và độ nhạy (không gian tên com.zjx.pubg.rcConfig2). Xem chi tiết từng súng ở tab "Phân tích độ giật".' },
  };

  function viewKeymaps() {
    const ov = state.overview;
    const kind = KIND_OF_VIEW[state.view];
    const info = KIND_INFO[kind];
    const countOf = (a) => a.namespaces.filter((n) => n.kind === kind).reduce((sum, n) => sum + n.count, 0);
    if (!ov.accounts.length) {
      return el('div', { class: 'card' }, el('h2', {}, 'Chưa có dữ liệu'),
        el('p', {}, 'Chưa có tài khoản nào lưu dữ liệu. Dữ liệu sẽ xuất hiện khi app kết nối tới server này, hoặc bạn có thể '),
        el('button', { class: 'btn primary', onclick: () => { state.view = 'import'; render(); } }, 'nhập từ file backup'));
    }
    const acc = ov.accounts.find((a) => a.id === state.account);
    const accSel = el('select', { 'aria-label': 'Tài khoản', onchange: guard(async (e) => { state.account = e.target.value; state.ns = ''; state.doc = null; await render(); }) },
      ov.accounts.map((a) => el('option', { value: a.id, selected: a.id === state.account }, `${a.id} — ${countOf(a)} ${info.unit}`)));
    const chips = el('div', { class: 'chips' },
      el('button', { class: 'chip', 'aria-pressed': state.ns === '', onclick: () => { state.ns = ''; render(); } }, `Tất cả (${countOf(acc)})`),
      acc.namespaces.filter((n) => n.kind === kind).map((n) => el('button', { class: 'chip', 'aria-pressed': state.ns === n.ns, onclick: () => { state.ns = n.ns; render(); } }, `${n.ns} (${n.count})`)));
    const rows = state.docs.filter((d) => d.kind === kind && (!state.ns || d.ns === state.ns));
    const table = el('table', { class: 'stack' },
      el('thead', {}, el('tr', {}, ['', 'Tên', 'Không gian tên', 'ID', 'Ngày', 'Dung lượng', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.length ? rows.map(docRow) : el('tr', {}, el('td', { colspan: 7, class: 'muted' }, `Tài khoản này chưa có ${info.unit} nào.`))));
    return el('div', { class: 'layout' },
      el('div', {}, el('div', { class: 'card' }, el('h2', {}, info.title), el('p', { class: 'muted' }, info.hint), el('div', { class: 'row' }, accSel), chips, table), screenCard(kind)),
      el('div', {}, state.edit ? viewEditor() : [compPanelSlot(kind), state.doc ? viewDoc() : el('div', { class: 'card muted' }, 'Chọn một dòng để xem nội dung.')]));
  }

  function docRow(d) {
    return el('tr', { class: `pick${state.doc && state.doc.id === d.id ? ' active' : ''}`, onclick: guard(() => openDoc(d.id)) },
      el('td', { class: 'star', title: d.selected ? 'Đang được chọn trong app' : '' }, d.selected ? '★' : ''),
      el('td', {}, d.name || el('span', { class: 'muted' }, '(không tên)')),
      el('td', {}, el('span', { class: 'tag' }, d.ns)),
      el('td', { class: 'mono', title: d.id }, short(d.id)),
      el('td', { class: 'mono' }, d.add_time),
      el('td', { class: 'num' }, fmtBytes(d.bytes)),
      el('td', { class: 'act' },
        el('a', { class: 'btn small', href: `/admin/api/accounts/${state.account}/docs/${d.id}?download=1`, onclick: (e) => e.stopPropagation() }, 'Tải'),
        ' ',
        el('button', { class: 'btn small danger', onclick: guard((e) => { e.stopPropagation(); return removeDoc(d); }) }, 'Xóa')));
  }

  async function openDoc(id) {
    if (!discardOk()) return;
    state.doc = await api('GET', `/accounts/${state.account}/docs/${id}`);
    state.tab = 'summary';
    state.edit = null;
    state.hist = null;
    state.lay = null;
    $('#app').replaceChildren(viewKeymaps());
  }

  async function removeDoc(d) {
    if (!confirm(`Xóa "${d.name || d.id}"?\nKhông hoàn tác được (hãy tải về trước nếu cần).`)) return;
    await api('DELETE', `/accounts/${state.account}/docs/${d.id}`);
    toast('Đã xóa');
    await render();
  }

  function viewDoc() {
    const d = state.doc;
    const tabs = el('div', { class: 'tabs', role: 'tablist' }, [['summary', 'Tóm tắt'], ['json', 'JSON'], ['history', 'Lịch sử']].map(([id, label]) =>
      el('button', { role: 'tab', 'aria-selected': state.tab === id, onclick: () => { state.tab = id; $('#app').replaceChildren(viewKeymaps()); } }, label)));
    return el('div', { class: 'card' },
      el('h2', {}, (d.metadata && d.metadata.name) || d.id),
      el('dl', { class: 'kv' }, el('dt', {}, 'ID'), el('dd', { class: 'mono' }, d.id), el('dt', {}, 'Không gian tên'), el('dd', {}, d.ns), el('dt', {}, 'Ngày'), el('dd', {}, d.add_time)),
      d.ns === 'com.zjx.pubg.rcConfig2' ? el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => { rc.docId = d.id; state.view = 'recoil'; render(); } }, 'Phân tích chi tiết theo súng →')) : null,
      editButtons(d),
      tabs, state.tab === 'summary' ? viewSummary(d) : state.tab === 'history' ? viewHistory() : viewTree(d));
  }

  function describe(v) {
    if (Array.isArray(v)) return `mảng ${v.length} phần tử`;
    if (v && typeof v === 'object') return `đối tượng ${Object.keys(v).length} khóa`;
    return JSON.stringify(v);
  }

  function viewSummary(d) {
    const km = d.keymap;
    const out = [];
    out.push(el('h2', {}, 'Các trường cấp cao nhất'),
      el('table', {}, el('tbody', {}, Object.entries(km).map(([k, v]) => el('tr', {}, el('td', { class: 'mono' }, k), el('td', {}, describe(v)))))));
    if (Array.isArray(km.components)) {
      const counts = new Map();
      for (const c of km.components) {
        const key = (c && (c['base:componentIdentifier'] ?? c.type)) ?? '(không rõ)';
        counts.set(String(key), (counts.get(String(key)) || 0) + 1);
      }
      out.push(el('h2', {}, `Thành phần (${km.components.length})`),
        el('table', {}, el('tbody', {}, [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => el('tr', {}, el('td', { class: 'mono' }, k), el('td', { class: 'num' }, n))))));
    }
    if (Array.isArray(km.recoil_data)) {
      const entries = km.recoil_data.reduce((s, g) => s + ((g && g.v && g.v.length) || 0), 0);
      out.push(el('h2', {}, 'Dữ liệu độ giật'), el('p', {}, `${km.recoil_data.length} nhóm, ${entries} mục`
        + (km.recoil_value_coefficient != null ? `, hệ số recoil_value_coefficient = ${km.recoil_value_coefficient}` : '')
        + (km.ft_recoil_mode_profiles ? ', có khối ft_recoil_mode_profiles' : '')));
    }
    out.push(el('h2', {}, 'Siêu dữ liệu'), el('pre', { class: 'mono tree' }, JSON.stringify(d.metadata, null, 1)));
    return el('div', {}, out);
  }

  // ---------------------------------------------------------------- JSON tree (children are built on first expand)
  const CHUNK = 100;
  const editBtn = (path) => el('button', { class: 'btn small edit', title: `Sửa ${path}`, onclick: (e) => { e.preventDefault(); e.stopPropagation(); startEdit('keymap', path); } }, 'Sửa');
  function leaf(key, v, path) {
    const cls = typeof v === 'string' ? 's' : typeof v === 'number' ? 'n' : '';
    const shown = typeof v === 'string' && v.length > 300 ? `${JSON.stringify(v.slice(0, 300))}… (${v.length} ký tự)` : JSON.stringify(v);
    return el('div', { class: 'leaf mono' }, key != null && el('span', { class: 'k' }, `${key}: `), el('span', { class: cls }, shown), path !== '$' ? editBtn(path) : null);
  }
  function node(key, v, path = '$') {
    if (v === null || typeof v !== 'object') return leaf(key, v, path);
    const isArr = Array.isArray(v);
    const keys = isArr ? null : Object.keys(v);
    const size = isArr ? v.length : keys.length;
    const box = el('details', {}, el('summary', { class: 'mono' }, key != null && el('span', { class: 'k' }, `${key}: `), isArr ? `[${size}]` : `{${size}}`, path !== '$' ? editBtn(path) : null));
    let built = false;
    box.addEventListener('toggle', () => {
      if (!box.open || built) return;
      built = true;
      let i = 0;
      const more = el('button', { class: 'btn small more', onclick: () => fill() }, '');
      const fill = () => {
        const end = Math.min(i + CHUNK, size);
        const frag = document.createDocumentFragment();
        for (; i < end; i++) frag.append(node(isArr ? i : keys[i], isArr ? v[i] : v[keys[i]], EL.childPath(path, isArr ? i : keys[i])));
        box.insertBefore(frag, more);
        if (i >= size) more.remove(); else more.textContent = `Hiện thêm (${size - i} còn lại)`;
      };
      box.append(more);
      fill();
    });
    return box;
  }

  function search(root, q, limit = 300) {
    const hits = [];
    const needle = q.toLowerCase();
    const walk = (v, path) => {
      if (hits.length >= limit) return;
      if (v !== null && typeof v === 'object') {
        for (const [k, c] of Object.entries(v)) {
          const p = EL.childPath(path, Array.isArray(v) ? Number(k) : k);
          if (!Array.isArray(v) && k.toLowerCase().includes(needle) && (c === null || typeof c !== 'object')) hits.push([p, c]);
          else if (c === null || typeof c !== 'object') { if (String(c).toLowerCase().includes(needle)) hits.push([p, c]); }
          walk(c, p);
          if (hits.length >= limit) return;
        }
      }
    };
    walk(root, '$');
    return hits;
  }

  function viewTree(d) {
    const box = el('div', {});
    const hits = el('div', { class: 'hits mono' });
    const input = el('input', { type: 'search', placeholder: 'Tìm khóa hoặc giá trị…', 'aria-label': 'Tìm trong JSON' });
    input.addEventListener('input', () => {
      const q = input.value.trim();
      if (q.length < 2) { hits.replaceChildren(); return; }
      const found = search(d.keymap, q);
      hits.replaceChildren(el('div', { class: 'muted' }, `${found.length}${found.length >= 300 ? '+' : ''} kết quả`),
        ...found.map(([p, v]) => el('div', { title: 'Bấm để sao chép đường dẫn', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(p); toast('Đã sao chép đường dẫn'); } },
          el('span', { class: 'k' }, p), ' = ', el('span', { class: typeof v === 'string' ? 's' : 'n' }, JSON.stringify(v)), ' ', editBtn(p))));
    });
    box.append(el('div', { class: 'row' }, input), hits, el('div', { class: 'tree' }, node(null, d.keymap, '$')));
    return box;
  }

  // ---------------------------------------------------------------- shares
  async function viewShares() {
    const { shares } = await api('GET', '/shares');
    const body = shares.length ? shares.map((s) => el('tr', {},
      el('td', { class: 'mono' }, s.code), el('td', {}, s.name || el('span', { class: 'muted' }, '—')), el('td', {}, el('span', { class: 'tag' }, s.ns)),
      el('td', { class: 'num' }, `${s.uses} / ${s.max_uses || '∞'}`), el('td', { class: 'mono' }, s.created),
      el('td', { class: 'act' },
        el('button', { class: 'btn small', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(s.code); toast('Đã sao chép mã'); } }, 'Sao chép'), ' ',
        el('button', { class: 'btn small danger', onclick: guard(async () => { if (!confirm(`Xóa mã ${s.code}?`)) return; await api('DELETE', `/shares/${s.code}`); toast('Đã xóa'); await render(); }) }, 'Xóa'))))
      : el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Chưa có mã chia sẻ nào.'));
    return el('div', { class: 'card' }, el('h2', {}, 'Mã chia sẻ'),
      el('table', { class: 'stack' }, el('thead', {}, el('tr', {}, ['Mã', 'Tên', 'Không gian tên', 'Đã dùng', 'Tạo lúc', ''].map((h) => el('th', {}, h)))), el('tbody', {}, body)));
  }

  // ---------------------------------------------------------------- import
  function viewImport() {
    const ov = state.overview;
    const picked = [];
    const info = el('p', { class: 'muted' }, 'Chưa chọn file nào.');
    const report = el('div', { class: 'report' });
    const go = el('button', { class: 'btn primary', disabled: true }, 'Nhập');
    const newAcc = el('input', { type: 'text', placeholder: 'ft_client mới: 32 ký tự hex', 'aria-label': 'ft_client mới', maxlength: 32 });
    const accSel = el('select', { 'aria-label': 'Tài khoản đích' },
      ov.accounts.map((a) => el('option', { value: a.id, selected: a.id === state.account }, a.id)),
      el('option', { value: '__new' }, 'Tài khoản mới…'));
    const sync = () => {
      newAcc.hidden = accSel.value !== '__new';
    };
    accSel.addEventListener('change', sync);
    if (!ov.accounts.length) accSel.value = '__new';
    sync();

    const take = async (fileList) => {
      picked.length = 0;
      for (const f of fileList) if (/\.json$/i.test(f.name)) picked.push({ name: f.name, text: await f.text() });
      const lists = picked.filter((f) => /^list(\||%7C)/i.test(f.name)).length;
      const maps = picked.filter((f) => /^map(\||%7C)/i.test(f.name)).length;
      info.textContent = `${picked.length} file JSON: ${lists} danh mục (list|…), ${maps} keymap (map|…).`;
      go.disabled = !lists || !maps;
    };
    go.addEventListener('click', guard(async () => {
      let id = accSel.value;
      if (id === '__new') {
        const hex = newAcc.value.trim().toLowerCase();
        if (!/^[a-f0-9]{32}$/.test(hex)) throw new Error('ft_client phải là 32 ký tự hex (0-9, a-f)');
        id = `c_${hex}`;
      }
      go.disabled = true;
      const r = await api('POST', `/accounts/${id}/import-cache`, { files: picked });
      state.account = id;
      report.replaceChildren(el('p', { class: 'ok' }, `Vào ${id}: ${r.imported.length} mới, ${r.updated.length} cập nhật (bản cũ được giữ trong tab Lịch sử), ${r.unchanged} giữ nguyên.`),
        r.skipped.length ? el('div', {}, el('p', { class: 'bad' }, `Bỏ qua ${r.skipped.length}:`),
          el('ul', {}, r.skipped.map((s) => el('li', { class: 'mono' }, `${s.id || s.file}: ${s.reason}`)))) : null);
      toast(`Mới ${r.imported.length}, cập nhật ${r.updated.length}, giữ nguyên ${r.unchanged}`);
      go.disabled = false;
    }));

    return el('div', { class: 'card' },
      el('h2', {}, 'Nhập từ backup của điện thoại'),
      el('p', {}, 'Chọn các file trong ', el('code', {}, 'Documents/Gamwing/keymap_cache/'), ' (các file ', el('code', {}, 'list|…'), ' và ', el('code', {}, 'map|…'), '). Giữ nguyên id và bản đang được chọn.'),
      el('p', { class: 'muted' }, 'Mỗi tài khoản ứng với một ft_client mà app gửi lên. Sau khi điện thoại kết nối lần đầu, tài khoản của nó sẽ xuất hiện trong danh sách; hãy nhập vào đúng tài khoản đó thì app mới thấy dữ liệu.'),
      el('div', { class: 'row' }, el('label', {}, 'Tài khoản đích: '), accSel, newAcc),
      el('div', { class: 'drop' },
        el('div', { class: 'row' },
          el('label', { class: 'btn' }, 'Chọn file…', el('input', { type: 'file', multiple: true, accept: '.json', hidden: true, onchange: guard((e) => take(e.target.files)) })),
          el('label', { class: 'btn' }, 'Chọn thư mục…', el('input', { type: 'file', webkitdirectory: true, hidden: true, onchange: guard((e) => take(e.target.files)) }))),
        info),
      el('div', { class: 'row' }, go), report);
  }

  // ---------------------------------------------------------------- editing (with warning, backup and restore)
  const EL = window.EditLib;
  const EDIT_WHOLE_MAX = 150000; // bytes of compact JSON; larger documents are edited branch by branch
  const EDIT_NODE_MAX = 2000000; // characters of pretty JSON in the text box
  const docKind = (doc = state.doc) => { const m = state.docs.find((x) => x.id === doc.id); return m ? m.kind : 'keymap'; };
  const bytesOf = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
  const brief = (v) => { if (v === undefined) return '—'; const t = JSON.stringify(v); return t.length > 70 ? `${t.slice(0, 70)}…` : t; };
  const redrawDocs = () => $('#app').replaceChildren(viewKeymaps());
  const KIND_VN = { added: 'Thêm', removed: 'Xóa', changed: 'Sửa' };

  function showModal({ title, tone = 'warn', body, actions }) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const done = (id) => { overlay.remove(); document.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus(); resolve(id); };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      const buttons = actions.map((a) => el('button', { class: `btn${a.primary ? ' primary' : ''}${a.danger ? ' danger-fill' : ''}`, onclick: () => done(a.id) }, a.label));
      const dialog = el('div', { class: `modal-card ${tone}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' },
        el('h2', { id: 'modal-title' }, title), el('div', { class: 'modal-body' }, body), el('div', { class: 'modal-actions' }, buttons));
      const overlay = el('div', { class: 'modal' }, dialog);
      document.body.append(overlay);
      document.addEventListener('keydown', onKey);
      buttons[0].focus(); // the first action is always the safe one (cancel), so a stray Enter cannot save
    });
  }

  function changesList(c) {
    return el('div', { class: 'changes mono' },
      c.changes.map((x) => el('div', {}, el('span', { class: `chg ${x.kind}` }, KIND_VN[x.kind]), ' ', el('span', { class: 'k' }, x.path), ': ',
        x.kind === 'added' ? el('span', { class: 's' }, brief(x.after)) : x.kind === 'removed' ? el('span', { class: 'n' }, brief(x.before))
          : [el('span', { class: 'n' }, brief(x.before)), ' → ', el('span', { class: 's' }, brief(x.after))])),
      c.truncated ? el('div', { class: 'muted' }, `… và ${c.total - c.changes.length} thay đổi nữa.`) : null);
  }

  function issuesList(issues) {
    if (!issues.length) return el('p', { class: 'ok-text' }, 'Không phát hiện vấn đề cấu trúc mới.');
    return el('ul', { class: 'issues' }, issues.map((i) => el('li', { class: i.level }, el('b', {}, i.level === 'error' ? 'Nghiêm trọng' : 'Cảnh báo'), ' ', el('span', { class: 'mono' }, i.path), ' — ', i.message)));
  }

  const WARNING_TEXT = 'Bạn đang sửa trực tiếp dữ liệu mà điện thoại sẽ tải về. Sai cấu trúc có thể làm app báo lỗi, hoặc làm phím/độ giật hoạt động sai. Bản hiện tại sẽ được tự động sao lưu (giữ tối đa 20 bản) và có thể khôi phục ở tab "Lịch sử".';

  function kindNotes(kind, changes) {
    const notes = [];
    if (kind === 'recoil') notes.push('Đây là dữ liệu độ giật: giá trị lệch có thể làm tâm kéo sai trong game.');
    if (changes.changes.some((c) => c.path === '$.recoil_value_coefficient')) {
      notes.push('Bạn đang sửa recoil_value_coefficient. Việc này KHÔNG tự nhân lại các giá trị trong bảng recoilValue (app chỉ nhân khi bạn kéo thanh trượt trong cài đặt), nên con số này và bảng có thể không còn khớp nhau.');
    }
    return notes;
  }

  function editButtons(d) {
    const small = bytesOf(d.keymap) <= EDIT_WHOLE_MAX;
    return el('div', { class: 'row' },
      el('button', { class: 'btn small', disabled: !small, title: small ? 'Sửa toàn bộ nội dung' : `File lớn (${fmtBytes(bytesOf(d.keymap))}): hãy sửa theo nhánh từ tab JSON`, onclick: () => startEdit('keymap', '$') }, 'Sửa toàn bộ'),
      el('button', { class: 'btn small', onclick: () => startEdit('metadata', '$') }, 'Sửa siêu dữ liệu'),
      small ? null : el('span', { class: 'muted' }, 'File lớn: sửa theo nhánh (nút "Sửa" ở tab JSON).'));
  }

  function startEdit(target, path) {
    const root = target === 'keymap' ? state.doc.keymap : state.doc.metadata;
    let value;
    try { value = EL.getAt(root, EL.parsePath(path)); } catch (e) { toast(e.message, true); return; }
    if (value === undefined) { toast('Không tìm thấy nhánh này.', true); return; }
    const text = JSON.stringify(value, null, 2);
    if (text.length > EDIT_NODE_MAX) { toast(`Nhánh này quá lớn (${fmtBytes(text.length)}) để sửa trong trình duyệt. Hãy chọn một nhánh con nhỏ hơn.`, true); return; }
    state.edit = { target, path, text, original: text };
    redrawDocs();
  }

  function jsonProblem(text) {
    try { JSON.parse(text); return null; } catch (e) {
      const m = /position (\d+)/.exec(e.message);
      if (!m) return e.message;
      const lines = text.slice(0, Number(m[1])).split('\n');
      return `${e.message.replace(/ in JSON at position.*$/, '')} (dòng ${lines.length}, cột ${lines[lines.length - 1].length + 1})`;
    }
  }

  function viewEditor() {
    const ed = state.edit;
    const d = state.doc;
    const status = el('div', { class: 'status', role: 'status' });
    const save = el('button', { class: 'btn primary', disabled: true, onclick: guard(requestSave) }, 'Lưu thay đổi…');
    const ta = el('textarea', { class: 'editor mono', spellcheck: 'false', rows: '22', 'aria-label': 'Nội dung JSON đang sửa' });
    ta.value = ed.text;
    const refresh = () => {
      ed.text = ta.value;
      const problem = jsonProblem(ed.text);
      const changed = ed.text !== ed.original;
      status.className = `status ${problem ? 'bad' : 'ok'}`;
      status.textContent = problem ? `JSON chưa hợp lệ: ${problem}` : changed ? 'JSON hợp lệ · có thay đổi chưa lưu' : 'JSON hợp lệ · chưa thay đổi';
      save.disabled = Boolean(problem) || !changed;
    };
    ta.addEventListener('input', refresh);
    refresh();
    const cancel = () => { if (ed.text !== ed.original && !confirm('Bỏ các thay đổi chưa lưu?')) return; state.edit = null; redrawDocs(); };
    return el('div', { class: 'card' },
      el('h2', {}, `Sửa JSON — ${(d.metadata && d.metadata.name) || d.id}`),
      el('dl', { class: 'kv' }, el('dt', {}, 'Đang sửa'), el('dd', {}, ed.target === 'keymap' ? 'Nội dung' : 'Siêu dữ liệu'), el('dt', {}, 'Nhánh'), el('dd', { class: 'mono' }, ed.path)),
      el('div', { class: 'warnbox' }, `⚠ ${WARNING_TEXT}`),
      ta, status,
      el('div', { class: 'row' }, save,
        el('button', { class: 'btn', onclick: () => { ta.value = ed.original; refresh(); } }, 'Đặt lại như ban đầu'),
        el('button', { class: 'btn', onclick: cancel }, 'Hủy')));
  }

  async function requestSave() {
    const ed = state.edit;
    const d = state.doc;
    const parsed = JSON.parse(ed.text);
    const root = ed.target === 'keymap' ? d.keymap : d.metadata;
    const next = EL.setAt(structuredClone(root), EL.parsePath(ed.path), parsed);
    if (next === null || typeof next !== 'object' || Array.isArray(next)) throw new Error('Sau khi sửa, nội dung phải vẫn là một đối tượng JSON ({ … }).');
    await confirmAndSave(ed.target, root, next);
  }

  // Shows the warning dialog (changes, structure check, backup notice) and saves when the user agrees.
  async function confirmAndSave(target, root, next, { title = 'Xác nhận lưu thay đổi', intro = null, doc = state.doc, after = redrawDocs, reload = null } = {}) {
    const changes = EL.diff(root, next, { limit: 40 });
    if (!changes.total) { toast('Không có thay đổi nào để lưu.'); return; }
    const kind = docKind(doc);
    const issues = target === 'keymap' ? EL.newIssues(EL.validate(kind, root), EL.validate(kind, next)) : [];
    const hasError = issues.some((i) => i.level === 'error');
    const choice = await showModal({
      title,
      tone: hasError ? 'error' : 'warn',
      body: [
        intro,
        el('p', { class: 'warnbox' }, `⚠ ${WARNING_TEXT}`),
        kindNotes(kind, changes).map((n) => el('p', { class: 'warnbox strong' }, `⚠ ${n}`)),
        el('p', {}, `${changes.total} thay đổi trong ${target === 'keymap' ? 'nội dung' : 'siêu dữ liệu'} · dung lượng ${fmtBytes(bytesOf(root))} → ${fmtBytes(bytesOf(next))}`),
        el('h2', {}, 'Kiểm tra cấu trúc'), issuesList(issues),
        el('h2', {}, 'Các thay đổi'), changesList(changes),
      ],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'save', label: hasError ? 'Tôi hiểu rủi ro, vẫn lưu' : 'Tôi hiểu, lưu thay đổi', primary: !hasError, danger: hasError }],
    });
    if (choice !== 'save') return;
    await commit(target === 'keymap' ? { keymap: next } : { metadata: next }, target, next, { doc, after, reload });
  }

  async function commit(payload, target, next, { doc = state.doc, after = redrawDocs, reload = null } = {}) {
    const d = doc;
    try {
      const res = await api('PUT', `/accounts/${state.account}/docs/${d.id}`, { etag: d.etag, ...payload });
      d[target] = next;
      d.etag = res.etag;
      state.edit = null;
      state.hist = null;
      if (state.lay) state.lay.pending = {};
      rc.doc = null; rc.base = null; rc.cache = null; // the analysis tab must reload the edited document
      await loadDocs();
      toast(`Đã lưu. Bản trước đã được sao lưu (lịch sử: ${res.history}/20).`);
      await after();
    } catch (e) {
      if (e.status !== 409) throw e;
      const mine = state.edit ? state.edit.text : null;
      const choice = await showModal({
        title: 'File đã thay đổi từ lúc bạn mở', tone: 'error',
        body: [el('p', {}, 'Có nơi khác vừa sửa file này (thường là app trên điện thoại vừa đồng bộ). Để không ghi đè mất dữ liệu, tôi đã KHÔNG lưu.'),
          el('p', { class: 'muted' }, 'Bạn có thể sao chép nội dung đang soạn, tải lại bản mới rồi sửa lại.')],
        actions: [{ id: 'close', label: 'Đóng' }, ...(mine !== null ? [{ id: 'copy', label: 'Sao chép nội dung của tôi' }] : []), { id: 'reload', label: 'Tải lại bản mới', primary: true }],
      });
      if (choice === 'copy' && mine !== null && navigator.clipboard) { navigator.clipboard.writeText(mine); toast('Đã sao chép nội dung bạn đang soạn'); }
      if (choice === 'reload') { if (reload) await reload(); else { state.edit = null; await openDoc(d.id); } }
    }
  }

  // ---- history tab
  function viewHistory() {
    const d = state.doc;
    if (!state.hist || state.hist.docId !== d.id) {
      state.hist = { docId: d.id, versions: null };
      api('GET', `/accounts/${state.account}/docs/${d.id}/history`).then((r) => {
        if (state.hist && state.hist.docId === d.id) { state.hist.versions = r.versions; if (state.tab === 'history' && state.doc && state.doc.id === d.id) redrawDocs(); }
      }).catch((e) => toast(e.message, true));
    }
    const v = state.hist.versions;
    if (!v) return el('p', { class: 'muted' }, 'Đang tải lịch sử…');
    if (!v.length) return el('p', { class: 'muted' }, 'Chưa có bản lịch sử nào. Mỗi lần bạn lưu một thay đổi, bản trước đó sẽ được giữ lại ở đây (tối đa 20 bản).');
    return el('div', {},
      el('p', { class: 'muted' }, `${v.length} bản gần nhất, mới nhất ở trên. Khôi phục cũng tự sao lưu trạng thái hiện tại nên có thể hoàn tác.`),
      el('table', { class: 'stack' }, el('thead', {}, el('tr', {}, ['Thời điểm lưu', 'Dung lượng', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, v.map((x) => el('tr', {},
          el('td', { class: 'mono' }, new Date(x.saved_at).toLocaleString('vi-VN')), el('td', { class: 'num' }, fmtBytes(x.bytes)),
          el('td', { class: 'act' },
            el('button', { class: 'btn small', onclick: guard(() => compareVersion(x)) }, 'So sánh'), ' ',
            el('button', { class: 'btn small danger', onclick: guard(() => restoreVersion(x)) }, 'Khôi phục')))))));
  }

  async function snapshotDiff(x, direction) {
    const snap = await api('GET', `/accounts/${state.account}/docs/${state.doc.id}/history/${x.version}`);
    const cur = { keymap: state.doc.keymap, metadata: state.doc.metadata };
    const old = { keymap: snap.keymap, metadata: snap.metadata };
    return direction === 'snapshot' ? EL.diff(old, cur, { limit: 60 }) : EL.diff(cur, old, { limit: 60 });
  }

  async function compareVersion(x) {
    const changes = await snapshotDiff(x, 'snapshot');
    await showModal({
      title: `So sánh bản ${new Date(x.saved_at).toLocaleString('vi-VN')} với bản hiện tại`, tone: 'info',
      body: [el('p', { class: 'muted' }, 'Dòng "Sửa a → b": a là giá trị ở bản lịch sử, b là giá trị hiện tại.'), changes.total ? changesList(changes) : el('p', {}, 'Hai bản giống hệt nhau.')],
      actions: [{ id: 'close', label: 'Đóng' }],
    });
  }

  async function restoreVersion(x) {
    const changes = await snapshotDiff(x, 'current');
    if (!changes.total) { toast('Bản này giống hệt bản hiện tại.'); return; }
    const choice = await showModal({
      title: `Khôi phục bản ${new Date(x.saved_at).toLocaleString('vi-VN')}`,
      body: [el('p', { class: 'warnbox' }, '⚠ Nội dung hiện tại sẽ được thay bằng bản lịch sử này. Trạng thái hiện tại vẫn được sao lưu trước nên bạn có thể quay lại. Điện thoại sẽ nhận bản khôi phục khi đồng bộ.'),
        el('p', {}, `${changes.total} thay đổi so với bản hiện tại:`), changesList(changes)],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'go', label: 'Khôi phục bản này', primary: true }],
    });
    if (choice !== 'go') return;
    try {
      await api('POST', `/accounts/${state.account}/docs/${state.doc.id}/history/${x.version}/restore`, { etag: state.doc.etag });
    } catch (e) {
      if (e.status === 409) { toast('File vừa thay đổi ở nơi khác. Đang tải lại, hãy thử khôi phục lần nữa.', true); await openDoc(state.doc.id); state.tab = 'history'; redrawDocs(); return; }
      throw e;
    }
    rc.doc = null; rc.base = null; rc.cache = null;
    const id = state.doc.id;
    await loadDocs();
    await openDoc(id);
    state.tab = 'history';
    redrawDocs();
    toast('Đã khôi phục.');
  }

  // ---------------------------------------------------------------- on-screen layout (key maps and AI recognition maps)
  const LL = window.LayoutLib;
  const LAYOUT_KINDS = new Set(['keymap', 'recognition']);
  const BASE_FIELDS = [['x', 'base:x'], ['y', 'base:y'], ['w', 'base:width'], ['h', 'base:height']];

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem('ftAdminLayout')) || {}; } catch { return {}; }
  }
  function savePrefs() {
    try { localStorage.setItem('ftAdminLayout', JSON.stringify({ screen: state.lay.screenId, origin: state.lay.origin, w: state.lay.custom.w, h: state.lay.custom.h })); } catch { /* private mode */ }
  }
  const pendingCount = () => (state.lay ? Object.keys(state.lay.pending).length : 0);
  function discardOk() {
    if (state.edit && !confirm('Bỏ các thay đổi chưa lưu trong trình soạn thảo?')) return false;
    if (pendingCount() && !confirm(`Bỏ ${pendingCount()} thay đổi vị trí chưa lưu?`)) return false;
    if (rcPendingCount() && !confirm(`Bỏ ${rcPendingCount()} chỉnh sửa độ giật chưa lưu?`)) return false;
    return true;
  }

  function ensureLayout() {
    if (state.lay && state.lay.docId === state.doc.id) return state.lay;
    const prefs = loadPrefs();
    state.lay = {
      docId: state.doc.id, pending: {}, selected: null, origin: prefs.origin === 'center' ? 'center' : 'topleft',
      screenId: prefs.screen || LL.SCREEN_PRESETS[0].id, custom: { w: prefs.w || 2960, h: prefs.h || 1848 },
      bg: { url: null, opacity: 0.5 }, ui: {},
    };
    return state.lay;
  }
  const screenSize = (lay) => (lay.screenId === 'custom' ? lay.custom : (LL.SCREEN_PRESETS.find((p) => p.id === lay.screenId) || LL.SCREEN_PRESETS[0]));
  const compLabel = (kind, c) => { const d = LL.describe(kind, c); return `${d.title}${d.keys.length ? ` [${d.keys.join(' ')}]` : ''}`; };

  // the four base numbers of a component as stored (before any unsaved change)
  function savedValues(c) { return { x: c['base:x'], y: c['base:y'], w: c['base:width'], h: c['base:height'] }; }
  function currentValues(lay, i) { return lay.pending[i] || savedValues(state.doc.keymap.components[i]); }
  function currentRect(lay, i) {
    const v = currentValues(lay, i);
    return LL.rectOf({ 'base:x': v.x, 'base:y': v.y, 'base:width': v.w, 'base:height': v.h }, lay.origin);
  }

  function setPending(kind, i, vals) {
    const lay = state.lay;
    const c = state.doc.keymap.components[i];
    const saved = savedValues(c);
    const next = { x: Math.round(vals.x), y: Math.round(vals.y), w: Math.max(1, Math.round(vals.w)), h: Math.max(1, Math.round(vals.h)) };
    const same = ['x', 'y', 'w', 'h'].every((k) => Math.round(saved[k]) === next[k]);
    if (same) delete lay.pending[i]; else lay.pending[i] = next;
    const msg = LL.describeChange(compLabel(kind, c), saved, next);
    toast(msg || `Phím «${compLabel(kind, c)}» đã về đúng vị trí đã lưu`);
    paintComponent(kind, i);
    refreshPending(kind);
    refreshPanel(kind);
  }

  function paintComponent(kind, i) {
    const lay = state.lay;
    const ui = lay.ui.nodes && lay.ui.nodes[i];
    if (!ui) return;
    const r = currentRect(lay, i);
    ui.g.classList.toggle('moved', Boolean(lay.pending[i]));
    ui.g.classList.toggle('sel', lay.selected === i);
    if (ui.ellipse) { ui.shape.setAttribute('cx', r.x + r.w / 2); ui.shape.setAttribute('cy', r.y + r.h / 2); ui.shape.setAttribute('rx', r.w / 2); ui.shape.setAttribute('ry', r.h / 2); }
    else { ui.shape.setAttribute('x', r.x); ui.shape.setAttribute('y', r.y); ui.shape.setAttribute('width', r.w); ui.shape.setAttribute('height', r.h); }
    ui.text.setAttribute('x', r.x + r.w / 2);
    ui.text.setAttribute('y', r.y + r.h / 2);
  }

  function select(kind, i) {
    const lay = state.lay;
    const prev = lay.selected;
    lay.selected = i;
    if (prev !== null && prev !== i) paintComponent(kind, prev);
    if (i !== null) paintComponent(kind, i);
    refreshPanel(kind);
  }

  function refreshPending(kind) {
    const lay = state.lay;
    const slot = lay.ui.pendingSlot;
    if (!slot) return;
    const idx = Object.keys(lay.pending).map(Number).sort((a, b) => a - b);
    if (!idx.length) { slot.replaceChildren(); return; }
    slot.replaceChildren(el('div', { class: 'warnbox' },
      el('b', {}, `Thay đổi vị trí chưa lưu (${idx.length})`),
      el('ul', { class: 'pendinglist' }, idx.map((i) => {
        const c = state.doc.keymap.components[i];
        return el('li', {}, LL.describeChange(compLabel(kind, c), savedValues(c), lay.pending[i]));
      })),
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', onclick: guard(() => savePending(kind)) }, 'Lưu vị trí…'),
        el('button', { class: 'btn', onclick: () => { const ids = Object.keys(lay.pending).map(Number); lay.pending = {}; ids.forEach((i) => paintComponent(kind, i)); refreshPending(kind); refreshPanel(kind); toast('Đã hoàn tác mọi thay đổi vị trí chưa lưu'); } }, 'Hoàn tác tất cả'))));
  }

  async function savePending(kind) {
    const lay = state.lay;
    const changes = {};
    for (const [k, v] of Object.entries(lay.pending)) {
      const saved = savedValues(state.doc.keymap.components[Number(k)]);
      changes[k] = {};
      for (const f of ['x', 'y', 'w', 'h']) if (Math.round(saved[f]) !== v[f]) changes[k][f] = v[f]; // only the numbers that really changed
    }
    const next = LL.applyChanges(state.doc.keymap, changes);
    await confirmAndSave('keymap', state.doc.keymap, next, {
      title: `Lưu vị trí của ${Object.keys(changes).length} phím`,
      intro: el('p', {}, `Chỉ các số base:x, base:y, base:width, base:height của ${Object.keys(changes).length} thành phần được thay đổi; mọi tham số khác giữ nguyên.`),
    });
  }

  function refreshPanel(kind) {
    const lay = state.lay;
    const slot = lay.ui.panelSlot;
    if (!slot) return;
    const i = lay.selected;
    if (i === null) { slot.replaceChildren(); return; }
    const c = state.doc.keymap.components[i];
    const d = LL.describe(kind, c);
    const v = currentValues(lay, i);
    const inputs = [['x', 'X'], ['y', 'Y'], ['w', 'Rộng'], ['h', 'Cao']].map(([f, label]) =>
      el('label', { class: 'numfield' }, label, el('input', {
        type: 'number', value: String(Math.round(v[f])), min: f === 'w' || f === 'h' ? '1' : undefined, step: '1', 'aria-label': `${label} của thành phần`,
        onchange: (e) => { const cur = { ...currentValues(lay, i) }; const n = Number(e.target.value); if (Number.isFinite(n)) cur[f] = n; setPending(kind, i, cur); },
      })));
    slot.replaceChildren(el('div', { class: 'card' },
      el('h2', {}, d.title),
      el('p', { class: 'muted' }, `${d.subtitle}${d.sure ? '' : ' · tên suy ra từ code'}`),
      d.keys.length ? el('div', { class: 'keychips' }, d.keys.map((k) => el('span', { class: 'keychip' }, k))) : null,
      el('div', { class: 'row' }, inputs),
      el('div', { class: 'row' },
        el('button', { class: 'btn small', disabled: !lay.pending[i], onclick: () => { delete lay.pending[i]; paintComponent(kind, i); refreshPending(kind); refreshPanel(kind); toast(`Phím «${compLabel(kind, c)}» đã về vị trí đã lưu`); } }, 'Về vị trí đã lưu'),
        el('button', { class: 'btn small', disabled: pendingCount() > 0, title: pendingCount() ? 'Hãy lưu hoặc hoàn tác thay đổi vị trí trước' : 'Mở trình soạn thảo JSON cho thành phần này', onclick: () => startEdit('keymap', `$.components[${i}]`) }, 'Sửa mọi tham số (JSON)')),
      el('table', {}, el('tbody', {}, d.rows.map((r) => el('tr', {}, el('td', { title: r.raw }, r.label), el('td', { class: 'mono' }, r.display)))))));
  }

  function compPanelSlot(kind) {
    if (!state.lay || state.lay.docId !== state.doc.id || !LAYOUT_KINDS.has(kind)) return null;
    state.lay.ui.panelSlot = el('div', {});
    refreshPanel(kind);
    return state.lay.ui.panelSlot;
  }

  function screenCard(kind) {
    if (!state.doc || state.edit || !LAYOUT_KINDS.has(kind) || !Array.isArray(state.doc.keymap.components)) return null;
    const lay = ensureLayout();
    lay.ui = { nodes: {} };
    const comps = state.doc.keymap.components;
    const scr = screenSize(lay);
    const all = comps.map((c, i) => ({ 'base:x': currentValues(lay, i).x, 'base:y': currentValues(lay, i).y, 'base:width': currentValues(lay, i).w, 'base:height': currentValues(lay, i).h }));
    const canvas = LL.canvasSize(all, scr, lay.origin);
    const svg = svgEl('svg', { viewBox: `0 0 ${canvas.w} ${canvas.h}`, class: 'screen', tabindex: '0', role: 'application', 'aria-label': 'Màn hình mô phỏng vị trí các phím' });
    svg.append(svgEl('rect', { class: 'frame', x: 0, y: 0, width: scr.w, height: scr.h }));
    if (lay.bg.url) svg.append(svgEl('image', { href: lay.bg.url, x: 0, y: 0, width: scr.w, height: scr.h, preserveAspectRatio: 'none', opacity: lay.bg.opacity }));
    for (let gx = 100; gx < canvas.w; gx += 100) svg.append(svgEl('line', { class: gx % 500 === 0 ? 'grid major' : 'grid', x1: gx, x2: gx, y1: 0, y2: canvas.h }));
    for (let gy = 100; gy < canvas.h; gy += 100) svg.append(svgEl('line', { class: gy % 500 === 0 ? 'grid major' : 'grid', x1: 0, x2: canvas.w, y1: gy, y2: gy }));
    for (const o of LL.overlays(kind, state.doc.keymap)) {
      svg.append(svgEl('rect', { class: 'overlay', x: o.rect.x, y: o.rect.y, width: o.rect.w, height: o.rect.h }, svgEl('title', {}, o.name)),
        svgEl('text', { class: 'overlay-label', x: o.rect.x + 12, y: o.rect.y + 34 }, o.name));
    }
    // big shapes first so small ones stay clickable on top
    const order = comps.map((c, i) => i).sort((a, b) => { const ra = currentRect(lay, a); const rb = currentRect(lay, b); return rb.w * rb.h - ra.w * ra.h; });
    for (const i of order) {
      const c = comps[i];
      const d = LL.describe(kind, c);
      const r = currentRect(lay, i);
      const isRound = c['base:componentIdentifier'] === 'com.zjx.app:joystick';
      const shape = isRound ? svgEl('ellipse', { class: 'shape' }) : svgEl('rect', { class: 'shape', rx: 8 });
      const label = kind === 'recognition' ? String(c.type) : (d.keys[0] || LL.componentInfo(c['base:componentIdentifier']).short);
      const text = svgEl('text', { class: 'label' }, label.length > 9 ? `${label.slice(0, 8)}…` : label);
      const g = svgEl('g', { class: `comp c-${d.cls}`, 'data-i': i }, svgEl('title', {}, `${d.title}${d.keys.length ? ` [${d.keys.join(' ')}]` : ''} — (${Math.round(currentValues(lay, i).x)}, ${Math.round(currentValues(lay, i).y)}) ${Math.round(r.w)}×${Math.round(r.h)}`), shape, text);
      svg.append(g);
      lay.ui.nodes[i] = { g, shape, text, ellipse: isRound };
      paintComponent(kind, i);
    }

    // ---- interaction: select, drag (Shift = snap to 10 px), arrow keys nudge (Shift = 10 px)
    const coords = el('span', { class: 'muted mono' }, 'Rê chuột vào màn hình để xem toạ độ');
    const toSvg = (e) => { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const p = pt.matrixTransform(svg.getScreenCTM().inverse()); return { x: p.x, y: p.y }; };
    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      const g = e.target.closest && e.target.closest('g.comp');
      if (!g) { select(kind, null); return; }
      const i = Number(g.dataset.i);
      select(kind, i);
      e.preventDefault();
      svg.focus({ preventScroll: true });
      drag = { i, start: toSvg(e), r0: currentRect(lay, i), cur: null, moved: false };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      const p = toSvg(e);
      coords.textContent = `x=${Math.round(p.x)}  y=${Math.round(p.y)}`;
      if (!drag) return;
      let nx = drag.r0.x + (p.x - drag.start.x);
      let ny = drag.r0.y + (p.y - drag.start.y);
      if (e.shiftKey) { nx = Math.round(nx / 10) * 10; ny = Math.round(ny / 10) * 10; }
      nx = Math.min(Math.max(0, nx), canvas.w - drag.r0.w);
      ny = Math.min(Math.max(0, ny), canvas.h - drag.r0.h);
      if (Math.abs(p.x - drag.start.x) + Math.abs(p.y - drag.start.y) > 3) drag.moved = true;
      drag.cur = { x: nx, y: ny, w: drag.r0.w, h: drag.r0.h };
      const node = lay.ui.nodes[drag.i];
      if (node.ellipse) { node.shape.setAttribute('cx', nx + drag.r0.w / 2); node.shape.setAttribute('cy', ny + drag.r0.h / 2); } else { node.shape.setAttribute('x', nx); node.shape.setAttribute('y', ny); }
      node.text.setAttribute('x', nx + drag.r0.w / 2);
      node.text.setAttribute('y', ny + drag.r0.h / 2);
      node.g.classList.add('dragging');
    });
    const endDrag = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      lay.ui.nodes[d.i].g.classList.remove('dragging');
      if (d.moved && d.cur) {
        const pos = LL.positionFromRect(d.cur, lay.origin);
        setPending(kind, d.i, { x: pos.x, y: pos.y, w: d.cur.w, h: d.cur.h });
      } else paintComponent(kind, d.i);
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
    let nudgeTimer;
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { select(kind, null); return; }
      const step = e.shiftKey ? 10 : 1;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!delta || lay.selected === null) return;
      e.preventDefault();
      const cur = { ...currentValues(lay, lay.selected) };
      cur.x += delta[0]; cur.y += delta[1];
      const i = lay.selected;
      const c = state.doc.keymap.components[i];
      const saved = savedValues(c);
      const same = Math.round(saved.x) === Math.round(cur.x) && Math.round(saved.y) === Math.round(cur.y) && Math.round(saved.w) === Math.round(cur.w) && Math.round(saved.h) === Math.round(cur.h);
      if (same) delete lay.pending[i]; else lay.pending[i] = { x: Math.round(cur.x), y: Math.round(cur.y), w: Math.round(cur.w), h: Math.round(cur.h) };
      paintComponent(kind, i); refreshPending(kind); refreshPanel(kind);
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => toast(LL.describeChange(compLabel(kind, c), saved, currentValues(lay, i)) || `Phím «${compLabel(kind, c)}» đã về vị trí đã lưu`), 450);
    });

    // ---- controls
    const screenSel = el('select', { 'aria-label': 'Kích thước màn hình', onchange: (e) => { lay.screenId = e.target.value; savePrefs(); redrawDocs(); } },
      LL.SCREEN_PRESETS.map((p) => el('option', { value: p.id, selected: p.id === lay.screenId }, p.label)), el('option', { value: 'custom', selected: lay.screenId === 'custom' }, 'Tùy chỉnh…'));
    const customBox = lay.screenId === 'custom' ? ['w', 'h'].map((f) => el('label', { class: 'numfield' }, f === 'w' ? 'Rộng' : 'Cao', el('input', { type: 'number', value: String(lay.custom[f]), min: '100', onchange: (e) => { const n = Math.round(Number(e.target.value)); if (n >= 100) { lay.custom[f] = n; savePrefs(); redrawDocs(); } } }))) : null;
    const originSel = el('select', { 'aria-label': 'Gốc toạ độ', title: 'Chưa xác nhận base:x/base:y là góc trên-trái hay tâm ô; dùng ảnh nền để kiểm tra', onchange: (e) => { lay.origin = e.target.value; savePrefs(); redrawDocs(); } },
      el('option', { value: 'topleft', selected: lay.origin === 'topleft' }, 'Toạ độ = góc trên-trái ô'), el('option', { value: 'center', selected: lay.origin === 'center' }, 'Toạ độ = tâm ô'));
    const file = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => { const f = e.target.files[0]; if (!f) return; if (lay.bg.url) URL.revokeObjectURL(lay.bg.url); lay.bg.url = URL.createObjectURL(f); redrawDocs(); } });
    const opacity = el('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(lay.bg.opacity), 'aria-label': 'Độ mờ ảnh nền', onchange: (e) => { lay.bg.opacity = Number(e.target.value); redrawDocs(); } });
    lay.ui.pendingSlot = el('div', {});
    refreshPending(kind);
    return el('div', { class: 'card' },
      el('h2', {}, `Màn hình hiển thị vị trí (${comps.length} ${kind === 'recognition' ? 'ô' : 'phím'})`),
      el('div', { class: 'row' }, screenSel, customBox, originSel),
      el('div', { class: 'row' }, el('label', { class: 'btn small' }, 'Chọn ảnh chụp game làm nền…', file), lay.bg.url ? [opacity, el('button', { class: 'btn small', onclick: () => { URL.revokeObjectURL(lay.bg.url); lay.bg.url = null; redrawDocs(); } }, 'Bỏ ảnh nền')] : el('span', { class: 'muted' }, 'Ảnh chỉ xử lý trong trình duyệt, không tải lên server.')),
      lay.ui.pendingSlot, svg,
      el('div', { class: 'row' }, coords, el('span', { class: 'muted' }, 'Kéo để di chuyển · Shift = làm tròn 10 px · mũi tên = nhích 1 px (Shift = 10 px) · Esc = bỏ chọn')),
      el('p', { class: 'muted' }, 'Khung xám là màn hình; nội dung vượt ngoài khung vẫn được vẽ. Chưa xác nhận gốc toạ độ (góc trên-trái hay tâm ô): hãy đối chiếu bằng ảnh chụp game rồi chọn đúng.'));
  }

  // ---------------------------------------------------------------- recoil analysis (click a number to edit it; ↺ resets it)
  const RL = window.RecoilLib;
  const RC_NS = 'com.zjx.pubg.rcConfig2';
  const POSTURE_VN = RL.LABELS.POSTURES;
  const MODE_VN = { touch: 'Chạm thường', gyro: 'Con quay (gyro)', raw: 'Dữ liệu gốc (recoil_data)' };
  const rc = {
    docId: null, docAccount: null, doc: null, mode: 'touch', weapon: RL.WEAPONS.indexOf('AUG'), scope: 1, gesture: 0, showAll: false, picked: null,
    base: null, cache: null,
    pending: { curves: new Map(), coefs: new Map() }, // unsaved edits: curves by combination, coefficients by weapon|scope|name
    mirror: true, rev: 0,
  };
  // Vietnamese name, raw enum name in the tooltip. Index 0 of grip/muzzle/stock means "nothing attached" and shows as a dash.
  const NONE_KINDS = new Set(['GRIPS', 'MUZZLES', 'STOCKS']);
  const opt = (kind, i) => (i === 0 && NONE_KINDS.has(kind) ? el('span', { title: 'None (không gắn)' }, '—') : el('span', { title: RL[kind][i] }, RL.LABELS[kind][i]));
  const optText = (kind, i) => (i === 0 && NONE_KINDS.has(kind) ? 'không' : RL.LABELS[kind][i]);
  const num = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
  const fmtPoint = (p) => `${p[0]} ms = ${Number(p[1].toFixed(2))}`;

  const rcPendingCount = () => rc.pending.curves.size + rc.pending.coefs.size;
  function clearRecoilPending() { rc.pending.curves.clear(); rc.pending.coefs.clear(); rc.rev++; }
  const redrawRecoil = () => $('#app').replaceChildren(drawRecoil());
  const keepScroll = (fn) => { const y = window.scrollY; fn(); window.scrollTo(0, y); };
  const discardRecoilOk = () => rcPendingCount() === 0 || confirm(`Bỏ ${rcPendingCount()} chỉnh sửa độ giật chưa lưu?`);

  async function ensureRecoilDoc() {
    const cands = state.docs.filter((d) => d.kind === 'recoil');
    if (!cands.length) { rc.doc = null; rc.docId = null; return; }
    if (!cands.some((d) => d.id === rc.docId)) rc.docId = (cands.find((d) => d.selected) || cands[cands.length - 1]).id;
    if (!rc.doc || rc.doc.id !== rc.docId || rc.docAccount !== state.account) {
      rc.doc = await api('GET', `/accounts/${state.account}/docs/${rc.docId}`);
      rc.docAccount = state.account;
      rc.base = null; rc.cache = null; rc.picked = null;
      clearRecoilPending(); // the edits belonged to the document that was just replaced
    }
  }

  // base = the saved data; cache = the data with the unsaved edits applied (what every table and chart shows)
  function recoilIndex() {
    const baseKey = `${rc.doc.id}|${rc.doc.etag}|${rc.mode}`;
    if (!rc.base || rc.base.key !== baseKey) {
      const ds = RL.pickDataset(rc.doc.keymap, rc.mode);
      rc.base = { key: baseKey, ds, idx: ds ? RL.indexData(ds.data) : null };
      rc.cache = null;
    }
    if (!rc.base.ds) return { ds: null };
    if (rc.cache && rc.cache.rev === rc.rev && rc.cache.baseKey === baseKey) return rc.cache;
    let data = rc.base.ds.data;
    let idx = rc.base.idx;
    if (rcPendingCount()) {
      const out = RL.applyRecoilEdits(rc.doc.keymap, { mode: rc.mode, curves: [...rc.pending.curves.values()], coefs: [...rc.pending.coefs.values()], mirror: false });
      data = RL.pickDataset(out.next, rc.mode).data;
      idx = RL.indexData(data);
    }
    const summaries = data.map((_, w) => RL.weaponSummary(idx, w));
    return (rc.cache = { rev: rc.rev, baseKey, ds: rc.base.ds, idx, baseIdx: rc.base.idx, summaries });
  }

  // ---- edit operations
  const comboOf = (c) => ({ weapon: rc.weapon, scope: rc.scope, gesture: rc.gesture, grip: c.grip, muzzle: c.muzzle, stock: c.stock });

  function setCurve(o, curve) {
    try { RL.checkCurve(curve); } catch (e) { toast(e.message, true); return; }
    const ix = recoilIndex();
    const key = RL.comboKey(o);
    if (JSON.stringify(curve) === JSON.stringify(RL.resolve(ix.baseIdx, o).curve)) rc.pending.curves.delete(key); // back to the saved values
    else rc.pending.curves.set(key, { combo: o, curve });
    rc.rev++;
    keepScroll(redrawRecoil);
  }
  function mutateCurve(o, fn) {
    const cur = RL.resolve(recoilIndex().idx, o).curve.map((p) => [...p]);
    setCurve(o, fn(cur));
  }
  function setCoef(weapon, scope, name, value) {
    if (!Number.isFinite(value)) { toast('Hệ số không hợp lệ.', true); return; }
    const saved = (RL.coefficientsFor(recoilIndex().baseIdx, weapon, scope) || {})[name];
    const key = `${weapon}|${scope}|${name}`;
    if (saved === value) rc.pending.coefs.delete(key); else rc.pending.coefs.set(key, { weapon, scope, name, value });
    rc.rev++;
    keepScroll(redrawRecoil);
  }

  // A number you can click to edit (Enter = ok, Esc = cancel). When it differs from the saved value it is highlighted and gets a ↺ button.
  function editableCell({ value, format, savedValue, isNew = false, onCommit, onReset, label }) {
    const changed = isNew || (savedValue !== undefined && savedValue !== null && savedValue !== value);
    const span = el('span', { class: 'val', tabindex: '0', role: 'button', title: 'Bấm để sửa', 'aria-label': `${label}: ${format(value)}. Bấm để sửa` }, format(value));
    const begin = () => {
      const input = el('input', { type: 'number', step: 'any', value: String(value), 'aria-label': label });
      span.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        if (commit && input.value !== String(value)) {
          const n = Number(input.value);
          if (input.value.trim() !== '' && Number.isFinite(n)) onCommit(n); else toast('Giá trị không hợp lệ.', true);
        }
        if (input.isConnected) input.replaceWith(span);
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
      input.addEventListener('blur', () => finish(true));
    };
    span.addEventListener('click', begin);
    span.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); begin(); } });
    const reset = changed && !isNew && onReset
      ? el('button', { class: 'reset', title: `Đặt lại về giá trị đã lưu (${format(savedValue)})`, 'aria-label': `Đặt lại ${label} về ${format(savedValue)}`, onclick: (e) => { e.stopPropagation(); onReset(); } }, '↺') : null;
    return el('td', { class: `num editable${changed ? ' edited' : ''}` }, span, reset);
  }

  // ---- unsaved edits: summary, save, undo
  function pendingLines(ix) {
    const lines = [];
    for (const { combo: o, curve } of rc.pending.curves.values()) {
      const orig = RL.resolve(ix.baseIdx, o);
      const diffs = RL.curveDiff(orig.curve, curve);
      const parts = diffs.slice(0, 3).map((x) => (x.kind === 'changed' ? `mốc ${x.index}: ${fmtPoint(x.before)} → ${fmtPoint(x.after)}` : x.kind === 'added' ? `thêm mốc ${x.index}: ${fmtPoint(x.after)}` : `xóa mốc ${x.index}`));
      if (diffs.length > 3) parts.push(`… và ${diffs.length - 3} thay đổi nữa`);
      lines.push(`${RL.weaponLabel(o.weapon)} · ${POSTURE_VN[o.gesture]} · ${RL.LABELS.SCOPES[o.scope]} · tay cầm: ${optText('GRIPS', o.grip)} · nòng: ${optText('MUZZLES', o.muzzle)} · báng: ${optText('STOCKS', o.stock)} — ${parts.join('; ')}${orig.source === 'exact' ? '' : ' (sẽ tạo mục riêng mới)'}`);
    }
    for (const c of rc.pending.coefs.values()) {
      const saved = (RL.coefficientsFor(ix.baseIdx, c.weapon, c.scope) || {})[c.name];
      lines.push(`Hệ số «${RL.coefLabel(c.name)}» của ${RL.weaponLabel(c.weapon)} / ${RL.LABELS.SCOPES[c.scope]}: ${saved} → ${c.value}`);
    }
    return lines;
  }

  function pendingBar(ix) {
    if (!rcPendingCount()) return null;
    const mirrors = RL.mirrorTargets(rc.doc.keymap, rc.mode);
    return el('div', { class: 'warnbox' },
      el('b', {}, `Chỉnh sửa độ giật chưa lưu (${rcPendingCount()})`),
      el('ul', { class: 'pendinglist' }, pendingLines(ix).map((l) => el('li', {}, l))),
      mirrors.length ? el('label', { class: 'row' }, el('input', { type: 'checkbox', checked: rc.mirror, onchange: (e) => { rc.mirror = e.target.checked; } }),
        `Cập nhật cả ${mirrors.map((m) => `«${m}»`).join(', ')} (đang giống hệt bộ dữ liệu này)`) : null,
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', onclick: guard(saveRecoil) }, 'Lưu…'),
        el('button', { class: 'btn', onclick: () => { clearRecoilPending(); keepScroll(redrawRecoil); toast('Đã hoàn tác mọi chỉnh sửa chưa lưu'); } }, 'Hoàn tác tất cả')));
  }

  async function saveRecoil() {
    const ix = recoilIndex();
    const picked = rc.picked;
    const out = RL.applyRecoilEdits(rc.doc.keymap, { mode: rc.mode, curves: [...rc.pending.curves.values()], coefs: [...rc.pending.coefs.values()], mirror: rc.mirror });
    const intro = [
      el('p', {}, `Sẽ ghi vào bộ dữ liệu «${out.primary}»${out.mirrored.length ? ` và cập nhật cả ${out.mirrored.map((n) => `«${n}»`).join(', ')} (đang giống hệt)` : ''}.`),
      out.created ? el('p', { class: 'warnbox strong' }, `⚠ ${out.created} tổ hợp chưa có mục riêng sẽ được TẠO MỚI. Từ đó app dùng đúng đường cong bạn nhập thay vì tính từ đường cong nền × hệ số, nên sửa hệ số về sau sẽ không còn ảnh hưởng tổ hợp đó.`) : null,
      el('ul', {}, pendingLines(ix).map((l) => el('li', {}, l))),
    ];
    await confirmAndSave('keymap', rc.doc.keymap, out.next, {
      doc: rc.doc, title: 'Lưu chỉnh sửa độ giật', intro,
      after: async () => { await ensureRecoilDoc(); rc.picked = picked; redrawRecoil(); },
      reload: async () => { rc.doc = null; await ensureRecoilDoc(); redrawRecoil(); },
    });
  }

  // ---- drawing
  const svgEl = (tag, attrs = {}, ...kids) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };

  // original: the saved curve (drawn dashed while the curve is edited); onDrag(i, value): drag a point up/down to change its value
  function chart(curve, { original = null, onDrag = null } = {}) {
    const W = 640; const H = 240; const L = 56; const R = 14; const T = 14; const B = 30;
    const all = original ? curve.concat(original) : curve;
    const tMax = Math.max(...all.map((p) => p[0]), 1);
    const vs = all.map((p) => p[1]);
    const vMin = Math.min(0, ...vs);
    let vMax = Math.max(...vs);
    if (vMax === vMin) vMax = vMin + 1;
    vMax += (vMax - vMin) * 0.08;
    const x = (t) => L + (t / tMax) * (W - L - R);
    const y = (v) => T + (1 - (v - vMin) / (vMax - vMin)) * (H - T - B);
    const valueAt = (py) => vMax - ((py - T) / (H - T - B)) * (vMax - vMin);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Đường cong độ giật theo thời gian' });
    for (let i = 0; i <= 4; i++) {
      const v = vMin + ((vMax - vMin) * i) / 4;
      svg.append(svgEl('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }), svgEl('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, v.toFixed(0)));
      const t = (tMax * i) / 4;
      svg.append(svgEl('text', { x: x(t), y: H - 10, 'text-anchor': i === 4 ? 'end' : 'middle' }, `${Math.round(t)} ms`));
    }
    const line = (c, cls) => (c.length === 1
      ? svgEl('line', { class: `${cls} flat`, x1: L, x2: W - R, y1: y(c[0][1]), y2: y(c[0][1]) })
      : svgEl('polyline', { class: cls, fill: 'none', points: c.map(([t, v]) => `${x(t)},${y(v)}`).join(' ') }));
    if (original) svg.append(line(original, 'curve orig'));
    const main = line(curve, 'curve');
    svg.append(main);
    const live = curve.map((p) => [...p]);
    curve.forEach(([t, v], i) => {
      const dot = svgEl('circle', { class: `dot${onDrag ? ' drag' : ''}`, cx: x(t), cy: y(v), r: onDrag ? 6 : 3.5 }, svgEl('title', {}, `mốc ${i}: t=${t} ms, giá trị=${v}${onDrag ? ' (kéo lên/xuống để đổi giá trị)' : ''}`));
      svg.append(dot);
      if (!onDrag) return;
      let dragging = false;
      const toY = (e) => { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()).y; };
      dot.addEventListener('pointerdown', (e) => { e.preventDefault(); dragging = true; dot.setPointerCapture(e.pointerId); });
      dot.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const val = Math.min(Math.max(valueAt(toY(e)), vMin), vMax);
        live[i][1] = val;
        dot.setAttribute('cy', y(val));
        if (curve.length > 1) main.setAttribute('points', live.map(([tt, vv]) => `${x(tt)},${y(vv)}`).join(' '));
        else main.setAttribute('y1', y(val)), main.setAttribute('y2', y(val));
      });
      const stop = () => { if (!dragging) return; dragging = false; const val = Math.round(live[i][1] * 100) / 100; if (val !== curve[i][1]) onDrag(i, val); };
      dot.addEventListener('pointerup', stop);
      dot.addEventListener('pointercancel', stop);
    });
    return svg;
  }

  const sourceTag = (r) => {
    if (r.source === 'exact') return el('span', { class: 'tag ok' }, 'Có mục riêng');
    if (r.source === 'zero') return el('span', { class: 'tag' }, 'Luôn 0');
    return el('span', { class: 'tag warn' }, r.baseMissing ? 'Nền thiếu → 0' : `Tính ×${r.multiplier.toFixed(3)}`);
  };

  function drawRecoil() {
    const cands = state.docs.filter((d) => d.kind === 'recoil');
    if (!cands.length || !rc.doc) {
      return el('div', { class: 'card' }, el('h2', {}, 'Phân tích độ giật'),
        el('p', {}, `Chưa có bản cấu hình độ giật nào (không gian tên ${RC_NS}) trong tài khoản này. Hãy nhập backup hoặc chọn tài khoản khác.`));
    }
    const redraw = () => redrawRecoil();
    const ix = recoilIndex();
    const docSel = el('select', { 'aria-label': 'Bản config', onchange: guard(async (e) => { if (!discardRecoilOk()) { redraw(); return; } rc.docId = e.target.value; await ensureRecoilDoc(); redraw(); }) },
      cands.map((d) => el('option', { value: d.id, selected: d.id === rc.docId }, `${d.selected ? '★ ' : ''}${d.name || d.id} — ${d.add_time} — ${d.id.slice(0, 8)}`)));
    const modeSel = el('select', { 'aria-label': 'Bộ dữ liệu', onchange: (e) => { if (!discardRecoilOk()) { redraw(); return; } clearRecoilPending(); rc.mode = e.target.value; rc.picked = null; redraw(); } },
      Object.entries(MODE_VN).map(([m, label]) => el('option', { value: m, selected: m === rc.mode }, label)));
    const acctSel = el('select', { 'aria-label': 'Tài khoản', onchange: guard(async (e) => { if (!discardRecoilOk()) { redraw(); return; } state.account = e.target.value; await loadDocs(); await ensureRecoilDoc(); redraw(); }) },
      state.overview.accounts.map((a) => el('option', { value: a.id, selected: a.id === state.account }, a.id)));
    const head = el('div', { class: 'row' }, acctSel, docSel, el('label', {}, 'Bộ dữ liệu: '), modeSel);
    if (!ix.ds) return el('div', { class: 'card' }, head, el('p', {}, 'Bản này không có trường recoil_data.'));

    const sums = ix.summaries;
    const weaponName = (w) => RL.weaponLabel(w);
    const weaponSel = el('select', { 'aria-label': 'Súng', onchange: (e) => { rc.weapon = Number(e.target.value); rc.picked = null; redraw(); } },
      sums.map((s, w) => el('option', { value: w, selected: w === rc.weapon }, `${weaponName(w)} — ${s.keys} khóa${s.entries > s.keys ? `, ${s.entries} mục` : ''}`)));
    const sum = sums[rc.weapon] || { keys: 0, entries: 0, byGesture: [0, 0, 0], byScope: [] };
    const postureChips = el('div', { class: 'chips' }, POSTURE_VN.map((label, g) =>
      el('button', { class: 'chip', 'aria-pressed': rc.gesture === g, onclick: () => { rc.gesture = g; rc.picked = null; redraw(); } }, `${label} (${sum.byGesture[g] || 0})`)));
    const scopeChips = el('div', { class: 'chips' }, RL.SCOPES.map((raw, s) =>
      el('button', { class: 'chip', title: raw, 'aria-pressed': rc.scope === s, onclick: () => { rc.scope = s; rc.picked = null; redraw(); } }, `${RL.LABELS.SCOPES[s]} (${sum.byScope[s] || 0})`)));

    let combos = RL.exactCombos(ix.idx, rc.weapon, rc.scope, rc.gesture);
    if (rc.showAll) {
      combos = [];
      for (let g = 0; g < RL.GRIPS.length; g++) for (let m = 0; m < RL.MUZZLES.length; m++) for (let st = 0; st < RL.STOCKS.length; st++) combos.push({ grip: g, muzzle: m, stock: st });
    } else if (!combos.some((c) => !c.grip && !c.muzzle && !c.stock)) {
      combos.unshift({ grip: 0, muzzle: 0, stock: 0 });
    }
    const rows = combos.map((c) => {
      const o = comboOf(c);
      const r = RL.resolve(ix.idx, o);
      const st = RL.curveStats(r.curve);
      const edited = rc.pending.curves.has(RL.comboKey(o));
      const active = rc.picked && rc.picked.grip === c.grip && rc.picked.muzzle === c.muzzle && rc.picked.stock === c.stock;
      return el('tr', { class: `pick${active ? ' active' : ''}`, onclick: () => { rc.picked = c; redraw(); } },
        el('td', {}, opt('GRIPS', c.grip)), el('td', {}, opt('MUZZLES', c.muzzle)), el('td', {}, opt('STOCKS', c.stock)),
        el('td', {}, edited ? el('span', { class: 'tag edited' }, 'Đã sửa (chưa lưu)') : sourceTag(r), r.copies > 1 ? el('span', { class: 'tag', title: `${r.copies} mục trùng khóa, ${r.distinct} nội dung khác nhau; app dùng mục cuối` }, ` ×${r.copies}`) : null),
        el('td', { class: 'num' }, num(st.v0)), el('td', { class: 'num' }, num(st.vEnd)), el('td', { class: 'num' }, `${st.duration} ms`), el('td', { class: 'num' }, st.points));
    });
    const table = el('table', {},
      el('thead', {}, el('tr', {}, ['Tay cầm', 'Nòng', 'Báng', 'Nguồn', 'Giá trị t=0', 'Giá trị cuối', 'Thời lượng', 'Mốc'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colspan: 8, class: 'muted' }, 'Không có tổ hợp nào.'))));

    const left = el('div', {},
      el('div', { class: 'card' }, head,
        el('div', { class: 'row' }, el('label', {}, 'Súng: '), weaponSel,
          el('span', { class: 'muted' }, `${ix.ds.key} · ${sum.keys} khóa, ${sum.entries} mục`)),
        el('div', { class: 'muted' }, 'Tư thế'), postureChips, el('div', { class: 'muted' }, 'Ống ngắm (số khóa có dữ liệu)'), scopeChips,
        el('label', { class: 'row' }, el('input', { type: 'checkbox', checked: rc.showAll, onchange: (e) => { rc.showAll = e.target.checked; redraw(); } }), 'Hiện mọi tổ hợp, kể cả tổ hợp tính từ hệ số'),
        pendingBar(ix)),
      el('div', { class: 'card' }, el('h2', {}, `${weaponName(rc.weapon)} · ${POSTURE_VN[rc.gesture]} · ${RL.LABELS.SCOPES[rc.scope]}`), table,
        el('p', { class: 'muted' }, 'Bấm một dòng rồi bấm vào số cần sửa ở khung bên phải. Đơn vị của "giá trị" chưa xác định (chưa rõ app đọc thành pixel hay tốc độ). Thời gian tính từ lúc bắt đầu bắn.')));
    return el('div', { class: 'layout' }, left, el('div', {}, rc.picked ? viewRecoilDetail(ix) : el('div', { class: 'card muted' }, 'Bấm một dòng trong bảng để xem và sửa đường cong chi tiết.')));
  }

  function viewRecoilDetail(ix) {
    const c = rc.picked;
    const o = comboOf(c);
    const r = RL.resolve(ix.idx, o);
    const orig = RL.resolve(ix.baseIdx, o);
    const st = RL.curveStats(r.curve);
    const editable = r.source !== 'zero';
    const edited = rc.pending.curves.has(RL.comboKey(o));
    const savedCurve = orig.curve;
    const label = `${RL.weaponLabel(rc.weapon)} · ${POSTURE_VN[rc.gesture]} · ${RL.LABELS.SCOPES[rc.scope]} · tay cầm: ${optText('GRIPS', c.grip)} · nòng: ${optText('MUZZLES', c.muzzle)} · báng: ${optText('STOCKS', c.stock)}`;

    const rowsEl = r.curve.map(([t, v], i) => {
      const was = savedCurve[i];
      const isNew = !was;
      const disordered = i > 0 && t <= r.curve[i - 1][0];
      const cellT = editable
        ? editableCell({ value: t, format: String, savedValue: was ? was[0] : null, isNew, label: `Thời gian mốc ${i}`, onCommit: (n) => mutateCurve(o, (cv) => { cv[i][0] = Math.max(0, Math.round(n)); return cv; }), onReset: () => mutateCurve(o, (cv) => { cv[i][0] = was[0]; return cv; }) })
        : el('td', { class: 'num' }, t);
      const cellV = editable
        ? editableCell({ value: v, format: num, savedValue: was ? was[1] : null, isNew, label: `Giá trị mốc ${i}`, onCommit: (n) => mutateCurve(o, (cv) => { cv[i][1] = n; return cv; }), onReset: () => mutateCurve(o, (cv) => { cv[i][1] = was[1]; return cv; }) })
        : el('td', { class: 'num' }, num(v));
      const delta = i ? `${v - r.curve[i - 1][1] >= 0 ? '+' : ''}${(v - r.curve[i - 1][1]).toFixed(2)} / ${t - r.curve[i - 1][0]} ms` : '';
      return el('tr', { class: `${isNew ? 'newrow' : ''}${disordered ? ' warnrow' : ''}`, title: disordered ? 'Thời gian không lớn hơn mốc trước: đường cong nên tăng dần theo thời gian.' : undefined },
        el('td', {}, i, isNew ? el('span', { class: 'tag edited' }, ' mới') : null), cellT, cellV, el('td', { class: 'num muted' }, delta),
        editable ? el('td', { class: 'act' },
          el('button', { class: 'btn small', title: 'Chèn một mốc sau mốc này', 'aria-label': `Chèn mốc sau mốc ${i}`, onclick: () => mutateCurve(o, (cv) => { const a = cv[i]; const b = cv[i + 1]; cv.splice(i + 1, 0, b ? [Math.round((a[0] + b[0]) / 2), (a[1] + b[1]) / 2] : [a[0] + 100, a[1]]); return cv; }) }, '＋'), ' ',
          el('button', { class: 'btn small danger', disabled: r.curve.length <= 1, title: r.curve.length <= 1 ? 'Cần ít nhất một mốc' : 'Xóa mốc này', 'aria-label': `Xóa mốc ${i}`, onclick: () => mutateCurve(o, (cv) => { cv.splice(i, 1); return cv; }) }, '✕')) : null);
    });
    const removed = savedCurve.length > r.curve.length ? savedCurve.length - r.curve.length : 0;
    const pts = el('table', {}, el('thead', {}, el('tr', {}, ['#', 'Thời gian (ms)', 'Giá trị', 'Δ so với mốc trước', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rowsEl));

    const compare = el('table', {}, el('thead', {}, el('tr', {}, ['Tư thế', 'Nguồn', 'Giá trị t=0', 'Giá trị cuối', 'Thời lượng'].map((h) => el('th', {}, h)))),
      el('tbody', {}, POSTURE_VN.map((name, g) => {
        const rr = RL.resolve(ix.idx, { ...o, gesture: g });
        const s2 = RL.curveStats(rr.curve);
        return el('tr', { class: g === rc.gesture ? 'active' : '' }, el('td', {}, name), el('td', {}, sourceTag(rr)), el('td', { class: 'num' }, num(s2.v0)), el('td', { class: 'num' }, num(s2.vEnd)), el('td', { class: 'num' }, `${s2.duration} ms`));
      })));

    const coef = RL.coefficientsFor(ix.idx, rc.weapon, rc.scope);
    const savedCoef = RL.coefficientsFor(ix.baseIdx, rc.weapon, rc.scope) || {};
    const used = new Set(r.parts.map((p) => p.key));
    const coefTable = coef ? el('table', {}, el('tbody', {}, Object.entries(coef).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => {
      const cell = typeof v === 'number'
        ? editableCell({ value: v, format: (x) => Number(x.toFixed(4)).toString(), savedValue: savedCoef[k], label: `Hệ số ${RL.coefLabel(k)}`, onCommit: (n) => setCoef(rc.weapon, rc.scope, k, n), onReset: () => setCoef(rc.weapon, rc.scope, k, savedCoef[k]) })
        : el('td', { class: 'num' }, String(v));
      return el('tr', { class: used.has(k) ? 'active' : '' }, el('td', { title: k }, RL.coefLabel(k)), cell);
    }))) : el('p', { class: 'muted' }, 'Không có bảng hệ số.');

    return el('div', { class: 'card' },
      el('h2', {}, label),
      !editable ? el('p', { class: 'warnbox' }, 'Súng này luôn dùng đường cong 0 trong app nên không sửa được.') : null,
      editable && orig.source !== 'exact' ? el('p', { class: 'warnbox' }, orig.baseMissing
        ? 'Tổ hợp này chưa có mục riêng và cũng không có đường cong nền (app dùng 0). Nếu bạn sửa rồi lưu, mục riêng mới sẽ được tạo cho tổ hợp này.'
        : 'Tổ hợp này chưa có mục riêng (đang tính = đường cong nền × hệ số). Nếu bạn sửa rồi lưu, mục riêng mới sẽ được tạo cho tổ hợp này và app sẽ dùng nó thay vì phép tính.') : null,
      el('dl', { class: 'kv' },
        el('dt', {}, 'Nguồn'), el('dd', {}, edited ? el('span', { class: 'tag edited' }, 'Đã sửa (chưa lưu)') : sourceTag(r), r.source === 'exact' ? ' app dùng đúng mục này' : r.source === 'computed' ? ' = đường cong nền (đứng, không phụ kiện) × hệ số' : ''),
        r.multiplier != null ? [el('dt', {}, 'Hệ số nhân'), el('dd', {}, r.parts.length ? `${r.parts.map((p) => `${p.label} ${Number(p.value.toFixed(4))}`).join(' × ')} = ${r.multiplier.toFixed(4)}` : '1 (không có hệ số áp dụng)')] : null,
        r.copies > 1 ? [el('dt', {}, 'Trùng khóa'), el('dd', {}, `${r.copies} mục cùng khóa, ${r.distinct} nội dung khác nhau. App dùng mục xuất hiện cuối cùng, và đó là mục bạn đang sửa; các bản trùng khác giữ nguyên.`)] : null,
        el('dt', {}, 'Tóm tắt'), el('dd', {}, `${st.points} mốc, ${st.duration} ms, giá trị ${num(st.min)} … ${num(st.max)}`)),
      r.notes.length ? el('ul', { class: 'muted' }, r.notes.map((n) => el('li', {}, n))) : null,
      chart(r.curve, { original: edited ? savedCurve : null, onDrag: editable ? (i, val) => mutateCurve(o, (cv) => { cv[i][1] = val; return cv; }) : null }),
      editable ? el('p', { class: 'muted' }, 'Kéo một điểm lên/xuống để đổi giá trị của mốc đó. Đường nét đứt là đường cong đã lưu.') : null,
      el('h2', {}, 'Từng mốc'), pts,
      removed ? el('p', { class: 'muted' }, `Đã xóa ${removed} mốc so với bản đã lưu.`) : null,
      editable ? el('div', { class: 'row' },
        el('button', { class: 'btn small', onclick: () => mutateCurve(o, (cv) => { const last = cv[cv.length - 1]; cv.push([last[0] + 100, last[1]]); return cv; }) }, '＋ Thêm mốc cuối'),
        el('button', { class: 'btn small', disabled: !edited, onclick: () => { rc.pending.curves.delete(RL.comboKey(o)); rc.rev++; keepScroll(redrawRecoil); toast('Đã đặt lại đường cong về giá trị đã lưu'); } }, '↺ Đặt lại cả đường cong')) : null,
      el('h2', {}, 'So sánh tư thế (cùng phụ kiện, ống ngắm)'), compare,
      el('h2', {}, `Hệ số của ${RL.weaponLabel(rc.weapon)} / ${RL.LABELS.SCOPES[rc.scope]}`), coefTable,
      el('p', { class: 'muted' }, 'Sửa hệ số ảnh hưởng mọi tổ hợp của súng và ống ngắm này đang tính từ hệ số (không có mục riêng). Tổ hợp đã có mục riêng không bị ảnh hưởng.'),
      el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(JSON.stringify(r.curve)); toast('Đã sao chép đường cong (JSON)'); } }, 'Sao chép đường cong JSON')));
  }

  // ---------------------------------------------------------------- who is connected (phone app <-> this page)
  // This page pings the server every 10 s so the Android app can show "web: open"; the app sends a heartbeat every 15 s
  // and this page shows it. "Connected" means a sign of life in the last 40 s (devices) / 30 s (pages), not an open socket.
  const SESSION = `web-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const clockTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('vi-VN') : '—');
  const clockDateTime = (iso) => (iso ? new Date(iso).toLocaleString('vi-VN') : '—');
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
    } catch (e) {
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
        el('dt', {}, 'Lần đẩy lên gần nhất'), el('dd', {}, d.last_push ? `${clockDateTime(d.last_push.at)} — mới ${d.last_push.imported}, cập nhật ${d.last_push.updated}, giữ nguyên ${d.last_push.unchanged}, bỏ qua ${d.last_push.skipped}` : 'chưa có'),
        el('dt', {}, 'Lần nhập về gần nhất'), el('dd', {}, d.last_pull ? `${clockDateTime(d.last_pull.at)} — ${d.last_pull.files} file` : 'chưa có'),
        el('dt', {}, 'Lỗi gần nhất'), el('dd', {}, d.error || '—'),
        el('dt', {}, 'Thấy lần đầu'), el('dd', {}, clockDateTime(d.first_seen))),
      el('button', { class: 'btn small danger', onclick: guard(async () => { if (!confirm(`Quên thiết bị "${d.name}"? Nó sẽ hiện lại nếu app kết nối lần nữa.`)) return; await api('DELETE', `/sync/devices/${d.id}`); await render(); refreshConn(); }) }, 'Quên thiết bị')));
    return el('div', {}, head, ...cards);
  }

  async function viewBackups() {
    const { days } = await api('GET', '/sync/backups');
    const rows = days.length ? days.map((d) => el('tr', {},
      el('td', { class: 'mono' }, d.date), el('td', { class: 'num' }, d.docs), el('td', { class: 'num' }, d.files), el('td', { class: 'num' }, d.databases || 0), el('td', { class: 'num' }, fmtBytes(d.bytes)),
      el('td', { class: 'mono' }, clockDateTime(d.updated_at)), el('td', {}, d.last_actor || '—')))
      : el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'Chưa có bản sao lưu nào. Bản đầu tiên được tạo khi tài khoản đồng bộ có dữ liệu.'));
    return el('div', { class: 'card' }, el('h2', {}, 'Sao lưu theo ngày'),
      el('p', { class: 'muted' }, 'Mỗi ngày một thư mục (data/backups/<ngày>/) chứa bộ file cache đúng như trên điện thoại. Trong ngày thì ghi đè bằng trạng thái mới nhất, sang ngày mới thì tạo thư mục mới. '
        + 'Ngày tính theo giờ Việt Nam. Khôi phục: mở app Android → "Khôi phục theo ngày…" rồi chọn ngày.'),
      el('table', { class: 'stack' }, el('thead', {}, el('tr', {}, ['Ngày', 'Keymap', 'File cache', 'File cài đặt', 'Dung lượng', 'Cập nhật lúc', 'Cập nhật bởi'].map((h) => el('th', {}, h)))), el('tbody', {}, rows)));
  }

  // ---------------------------------------------------------------- the app's own preference files (Documents/jya2/databases)
  // Read-only here on purpose: the page shows and downloads what the phone sent; putting a file back is done from the Android app.
  function downloadText(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/xml;charset=utf-8' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function showDatabaseFile(name, day) {
    const f = day ? (await api('GET', `/sync/backups/${day}/databases`)).files.find((x) => x.name === name) : await api('GET', `/sync/databases/${encodeURIComponent(name)}`);
    if (!f) { toast('Không tìm thấy file này trong bản sao lưu.', true); return; }
    const secret = /adbkey/i.test(name);
    const id = await showModal({
      title: `${name}${day ? ` — ngày ${day}` : ''}`, tone: secret ? 'warn' : 'info',
      body: [secret ? el('p', { class: 'warnbox' }, 'File này nhiều khả năng chứa khóa riêng của app (ADB). Server không có đăng nhập: ai trong mạng nội bộ cũng xem được trang này.') : null,
        el('p', { class: 'muted' }, `${fmtBytes(new Blob([f.text]).size)} · chỉ xem, không sửa ở đây.`),
        el('pre', { class: 'mono tree xmlview' }, f.text)],
      actions: [{ id: 'close', label: 'Đóng' }, { id: 'download', label: 'Tải về', primary: true }],
    });
    if (id === 'download') downloadText(name, f.text);
  }

  // ---- editing one preference file on the server (the phone only changes when it is restored from the app)
  const dbDirty = () => !!state.dbEdit && state.dbEdit.text !== state.dbEdit.original;
  const dbEditDiscardOk = () => !dbDirty() || confirm('Bỏ các thay đổi chưa lưu của file cài đặt?');

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

  async function openDbEditor(name) {
    const f = await api('GET', `/sync/databases/${encodeURIComponent(name)}`);
    state.dbEdit = { name, original: f.text, text: f.text, etag: f.etag };
    await render();
  }

  async function dbHistory() {
    const e = state.dbEdit;
    const { versions } = await api('GET', `/sync/databases/${encodeURIComponent(e.name)}/history`);
    if (!versions.length) { toast('Chưa có bản cũ nào của file này.'); return; }
    const picked = await new Promise((resolve) => {
      showModal({
        title: `Bản cũ của ${e.name}`, tone: 'info',
        body: [el('p', { class: 'muted' }, `${versions.length} bản gần nhất. Chọn một bản để nạp vào ô soạn thảo (chưa lưu cho tới khi bạn bấm Lưu).`),
          el('div', { class: 'hits' }, versions.map((v) => el('div', {}, el('button', { class: 'btn small', onclick: (ev) => { resolve(v.version); ev.target.closest('.modal').querySelector('.modal-actions button').click(); } }, 'Nạp'), ' ',
            el('span', { class: 'mono' }, clockDateTime(v.saved_at)), ' ', el('span', { class: 'muted' }, fmtBytes(v.bytes)))))],
        actions: [{ id: 'close', label: 'Đóng' }],
      }).then(() => resolve(null));
    });
    if (!picked) return;
    const v = await api('GET', `/sync/databases/${encodeURIComponent(e.name)}/history/${encodeURIComponent(picked)}`);
    e.text = v.text;
    await render();
  }

  async function saveDbEdit() {
    const e = state.dbEdit;
    const bad = xmlProblem(e.text);
    if (bad) { toast(`XML chưa hợp lệ: ${bad}`, true); return; }
    const secret = /adbkey/i.test(e.name);
    const ok = await showModal({
      title: `Lưu thay đổi vào ${e.name}?`,
      body: [el('p', {}, `Server sẽ giữ bản hiện tại trong lịch sử (tối đa 10 bản) rồi thay bằng nội dung bạn vừa sửa (${fmtBytes(new Blob([e.text]).size)}).`),
        el('p', { class: 'warnbox' }, 'Máy tính bảng KHÔNG đổi theo. Muốn đưa về máy, mở app KeyMap Sync → "Khôi phục cài đặt theo ngày…" và chọn ngày hôm nay. Khi đó app Gamwing có thể ghi đè lại hoặc không đọc lại file; tôi chưa kiểm chứng.'),
        secret ? el('p', { class: 'warnbox strong' }, 'File này có thể là khóa riêng của app (ADB). Sửa sai có thể làm app mất quyền kết nối ADB.') : null],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'save', label: 'Lưu vào server', primary: true }],
    });
    if (ok !== 'save') return;
    try {
      await api('PUT', `/sync/databases/${encodeURIComponent(e.name)}`, { text: e.text, etag: e.etag });
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
    const bad = xmlProblem(e.text);
    const dirty = dbDirty();
    const status = el('p', { class: `status ${bad ? 'bad' : dirty ? 'ok' : ''}`, role: 'status' }, bad ? `XML chưa hợp lệ: ${bad}` : dirty ? 'XML hợp lệ, có thay đổi chưa lưu.' : 'Chưa có thay đổi.');
    const area = el('textarea', { class: 'editor mono', spellcheck: 'false', 'aria-label': `Nội dung ${e.name}`, oninput: (ev) => {
      e.text = ev.target.value;
      const p = xmlProblem(e.text);
      const d = dbDirty();
      status.className = `status ${p ? 'bad' : d ? 'ok' : ''}`;
      status.textContent = p ? `XML chưa hợp lệ: ${p}` : d ? 'XML hợp lệ, có thay đổi chưa lưu.' : 'Chưa có thay đổi.';
      save.disabled = !!p || !d;
    } });
    area.value = e.text;
    const save = el('button', { class: 'btn primary', onclick: guard(saveDbEdit) }, 'Lưu vào server');
    save.disabled = !!bad || !dirty;
    return el('div', { class: 'card' }, el('h2', {}, `Sửa ${e.name}`),
      el('p', { class: 'warnbox' }, 'Bạn đang sửa bản lưu trên server, không phải file trên máy tính bảng. Máy chỉ đổi khi bạn khôi phục từ app KeyMap Sync. '
        + 'Server chặn lưu khi XML sai cú pháp và giữ 10 bản cũ để quay lại.'),
      e.stale ? el('p', { class: 'warnbox strong' }, 'File đã đổi trên server từ lúc bạn mở.', ' ', el('button', { class: 'btn small', onclick: guard(() => openDbEditor(e.name)) }, 'Tải lại bản mới (bỏ thay đổi hiện tại)')) : null,
      area, status,
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: guard(async () => { if (!dbEditDiscardOk()) return; state.dbEdit = null; await render(); }) }, 'Hủy'),
        el('button', { class: 'btn', onclick: guard(dbHistory) }, 'Bản cũ…'),
        el('button', { class: 'btn', disabled: !dirty, onclick: guard(async () => { e.text = e.original; await render(); }) }, 'Hoàn tác về bản đang lưu'),
        save));
  }

  async function viewDatabases() {
    if (state.dbEdit) return viewDbEditor();
    const { days } = await api('GET', '/sync/backups');
    const day = state.dbDay && days.some((d) => d.date === state.dbDay) ? state.dbDay : '';
    const files = day ? (await api('GET', `/sync/backups/${day}/databases`)).files.map((f) => ({ name: f.name, bytes: new Blob([f.text]).size })) : (await api('GET', '/sync/databases')).files;
    const picker = el('select', { onchange: (e) => { state.dbDay = e.target.value; render(); } },
      el('option', { value: '' }, 'Mới nhất (bản app vừa gửi)'),
      days.filter((d) => d.databases).map((d) => el('option', { value: d.date, selected: d.date === day }, `Ngày ${d.date} (${d.databases} file)`)));
    const rows = files.length ? files.map((f) => el('tr', {},
      el('td', { class: 'mono' }, f.name), el('td', { class: 'num' }, fmtBytes(f.bytes)), el('td', { class: 'mono' }, f.updated_at ? clockDateTime(f.updated_at) : '—'),
      el('td', {}, el('button', { class: 'btn small', onclick: guard(() => showDatabaseFile(f.name, day)) }, 'Xem'), ' ',
        day ? null : el('button', { class: 'btn small', onclick: guard(() => openDbEditor(f.name)) }, 'Sửa'), day ? null : ' ',
        el('button', { class: 'btn small', onclick: guard(async () => { const x = day ? (await api('GET', `/sync/backups/${day}/databases`)).files.find((y) => y.name === f.name) : await api('GET', `/sync/databases/${encodeURIComponent(f.name)}`); if (x) downloadText(f.name, x.text); }) }, 'Tải về'))))
      : el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'Chưa có file cài đặt nào. Mở app KeyMap Sync, đặt thư mục cài đặt (mặc định Documents/jya2/databases) rồi bấm "Đẩy lên server".'));
    return el('div', { class: 'card' }, el('h2', {}, 'Cài đặt của Gamwing (Documents/jya2/databases)'),
      el('p', { class: 'muted' }, 'Các file XML cài đặt mà app Gamwing lưu trên máy (kể cả bản chép cache keymap). App KeyMap Sync gửi lên; server giữ bản mới nhất và chép vào thư mục "databases" của mỗi ngày sao lưu. '
        + 'Không có file giấy phép/phiên đăng nhập (bị từ chối). Bấm "Sửa" để sửa trực tiếp bản trên server (chỉ với bản "Mới nhất"); khôi phục về máy làm từ app Android: "Khôi phục cài đặt theo ngày…".'),
      el('p', {}, 'Nguồn: ', picker),
      el('table', { class: 'stack' }, el('thead', {}, el('tr', {}, ['File', 'Dung lượng', 'Cập nhật lúc', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rows)));
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
