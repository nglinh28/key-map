'use strict';
// Tab "Tiêu chuẩn súng": the table of accessories that the page checks the data against (RecoilLib.ATTACHMENT_RULES), one line per gun code with its
// number in the app's list, written like "M416 (22)". The table is the one built from the official 和平精英 data (see docs/PhuKien_Sung_PUBG_Mobile.xlsx).
// "Đối chiếu với dữ liệu thật" adds two columns taken from the keymap cache on the server: how many own entries each gun has, and how many of them
// are against this table (those are what "Kiểm tra theo chuẩn" in the recoil analysis lists and deletes).
(() => {
  const { $, el, icon, pageHead, badge, alert, emptyState, api, guard, copyText, labelStacked, skeleton, showModal, toast } = window.Ui;
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
      const disabled = RL.isGunDisabled(w);
      const off = Object.prototype.hasOwnProperty.call(RL.getRuleOverrides(), code) && !a; // the user switched the rule off
      const status = a ? (a.edited ? 'Đã sửa' : 'Có chuẩn') : off ? 'Đã tắt chuẩn' : zero ? 'Luôn 0' : WAITING.has(code) ? 'Chờ xác nhận' : 'Chưa có nguồn';
      const label = RL.weaponLabel(w);
      const fire = zero ? null : RL.fireOf(w, { ignoreDisabled: true }); // a disabled gun keeps its data
      const c = st.counts && st.counts.get(w);
      out.push({
        w, code, label, tag: `${code} (${w})`, cls: CLASS_VN[RL.gunClass(w)] || CLASS_VN[GUN_CLASS[code]] || '—', a, status, edited: Boolean((a && a.edited) || off), zero, disabled,
        use: disabled ? 'Đã tắt' : 'Đang dùng',
        muzzles: a ? (a.muzzles.size ? listText(a.muzzles, RL.MUZZLES, SHORT.muzzle) : none) : '—',
        grips: a ? (a.grips.size ? listText(a.grips, RL.GRIPS, SHORT.grip) : none) : '—',
        stocks: a ? (a.stocks.size ? listText(a.stocks, RL.STOCKS, SHORT.stock) : none) : '—',
        zoom: a ? (a.maxZoom === null ? 'không giới hạn' : a.maxZoom === 0 ? 'không lắp được' : `đến ${a.maxZoom}x`) : '—',
        source: a ? a.sourceLabel : '—',
        fire, magazine: fire ? fire.magazine : null, interval: fire ? fire.interval : null, emptyS: fire ? Math.round(fire.emptyMs / 10) / 100 : null,
        own: c ? c.own : null, bad: c ? c.bad : null,
      });
    }
    return out;
  }

  const COLS = [
    ['tag', 'Súng (số)', {}], ['cls', 'Loại', {}], ['use', 'Sử dụng', {}], ['muzzles', 'Nòng', {}], ['grips', 'Tay cầm', {}], ['stocks', 'Báng', {}],
    ['zoom', 'Ống ngắm', {}], ['magazine', 'Băng', { numeric: true }], ['interval', 'Giây/phát', { numeric: true }], ['emptyS', 'Hết băng (s)', { numeric: true }], ['status', 'Trạng thái', {}],
  ];
  const COUNT_COLS = [['own', 'Mục riêng', { numeric: true }], ['bad', 'Sai chuẩn', { numeric: true }]];
  const value = (r, col) => r[col];
  const vnum = (n) => String(n).replace('.', ',');
  const secondsOf = (ms) => vnum(Math.round(ms / 10) / 100); // 2465 -> 2,47 (from the whole ms, so no 2.46 from float rounding)

  const statusBadge = (s) => badge(s, { 'Có chuẩn': 'ok', 'Đã sửa': 'info', 'Đã tắt chuẩn': 'warn', 'Chờ xác nhận': 'warn', 'Luôn 0': 'neutral', 'Chưa có nguồn': 'neutral' }[s] || 'neutral');
  const hasRule = (s) => s === 'Có chuẩn' || s === 'Đã sửa';

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

  // ---- "Sửa tiêu chuẩn": what this gun really takes in the game. Saved on the server (DATA_DIR/gun-standards.json) and used by every check,
  // suggestion, scan and AI question from then on, on the server and on this page.
  const ZOOM_CHOICES = [[null, 'không giới hạn'], [0, 'không lắp được ống ngắm'], [1, '1x (Red Dot, Holo)'], [2, '2x'], [3, '3x'], [4, '4x'], [6, '6x'], [8, '8x']];
  async function saveOverrides(promise, done) {
    const r = await promise;
    RL.setRuleOverrides(r.overrides);
    if (r.disabled) RL.setDisabledGuns(r.disabled);
    if (r.fire) RL.setFireOverrides(r.fire);
    if (st.counts) compute(); // "Sai chuẩn" follows the new table
    toast(done);
    refresh();
  }
  async function toggleGunUsage(r, willEnable) {
    const enabling = willEnable !== undefined ? willEnable : r.disabled;
    if (!enabling) {
      const ok = await showModal({
        title: `Tắt không sử dụng ${r.tag}?`, tone: 'warn',
        body: el('p', {}, `Khi tắt, các chức năng AI gợi ý mốc, hệ thống tìm súng tương tự và "Thêm tổ hợp" trong Phân tích cache sẽ không chọn và không sử dụng ${r.tag}. Dữ liệu hiện có của súng trong file không bị xóa.`),
        actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'disable', label: 'Tắt súng', danger: true }],
      });
      if (ok !== 'disable') return;
    }
    await saveOverrides(api('PUT', `/standards/${encodeURIComponent(r.code)}`, { disabled: !enabling }), enabling ? `${r.code}: đã bật sử dụng súng.` : `${r.code}: đã tắt không sử dụng súng.`);
  }

  async function editRule(r) {
    const a = r.a;
    const pick = {
      muzzles: new Set(a ? [...a.muzzles].map((i) => RL.MUZZLES[i]) : []),
      grips: new Set(a ? [...a.grips].map((i) => RL.GRIPS[i]) : []),
      stocks: new Set(a ? [...a.stocks].map((i) => RL.STOCKS[i]) : []),
    };
    // one group of accessories: a pill to tick for each option, how many are ticked, and "Chọn hết" / "Bỏ hết"
    const group = (title, list, labels, key) => {
      const names = list.slice(1);
      const count = el('span', { class: 'se-count' });
      const boxes = [];
      const paint = () => { count.textContent = `${pick[key].size}/${names.length}`; };
      const setAll = (on) => { names.forEach((name, k) => { boxes[k].checked = on; if (on) pick[key].add(name); else pick[key].delete(name); }); paint(); };
      const chips = names.map((name, k) => {
        const input = el('input', { type: 'checkbox', checked: pick[key].has(name), onchange: (e) => { if (e.target.checked) pick[key].add(name); else pick[key].delete(name); paint(); } });
        boxes.push(input);
        return el('label', { class: 'opt-chip' }, input, el('span', {}, (labels && labels[k + 1]) || name));
      });
      paint();
      return el('div', { class: 'se-group', role: 'group', 'aria-label': title },
        el('div', { class: 'se-group-head' }, el('strong', {}, title), count,
          el('span', { class: 'se-links' }, el('button', { type: 'button', class: 'se-link', onclick: () => setAll(true) }, 'Chọn hết'), el('button', { type: 'button', class: 'se-link', onclick: () => setAll(false) }, 'Bỏ hết'))),
        el('div', { class: 'opt-chips' }, chips));
    };
    const current = a ? a.maxZoom : null;
    const zoom = el('select', { 'aria-label': 'Ống ngắm tối đa' }, ZOOM_CHOICES.map(([v, t]) => el('option', { value: v === null ? '' : String(v), selected: current === v }, t)));
    const note = el('textarea', { rows: '2', maxlength: '300', placeholder: 'Ví dụ: đã kiểm tra trong game tháng 10/2026' });
    note.value = a && a.source === 'edited' ? a.note || '' : '';
    const useCheck = el('input', { type: 'checkbox', role: 'switch', checked: !r.disabled });
    const useRow = el('label', { class: 'se-switch' }, useCheck, el('span', { class: 'se-track', 'aria-hidden': 'true' }),
      el('span', { class: 'se-switch-text' }, el('strong', {}, 'Sử dụng súng này'), el('span', { class: 'muted text-sm' }, 'Tắt thì hệ thống và AI không chọn súng này, không gợi ý và không thêm tổ hợp cho nó.')));
    // fire parameters: what the gun fires (one normal magazine) -> T, the length of a recoil curve
    const f0 = r.fire;
    const magInput = el('input', { type: 'number', min: '2', max: '200', step: '1', inputmode: 'numeric', 'aria-label': 'Số viên một băng', value: f0 ? String(f0.magazine) : '' });
    const intInput = el('input', { type: 'number', min: '0.02', max: '3', step: 'any', inputmode: 'decimal', 'aria-label': 'Số giây giữa hai phát', value: f0 ? String(f0.interval) : '' });
    const emptyLine = el('p', { class: 'muted text-sm', role: 'status' });
    const typedFire = () => (magInput.value === '' && intInput.value === '' ? null : { magazine: magInput.value === '' ? NaN : Number(magInput.value), interval: intInput.value === '' ? NaN : Number(intInput.value) });
    const paintEmpty = () => {
      const f = typedFire();
      const c = f && RL.checkFire(f);
      emptyLine.textContent = !f ? 'Chưa có thông số bắn: các mốc của súng này giữ cách tính thời gian cũ (bước 450–678 ms).'
        : c.ok ? `Hết một băng: ${secondsOf(RL.emptyMsOf(c.fire))} s (${c.fire.magazine} viên × ${vnum(c.fire.interval)} s). Các mốc độ giật sẽ chia đều trên thời gian này.` : c.error;
    };
    magInput.oninput = paintEmpty; intInput.oninput = paintEmpty;
    paintEmpty();
    const fireBox = el('div', { class: 'se-card fire-box', role: 'group', 'aria-label': 'Thông số bắn (băng thường)' }, el('h3', {}, 'Thông số bắn (băng thường)'),
      el('div', { class: 'fire-grid' }, el('label', { class: 'field' }, 'Số viên một băng', magInput), el('label', { class: 'field' }, 'Giây giữa hai phát', intInput)),
      emptyLine,
      f0 ? el('p', { class: 'muted text-sm' }, `Đang dùng: ${f0.sourceLabel}${f0.note ? ` · ${f0.note}` : ''}.`) : null);
    const initial = JSON.stringify([[...pick.muzzles].sort(), [...pick.grips].sort(), [...pick.stocks].sort(), zoom.value, note.value]);
    for (;;) {
    const id = await showModal({
      title: `Sửa tiêu chuẩn: ${r.tag}`, tone: 'info', className: 'wide',
      body: [
        el('div', { class: 'se-head' }, statusBadge(r.status), r.disabled ? badge('Đã tắt sử dụng', 'danger') : badge('Đang sử dụng', 'ok'),
          el('span', { class: 'muted text-sm' }, [r.label !== r.code ? r.label : null, r.cls !== '—' ? r.cls : null].filter(Boolean).join(' · '))),
        el('p', { class: 'muted text-sm' }, 'Chọn đúng những gì súng này lắp được trong game. Bảng này là cơ sở để kiểm tra dữ liệu ("Sai chuẩn"), gợi ý và tạo tổ hợp, "Quét tất cả", và là điều AI được báo khi tính mốc: không chọn = súng không lắp được.'),
        el('div', { class: 'se-grid' },
          el('div', { class: 'se-col' },
            el('section', { class: 'se-card' }, el('h3', {}, 'Phụ kiện lắp được'),
              group('Đầu nòng', RL.MUZZLES, RL.LABELS.MUZZLES, 'muzzles'),
              group('Tay cầm', RL.GRIPS, RL.LABELS.GRIPS, 'grips'),
              group('Báng', RL.STOCKS, RL.LABELS.STOCKS, 'stocks'))),
          el('div', { class: 'se-col' },
            el('section', { class: 'se-card' }, el('h3', {}, 'Ống ngắm'), el('label', { class: 'field' }, 'Ống ngắm tối đa', zoom)),
            fireBox,
            el('section', { class: 'se-card' }, el('h3', {}, 'Ghi chú và sử dụng'),
              el('label', { class: 'field' }, 'Ghi chú (nguồn, lý do sửa)', note), useRow))),
        a ? el('p', { class: 'muted text-sm' }, `Quy tắc đang dùng: ${a.sourceLabel}.`) : el('p', { class: 'muted text-sm' }, 'Súng này chưa có chuẩn: lưu ở đây sẽ tạo chuẩn mới cho nó.'),
      ],
      actions: [{ id: 'cancel', label: 'Hủy' }, ...(a ? [{ id: 'off', label: 'Tắt chuẩn (cho phép mọi tổ hợp)' }] : []), { id: 'save', label: 'Lưu tiêu chuẩn', primary: true }],
    });
    if (id === 'off') {
      await saveOverrides(api('PUT', `/standards/${encodeURIComponent(r.code)}`, { rule: null, disabled: !useCheck.checked }), `${r.code}: đã tắt tiêu chuẩn.`);
      return;
    }
    if (id !== 'save') return;
    // the fire parameters are sent when they changed (both cleared = the gun has none), the rule only when its own fields changed
    const typed = typedFire();
    const fireChecked = typed && RL.checkFire(typed);
    if (fireChecked && !fireChecked.ok) { toast(fireChecked.error, true); continue; } // the window opens again with what was typed
    const fireNow = fireChecked ? fireChecked.fire : null;
    const fireChanged = JSON.stringify(fireNow) !== JSON.stringify(f0 ? { magazine: f0.magazine, interval: f0.interval } : null);
    const ruleChanged = JSON.stringify([[...pick.muzzles].sort(), [...pick.grips].sort(), [...pick.stocks].sort(), zoom.value, note.value]) !== initial;
    const body = { disabled: !useCheck.checked };
    if (ruleChanged) body.rule = { muzzles: [...pick.muzzles], grips: [...pick.grips], stocks: [...pick.stocks], maxZoom: zoom.value === '' ? null : Number(zoom.value), note: note.value };
    if (fireChanged) body.fire = fireNow;
    await saveOverrides(api('PUT', `/standards/${encodeURIComponent(r.code)}`, body), ruleChanged ? `${r.code}: đã lưu tiêu chuẩn mới. Mọi phép kiểm tra từ giờ dùng bảng này.` : fireChanged ? `${r.code}: đã lưu thông số bắn.` : `${r.code}: không có gì thay đổi.`);
    return;
    }
  }
  async function resetFire(r) {
    await saveOverrides(api('DELETE', `/standards/${encodeURIComponent(r.code)}/fire`), `${r.code}: đã dùng lại thông số bắn mặc định.`);
  }
  async function resetRule(r) {
    const ok = await showModal({
      title: `Khôi phục tiêu chuẩn mặc định của ${r.tag}?`, tone: 'warn',
      body: el('p', {}, 'Bỏ phần bạn đã sửa và dùng lại bảng chuẩn có sẵn (dữ liệu chính thức 和平精英) cho súng này.'),
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'reset', label: 'Khôi phục mặc định', danger: true }],
    });
    if (ok !== 'reset') return;
    await saveOverrides(api('DELETE', `/standards/${encodeURIComponent(r.code)}`), `${r.code}: đã dùng lại tiêu chuẩn mặc định.`);
  }

  // ---- the page
  const refresh = () => { const app = $('#app'); if (app && app.dataset.view === 'standards') { app.replaceChildren(build()); labelStacked(app); } }; // only while this tab is the one on the page

  function inspector(r) {
    if (!r) return el('section', { class: 'card' }, emptyState('list', 'Chọn một súng', 'để xem đủ tiêu chuẩn phụ kiện và nguồn của nó.'));
    const a = r.a;
    return el('section', { class: 'card' },
      el('div', { class: 'row' }, el('h2', {}, r.tag), r.disabled ? badge('Đã tắt sử dụng', 'danger') : badge('Đang sử dụng', 'ok'), statusBadge(r.status)),
      r.disabled ? alert('warn', el('span', {}, 'Súng này đang BỊ TẮT KHÔNG SỬ DỤNG. Các chức năng AI, hệ thống gợi ý và Phân tích cache -> Thêm tổ hợp sẽ không chọn và không sử dụng súng này.')) : null,
      el('p', { class: 'muted' }, [r.label !== r.code ? r.label : null, r.cls !== '—' ? r.cls : null].filter(Boolean).join(' · ') || ' '),
      a ? el('dl', { class: 'kv' },
        el('dt', {}, 'Nòng'), el('dd', {}, r.muzzles),
        el('dt', {}, 'Tay cầm'), el('dd', {}, r.grips),
        el('dt', {}, 'Báng'), el('dd', {}, r.stocks),
        el('dt', {}, 'Ống ngắm'), el('dd', {}, r.zoom),
        el('dt', {}, 'Nguồn'), el('dd', {}, r.source),
        r.own != null ? [el('dt', {}, 'Mục riêng trong dữ liệu'), el('dd', {}, `${r.own}${r.bad ? `, trong đó ${r.bad} sai chuẩn` : ', đều đúng chuẩn'}`)] : null)
        : el('p', {}, r.status === 'Đã tắt chuẩn' ? 'Bạn đã tắt tiêu chuẩn của súng này: mọi tổ hợp đều được phép, không bị kiểm tra. "Khôi phục mặc định" để dùng lại bảng chuẩn.'
          : r.status === 'Luôn 0' ? 'App luôn dùng đường cong 0 cho mã này: không có gì để chuẩn hóa.'
          : r.status === 'Chờ xác nhận' ? 'Mới có một nguồn thứ cấp cho súng này. Khi bạn xác nhận, nó sẽ được thêm vào bảng; đến lúc đó mọi tổ hợp của nó vẫn được phép.'
            : 'Chưa tìm được nguồn đáng tin cho mã này, nên chưa có chuẩn: mọi tổ hợp của nó vẫn được phép và không bị kiểm tra.'),
      a ? el('p', { class: 'muted text-sm' }, a.note) : null,
      r.zero ? null : el('dl', { class: 'kv' },
        el('dt', {}, 'Băng thường'), el('dd', {}, r.fire ? `${r.fire.magazine} viên` : 'chưa có số liệu'),
        el('dt', {}, 'Giây giữa hai phát'), el('dd', {}, r.fire ? vnum(r.fire.interval) : '—'),
        el('dt', {}, 'Hết một băng'), el('dd', {}, r.fire ? `${secondsOf(r.fire.emptyMs)} s` : 'chưa có số liệu: các mốc dùng bước thời gian cũ'),
        r.fire ? [el('dt', {}, 'Nguồn thông số'), el('dd', {}, `${r.fire.sourceLabel}${r.fire.note ? ` · ${r.fire.note}` : ''}`)] : null),
      el('div', { class: 'row mt-4' },
        r.zero ? null : el('button', { type: 'button', class: 'btn small primary', onclick: guard(() => editRule(r)) }, icon('pencil'), 'Sửa tiêu chuẩn'),
        el('button', { type: 'button', class: `btn small ${r.disabled ? 'ok' : 'danger'}`, onclick: guard(() => toggleGunUsage(r)) }, icon(r.disabled ? 'check' : 'x'), r.disabled ? 'Bật sử dụng súng' : 'Tắt không sử dụng'),
        r.edited ? el('button', { type: 'button', class: 'btn small', onclick: guard(() => resetRule(r)) }, icon('history'), 'Khôi phục mặc định') : null,
        r.fire && r.fire.edited ? el('button', { type: 'button', class: 'btn small', onclick: guard(() => resetFire(r)) }, icon('history'), 'Đặt lại thông số bắn') : null,
        el('button', { type: 'button', class: 'btn small ghost', onclick: () => copyText(r.tag, 'Đã sao chép mã súng') }, icon('copy'), 'Sao chép mã')));
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
      return el('tr', { class: `pick${r.code === st.pick ? ' active' : ''}${hasRule(r.status) ? '' : ' dim'}${r.disabled ? ' gun-disabled' : ''}`, tabindex: '0', onclick: select, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } } },
        td('tag', 'Súng', el('span', { class: 'name' }, r.tag), r.label !== r.code ? el('span', { class: 'sub' }, r.label) : null),
        td('cls', 'Loại', r.cls),
        td('use', 'Sử dụng', el('button', { type: 'button', class: `btn mini ${r.disabled ? 'ghost' : 'ok'}`, title: r.disabled ? 'Đang tắt: bấm để bật sử dụng' : 'Đang dùng: bấm để tắt sử dụng', onclick: (e) => { e.stopPropagation(); toggleGunUsage(r); } }, r.disabled ? 'Đã tắt' : 'Đang dùng')),
        td('muzzles', 'Nòng', r.muzzles), td('grips', 'Tay cầm', r.grips), td('stocks', 'Báng', r.stocks),
        td('zoom', 'Ống ngắm', r.zoom),
        td('magazine', 'Băng', r.fire ? String(r.magazine) : '—', 'num'), td('interval', 'Giây/phát', r.fire ? vnum(r.interval) : '—', 'num'), td('emptyS', 'Hết băng (s)', r.fire ? secondsOf(r.fire.emptyMs) : '—', 'num'),
        td('status', 'Trạng thái', el('div', { class: 'inline-flex items-center gap-1' }, r.disabled ? badge('Đã tắt', 'danger') : null, statusBadge(r.status))),
        ...(st.counts ? [td('own', 'Mục riêng', r.own == null ? '—' : String(r.own), 'num'), td('bad', 'Sai chuẩn', r.bad == null ? '—' : String(r.bad), `num${r.bad ? ' bad' : ''}`)] : []));
    });
    const table = el('table', { class: 'std-table' },
      el('thead', {}, el('tr', {}, cols.map(([col, label, o]) => fh(label, col, o)))),
      el('tbody', {}, body.length ? body : el('tr', {}, el('td', { colspan: cols.length, class: 'muted' }, 'Không có súng nào khớp bộ lọc. ', el('button', { type: 'button', class: 'btn small', onclick: clear }, 'Xóa bộ lọc')))));

    const withRule = all.filter((r) => hasRule(r.status)).length;
    const edited = all.filter((r) => r.edited).length;
    const disabledCount = all.filter((r) => r.disabled).length;
    const compare = el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn small', disabled: st.loading, onclick: guard(loadCounts) }, icon('refresh'), st.loading ? 'Đang đọc dữ liệu…' : st.counts ? 'Đối chiếu lại' : 'Đối chiếu với dữ liệu thật'),
      st.docs.length > 1 ? el('select', { 'aria-label': 'Mục độ giật', onchange: (e) => { st.docId = e.target.value; compute(); refresh(); } }, st.docs.map((d) => el('option', { value: d.id, selected: d.id === st.docId }, d.name))) : null,
      st.counts ? el('select', { 'aria-label': 'Bộ dữ liệu', onchange: (e) => { st.mode = e.target.value; compute(); refresh(); } }, [['touch', 'Chạm thường'], ['gyro', 'Con quay (gyro)'], ['raw', 'Dữ liệu gốc']].map(([v, t]) => el('option', { value: v, selected: v === st.mode }, t))) : null,
      st.counts ? el('span', { class: 'muted' }, st.note) : null,
      filtered ? el('button', { type: 'button', class: 'btn small ghost', onclick: clear }, icon('x'), `Xóa bộ lọc (${TF.countActive(st.filters)})`) : null);

    return el('div', {},
      pageHead('Tiêu chuẩn súng', 'Phụ kiện và ống ngắm mà mỗi súng lắp được, theo dữ liệu chính thức 和平精英. Trang kiểm tra dữ liệu theo bảng này; số trong ngoặc là số thứ tự của súng trong dữ liệu.',
        el('span', { class: 'muted' }, `${withRule}/${all.length} súng đã có chuẩn${edited ? ` · ${edited} súng bạn đã sửa` : ''}${disabledCount ? ` · ${disabledCount} súng đã tắt` : ''}`)),
      st.error ? alert('danger', el('span', {}, st.error)) : null,
      compare,
      el('div', { class: 'split' }, el('section', { class: 'card flush table-card std-card' }, table), el('aside', { class: 'inspector', 'aria-label': 'Chi tiết súng' }, inspector(pick))));
  }

  window.Standards = { async view() { return build(); } };
})();
