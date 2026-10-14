'use strict';
// Tab "Tiêu chuẩn súng": the table of accessories that the page checks the data against (RecoilLib.ATTACHMENT_RULES), one line per gun code with its
// number in the app's list, written like "M416 (22)". The table is the one built from the official 和平精英 data (see docs/PhuKien_Sung_PUBG_Mobile.xlsx).
// "Đối chiếu với dữ liệu thật" adds two columns taken from the keymap cache on the server: how many own entries each gun has, and how many of them
// are against this table (those are what "Kiểm tra theo chuẩn" in the recoil analysis lists and deletes).
(() => {
  const { $, el, icon, pageHead, badge, alert, emptyState, api, guard, copyText, labelStacked, skeleton } = window.Ui;
  const RL = window.RecoilLib;
  const CX = window.CacheXml;
  const TF = window.TableFilter;
  const FU = window.FilterUi;
  const CACHE_FILE = 'gamwing_keymap_cache.xml';

  const CLASS_VN = { ar: 'Súng trường tấn công', smg: 'Tiểu liên', dmr: 'Súng thiện xạ (DMR)', sr: 'Súng bắn tỉa (SR)', sg: 'Shotgun', lmg: 'Súng máy (LMG)', other: 'Khác' };
  const GUN_CLASS = {
    AKM: 'ar', M16: 'ar', M416: 'ar', Scar: 'ar', Groza: 'ar', AUG: 'ar', QBZ: 'ar', M762: 'ar', MK47: 'ar', G36C: 'ar', ACE32: 'ar', FAMAS: 'ar',
    UZI: 'smg', Thomson: 'smg', UMP45: 'smg', Vector: 'smg', Bison: 'smg', MP5K: 'smg', P90: 'smg',
    VSS: 'dmr', SKS: 'dmr', MK14: 'dmr', Mini14: 'dmr', SLR: 'dmr', QBU: 'dmr', MK12: 'dmr',
    AWM: 'sr', Kar98K: 'sr', M24: 'sr', Win94: 'sr', Mosin: 'sr', AMR: 'sr',
    S12K: 'sg', S1897: 'sg', S686: 'sg', DBS: 'sg', M1014: 'sg',
    M249: 'lmg', DP28: 'lmg', MG3: 'lmg', PKM: 'lmg',
    CrossBow: 'other',
  };
  // guns that have one secondary source only: not in the table until the user decides
  const WAITING = new Set(['Mosin', 'M1014', 'MP5K', 'P90', 'AMR']);
  const SHORT = {
    muzzle: { COMPENSATOR: 'hãm giật', FLASH_HIDER: 'ẩn tia lửa', SUPPRESSOR: 'giảm thanh', BRAKE: 'brake', EXTENDER: 'nối dài', BRAKE_NEW: 'brake (mới)' },
    grip: { VERTICAL: 'đứng', HORIZONTAL: 'tam giác', THUMB: 'ngón cái', HALF: 'half', LIGHT: 'nhẹ', LASER: 'laser', ERGONOMIC: 'công thái học' },
    stock: { GENERAL: 'báng chiến thuật', GENERAL_NEW: 'báng (mới)' },
  };
  const listText = (set, enumNames, map) => [...set].sort((a, b) => a - b).map((i) => map[enumNames[i]] || enumNames[i]).join(', ');
  const none = 'không';

  const st = { filters: {}, sort: null, pick: '', counts: null, docs: [], docId: '', mode: 'touch', loading: false, error: '', note: '' };

  // ---- one row per gun code (the first code, "Empty", is not a gun)
  function rows() {
    const out = [];
    for (let w = 1; w < RL.WEAPONS.length; w++) {
      const code = RL.WEAPONS[w];
      const a = RL.attachmentsFor(w);
      const zero = RL.isZeroWeapon(w);
      const status = a ? 'Có chuẩn' : zero ? 'Luôn 0' : WAITING.has(code) ? 'Chờ xác nhận' : 'Chưa có nguồn';
      const label = RL.weaponLabel(w);
      const c = st.counts && st.counts.get(w);
      out.push({
        w, code, label, tag: `${code} (${w})`, cls: CLASS_VN[GUN_CLASS[code]] || '—', a, status,
        muzzles: a ? (a.muzzles.size ? listText(a.muzzles, RL.MUZZLES, SHORT.muzzle) : none) : '—',
        grips: a ? (a.grips.size ? listText(a.grips, RL.GRIPS, SHORT.grip) : none) : '—',
        stocks: a ? (a.stocks.size ? listText(a.stocks, RL.STOCKS, SHORT.stock) : none) : '—',
        zoom: a ? (a.maxZoom === null ? 'không giới hạn' : a.maxZoom === 0 ? 'không lắp được' : `đến ${a.maxZoom}x`) : '—',
        source: a ? a.sourceLabel : '—',
        own: c ? c.own : null, bad: c ? c.bad : null,
      });
    }
    return out;
  }

  const COLS = [
    ['tag', 'Súng (số)', {}], ['cls', 'Loại', {}], ['muzzles', 'Nòng', {}], ['grips', 'Tay cầm', {}], ['stocks', 'Báng', {}],
    ['zoom', 'Ống ngắm', {}], ['status', 'Trạng thái', {}],
  ];
  const COUNT_COLS = [['own', 'Mục riêng', { numeric: true }], ['bad', 'Sai chuẩn', { numeric: true }]];
  const value = (r, col) => r[col];

  const statusBadge = (s) => badge(s, { 'Có chuẩn': 'ok', 'Chờ xác nhận': 'warn', 'Luôn 0': 'neutral', 'Chưa có nguồn': 'neutral' }[s] || 'neutral');

  // ---- the keymap cache of the server: how many own entries each gun has and how many are against the table
  async function loadCounts() {
    st.loading = true; st.error = '';
    refresh();
    try {
      const file = await api('GET', `/sync/databases/${encodeURIComponent(CACHE_FILE)}`);
      const analysis = CX.analyze(CX.parse(file.text));
      st.docs = [...analysis.docs].filter(([, d]) => Array.isArray(d.recoil_data)).map(([id, d]) => ({ id, name: typeof d.name === 'string' && d.name ? d.name : id.slice(0, 8), doc: d }));
      if (!st.docs.length) { st.error = 'File cache trên server chưa có mục độ giật nào.'; st.counts = null; } else {
        if (!st.docs.some((d) => d.id === st.docId)) st.docId = st.docs[0].id;
        compute();
      }
    } catch (e) {
      st.error = e.status === 404 ? `Server chưa có file ${CACHE_FILE}.` : e.message;
      st.counts = null;
    }
    st.loading = false;
    refresh();
  }

  function compute() {
    const item = st.docs.find((d) => d.id === st.docId);
    const ds = item && RL.pickDataset(item.doc, st.mode);
    if (!ds) { st.counts = null; st.error = 'Mục này không có bộ dữ liệu đó.'; return; }
    const idx = RL.indexData(ds.data);
    const counts = new Map();
    for (const key of idx.map.keys()) { const w = Number(key.split('|')[0]); (counts.get(w) || counts.set(w, { own: 0, bad: 0 }).get(w)).own++; }
    for (const e of RL.auditEntries(idx)) counts.get(e.weapon).bad++;
    st.counts = counts;
    st.note = `${item.name} · ${ds.key}`;
  }

  // ---- the page
  const refresh = () => { const app = $('#app'); if (app && app.dataset.view === 'standards') { app.replaceChildren(build()); labelStacked(app); } }; // only while this tab is the one on the page

  function inspector(r) {
    if (!r) return el('section', { class: 'card' }, emptyState('list', 'Chọn một súng', 'để xem đủ tiêu chuẩn phụ kiện và nguồn của nó.'));
    const a = r.a;
    return el('section', { class: 'card' },
      el('div', { class: 'row' }, el('h2', {}, r.tag), statusBadge(r.status)),
      el('p', { class: 'muted' }, [r.label !== r.code ? r.label : null, r.cls !== '—' ? r.cls : null].filter(Boolean).join(' · ') || ' '),
      a ? el('dl', { class: 'kv' },
        el('dt', {}, 'Nòng'), el('dd', {}, r.muzzles),
        el('dt', {}, 'Tay cầm'), el('dd', {}, r.grips),
        el('dt', {}, 'Báng'), el('dd', {}, r.stocks),
        el('dt', {}, 'Ống ngắm'), el('dd', {}, r.zoom),
        el('dt', {}, 'Nguồn'), el('dd', {}, r.source),
        r.own != null ? [el('dt', {}, 'Mục riêng trong dữ liệu'), el('dd', {}, `${r.own}${r.bad ? `, trong đó ${r.bad} sai chuẩn` : ', đều đúng chuẩn'}`)] : null)
        : el('p', {}, r.status === 'Luôn 0' ? 'App luôn dùng đường cong 0 cho mã này: không có gì để chuẩn hóa.'
          : r.status === 'Chờ xác nhận' ? 'Mới có một nguồn thứ cấp cho súng này. Khi bạn xác nhận, nó sẽ được thêm vào bảng; đến lúc đó mọi tổ hợp của nó vẫn được phép.'
            : 'Chưa tìm được nguồn đáng tin cho mã này, nên chưa có chuẩn: mọi tổ hợp của nó vẫn được phép và không bị kiểm tra.'),
      a ? el('p', { class: 'muted text-sm' }, a.note) : null,
      el('div', { class: 'row mt-4' }, el('button', { type: 'button', class: 'btn small', onclick: () => copyText(r.tag, 'Đã sao chép mã súng') }, icon('copy'), 'Sao chép mã')));
  }

  function build() {
    const all = rows();
    const cols = st.counts ? [...COLS, ...COUNT_COLS] : COLS;
    const visible = TF.sortRows(TF.applyFilters(all, st.filters, value), st.sort, value);
    const filtered = TF.countActive(st.filters) > 0;
    const setView = ({ filters, sort }) => { st.filters = filters; st.sort = sort; refresh(); };
    const clear = () => { st.filters = {}; st.sort = null; refresh(); };
    const pick = all.find((r) => r.code === st.pick);

    const fh = (label, col, o) => el('th', { 'aria-sort': FU.ariaSort(st.sort, col), class: o.numeric ? 'num' : '' }, FU.header({ label, col, rows: all, valueOf: value, filters: st.filters, sort: st.sort, onChange: setView, ...o }));
    const body = visible.map((r) => {
      const select = () => { st.pick = r.code; refresh(); };
      const td = (col, label, content, cls = '') => el('td', { 'data-label': label, class: cls }, content);
      return el('tr', { class: `pick${r.code === st.pick ? ' active' : ''}${r.status === 'Có chuẩn' ? '' : ' dim'}`, tabindex: '0', onclick: select, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } } },
        td('tag', 'Súng', el('span', { class: 'name' }, r.tag), r.label !== r.code ? el('span', { class: 'sub' }, r.label) : null),
        td('cls', 'Loại', r.cls),
        td('muzzles', 'Nòng', r.muzzles), td('grips', 'Tay cầm', r.grips), td('stocks', 'Báng', r.stocks),
        td('zoom', 'Ống ngắm', r.zoom),
        td('status', 'Trạng thái', statusBadge(r.status)),
        ...(st.counts ? [td('own', 'Mục riêng', r.own == null ? '—' : String(r.own), 'num'), td('bad', 'Sai chuẩn', r.bad == null ? '—' : String(r.bad), `num${r.bad ? ' bad' : ''}`)] : []));
    });
    const table = el('table', { class: 'std-table' },
      el('thead', {}, el('tr', {}, cols.map(([col, label, o]) => fh(label, col, o)))),
      el('tbody', {}, body.length ? body : el('tr', {}, el('td', { colspan: cols.length, class: 'muted' }, 'Không có súng nào khớp bộ lọc. ', el('button', { type: 'button', class: 'btn small', onclick: clear }, 'Xóa bộ lọc')))));

    const withRule = all.filter((r) => r.status === 'Có chuẩn').length;
    const compare = el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn small', disabled: st.loading, onclick: guard(loadCounts) }, icon('refresh'), st.loading ? 'Đang đọc dữ liệu…' : st.counts ? 'Đối chiếu lại' : 'Đối chiếu với dữ liệu thật'),
      st.docs.length > 1 ? el('select', { 'aria-label': 'Mục độ giật', onchange: (e) => { st.docId = e.target.value; compute(); refresh(); } }, st.docs.map((d) => el('option', { value: d.id, selected: d.id === st.docId }, d.name))) : null,
      st.counts ? el('select', { 'aria-label': 'Bộ dữ liệu', onchange: (e) => { st.mode = e.target.value; compute(); refresh(); } }, [['touch', 'Chạm thường'], ['gyro', 'Con quay (gyro)'], ['raw', 'Dữ liệu gốc']].map(([v, t]) => el('option', { value: v, selected: v === st.mode }, t))) : null,
      st.counts ? el('span', { class: 'muted' }, st.note) : null,
      filtered ? el('button', { type: 'button', class: 'btn small ghost', onclick: clear }, icon('x'), `Xóa bộ lọc (${TF.countActive(st.filters)})`) : null);

    return el('div', {},
      pageHead('Tiêu chuẩn súng', 'Phụ kiện và ống ngắm mà mỗi súng lắp được, theo dữ liệu chính thức 和平精英. Trang kiểm tra dữ liệu theo bảng này; số trong ngoặc là số thứ tự của súng trong dữ liệu.',
        el('span', { class: 'muted' }, `${withRule}/${all.length} súng đã có chuẩn`)),
      st.error ? alert('danger', el('span', {}, st.error)) : null,
      compare,
      el('div', { class: 'split' }, el('section', { class: 'card flush table-card std-card' }, table), el('aside', { class: 'inspector', 'aria-label': 'Chi tiết súng' }, inspector(pick))));
  }

  window.Standards = { async view() { return build(); } };
})();
