'use strict';
// Tab "Phân tích cache": reads gamwing_keymap_cache.xml from the server and shows what is inside it.
// Key maps and AI recognition maps are drawn on a screen; recoil configs are analysed per gun and their curves can be edited
// (recoil.js checks and applies the edit; replaceMapItem in cachexml.js writes the one item back, the rest of the file byte for byte).
// Items can be deleted: from the file on the server at once, and on the tablet by the app (a command it picks up).
(() => {
  const { $, el, svgEl, icon, pageHead: head, fmtBytes, short, textBytes, clockDateTime, toast, api, guard, showModal, badge, alert, emptyState, segmented, menuButton, skeleton, setCrumbs, copyText, labelStacked, choiceCard } = window.Ui;
  const CX = window.CacheXml;
  const LL = window.LayoutLib;
  const RL = window.RecoilLib;
  const TF = window.TableFilter;
  const FU = window.FilterUi;
  const CACHE_FILE = 'gamwing_keymap_cache.xml';
  const REFS_FILE = 'ft_map_server_v1.xml'; // also writes the ids of the documents it knows
  const KIND_VN = { keymap: 'Sơ đồ phím', recognition: 'Nhận diện AI', recoil: 'Độ giật / Cấu hình', unknown: 'Không rõ' };

  // data: the loaded file and its analysis; pick: the row selected in the list (shown in the inspector);
  // sel: the item opened in the viewer { id, kind, ns, label }; refs: id -> where else the id is written
  const AUTO_KEY = 'ftAdminAutoStep';
  const loadAutoStep = () => { try { return localStorage.getItem(AUTO_KEY) !== 'off'; } catch { return true; } };
  const vn = (n) => String(n).replace('.', ','); // 1.02 -> 1,02
  const secondsText = (ms) => vn(Math.round(ms / 10) / 100); // 2465 -> 2,47 (from the whole ms)
  let aiStatusP = null;
  let aiStatusAt = 0;
  const aiStatus = (force = false) => {
    if (force || !aiStatusP || Date.now() - aiStatusAt > 10000) {
      aiStatusAt = Date.now();
      aiStatusP = api('GET', '/ai/status').catch(() => ({ enabled: false, model: '' }));
    }
    return aiStatusP;
  };
  const DIR_KEY = 'ftAdminStepDir';
  const loadStepDir = () => { try { const d = localStorage.getItem(DIR_KEY); return RL.DIRECTIONS.includes(d) ? d : 'up'; } catch { return 'up'; } };
  const DIR_VN = { up: 'Tăng (+)', down: 'Giảm (−)', random: 'Tăng hoặc giảm (ngẫu nhiên)' };
  const stepHint = () => `Mốc mới và các mốc sau nối tiếp mốc đứng trước, cộng dồn: thời gian +${RL.STEP.time[0]}–${RL.STEP.time[1]} ms; giá trị +${vn(RL.STEP.value[0])}–${vn(RL.STEP.value[1])} (hướng Tăng) hoặc −${vn(RL.STEP.value[0])}–${vn(RL.STEP.value[1])} (hướng Giảm).`;

  const S = { src: '', days: [], versions: [], data: null, error: '', pick: '', sel: null, refs: new Map(), cmds: [], pending: '' };
  const defaultWeapon = () => {
    const aug = RL.WEAPONS.indexOf('AUG');
    if (!RL.isGunDisabled(aug)) return aug;
    for (let w = 1; w < RL.WEAPONS.length; w++) {
      if (!RL.isZeroWeapon(w) && !RL.isGunDisabled(w)) return w;
    }
    return aug;
  };
  const rc = { mode: 'touch', weapon: defaultWeapon(), category: null, scope: 1, gesture: 0, showAll: false, picked: null, docId: null, idx: null, editCurve: null, editKey: '', dirty: false, bad: new Set(), autoStep: loadAutoStep(), stepDir: loadStepDir(), sugg: null, filters: {}, sort: null, drafts: new Map(), bulk: null, fresh: false, freshBase: null, itemId: '' }; // drafts: recoilKey -> { curve, source } points made for an added combination, not saved yet; bulk: the "AI tạo mốc" run // filters / sort: the Excel-like filter buttons of the combinations table // bad: boxes ("row:col") holding something that is not a finite number
  const lay = { screenId: '', origin: 'topleft', custom: { w: 2960, h: 1848 }, selected: null, bg: { url: null, opacity: 0.3 } };


  let active = false; // false once another tab is open: a slow reload must not draw over it
  let pollTimer = null;
  // Draws the page again. The height of the old page is held while it is swapped for the new one, so the scroll position does not jump and
  // the page does not flash; smooth = a short cross-fade (after a save), where the browser can do it.
  const redraw = ({ smooth = false } = {}) => {
    if (!active) return;
    const y = window.scrollY;
    const app = $('#app');
    const detailNow = app.querySelector('.recoil-detail-col'); // the detail scrolls inside itself (sticky column): keep its place across a redraw of the same combination
    const detailTop = detailNow ? detailNow.scrollTop : 0;
    const detailKey = rc.editKey;
    app.style.minHeight = `${app.offsetHeight}px`;
    const swap = () => {
      app.replaceChildren(draw());
      labelStacked(app);
      window.scrollTo(0, y);
      const detailNext = app.querySelector('.recoil-detail-col');
      if (detailNext && detailTop && rc.editKey === detailKey) detailNext.scrollTop = detailTop;
    };
    const release = () => requestAnimationFrame(() => { app.style.minHeight = ''; });
    const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (smooth && !calm && document.startViewTransition) {
      try { document.startViewTransition(swap).finished.then(release, release); return; } catch { /* the plain swap below */ }
    }
    swap();
    release();
  };
  const latest = () => S.src === '';
  // the source: '' = newest on the server; 'YYYY-MM-DD' = a daily backup; 'v:<version>' = an older version of the file kept in its history (has the time)
  const versionOf = () => (S.src.startsWith('v:') ? S.src.slice(2) : '');
  const srcLabel = () => {
    const v = versionOf();
    if (v) { const x = S.versions.find((q) => q.version === v); return `bản trước lúc ${x ? clockDateTime(x.saved_at) : v}`; }
    return `sao lưu ngày ${S.src}`;
  };
  // Saving from an older source writes it over the newest file: ask once, clearly. true = go on (or it is the newest anyway).
  async function oldSourceOk() {
    if (latest()) return true;
    const ok = await showModal({
      title: 'Lưu từ một mốc cũ?', tone: 'danger',
      body: [el('p', {}, `Bạn đang xem ${srcLabel()}. Lưu sẽ thay TOÀN BỘ ${CACHE_FILE} mới nhất trên server bằng bản này cộng chỉnh sửa của bạn: mọi thay đổi sau mốc này sẽ mất khỏi bản mới nhất.`),
        S.cmds.some((c) => c.status === 'pending') ? el('p', {}, 'Có lệnh xóa mục đang chờ máy tính bảng nhận: các mục đó có thể xuất hiện lại trên server khi lưu, rồi bị máy tính bảng xóa sau.') : null,
        el('p', { class: 'muted' }, 'Bản mới nhất hiện tại vẫn nằm trong lịch sử (tối đa 10 bản) để khôi phục. Bản nháp chưa lưu của mốc khác đã bị bỏ khi đổi nguồn.')],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'go', label: 'Tôi hiểu, tiếp tục', danger: true }],
    });
    return ok === 'go';
  }

  // Leaving a curve that was changed but not saved: ask once, with the same dialog as everything else. true = go on.
  async function discardOk() {
    if (!rc.dirty) return true;
    if (rc.freshBase && JSON.stringify(rc.editCurve) === rc.freshBase) return true; // an added combination nobody has touched: nothing to lose
    const review = rc.drafts.get(rc.editKey);
    if (review && review.review) return true; // "AI đề xuất" for an existing entry: the draft keeps the edits, "Lưu tất cả" writes it
    if (rc.fresh && rc.editKey && rc.editCurve) {
      // an added combination keeps what was done to it ("Lưu tất cả" writes it with the others): nothing is lost by leaving
      const prev = rc.drafts.get(rc.editKey);
      rc.drafts.set(rc.editKey, { curve: rc.editCurve, source: prev ? prev.source : 'edit' });
      return true;
    }
    const ok = await showModal({
      title: 'Bỏ thay đổi chưa lưu?', tone: 'warn',
      body: el('p', {}, 'Các thay đổi chưa lưu của đường cong độ giật sẽ mất.'),
      actions: [{ id: 'stay', label: 'Ở lại' }, { id: 'drop', label: 'Bỏ thay đổi', danger: true }],
    });
    if (ok !== 'drop') return false;
    rc.dirty = false;
    rc.editCurve = null;
    rc.bad.clear();
    return true;
  }

  // Count unsaved drafts and custom combos for a weapon vs other weapons in memory
  function weaponDraftStats(targetWeapon = null) {
    let mine = 0;
    let others = 0;
    const otherWeapons = new Set();
    const currentW = targetWeapon !== null ? targetWeapon : rc.weapon;

    if (rc.customCombos) {
      for (const k of rc.customCombos) {
        const w = Number(k.split('|')[0]);
        if (w === currentW) mine++;
        else { others++; otherWeapons.add(w); }
      }
    }
    if (rc.drafts) {
      for (const [k, d] of rc.drafts) {
        const w = d && d.o && typeof d.o.weapon === 'number' ? d.o.weapon : Number(k.split('|')[0]);
        if (w === currentW) mine++;
        else { others++; otherWeapons.add(w); }
      }
    }
    if (rc.picked && rc.dirty && rc.editCurve) {
      if (rc.weapon === currentW) mine++;
      else { others++; otherWeapons.add(rc.weapon); }
    }
    return { mine, others, otherWeapons: [...otherWeapons] };
  }

  function clearDraftsForWeapon(w) {
    if (rc.customCombos) {
      for (const k of [...rc.customCombos]) {
        if (Number(k.split('|')[0]) === w) rc.customCombos.delete(k);
      }
    }
    if (rc.drafts) {
      for (const [k, d] of [...rc.drafts]) {
        const gun = d && d.o && typeof d.o.weapon === 'number' ? d.o.weapon : Number(k.split('|')[0]);
        if (gun === w) rc.drafts.delete(k);
      }
    }
    if (rc.weapon === w) {
      rc.picked = null;
      rc.editCurve = null;
      rc.dirty = false;
      rc.bad.clear();
    }
    if (typeof paintSaveAll === 'function') paintSaveAll();
  }

  function clearDraftsForOtherWeapons(keepWeapon = rc.weapon) {
    if (rc.customCombos) {
      for (const k of [...rc.customCombos]) {
        const w = Number(k.split('|')[0]);
        if (w !== keepWeapon) rc.customCombos.delete(k);
      }
    }
    if (rc.drafts) {
      for (const [k, d] of [...rc.drafts]) {
        const w = d && d.o && typeof d.o.weapon === 'number' ? d.o.weapon : Number(k.split('|')[0]);
        if (w !== keepWeapon) rc.drafts.delete(k);
      }
    }
    if (typeof paintSaveAll === 'function') paintSaveAll();
  }

  async function loadRefs(day) {
    S.refs = new Map();
    if (day === null) return; // an older version of the file: the refs file has no matching version
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
    try { S.cmds = (await api('GET', '/cache/commands')).commands.filter((c) => c.type === 'delete_cache_items'); } catch { S.cmds = []; }
  }

  async function load() {
    S.error = '';
    S.data = null;
    const name = encodeURIComponent(CACHE_FILE);
    const [daysR, verR] = await Promise.all([api('GET', '/sync/backups'), api('GET', `/sync/databases/${name}/history`).catch(() => ({ versions: [] }))]);
    S.days = daysR.days.filter((d) => d.databases > 0);
    S.versions = verR.versions || [];
    if (S.src && !(versionOf() ? S.versions.some((v) => v.version === versionOf()) : S.days.some((d) => d.date === S.src))) S.src = '';
    try {
      let file;
      if (versionOf()) {
        const v = await api('GET', `/sync/databases/${name}/history/${encodeURIComponent(versionOf())}`);
        const q = S.versions.find((x) => x.version === v.version);
        file = { name: CACHE_FILE, text: v.text, etag: '', bytes: textBytes(v.text), updated_at: q ? q.saved_at : null, folder: '' };
      } else file = await api('GET', S.src ? `/sync/backups/${S.src}/databases/${name}` : `/sync/databases/${name}`);
      const t0 = performance.now();
      const parsed = CX.parse(file.text);
      S.data = { file, parsed, analysis: CX.analyze(parsed), ms: Math.round(performance.now() - t0) };
      await Promise.all([loadRefs(versionOf() ? null : S.src), loadCommands()]);
    } catch (e) {
      if (e.status === 404) S.error = S.src ? `Mốc ${S.src.replace(/^v:/, '')} không có file ${CACHE_FILE}.` : `Server chưa có file ${CACHE_FILE}. Mở app KeyMap Sync, kiểm tra thư mục Documents/jya2/databases rồi bấm "Đẩy lên server".`;
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
    const what = el('details', { class: 'disclosure' }, el('summary', {}, 'Việc sẽ xảy ra và những gì không bị xóa'),
      el('div', { class: 'disclosure-body' }, el('ol', {},
        el('li', {}, 'Server: cắt các mục trên khỏi ', el('span', { class: 'mono' }, CACHE_FILE), ' ngay bây giờ. Bản trước được giữ trong lịch sử của file (10 bản gần nhất).'),
        el('li', {}, `Máy tính bảng: app KeyMap Sync nhận lệnh trong khoảng 15 giây (khi app đang bật Chạy ngầm), tự sửa file ${CACHE_FILE} trên máy, `
          + 'sau khi chép file cũ vào Documents/FTKeymapSync/backup/<thời gian>/databases/. Không hỏi lại trên máy.')),
        el('p', { class: 'muted text-sm' }, 'Không xóa các dòng khác: '
          + (refs.length ? `${refs.length} dòng ghi id này ở ${REFS_FILE} (${refs.map((r) => `document|…|${short(r.id)}`).join(', ')}) vẫn được giữ; ` : '')
          + 'bản chép dạng .json (nếu có) ở Documents/Gamwing/keymap_cache cũng không bị xóa. Gamwing có thể tải lại mục nếu nó đồng bộ lại từ server keymap của nó.')));
    const first = await showModal({
      title: `Xóa ${items.length} mục?`, tone: 'warn', step: 'Bước 1/2 · Kiểm tra',
      body: [list, targets,
        alert('warn', el('span', {}, 'Hãy ĐÓNG HẲN Gamwing trên máy tính bảng trước. Nếu Gamwing đang chạy nó có thể ghi đè lại file và mục bị xóa sẽ hiện lại; app sẽ kiểm tra lại sau vài giây và báo ở đây nếu điều đó xảy ra.')),
        what],
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
      const r = await api('POST', '/cache/delete', { file: CACHE_FILE, ids, etag: S.data.file.etag, labels: items.map((i) => i.label), items: items.map((i) => ({ id: i.id, label: i.label })) });
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
    if (!cmds.length) return null;
    return el('section', { class: 'card', 'aria-label': 'Lệnh xóa gần đây' }, el('h2', {}, 'Lệnh xóa gần đây'),
      el('ol', { class: 'timeline' }, cmds.map(commandItem)),
      el('p', { class: 'muted text-sm' }, 'App KeyMap Sync nhận lệnh khi gửi nhịp 15 giây (cần app đang bật Chạy ngầm).'));
  }

  function pollCommands(slot) {
    clearInterval(pollTimer);
    pollTimer = null;
    if (!S.cmds.some((c) => c.status === 'pending')) return;
    pollTimer = setInterval(async () => {
      if (!active || document.querySelector('.modal')) return;
      await loadCommands();
      if (slot.isConnected) slot.replaceChildren(...[commandsNode()].filter(Boolean));
      if (!S.cmds.some((c) => c.status === 'pending')) { clearInterval(pollTimer); pollTimer = null; }
    }, 4000);
  }

  // ---------------------------------------------------------------- list: groups of rows and the inspector
  function sourceControl() {
    const ids = [{ value: '', label: 'Bản mới nhất trên server' },
      ...S.versions.map((v) => ({ value: `v:${v.version}`, label: `Bản trước lúc ${clockDateTime(v.saved_at)}` })),
      ...S.days.map((x) => ({ value: x.date, label: `Sao lưu ngày ${x.date}` }))];
    const change = guard(async (v) => { if (!(await discardOk())) { redraw(); return; } S.src = v; S.sel = null; S.pick = ''; rc.drafts.clear(); rc.customCombos = new Set(); rc.itemId = ''; await refresh(); });
    return el('select', { 'aria-label': 'Nguồn dữ liệu (thời gian)', class: 'src-select', onchange: (e) => change(e.target.value) }, ids.map((o) => el('option', { value: o.value, selected: o.value === S.src }, o.label)));
  }

  function pageHead() {
    const d = S.data;
    const refreshBtn = el('button', { type: 'button', class: 'btn', onclick: guard(refresh) }, icon('refresh'), 'Tải lại');
    if (!d) return head('Phân tích cache', 'Đang đọc file keymap của Gamwing…', sourceControl(), refreshBtn);
    const a = d.analysis;
    const total = a.namespaces.reduce((n, x) => n + x.items.length, 0);
    const sub = el('span', { class: 'meta' }, el('span', {}, `${total} mục`), el('span', {}, fmtBytes(d.file.bytes ?? textBytes(d.file.text))),
      d.file.updated_at ? el('span', {}, `cập nhật ${clockDateTime(d.file.updated_at)}`) : null,
      a.orphans.length ? badge(`${a.orphans.length} mục mồ côi`, 'warn') : null);
    return head('Phân tích cache', sub, sourceControl(), refreshBtn);
  }

  // The file on the server was changed on this page and the tablet does not have it yet: the server refuses other copies from the tablet meanwhile.
  function webEditNode() {
    const w = S.data && S.data.file && S.data.file.web_edit;
    if (!w || !latest()) return null;
    return alert('warn', el('span', {}, `Bản trên server là bản sửa trên web lúc ${clockDateTime(w.at)}; máy tính bảng chưa có. Server KHÔNG nhận bản khác của file này từ máy cho tới khi máy khôi phục đúng bản này (app: "Khôi phục theo ngày…" → hôm nay). `,
      el('button', { type: 'button', class: 'btn small', onclick: guard(() => window.Ui.acceptDeviceCopy(CACHE_FILE, refresh)) }, 'Chấp nhận bản từ máy')));
  }

  function warningsNode() {
    const a = S.data.analysis;
    const mismatches = a.namespaces.flatMap((n) => n.items).filter((i) => i.nameMismatch).length;
    const warns = [];
    if (a.orphans.length) warns.push(`${a.orphans.length} bản keymap/độ giật nằm trong file nhưng KHÔNG có trong danh sách (mục mồ côi: thường là bản cũ app còn giữ lại; app không hiện chúng).`);
    if (a.missingMaps.length) warns.push(`${a.missingMaps.length} mục có trong danh sách nhưng thiếu nội dung (map|…).`);
    if (mismatches) warns.push(`${mismatches} mục có tên trong danh sách khác với tên trong dữ liệu.`);
    for (const p of a.problems) warns.push(p.message);
    return warns.length ? alert('warn', el('div', {}, warns.map((w) => el('div', {}, w)))) : null;
  }

  const colHead = () => ['Tên', 'Dung lượng', ''].map((h, i) => el('th', { class: i === 0 ? 'col-name' : i === 1 ? 'col-size num' : '' }, h)); // new elements each time: a node has only one parent

  async function openItem(it) {
    if (rc.itemId !== it.id && rc.itemId && rc.drafts.size) {
      const go = await showModal({
        title: 'Bỏ các mốc chưa lưu?', tone: 'warn',
        body: el('p', {}, `Mục đang mở còn ${rc.drafts.size} tổ hợp có mốc chưa lưu (AI tạo hoặc AI đề xuất). Mở mục khác sẽ bỏ chúng.`),
        actions: [{ id: 'stay', label: 'Ở lại' }, { id: 'drop', label: 'Bỏ và mở mục khác', danger: true }],
      });
      if (go !== 'drop') return;
      if (rc.bulk) rc.bulk.ac.abort();
    }
    if (rc.itemId !== it.id) { rc.itemId = it.id; rc.drafts.clear(); rc.customCombos = new Set(); } // added combinations and drafts belong to one item
    S.sel = { id: it.id, kind: it.kind, ns: it.ns, label: it.label };
    lay.selected = null;
    lay.filter = null; lay.q = ''; lay.zoom = 1; // these belong to one item
    rc.picked = null;
    window.scrollTo(0, 0);
    redraw();
  }

  function itemRow(it) {
    const pickIt = () => { S.pick = it.id; redraw(); };
    const menu = menuButton([
      { label: 'Mở phân tích', icon: 'layers', disabled: !it.hasMap, onclick: () => openItem(it) },
      { label: 'Sao chép ID', icon: 'copy', onclick: () => copyText(it.id, 'Đã sao chép ID') },
      { label: 'Sao chép tên mục (map|…)', icon: 'copy', onclick: () => copyText(`map|${it.id}`, 'Đã sao chép tên mục') },
      { separator: true },
      { label: 'Xóa mục này…', icon: 'trash', danger: true, disabled: !latest(), onclick: () => guard(() => startDelete([it.id]))() },
    ], { label: `Thao tác với ${it.label}` });
    const sub = [it.addTime ? it.addTime.slice(0, 10) : null, it.nameMismatch ? `tên trong danh sách: ${it.listName}` : null, !it.listed ? 'không nằm trong danh sách nào' : null].filter(Boolean).join(' · ');
    return el('tr', { class: `pick${S.pick === it.id ? ' active' : ''}`, tabindex: '0', 'aria-selected': S.pick === it.id ? 'true' : 'false',
      onclick: pickIt, ondblclick: () => { if (it.hasMap) openItem(it); },
      onkeydown: (e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickIt(); } } },
      el('td', { class: 'col-name' }, el('div', { class: 'name-cell' },
        el('span', { class: 'name' }, el('span', {}, it.label), it.selected ? badge('Đang dùng', 'ok', { dot: true, title: 'Bản này đang được chọn trong app' }) : null),
        sub ? el('span', { class: 'sub' }, sub) : null)),
      el('td', { class: 'num col-size' }, it.hasMap ? fmtBytes(it.bytes) : '—'),
      el('td', { class: 'act' },
        it.hasMap ? el('button', { type: 'button', class: 'btn small hover-actions', onclick: (e) => { e.stopPropagation(); openItem(it); } }, 'Mở') : null, menu));
  }

  function groupRow(title, ns, count, extra) {
    return el('tr', { class: 'group' }, el('td', { colspan: 3 }, el('div', { class: 'row' }, el('span', { title: ns || undefined }, title), badge(String(count)), extra || null)));
  }

  function listCard() {
    const a = S.data.analysis;
    const body = [];
    for (const n of a.namespaces) {
      body.push(groupRow(KIND_VN[n.kind], n.ns, n.items.length));
      if (!n.items.length) body.push(el('tr', {}, el('td', { colspan: 3, class: 'muted' }, 'Danh sách trống.')));
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
        el('h2', {}, it.label),
        el('div', { class: 'row' }, badge(KIND_VN[it.kind] || 'Không rõ', 'accent'), it.selected ? badge('Đang dùng trong app', 'ok', { dot: true }) : null, ...itemFlags(it).filter((b) => !b.textContent.startsWith('có ở'))),
        el('dl', { class: 'kv' },
          el('dt', {}, 'Dung lượng'), el('dd', {}, it.hasMap ? fmtBytes(it.bytes) : '—'),
          it.addTime ? [el('dt', {}, 'Ngày'), el('dd', {}, it.addTime)] : null),
        el('div', { class: 'row mt-4' },
          el('button', { type: 'button', class: 'btn primary', disabled: !it.hasMap, onclick: () => openItem(it) }, icon('layers'), 'Mở phân tích'),
          deleteButton([it.id], 'Xóa…', 'btn danger')),
        el('details', { class: 'disclosure' }, el('summary', {}, 'Nơi lưu (chi tiết kỹ thuật)'),
          el('div', { class: 'disclosure-body' }, el('dl', { class: 'kv' },
            el('dt', {}, 'ID'), el('dd', { class: 'mono' }, it.id, ' ', copyBtn(it.id, 'Sao chép ID')),
            el('dt', {}, 'File XML'), el('dd', { class: 'mono' }, CACHE_FILE),
            el('dt', {}, 'Mục trong file'), el('dd', { class: 'mono' }, src.mapEntry || '— (không có nội dung map|…)'),
            el('dt', {}, 'Danh sách'), el('dd', { class: 'mono' }, src.listEntry || '— (không nằm trong danh sách nào: mục mồ côi)'),
            el('dt', {}, 'Thư mục trên máy tính bảng'), el('dd', { class: 'mono' }, folderOf() || NO_FOLDER),
            el('dt', {}, `Còn được ghi ở ${REFS_FILE}`), el('dd', { class: 'mono' }, refs.length ? refs.map((r) => `${r.entry} = ${r.ns}`).join('; ') : '—'))))));
    } else {
      parts.push(el('section', { class: 'card' }, emptyState('layers', 'Chọn một mục trong danh sách', 'để xem chi tiết và mở phân tích.')));
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
    slot.append(...[commandsNode()].filter(Boolean));
    pollCommands(slot);
    if (!S.sel) {
      setCrumbs([{ label: 'Phân tích cache' }]);
      return el('div', {}, pageHead(), webEditNode(), warningsNode(), el('div', { class: 'split' }, listCard(), inspectorNode(slot)));
    }
    return viewerPage(slot);
  }

  function viewerPage(slot) {
    const doc = S.data.analysis.docs.get(S.sel.id);
    const info = itemInfo(S.sel.id);
    const back = async () => {
      if (!(await discardOk())) return;
      rc.dirty = false;
      rc.editCurve = null;
      S.sel = null;
      redraw();
    };
    setCrumbs([{ label: 'Phân tích cache', onclick: back }, { label: KIND_VN[S.sel.kind] || 'Không rõ', onclick: back }, { label: S.sel.label }]);
    const src = CX.sourceOf(S.data.parsed, S.sel.id);
    const refs = S.refs.get(S.sel.id) || [];
    const viewHead = el('div', { class: 'view-head' },
      el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn small', onclick: back }, icon('back'), 'Danh sách'), el('h2', {}, S.sel.label), badge(KIND_VN[S.sel.kind] || 'Không rõ', 'accent'),
        info && info.selected ? badge('Đang dùng trong app', 'ok', { dot: true }) : null, !S.src ? null : badge(srcLabel()),
        el('span', { class: 'spacer' }),
        menuButton([
          { label: 'Lịch sử & khôi phục', icon: 'history', onclick: guard(() => (window.Ui.restoreFromHistory ? window.Ui.restoreFromHistory(CACHE_FILE, async () => { rc.dirty = false; rc.editCurve = null; rc.idx = null; await refresh(); }) : null)) },
          { label: 'Sao chép ID', icon: 'copy', onclick: () => copyText(S.sel.id, 'Đã sao chép ID') },
          { separator: true },
          { label: 'Xóa mục này…', icon: 'trash', danger: true, disabled: !latest(), onclick: guard(() => startDelete([S.sel.id])) },
        ], { label: 'Thao tác với mục này' })),
      el('details', { class: 'disclosure flat' }, el('summary', {}, 'Nơi lưu của mục này'),
        el('div', { class: 'disclosure-body' }, el('dl', { class: 'kv' },
          el('dt', {}, 'ID'), el('dd', { class: 'mono' }, S.sel.id),
          el('dt', {}, 'File XML'), el('dd', { class: 'mono' }, CACHE_FILE),
          el('dt', {}, 'Mục trong file'), el('dd', { class: 'mono' }, src.mapEntry || '— (không có nội dung map|…)'),
          el('dt', {}, 'Danh sách'), el('dd', { class: 'mono' }, src.listEntry || '— (không nằm trong danh sách nào: mục mồ côi)'),
          el('dt', {}, 'Thư mục trên máy'), el('dd', { class: 'mono' }, folderOf() || NO_FOLDER),
          el('dt', {}, `Còn được ghi ở ${REFS_FILE}`), el('dd', { class: 'mono' }, refs.length ? refs.map((r) => `${r.entry} = ${r.ns}`).join('; ') : '—')))));
    if (!doc) return el('div', {}, viewHead, alert('danger', el('span', {}, 'Nội dung bị hỏng (không phải JSON hợp lệ).')), slot);
    let body;
    if (S.sel.kind === 'recoil') body = recoilView(doc);
    else if ((S.sel.kind === 'keymap' || S.sel.kind === 'recognition') && Array.isArray(doc.components)) body = layoutView(S.sel.kind, doc);
    else body = summaryView(doc);
    return el('div', {}, viewHead, webEditNode(), body, slot);
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

  const ZOOMS = [1, 1.5, 2, 3, 4];
  function layoutView(kind, doc) {
    if (!lay.screenId) { const p = loadPrefs(); lay.screenId = p.screen || LL.SCREEN_PRESETS[0].id; lay.origin = p.origin === 'center' ? 'center' : 'topleft'; lay.custom = { w: p.w || 2960, h: p.h || 1848 }; }
    if (!lay.zoom) lay.zoom = 1;
    if (lay.filter === undefined) lay.filter = null;
    if (lay.q === undefined) lay.q = '';
    const comps = doc.components;
    lay.filter = LL.validFilter(kind, comps, lay.filter);
    const noun = kind === 'recognition' ? 'ô' : 'phím';
    const scr = screenSize();
    const canvas = LL.canvasSize(comps.filter((c) => c && typeof c === 'object'), scr, lay.origin);
    const rows = LL.listRows(kind, comps, lay.origin);
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
    const order = comps.map((c, i) => i).sort((a, b2) => rects[b2].w * rects[b2].h - rects[a].w * rects[a].h); // big ones first, so small ones stay clickable
    const nodes = {};
    for (const i of order) {
      const c = comps[i] || {};
      const d = LL.describe(kind, c);
      const r = rects[i];
      const round = c['base:componentIdentifier'] === 'com.zjx.app:joystick';
      const outline = d.cls === 'mainview'; // the whole-screen view box: an outline with its name in the corner, not a fill that hides the rest
      const shape = round ? svgEl('ellipse', { class: 'shape', cx: r.x + r.w / 2, cy: r.y + r.h / 2, rx: r.w / 2, ry: r.h / 2 }) : svgEl('rect', { class: 'shape', rx: 8, x: r.x, y: r.y, width: r.w, height: r.h });
      const text = outline ? svgEl('text', { class: 'label corner', x: r.x + 16, y: r.y + 40 }, LL.labelOf(kind, c))
        : svgEl('text', { class: 'label', x: r.x + r.w / 2, y: r.y + r.h / 2 }, LL.labelOf(kind, c));
      const g = svgEl('g', { class: `comp c-${d.cls}${outline ? ' outline' : ''}`, 'data-i': i },
        svgEl('title', {}, `${d.title}${d.keys.length ? ` [${d.keys.join(' ')}]` : ''} — (${Math.round(r.x)}, ${Math.round(r.y)}) ${Math.round(r.w)}×${Math.round(r.h)}`), shape, text);
      svg.append(g);
      nodes[i] = g;
    }
    const guide = svgEl('g', { class: 'guide' }); // the position and size of the selected box, drawn above everything
    svg.append(guide);

    // ---- the list beside the screen
    const rowEls = {};
    const count = el('span', { class: 'muted text-sm', role: 'status' });
    const listBody = el('tbody', {}, rows.map((r) => {
      const tr = el('tr', { class: 'lv-row', tabindex: '0', 'data-i': r.i, 'aria-current': 'false' },
        el('td', {}, el('div', { class: 'lv-keys' }, el('span', { class: `lv-dot c-${r.cls}`, title: r.className, 'aria-hidden': 'true' }), r.keys.length ? r.keys.map((k) => el('span', { class: 'keychip' }, k)) : el('span', {}, r.title)),
          r.keys.length ? null : el('div', { class: 'muted text-sm' }, r.className)),
        el('td', { class: 'mono num text-sm', title: `${r.w}×${r.h}` }, `${r.x}, ${r.y}`));
      tr.addEventListener('click', () => select(r.i, { scroll: false, fromList: true }));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(r.i, { fromList: true }); } });
      tr.addEventListener('mouseenter', () => nodes[r.i].classList.add('hot'));
      tr.addEventListener('mouseleave', () => nodes[r.i].classList.remove('hot'));
      rowEls[r.i] = tr;
      return tr;
    }));

    // ---- the box that is selected
    const panel = el('div', {});
    function showPanel() {
      const i = lay.selected;
      if (i === null || !comps[i]) { panel.replaceChildren(emptyState('layers', `Chưa chọn ${noun} nào`, `Bấm một ${noun} trên màn hình hoặc trong danh sách để xem thông số.`)); return; }
      const d = LL.describe(kind, comps[i]);
      panel.replaceChildren(el('div', { class: 'lv-detail' },
        el('div', { class: 'lv-detail-head' }, el('h2', {}, d.title), d.keys.length ? el('div', { class: 'keychips' }, d.keys.map((k) => el('span', { class: 'keychip' }, k))) : null),
        el('p', { class: 'muted' }, `${d.subtitle}${d.sure ? '' : ' · tên suy ra từ code'}`),
        el('table', { class: 'lv-props' }, el('tbody', {}, d.rows.map((r) => el('tr', {}, el('td', { title: r.raw }, r.label), el('td', { class: 'mono wrap' }, r.display)))))));
    }
    function drawGuide() {
      guide.replaceChildren();
      const i = lay.selected;
      if (i === null || !comps[i]) return;
      const r = rects[i];
      const below = r.y < 90;
      const right = r.x + r.w / 2 > canvas.w * 0.7; // near the right edge the text runs leftwards, so it is never cut
      guide.append(svgEl('text', { class: `guide-label${right ? ' end' : ''}`, x: right ? Math.min(canvas.w - 8, r.x + r.w) : Math.max(8, r.x), y: below ? r.y + r.h + 46 : r.y - 16 }, `${Math.round(r.x)}, ${Math.round(r.y)} · ${Math.round(r.w)}×${Math.round(r.h)}`));
    }
    function select(i, { scroll = true, fromList = false } = {}) {
      if (lay.selected !== null && nodes[lay.selected]) { nodes[lay.selected].classList.remove('sel'); rowEls[lay.selected].setAttribute('aria-current', 'false'); rowEls[lay.selected].classList.remove('sel'); }
      lay.selected = i;
      if (i !== null && nodes[i]) {
        nodes[i].classList.add('sel');
        svg.insertBefore(nodes[i], guide); // on top of its neighbours
        rowEls[i].classList.add('sel');
        rowEls[i].setAttribute('aria-current', 'true');
        if (scroll && rowEls[i].scrollIntoView) rowEls[i].scrollIntoView({ block: 'nearest' });
        if (fromList && nodes[i].scrollIntoView && lay.zoom > 1) nodes[i].scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      showPanel();
      drawGuide();
    }

    // ---- legend, search, filter
    const chipEls = [];
    function applyFilter() {
      const ok = new Set(LL.visibleRows(rows, lay.filter, lay.q).map((r) => r.i));
      for (const r of rows) {
        rowEls[r.i].hidden = !ok.has(r.i);
        nodes[r.i].classList.toggle('dim', !ok.has(r.i));
      }
      const shown = ok.size;
      if (lay.selected !== null && !ok.has(lay.selected)) select(null, { scroll: false }); // a hidden box is not left selected
      count.textContent = shown === rows.length ? `${rows.length} ${noun}` : `${shown}/${rows.length} ${noun}`;
      empty.hidden = shown !== 0;
      chipEls.forEach(([cls, b]) => b.setAttribute('aria-pressed', String(lay.filter === cls)));
    }
    const legendRow = el('div', { class: 'lv-legend', role: 'group', 'aria-label': 'Lọc theo loại' }, LL.legend(kind, comps).map((l) => {
      const b = el('button', { type: 'button', class: `lv-chip c-${l.cls}`, 'aria-pressed': 'false', title: `Chỉ hiện: ${l.name}`, onclick: () => { lay.filter = lay.filter === l.cls ? null : l.cls; applyFilter(); } },
        el('span', { class: 'lv-dot', 'aria-hidden': 'true' }), l.name, el('span', { class: 'lv-chip-n' }, String(l.count)));
      chipEls.push([l.cls, b]);
      return b;
    }));
    const search = el('input', { type: 'search', class: 'lv-search', placeholder: `Tìm ${noun}, ví dụ: Space, chạm, chuột…`, 'aria-label': `Tìm ${noun}`, value: lay.q, oninput: (e) => { lay.q = e.target.value; applyFilter(); } });
    const empty = el('div', { class: 'lv-empty muted' }, `Không có ${noun} nào khớp.`);

    // ---- the screen: size of the letters follows the size of the picture on the page
    const coords = el('span', { class: 'lv-coords mono' }, 'Rê chuột vào màn hình để xem toạ độ');
    svg.addEventListener('click', (e) => {
      const g = e.target.closest && e.target.closest('g.comp');
      select(g ? Number(g.dataset.i) : null, { scroll: true });
    });
    svg.addEventListener('pointermove', (e) => { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const p = pt.matrixTransform(svg.getScreenCTM().inverse()); coords.textContent = `x=${Math.round(p.x)}  y=${Math.round(p.y)}`; });
    svg.style.width = `${lay.zoom * 100}%`;
    const fitLetters = () => { const w = svg.getBoundingClientRect().width; if (w > 0) svg.style.setProperty('--fs', `${LL.fontUnits(w / canvas.w, Math.max(9, Math.min(13, w / 90)))}px`); };
    if (lay.ro) lay.ro.disconnect();
    lay.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fitLetters) : null;
    if (lay.ro) lay.ro.observe(svg);
    requestAnimationFrame(fitLetters);

    // ---- toolbar
    const screenSel = el('select', { 'aria-label': 'Kích thước màn hình', 'data-fk': 'screen', onchange: (e) => { lay.screenId = e.target.value; lay.focus = 'screen'; savePrefs(); redraw(); } },
      LL.SCREEN_PRESETS.map((p) => el('option', { value: p.id, selected: p.id === lay.screenId }, p.label)), el('option', { value: 'custom', selected: lay.screenId === 'custom' }, 'Tùy chỉnh…'));
    const custom = lay.screenId === 'custom' ? ['w', 'h'].map((f) => el('label', { class: 'numfield' }, f === 'w' ? 'Rộng' : 'Cao', el('input', { type: 'number', 'data-fk': `custom-${f}`, value: String(lay.custom[f]), min: '100', onchange: (e) => { const n = Math.round(Number(e.target.value)); if (n >= 100) { lay.custom[f] = n; lay.focus = `custom-${f}`; savePrefs(); redraw(); } } }))) : null;
    const originSel = el('select', { 'aria-label': 'Gốc toạ độ', 'data-fk': 'origin', title: 'Chưa xác nhận base:x/base:y là góc trên-trái hay tâm ô: dùng ảnh nền chụp từ game để đối chiếu rồi chọn đúng.', onchange: (e) => { lay.origin = e.target.value; lay.focus = 'origin'; savePrefs(); redraw(); } },
      el('option', { value: 'topleft', selected: lay.origin === 'topleft' }, 'Toạ độ = góc trên-trái ô'), el('option', { value: 'center', selected: lay.origin === 'center' }, 'Toạ độ = tâm ô'));
    const file = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => { const f = e.target.files[0]; if (!f) return; if (lay.bg.url) URL.revokeObjectURL(lay.bg.url); lay.bg.url = URL.createObjectURL(f); redraw(); } });
    const opacity = el('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(lay.bg.opacity), 'aria-label': 'Độ mờ ảnh nền', 'data-fk': 'opacity', onchange: (e) => { lay.bg.opacity = Number(e.target.value); lay.focus = 'opacity'; redraw(); } });
    // zoom changes the picture in place (no redraw): the buttons keep focus and the view stays centred where it was
    const scroller = el('div', { class: 'lv-scroll' }, svg);
    const zOut = el('button', { type: 'button', class: 'btn small', 'aria-label': 'Thu nhỏ', onclick: () => zoomBy(-1) }, '−');
    const zIn = el('button', { type: 'button', class: 'btn small', 'aria-label': 'Phóng to', onclick: () => zoomBy(1) }, '+');
    const zFit = el('button', { type: 'button', class: 'btn small', onclick: () => setZoom(1) }, 'Vừa khung');
    const zNum = el('span', { class: 'lv-zoom-n mono', role: 'status' });
    function setZoom(z) {
      const cx = (scroller.scrollLeft + scroller.clientWidth / 2) / (scroller.scrollWidth || 1);
      const cy = (scroller.scrollTop + scroller.clientHeight / 2) / (scroller.scrollHeight || 1);
      lay.zoom = z;
      svg.style.width = `${z * 100}%`;
      fitLetters();
      scroller.scrollLeft = cx * scroller.scrollWidth - scroller.clientWidth / 2;
      scroller.scrollTop = cy * scroller.scrollHeight - scroller.clientHeight / 2;
      const zi = ZOOMS.indexOf(z);
      zNum.textContent = `${Math.round(z * 100)}%`;
      zOut.disabled = zi <= 0; zIn.disabled = zi >= ZOOMS.length - 1; zFit.disabled = z === 1;
    }
    const zoomBy = (d) => { const zi = ZOOMS.indexOf(lay.zoom) + d; if (zi >= 0 && zi < ZOOMS.length) setZoom(ZOOMS[zi]); };
    const zoomBox = el('div', { class: 'lv-zoom', role: 'group', 'aria-label': 'Phóng to' }, zOut, zNum, zIn, zFit);
    setZoom(lay.zoom);
    const toolbar = el('div', { class: 'lv-toolbar' }, screenSel, custom, originSel,
      el('label', { class: 'btn small', title: 'Ảnh chỉ xử lý trong trình duyệt, không tải lên server.' }, icon('plus'), 'Ảnh game làm nền', file),
      lay.bg.url ? [opacity, el('button', { class: 'btn small', onclick: () => { URL.revokeObjectURL(lay.bg.url); lay.bg.url = null; redraw(); } }, 'Bỏ ảnh nền')] : null,
      zoomBox);

    applyFilter();
    if (lay.selected !== null && !nodes[lay.selected]) lay.selected = null;
    select(lay.selected, { scroll: false });
    const view = el('div', { class: 'layout2' },
      el('div', { class: 'card lv-stage-card' },
        el('div', { class: 'lv-title' }, el('h2', {}, `Màn hình hiển thị vị trí (${comps.length} ${noun})`), el('span', { class: 'muted text-sm' }, 'Chỉ xem, không sửa')),
        toolbar, legendRow,
        el('div', { class: 'lv-grid' },
          el('div', { class: 'lv-stage' }, scroller, coords),
          el('div', { class: 'lv-side' },
            el('div', { class: 'lv-side-head' }, search, count),
            el('div', { class: 'lv-list' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, noun === 'phím' ? 'Phím' : 'Ô'), el('th', { class: 'num' }, 'Vị trí'))), listBody), empty)))),
      el('div', { class: 'card' }, panel));
    if (lay.focus) { const key = lay.focus; lay.focus = null; requestAnimationFrame(() => { const t = view.querySelector(`[data-fk="${key}"]`); if (t) t.focus(); }); } // a redraw must not drop the keyboard focus
    return view;
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
    return el('span', { class: r.baseMissing ? 'tag warn' : 'tag' }, r.baseMissing ? 'Nền thiếu → 0' : `Tính ×${r.multiplier.toFixed(3)}`);
  };

  // drag (optional) makes the points movable: { lockX, onMove(i), onEnd(i, byKey) } (see recoilDetail). The scale of the picture is fixed while a point
  // is dragged (the picture is drawn again only when it is dropped), so the point follows the pointer.
  function chart(curve, drag = null) {
    const W = 640; const H = 240; const L = 56; const R = 14; const T = 14; const B = 30;
    const tMax = Math.max(...curve.map((p) => p[0]), 1);
    const vs = curve.map((p) => p[1]);
    const vMin = Math.min(0, ...vs);
    let vMax = Math.max(...vs);
    if (vMax === vMin) vMax = vMin + 1;
    vMax += (vMax - vMin) * 0.08;
    const x = (t) => L + (t / tMax) * (W - L - R);
    const y = (v) => T + (1 - (v - vMin) / (vMax - vMin)) * (H - T - B);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: drag ? 'chart draggable' : 'chart', role: drag ? 'group' : 'img', 'aria-label': drag ? 'Đường cong độ giật theo thời gian: kéo các chấm để đổi mốc' : 'Đường cong độ giật theo thời gian' });
    for (let i = 0; i <= 4; i++) {
      const v = vMin + ((vMax - vMin) * i) / 4;
      svg.append(svgEl('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }), svgEl('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, v.toFixed(0)));
      const t = (tMax * i) / 4;
      svg.append(svgEl('text', { x: x(t), y: H - 10, 'text-anchor': i === 4 ? 'end' : 'middle' }, `${Math.round(t)} ms`));
    }
    const line = curve.length === 1
      ? svgEl('line', { class: 'curve flat', x1: L, x2: W - R, y1: y(curve[0][1]), y2: y(curve[0][1]) })
      : svgEl('polyline', { class: 'curve', fill: 'none', points: curve.map(([t, v]) => `${x(t)},${y(v)}`).join(' ') });
    svg.append(line);
    const pts = [];
    const title = (i) => `mốc ${i}: t=${curve[i][0]} ms, giá trị=${Number(curve[i][1].toFixed(2))}`;
    curve.forEach(([t, v], i) => {
      const dot = svgEl('circle', { class: 'dot', cx: x(t), cy: y(v), r: 3.5 });
      if (!drag) { svg.append(svgEl('g', {}, svgEl('title', {}, title(i)), dot)); return; }
      const ring = svgEl('circle', { class: 'ring', cx: x(t), cy: y(v), r: 8 });
      const hit = svgEl('circle', { class: 'dot-hit', cx: x(t), cy: y(v), r: 14, tabindex: '0', role: 'slider', 'data-i': i, 'aria-orientation': 'vertical', 'aria-valuemin': String(Math.round(vMin * 100) / 100), 'aria-valuemax': String(Math.round(vMax * 100) / 100), 'aria-label': `Mốc ${i + 1}` });
      const g = svgEl('g', { class: 'pt' }, svgEl('title', {}, title(i)), ring, dot, hit);
      const paint = () => {
        for (const c of [dot, ring, hit]) { c.setAttribute('cx', x(curve[i][0])); c.setAttribute('cy', y(curve[i][1])); }
        g.firstChild.textContent = title(i);
        hit.setAttribute('aria-valuenow', String(curve[i][1]));
        hit.setAttribute('aria-valuetext', `${Number(curve[i][1].toFixed(2))} tại ${curve[i][0]} ms`);
        if (line.tagName === 'polyline') line.setAttribute('points', curve.map(([tt, vv]) => `${x(tt)},${y(vv)}`).join(' '));
        else { line.setAttribute('y1', y(curve[0][1])); line.setAttribute('y2', y(curve[0][1])); }
      };
      paint();
      // value: within the picture; time: between the neighbours (the first point stays at 0), and not at all when drag.lockX
      const setValue = (v) => { curve[i][1] = Math.round(Math.min(vMax, Math.max(vMin, v)) * 100) / 100; };
      const setTime = (t, byKey = false) => {
        if (drag.lockX || i === 0) return;
        const lo = curve[i - 1][0] + 1;
        const hi = i < curve.length - 1 ? curve[i + 1][0] - 1 : (byKey ? Infinity : tMax); // the last point may be pushed later by the keyboard
        if (hi < lo) return; // times out of order: leave them to the boxes
        curve[i][0] = Math.round(Math.min(hi, Math.max(lo, t)));
      };
      const moved = () => { paint(); drag.onMove(i); };
      const at = (e) => { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); };
      let dragging = false;
      hit.addEventListener('pointerdown', (e) => { if (e.button) return; e.preventDefault(); hit.setPointerCapture(e.pointerId); dragging = true; g.classList.add('dragging'); hit.focus(); });
      hit.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const p = at(e);
        setValue(vMin + (1 - (p.y - T) / (H - T - B)) * (vMax - vMin));
        setTime(((p.x - L) / (W - L - R)) * tMax);
        moved();
      });
      const drop = () => { if (!dragging) return; dragging = false; g.classList.remove('dragging'); drag.onEnd(i, false); };
      hit.addEventListener('pointerup', drop);
      hit.addEventListener('pointercancel', drop);
      hit.addEventListener('lostpointercapture', drop);
      hit.addEventListener('keydown', (e) => {
        const big = e.shiftKey;
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') setValue(curve[i][1] + (e.key === 'ArrowUp' ? 1 : -1) * (big ? 1 : 0.1));
        else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !drag.lockX) setTime(curve[i][0] + (e.key === 'ArrowRight' ? 1 : -1) * (big ? 100 : 10), true);
        else return;
        e.preventDefault();
        moved();
        drag.onEnd(i, true);
      });
      hit.addEventListener('focus', () => { if (hit.matches(':focus-visible')) g.classList.add('focus'); });
      hit.addEventListener('blur', () => g.classList.remove('focus'));
      pts.push(g);
    });
    svg.append(...pts);
    return svg;
  }

  function getAccessorySpecs(ixIdx, weapon, scope) {
    const coef = RL.coefficientsFor(ixIdx, weapon, scope) || {};
    const grips = RL.GRIPS.map((raw, i) => {
      const key = RL.GRIP_COEF ? RL.GRIP_COEF[raw] : null;
      const factor = key && typeof coef[key] === 'number' ? coef[key] : 1;
      return { index: i, raw, label: RL.LABELS.GRIPS[i], key, factor };
    });
    const muzzles = RL.MUZZLES.map((raw, i) => {
      const key = RL.MUZZLE_COEF ? RL.MUZZLE_COEF[raw] : null;
      const factor = key && typeof coef[key] === 'number' ? coef[key] : 1;
      return { index: i, raw, label: RL.LABELS.MUZZLES[i], key, factor };
    });
    const stocks = RL.STOCKS.map((raw, i) => {
      const key = RL.STOCK_COEF ? RL.STOCK_COEF[raw] : null;
      const factor = key && typeof coef[key] === 'number' ? coef[key] : 1;
      return { index: i, raw, label: RL.LABELS.STOCKS[i], key, factor };
    });
    return { grips, muzzles, stocks, coef };
  }

  function optWithBadge(kind, i, coef) {
    if (i === 0 && NONE_KINDS.has(kind)) return el('span', { class: 'faint', title: 'None (không gắn)' }, '—');
    const label = RL.LABELS[kind][i];
    const raw = RL[kind][i];
    let key = null;
    if (kind === 'GRIPS') key = RL.GRIP_COEF ? RL.GRIP_COEF[raw] : null;
    else if (kind === 'MUZZLES') key = RL.MUZZLE_COEF ? RL.MUZZLE_COEF[raw] : null;
    else if (kind === 'STOCKS') key = RL.STOCK_COEF ? RL.STOCK_COEF[raw] : null;
    const factor = key && coef && typeof coef[key] === 'number' ? coef[key] : null;
    if (factor != null && factor !== 1) {
      return el('span', { title: `${raw} · Hệ số: ${factor.toFixed(4)}` }, label, el('span', { class: 'coef' }, `×${factor.toFixed(2)}`));
    }
    return el('span', { title: raw }, label);
  }

  async function showComboModal(ix, initialCombo = null) {
    if (RL.isGunDisabled(rc.weapon)) {
      toast('Súng này đã bị tắt trong Tiêu chuẩn súng: không thể thêm tổ hợp.', true);
      return;
    }
    if (!rc.customCombos) rc.customCombos = new Set();
    const specs = getAccessorySpecs(ix.idx, rc.weapon, rc.scope);
    // what the gun takes (RecoilLib.attachmentsFor): other options stay in the list but are greyed out; the one being edited stays choosable
    const att = RL.attachmentsFor(rc.weapon);
    const slotKey = { grip: 'grips', muzzle: 'muzzles', stock: 'stocks' };
    const refused = (slot, index) => Boolean(att) && index > 0 && !att[slotKey[slot]].has(index) && !(initialCombo && initialCombo[slot] === index);
    const optionNode = (slot, o, current, factorText) => el('option', { value: o.index, selected: o.index === current, disabled: refused(slot, o.index) }, `${o.label}${factorText}${refused(slot, o.index) ? ' — súng này không hỗ trợ' : ''}`);
    let curGrip = initialCombo ? initialCombo.grip : 0;
    let curMuzzle = initialCombo ? initialCombo.muzzle : 0;
    let curStock = initialCombo ? initialCombo.stock : 0;

    const gripSelect = el('select', { 'aria-label': 'Tay cầm' });
    specs.grips.forEach((g) => {
      const factorText = g.factor !== 1 ? ` (×${g.factor.toFixed(3)})` : g.index === 0 ? ' (mặc định)' : '';
      gripSelect.append(optionNode('grip', g, curGrip, factorText));
    });

    const muzzleSelect = el('select', { 'aria-label': 'Nòng' });
    specs.muzzles.forEach((m) => {
      const factorText = m.factor !== 1 ? ` (×${m.factor.toFixed(3)})` : m.index === 0 ? ' (mặc định)' : '';
      muzzleSelect.append(optionNode('muzzle', m, curMuzzle, factorText));
    });

    const stockSelect = el('select', { 'aria-label': 'Báng' });
    specs.stocks.forEach((st) => {
      const factorText = st.factor !== 1 ? ` (×${st.factor.toFixed(3)})` : st.index === 0 ? ' (mặc định)' : '';
      stockSelect.append(optionNode('stock', st, curStock, factorText));
    });

    const refPreviewBox = el('div', { class: 'meta ref-preview' });

    // Is the chosen combination already in the list? Then it is not added a second time: the existing one is opened.
    const dupOf = () => {
      if (initialCombo && initialCombo.grip === curGrip && initialCombo.muzzle === curMuzzle && initialCombo.stock === curStock) return null; // "edit" and nothing changed
      return RL.findDuplicateCombo(ix.idx, rc.customCombos, { weapon: rc.weapon, scope: rc.scope, gesture: rc.gesture, grip: curGrip, muzzle: curMuzzle, stock: curStock });
    };
    const DUP_TEXT = { exact: 'đã có mục riêng trong file', custom: 'đã được thêm vào danh sách (chưa lưu)', default: 'là hàng mặc định, luôn có sẵn trong danh sách' };
    const dupBox = el('div', { role: 'status', 'aria-live': 'polite' });
    const scopeProblem = RL.comboProblems(rc.weapon, rc.scope, {}).find((p) => p.slot === 'scope');
    const attBox = att
      ? el('details', { class: 'disclosure flat' }, el('summary', {}, `Phụ kiện ${RL.weaponLabel(rc.weapon)} lắp được`), el('div', { class: 'disclosure-body muted text-sm' }, `Theo ${att.sourceLabel}: ${RL.describeAttachments(rc.weapon)}`))
      : el('p', { class: 'muted text-sm' }, `Chưa có quy tắc phụ kiện cho ${RL.weaponLabel(rc.weapon)} (tài liệu không nhắc tới): mọi lựa chọn đều được phép.`);
    const scopeBox = scopeProblem && !initialCombo ? alert('warn', el('span', {}, `${scopeProblem.reason} Không thêm tổ hợp mới ở ống ngắm này.`)) : null;
    const wantSuggest = el('input', { type: 'checkbox', checked: true });
    const suggestRow = initialCombo ? null : el('label', { class: 'auto-step' }, wantSuggest, el('span', {}, 'Tính các mốc ngay: server và AI chạy song song, rồi bạn chọn một kết quả'));
    const paintDup = () => {
      const d = dupOf();
      dupBox.replaceChildren(...(d ? [alert('warn', el('span', {}, `Tổ hợp này ${DUP_TEXT[d.kind]}. Sẽ không thêm bản trùng: bấm nút bên dưới để mở tổ hợp đó.`))] : []));
    };

    function updateRef() {
      curGrip = Number(gripSelect.value);
      curMuzzle = Number(muzzleSelect.value);
      curStock = Number(stockSelect.value);
      paintDup();
      const r = RL.resolve(ix.idx, { weapon: rc.weapon, scope: rc.scope, gesture: rc.gesture, grip: curGrip, muzzle: curMuzzle, stock: curStock });
      const st = RL.curveStats(r.curve);

      const partsText = r.parts.length ? r.parts.map((p) => `${p.label} ${Number(p.value.toFixed(3))}`).join(' × ') : '1.000';
      const multText = r.multiplier != null ? ` = ×${r.multiplier.toFixed(4)}` : '';

      // one quiet line: where the curve comes from, and its numbers
      refPreviewBox.replaceChildren(
        sourceTag(r),
        el('span', { title: partsText + multText }, `hệ số ${r.multiplier != null ? `×${r.multiplier.toFixed(3)}` : '—'}`),
        el('span', {}, `t=0: ${num(st.v0)} → ${num(st.vEnd)}`),
        el('span', {}, `${st.duration} ms · ${st.points} mốc`));
    }

    gripSelect.onchange = updateRef;
    muzzleSelect.onchange = updateRef;
    stockSelect.onchange = updateRef;
    updateRef();

    const ok = await showModal({
      title: initialCombo ? 'Sửa tổ hợp phụ kiện' : 'Thêm tổ hợp phụ kiện & tham chiếu độ giật',
      body: [
        el('p', { class: 'muted' }, `${RL.weaponLabel(rc.weapon)} · ${POSTURE_VN[rc.gesture]} · ${RL.LABELS.SCOPES[rc.scope]}`),
        el('div', { class: 'fields-3' },
          el('label', { class: 'field' }, 'Tay cầm', gripSelect),
          el('label', { class: 'field' }, 'Nòng', muzzleSelect),
          el('label', { class: 'field' }, 'Báng', stockSelect)
        ),
        refPreviewBox,
        attBox,
        scopeBox,
        dupBox,
        suggestRow
      ],
      actions: [
        { id: 'cancel', label: 'Hủy' },
        { id: 'apply', label: initialCombo ? 'Cập nhật & Mở chi tiết' : 'Thêm & Mở chi tiết', primary: true }
      ]
    });

    if (ok !== 'apply') return;
    if (!initialCombo) {
      const problems = RL.comboProblems(rc.weapon, rc.scope, { grip: curGrip, muzzle: curMuzzle, stock: curStock });
      if (problems.length) { toast(problems.map((p) => p.reason).join(' '), true); return; }
    }
    if (!(await discardOk())) return; // the curve on the right has unsaved changes

    const dup = dupOf();
    if (dup) toast(`Tổ hợp này ${DUP_TEXT[dup.kind]}: không thêm bản trùng, đã mở tổ hợp đó.`);
    else rc.customCombos.add(RL.comboKey({ weapon: rc.weapon, scope: rc.scope, gesture: rc.gesture, grip: curGrip, muzzle: curMuzzle, stock: curStock }));
    rc.picked = { grip: curGrip, muzzle: curMuzzle, stock: curStock };
    rc.editCurve = null;
    rc.dirty = false;
    rc.bad.clear();
    redraw();
    if (!dup && !initialCombo && wantSuggest.checked) {
      try { await suggestPoints({ weapon: rc.weapon, scope: rc.scope, gesture: rc.gesture, grip: curGrip, muzzle: curMuzzle, stock: curStock }); } catch (e) { toast(e.message, true); }
    }
  }

  async function showAccessoryReferenceModal(ix) {
    const specs = getAccessorySpecs(ix.idx, rc.weapon, rc.scope);

    let selG = rc.picked ? rc.picked.grip : 0;
    let selM = rc.picked ? rc.picked.muzzle : 0;
    let selSt = rc.picked ? rc.picked.stock : 0;

    const refBox = el('div', { class: ' text-xs ' });

    function refreshSummary() {
      const r = RL.resolve(ix.idx, { weapon: rc.weapon, scope: rc.scope, gesture: rc.gesture, grip: selG, muzzle: selM, stock: selSt });
      const st = RL.curveStats(r.curve);
      const label = `Tay cầm: ${specs.grips[selG].label} · Nòng: ${specs.muzzles[selM].label} · Báng: ${specs.stocks[selSt].label}`;
      const multText = r.multiplier != null ? `×${r.multiplier.toFixed(4)}` : '1.000';

      refBox.replaceChildren(
        el('div', { class: 'flex items-center justify-between font-semibold' },
          el('span', {}, label),
          sourceTag(r)
        ),
        el('div', { class: 'grid gap-2 ' },
          el('div', {}, el('span', { class: ' block ' }, 'Tổng hệ số:'), multText),
          el('div', {}, el('span', { class: ' block ' }, 'Giá trị t=0:'), num(st.v0)),
          el('div', {}, el('span', { class: ' block ' }, 'Giá trị cuối:'), num(st.vEnd)),
          el('div', {}, el('span', { class: ' block ' }, 'Thời lượng:'), `${st.duration} ms (${st.points} mốc)`)
        )
      );
    }

    function renderTable(title, list, selectedIdx, onPick) {
      const rows = list.map((item) => {
        const factorClass = item.factor < 1 ? 'text-emerald-600 dark:text-emerald-400 font-bold' : item.factor > 1 ? 'text-amber-600 font-bold' : 'text-slate-400';
        const reduction = item.factor !== 1 ? `${item.factor < 1 ? 'Giảm' : 'Tăng'} ${Math.abs((1 - item.factor) * 100).toFixed(1)}%` : 'Giữ nguyên';
        const isCurrent = item.index === selectedIdx;
        return el('tr', { class: `${isCurrent ? ' ' : ''} ` },
          el('td', { class: 'num text-xs ' }, item.index),
          el('td', { class: 'font-medium text-xs' }, item.label),
          el('td', { class: 'mono text-xs ' }, item.raw),
          el('td', { class: `num text-xs ${factorClass}` }, item.factor !== 1 ? `×${item.factor.toFixed(4)}` : '1.000'),
          el('td', { class: 'text-xs ' }, reduction),
          el('td', { class: 'act ' }, el('button', {
            type: 'button',
            class: `btn small${isCurrent ? ' primary' : ''}`,
            onclick: () => onPick(item.index)
          }, isCurrent ? 'Đang chọn' : 'Chọn'))
        );
      });

      return el('div', { class: '' },
        el('h3', { class: 'text-sm font-semibold mb-2 ' }, title),
        el('div', { class: 'table-wrap overflow-x-auto ' },
          el('table', { class: 'w-full text-xs' },
            el('thead', { class: ' ' }, el('tr', {},
              el('th', { class: ' ' }, '#'),
              el('th', {}, 'Tên phụ kiện'),
              el('th', {}, 'Mã hệ thống (Enum)'),
              el('th', { class: '' }, 'Hệ số'),
              el('th', {}, 'Tác dụng'),
              el('th', { class: ' ' }, '')
            )),
            el('tbody', {}, rows)
          )
        )
      );
    }

    const container = el('div', { class: ' ' });

    function renderModalContent() {
      container.replaceChildren(
        el('p', { class: 'text-xs ' }, `Danh sách các trường của Tay cầm, Nòng, Báng và hệ số tương ứng đối với ${RL.weaponLabel(rc.weapon)} · ${RL.LABELS.SCOPES[rc.scope]}. Bấm "Chọn" ở từng trường để xem tham chiếu ngược lại giá trị độ giật:`),
        renderTable('1. Các trường Tay cầm (GRIPS)', specs.grips, selG, (i) => { selG = i; refreshSummary(); renderModalContent(); }),
        renderTable('2. Các trường Nòng (MUZZLES)', specs.muzzles, selM, (i) => { selM = i; refreshSummary(); renderModalContent(); }),
        renderTable('3. Các trường Báng (STOCKS)', specs.stocks, selSt, (i) => { selSt = i; refreshSummary(); renderModalContent(); }),
        refBox
      );
    }

    refreshSummary();
    renderModalContent();

    const ok = await showModal({
      title: 'Danh sách các trường phụ kiện & Tham chiếu hệ số',
      body: container,
      actions: [
        { id: 'cancel', label: 'Đóng' },
        { id: 'apply', label: 'Áp dụng tổ hợp này & Mở chi tiết', primary: true }
      ]
    });

    if (ok === 'apply') {
      if (!rc.customCombos) rc.customCombos = new Set();
      const comboKey = `${rc.weapon}|${rc.scope}|${rc.gesture}|${selG}|${selM}|${selSt}`;
      rc.customCombos.add(comboKey);
      rc.picked = { grip: selG, muzzle: selM, stock: selSt };
      rc.editCurve = null;
      rc.dirty = false;
      redraw();
    }
  }

  // ---------------------------------------------------------------- combinations the page suggests adding
  // Faint rows under the combinations table. The server finds them (similar guns that own a combination this gun does not, and kinds of
  // combination where the coefficient curve is usually wrong); a little later the AI orders them and says why. Each row has a button that
  // adds it at once; "Thêm tổ hợp" and the last row stay for adding by hand. The rows are updated in place, never by redrawing the page,
  // so typing in the curve boxes is not interrupted.
  const MAX_GHOST = 6; // shown at first; "Hiện thêm" shows the rest of the missing combinations (up to MAX_GHOST_ALL)
  const MAX_GHOST_ALL = 300;
  const comboId = (c) => `${c.grip}|${c.muzzle}|${c.stock}`;
  const SRC_COMPUTED = 'Tính từ hệ số'; // the "Nguồn" of a combination without an own entry: every suggestion is one
  // The accessories the table filter lets through, as the indexes the server knows (a column without a ticked list = any); null = no filter.
  function filterConstraints() {
    const out = {};
    for (const [slot, col, kind] of [['grips', 'grip', 'GRIPS'], ['muzzles', 'muzzle', 'MUZZLES'], ['stocks', 'stock', 'STOCKS']]) {
      const f = rc.filters[col];
      if (f && f.values) out[slot] = RL.LABELS[kind].map((_, i) => i).filter((i) => f.values.has(optText(kind, i)));
    }
    return Object.keys(out).length ? out : null;
  }
  // a suggestion as the table's filters see it (same columns and values as a row of the table)
  const candVals = (c) => ({
    grip: optText('GRIPS', c.grip), muzzle: optText('MUZZLES', c.muzzle), stock: optText('STOCKS', c.stock), source: SRC_COMPUTED,
    v0: c.stats ? Number(c.stats.v0.toFixed(2)) : null, vEnd: c.stats ? Number(c.stats.vEnd.toFixed(2)) : null, duration: c.stats ? c.stats.duration : null, points: c.stats ? c.stats.points : null,
  });
  const candValue = (m, col) => m.vals[col];
  const suggKey = () => `${S.data.file.etag}|${S.sel.id}|${rc.mode}|${rc.weapon}|${rc.scope}|${rc.gesture}|${JSON.stringify(filterConstraints())}`;

  function startSuggestions() {
    if (RL.isGunDisabled(rc.weapon)) return null;
    const key = suggKey();
    if (rc.sugg && rc.sugg.key === key) return rc.sugg;
    stopSuggestions();
    const st = { key, status: 'loading', cands: [], missing: [], showMore: false, ai: { status: 'idle', model: '', reason: '', rank: new Map() }, aiEnabled: false, runAi: null, ac: new AbortController(), paint: null, timer: null };
    rc.sugg = st;
    if (!latest()) { st.status = 'none'; return st; } // a backup day: the server only knows the latest file
    // with a filter on the table the server picks its candidates inside it, and the AI is told what the user filtered
    const constraints = filterConstraints();
    const body = { id: S.sel.id, mode: rc.mode, combo: { weapon: rc.weapon, scope: rc.scope, gesture: rc.gesture }, ...(constraints ? { filter: constraints } : {}) };
    const paint = () => { if (rc.sugg === st && st.paint) st.paint(); };
    // asks the AI to order the candidates; regenerate = "AI tạo lại": a fresh opinion (the old order stays if it fails)
    st.runAi = (regenerate) => {
      if (rc.sugg !== st || st.ai.status === 'loading') return;
      st.ac = new AbortController();
      st.ai.status = 'loading';
      paint();
      api('POST', '/ai/rank-combos', regenerate ? { ...body, regenerate: true } : body, { signal: st.ac.signal }).then((a) => {
        if (rc.sugg !== st) return;
        if (a.ok) { st.ai.status = 'ok'; st.ai.model = a.model || ''; st.ai.rank = new Map(a.ranking.map((x) => [comboId(x), x])); } else { st.ai.status = 'fail'; st.ai.reason = a.reason || ''; }
        paint();
      }).catch((e) => { if (rc.sugg === st) { st.ai.status = 'fail'; st.ai.reason = e.message || 'Không gọi được AI.'; paint(); } });
    };
    api('POST', '/recoil/combo-suggestions', body).then(async (r) => {
      if (rc.sugg !== st) return;
      st.cands = r.ok ? r.candidates : [];
      st.missing = r.ok ? (r.missing || r.candidates) : []; // every combination the gun can still take, not only the best few
      st.status = st.cands.length ? 'ok' : 'none';
      paint();
      if (st.status !== 'ok') return;
      const status = await aiStatus();
      if (!status.enabled || rc.sugg !== st) return;
      st.aiEnabled = true;
      paint();
      // a short wait, so flipping through scopes, postures and filters does not send a request for each one
      st.timer = setTimeout(() => st.runAi(false), 600);
    }).catch(() => { if (rc.sugg === st) { st.status = 'none'; paint(); } });
    return st;
  }
  function stopSuggestions() {
    if (!rc.sugg) return;
    clearTimeout(rc.sugg.timer);
    rc.sugg.ac.abort(); // drops a question to the AI that is still waiting
    rc.sugg = null;
  }

  // Adds a suggested combination to the list as if it was added by hand, and opens it.
  async function addSuggested(c) {
    if (!(await discardOk())) return;
    if (!rc.customCombos) rc.customCombos = new Set();
    rc.customCombos.add(RL.comboKey({ weapon: rc.weapon, scope: rc.scope, gesture: rc.gesture, grip: c.grip, muzzle: c.muzzle, stock: c.stock }));
    rc.picked = { grip: c.grip, muzzle: c.muzzle, stock: c.stock };
    rc.editCurve = null;
    rc.dirty = false;
    rc.bad.clear();
    redraw();
    toast('Đã thêm tổ hợp. Bấm "Tính mốc (server + AI)" để tính các mốc cho nó.');
  }

  // Adds EVERY suggested combination (the whole list, not only the few shown) to the table as new ones: no points yet, nothing saved.
  // "AI tạo mốc" then makes the points and "Lưu tất cả" writes them.
  async function addAllSuggested(list) {
    if (!list.length) return;
    if (list.length > 40) {
      const go = await showModal({
        title: `Thêm ${list.length} tổ hợp?`, tone: 'warn',
        body: el('p', {}, 'Mỗi tổ hợp sẽ thành một dòng mới (chưa lưu). Sau đó "AI tạo mốc" hỏi AI từng tổ hợp một nên có thể lâu; bạn dừng được bất cứ lúc nào.'),
        actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'go', label: `Thêm ${list.length} tổ hợp`, primary: true }],
      });
      if (go !== 'go') return;
    }
    if (!(await discardOk())) return;
    if (!rc.customCombos) rc.customCombos = new Set();
    let added = 0;
    for (const c of list) {
      const key = RL.comboKey({ weapon: rc.weapon, scope: rc.scope, gesture: rc.gesture, grip: c.grip, muzzle: c.muzzle, stock: c.stock });
      if (!rc.customCombos.has(key)) { rc.customCombos.add(key); added++; }
    }
    rc.picked = null;
    rc.editCurve = null;
    rc.dirty = false;
    rc.bad.clear();
    redraw();
    toast(`Đã thêm ${added} tổ hợp vào danh sách (chưa lưu). Bấm "AI tạo mốc" để tạo mốc cho chúng, rồi "Lưu tất cả".`);
  }

  // listedKeys: the combinations already in the table (they are not suggested again). The block sits under the table, outside the part that
  // scrolls sideways, so the button is always in view. The few best candidates come first (the AI's order); "Hiện thêm" shows all the others
  // the gun can still take, and "Thêm tất cả" adds them all.
  function ghostList(ix, listedKeys, model) {
    if (RL.isGunDisabled(rc.weapon)) {
      return el('div', { class: 'ghost-list', role: 'region', 'aria-label': 'Gợi ý thêm tổ hợp' },
        el('div', { class: 'ghost-head' }, el('span', {}, 'Gợi ý thêm tổ hợp')),
        el('p', { class: 'muted text-sm' }, 'Súng này đã bị tắt trong Tiêu chuẩn súng: hệ thống và AI không gợi ý hoặc thêm tổ hợp.'));
    }
    const st = startSuggestions();
    if (!st) return el('div', { class: 'ghost-list', role: 'region', 'aria-label': 'Gợi ý thêm tổ hợp' });
    const box = el('div', { class: 'ghost-list', role: 'region', 'aria-label': 'Gợi ý thêm tổ hợp' });
    const paint = () => {
      const rank = (c) => (st.ai.rank.has(comboId(c)) ? st.ai.rank.get(comboId(c)).rank : 99);
      const candKeys = new Set(st.cands.map(comboId));
      const extra = st.missing.filter((c) => !candKeys.has(comboId(c)));
      // the same filters as the table; ordered like the table when it is sorted, otherwise by the AI's ranking (then the rest in the server's order)
      const filtered = (list) => TF.applyFilters(list.filter((c) => !listedKeys.has(comboId(c))).map((c) => ({ c, vals: candVals(c) })), rc.filters, candValue);
      const everyMissing = filtered([...st.cands, ...extra]).map((m) => m.c);
      const pool = filtered(st.showMore ? [...st.cands, ...extra] : st.cands);
      const open = st.cands.filter((c) => !listedKeys.has(comboId(c)));
      const ordered = rc.sort ? TF.sortRows(pool, rc.sort, candValue) : pool.sort((x, y) => rank(x.c) - rank(y.c));
      const shown = ordered.map((m) => m.c).slice(0, st.showMore ? MAX_GHOST_ALL : MAX_GHOST);
      const addAllBtn = () => el('button', {
        type: 'button', class: 'btn small', disabled: !everyMissing.length,
        title: 'Thêm vào danh sách mọi tổ hợp súng này lắp được mà chưa có mục riêng (theo bộ lọc của bảng). Chưa lưu gì.',
        onclick: guard(() => addAllSuggested(everyMissing)),
      }, icon('plus'), `Thêm tất cả (${everyMissing.length})`);
      const unsaved = pendingSaves(rc.weapon).length;
      if (!shown.length) {
        // said only when the filter is what left nothing (suggestions that are already rows of the table are not "hidden by the filter")
        const byFilter = TF.countActive(rc.filters) > 0 && (st.status === 'none' || (st.status === 'ok' && open.length > 0) || (st.missing.length > 0 && !everyMissing.length));
        box.replaceChildren(
          ...(byFilter && st.status !== 'loading' ? [el('div', { class: 'ghost-head' }, 'Không có gợi ý nào khớp bộ lọc của bảng. ', el('button', { type: 'button', class: 'btn small', onclick: () => { rc.filters = {}; rc.sort = null; redraw(); } }, icon('x'), 'Xóa bộ lọc'))] : []),
          ...(everyMissing.length || unsaved ? [el('div', { class: 'ghost-head' },
            el('span', {}, everyMissing.length ? `Còn ${everyMissing.length} tổ hợp súng này lắp được mà chưa có mục riêng${unsaved ? ` · ${unsaved} tổ hợp chưa lưu` : ''}` : `${unsaved} tổ hợp chưa lưu`),
            el('span', { class: 'head-actions' }, everyMissing.length ? addAllBtn() : null, saveAllButton(model)))] : []));
        return;
      }
      const aiNote = st.ai.status === 'loading' ? ' · AI đang xem…' : st.ai.status === 'ok' ? ` · AI (${st.ai.model || 'auto'}) đã xếp hạng` : st.ai.status === 'fail' ? ` · AI: ${st.ai.reason}` : '';
      const items = shown.map((c) => {
        const ai = st.ai.rank.get(comboId(c));
        const why = [
          c.gap ? `${c.gap.n}/${c.gap.of} súng tương tự có (${c.gap.names.slice(0, 3).join(', ')})` : c.seenIn ? `${c.seenIn} súng tương tự có` : null,
          c.expectedError != null ? `hệ số thường lệch ~${Math.round(c.expectedError * 100)}% với loại này` : null,
        ].filter(Boolean).join(' · ');
        const name = `tay cầm: ${optText('GRIPS', c.grip)} · nòng: ${optText('MUZZLES', c.muzzle)} · báng: ${optText('STOCKS', c.stock)}`;
        return el('div', { class: 'ghost-item' },
          el('div', { class: 'ghost-text' },
            el('div', { class: 'ghost-combo' }, name, c.multiplier != null ? el('span', { class: 'muted' }, ` ×${Number(c.multiplier.toFixed(3))}`) : null, ' ', el('span', { class: 'tag' }, 'gợi ý'), ai ? el('span', { class: 'tag ai-tag', title: ai.reason }, `AI #${ai.rank}`) : null),
            el('div', { class: 'ghost-why' }, why || 'tổ hợp chưa có mục riêng'),
            ai && ai.reason ? el('div', { class: 'ghost-ai' }, `AI: ${ai.reason}`) : null),
          el('button', { type: 'button', class: 'btn small', title: 'Thêm tổ hợp này vào danh sách và mở nó', onclick: guard(() => addSuggested(c)) }, icon('plus'), 'Thêm'));
      });
      const hidden = everyMissing.length - shown.length;
      const busy = st.ai.status === 'loading';
      const regen = el('button', {
        type: 'button', class: 'btn small', disabled: !st.aiEnabled || busy,
        title: !st.aiEnabled ? 'AI chưa được bật (cần AI_API_KEY trong .env của server)' : busy ? 'AI đang xem…' : 'Hỏi AI xếp hạng lại các gợi ý này (theo bộ lọc hiện tại)',
        onclick: () => st.runAi(true),
      }, icon('sparkles'), 'AI tạo lại');
      box.replaceChildren(
        el('div', { class: 'ghost-head' }, el('span', {}, `Gợi ý thêm tổ hợp (chưa có mục riêng)${TF.countActive(rc.filters) ? ' · theo bộ lọc của bảng' : ''}${aiNote}`), el('span', { class: 'head-actions' }, addAllBtn(), regen, saveAllButton(model))),
        ...items,
        hidden > 0 || st.showMore ? el('div', { class: 'ghost-more' }, el('button', { type: 'button', class: 'btn small ghost', onclick: () => { st.showMore = !st.showMore; paint(); } }, st.showMore ? 'Thu gọn' : `Hiện thêm ${hidden} tổ hợp còn thiếu`)) : null,
        el('div', { class: 'ghost-manual' }, el('button', { type: 'button', class: 'btn small', onclick: () => showComboModal(ix) }, icon('plus'), 'Hoặc thêm một tổ hợp khác bằng tay…')));
    };
    st.paint = paint;
    paint();
    return box;
  }

  function recoilView(doc) {
    if (RL.isGunDisabled(rc.weapon)) {
      rc.weapon = defaultWeapon();
      rc.picked = null;
      rc.editCurve = null;
      rc.dirty = false;
    }
    if (!rc.category || (rc.category !== 'all' && RL.gunClass(rc.weapon) !== rc.category)) {
      rc.category = RL.gunClass(rc.weapon) || 'ar';
    }
    const ix = recoilIndex(doc);
    const modeSel = el('select', { 'aria-label': 'Bộ dữ liệu', onchange: async (e) => {
      if (!(await discardOk())) { e.target.value = rc.mode; return; }
      rc.mode = e.target.value; rc.picked = null; rc.editCurve = null; rc.dirty = false; redraw();
    } },
      Object.entries(MODE_VN).map(([m, label]) => el('option', { value: m, selected: m === rc.mode }, label)));
    const field = (label, control) => el('label', { class: 'numfield' }, label, control);
    if (!ix.ds) return el('div', { class: 'card' }, el('div', { class: 'row' }, field('Bộ dữ liệu', modeSel)), el('p', {}, 'Bản này không có trường recoil_data.'));
    const sums = ix.sums;

    const catSel = el('select', {
      'aria-label': 'Loại súng',
      class: 'category-select',
      onchange: async (e) => {
        const newCat = e.target.value;
        if (newCat === rc.category) return;

        if (newCat === 'all' || RL.gunClass(rc.weapon) === newCat) {
          rc.category = newCat;
          redraw();
          return;
        }

        if (!(await discardOk())) {
          e.target.value = rc.category;
          return;
        }

        const prevW = rc.weapon;
        const prevStats = weaponDraftStats(prevW);
        if (prevStats.mine > 0) {
          const choice = await showModal({
            title: 'Chuyển sang loại súng khác?', tone: 'warn',
            body: [
              el('p', {}, `Súng hiện tại (${RL.weaponLabel(prevW)}) đang có ${prevStats.mine} bản nháp/tổ hợp chưa lưu.`),
              el('p', { class: 'muted text-sm' }, 'Bạn muốn giữ lại các bản nháp này để quay lại lưu sau, hay xóa bỏ bản nháp của súng này?'),
            ],
            actions: [
              { id: 'stay', label: 'Ở lại' },
              { id: 'drop', label: `Xóa nháp ${RL.weaponLabel(prevW)}`, danger: true },
              { id: 'keep', label: `Giữ nháp ${RL.weaponLabel(prevW)}`, primary: true },
            ],
          });
          if (choice === 'stay' || !choice) {
            e.target.value = rc.category;
            return;
          }
          if (choice === 'drop') {
            clearDraftsForWeapon(prevW);
          }
        }

        let targetW = null;
        for (let w = 1; w < RL.WEAPONS.length; w++) {
          if (RL.gunClass(w) === newCat && !RL.isGunDisabled(w) && !RL.isZeroWeapon(w)) {
            targetW = w;
            break;
          }
        }
        if (!targetW) {
          for (let w = 1; w < RL.WEAPONS.length; w++) {
            if (RL.gunClass(w) === newCat && !RL.isGunDisabled(w)) {
              targetW = w;
              break;
            }
          }
        }
        if (!targetW) {
          for (let w = 1; w < RL.WEAPONS.length; w++) {
            if (RL.gunClass(w) === newCat) {
              targetW = w;
              break;
            }
          }
        }

        rc.category = newCat;
        if (targetW) {
          rc.weapon = targetW;
          rc.picked = null;
          rc.editCurve = null;
          rc.dirty = false;
        }
        redraw();
      }
    },
      ...RL.GUN_CLASSES.map((cls) => el('option', { value: cls.id, selected: rc.category === cls.id }, cls.name)),
      el('option', { value: 'all', selected: rc.category === 'all' }, 'Tất cả loại súng')
    );

    const makeWeaponOption = (w) => {
      const s = sums[w] || { keys: 0, entries: 0, byGesture: [0, 0, 0], byScope: [] };
      const dis = RL.isGunDisabled(w);
      const isCur = w === rc.weapon;
      const name = RL.weaponLabel(w);
      const countText = `${s.keys} khóa${s.entries > s.keys ? `, ${s.entries} mục` : ''}`;
      const labelText = `${isCur ? '● ' : ''}${name}${dis ? ' (đã tắt)' : ''} — ${countText}${isCur ? ' [đang chọn]' : ''}`;
      return el('option', {
        value: w,
        selected: isCur,
        disabled: dis,
        class: isCur ? 'opt-current' : undefined,
      }, labelText);
    };

    let weaponOptions = [];
    if (rc.category === 'all') {
      weaponOptions = RL.GUN_CLASSES.map((cls) => {
        const gunsInClass = [];
        for (let w = 1; w < RL.WEAPONS.length; w++) {
          if (RL.gunClass(w) === cls.id) {
            gunsInClass.push(makeWeaponOption(w));
          }
        }
        return el('optgroup', { label: cls.name }, gunsInClass);
      });
    } else {
      for (let w = 1; w < RL.WEAPONS.length; w++) {
        if (RL.gunClass(w) === rc.category) {
          weaponOptions.push(makeWeaponOption(w));
        }
      }
    }

    const weaponSel = el('select', {
      'aria-label': 'Súng',
      class: 'weapon-select',
      onchange: async (e) => {
        const val = Number(e.target.value);
        if (RL.isGunDisabled(val)) {
          toast('Súng này đã bị tắt trong Tiêu chuẩn súng: không thể chọn.', true);
          e.target.value = rc.weapon;
          return;
        }
        if (!(await discardOk())) {
          e.target.value = rc.weapon;
          return;
        }

        const prevW = rc.weapon;
        const prevStats = weaponDraftStats(prevW);
        if (prevStats.mine > 0 && prevW !== val) {
          const choice = await showModal({
            title: `Chuyển sang súng ${RL.weaponLabel(val)}?`, tone: 'warn',
            body: [
              el('p', {}, `Súng hiện tại (${RL.weaponLabel(prevW)}) đang có ${prevStats.mine} bản nháp/tổ hợp chưa lưu.`),
              el('p', { class: 'muted text-sm' }, 'Bạn muốn giữ lại các bản nháp này để quay lại lưu sau, hay xóa bỏ bản nháp của súng này?'),
            ],
            actions: [
              { id: 'stay', label: 'Ở lại' },
              { id: 'drop', label: `Xóa nháp ${RL.weaponLabel(prevW)}`, danger: true },
              { id: 'keep', label: `Giữ nháp ${RL.weaponLabel(prevW)}`, primary: true },
            ],
          });
          if (choice === 'stay' || !choice) {
            e.target.value = rc.weapon;
            return;
          }
          if (choice === 'drop') {
            clearDraftsForWeapon(prevW);
          }
        }

        rc.weapon = val;
        if (rc.category !== 'all') {
          rc.category = RL.gunClass(val);
        }
        rc.picked = null;
        rc.editCurve = null;
        rc.dirty = false;
        redraw();
      }
    }, weaponOptions);
    const sum = sums[rc.weapon] || { keys: 0, entries: 0, byGesture: [0, 0, 0], byScope: [] };
    const postureSeg = segmented({
      label: 'Tư thế',
      options: POSTURE_VN.map((label, g) => ({ value: g, label: `${label} (${sum.byGesture[g] || 0})` })),
      value: rc.gesture,
      onchange: async (g) => { if (!(await discardOk())) return; rc.gesture = g; rc.picked = null; rc.editCurve = null; rc.dirty = false; redraw(); },
    });
    // the scopes the gun can take and has data for are the buttons; the others wait behind one line
    const scopeChip = (s) => {
      const problem = RL.comboProblems(rc.weapon, s, {})[0];
      return el('button', { type: 'button', class: `chip${problem ? ' unsupported' : ''}`, title: problem ? problem.reason : RL.SCOPES[s], 'aria-pressed': rc.scope === s, onclick: async () => {
        if (!(await discardOk())) return;
        rc.scope = s; rc.picked = null; rc.editCurve = null; rc.dirty = false; redraw();
      } }, `${RL.LABELS.SCOPES[s]} (${sum.byScope[s] || 0})`);
    };
    const mainScopes = RL.SCOPES.map((_, s) => s).filter((s) => rc.scope === s || ((sum.byScope[s] || 0) > 0 && !RL.comboProblems(rc.weapon, s, {}).length));
    const otherScopes = RL.SCOPES.map((_, s) => s).filter((s) => !mainScopes.includes(s));

    const specs = getAccessorySpecs(ix.idx, rc.weapon, rc.scope);
    const coef = specs.coef;

    if (!rc.customCombos) rc.customCombos = new Set();
    const currPrefix = `${rc.weapon}|${rc.scope}|${rc.gesture}|`;
    let combos = RL.exactCombos(ix.idx, rc.weapon, rc.scope, rc.gesture);
    for (const key of rc.customCombos) {
      if (key.startsWith(currPrefix)) {
        const [, , , g, m, st] = key.split('|').map(Number);
        if (!combos.some((c) => c.grip === g && c.muzzle === m && c.stock === st)) {
          combos.push({ grip: g, muzzle: m, stock: st, custom: true });
        }
      }
    }
    if (rc.showAll) {
      combos = [];
      // every combination the gun can take, plus the ones it already has an own entry for (those stay visible, whatever the table says)
      for (let g = 0; g < RL.GRIPS.length; g++) {
        for (let m = 0; m < RL.MUZZLES.length; m++) {
          for (let st = 0; st < RL.STOCKS.length; st++) {
            const has = ix.idx.map.has(`${rc.weapon}|${rc.scope}|${g}|${m}|${st}|${rc.gesture}`);
            if (has || !RL.comboProblems(rc.weapon, rc.scope, { grip: g, muzzle: m, stock: st }).length) combos.push({ grip: g, muzzle: m, stock: st });
          }
        }
      }
    } else if (!combos.some((c) => !c.grip && !c.muzzle && !c.stock)) combos.unshift({ grip: 0, muzzle: 0, stock: 0 });
    const zero = RL.isZeroWeapon(rc.weapon);
    const comboOf = (c) => ({ weapon: rc.weapon, scope: rc.scope, gesture: rc.gesture, grip: c.grip, muzzle: c.muzzle, stock: c.stock });
    // what the filter buttons of the table work on: one entry per combination with the value of each column
    const sourceName = (r) => (r.source === 'exact' ? 'Có mục riêng' : r.source === 'zero' ? 'Luôn 0' : SRC_COMPUTED);
    const model = combos.map((c) => {
      const r = RL.resolve(ix.idx, comboOf(c));
      const draft = rc.drafts.get(recoilKey(comboOf(c)));
      const st = RL.curveStats(draft ? draft.curve : r.curve);
      return { c, r, st, draft, vals: { grip: optText('GRIPS', c.grip), muzzle: optText('MUZZLES', c.muzzle), stock: optText('STOCKS', c.stock), source: sourceName(r), v0: Number(st.v0.toFixed(2)), vEnd: Number(st.vEnd.toFixed(2)), duration: st.duration, points: st.points } };
    });
    const cellValue = (m, col) => m.vals[col];
    const visible = TF.sortRows(TF.applyFilters(model, rc.filters, cellValue), rc.sort, cellValue);
    const filtered = TF.countActive(rc.filters) > 0;
    const setView = ({ filters, sort }) => { rc.filters = filters; rc.sort = sort; redraw(); };
    const clearFilters = () => { rc.filters = {}; rc.sort = null; redraw(); };
    const rows = visible.map(({ c, r, st, draft }) => {
      const active = rc.picked && rc.picked.grip === c.grip && rc.picked.muzzle === c.muzzle && rc.picked.stock === c.stock;

      const editBtn = zero ? null : el('button', {
        type: 'button',
        class: 'btn icon small ghost',
        title: 'Sửa tổ hợp này',
        onclick: (e) => { e.stopPropagation(); showComboModal(ix, c); }
      }, icon('pencil'));

      let delBtn = null;
      if (zero) {
        delBtn = null; // the app always uses a zero curve for this gun: nothing to edit or delete
      } else if (r.source === 'exact') {
        delBtn = el('button', {
          type: 'button',
          class: 'btn icon small ghost',
          title: 'Xóa mục riêng (quay về tính theo hệ số)',
          onclick: (e) => { e.stopPropagation(); deleteRecoil(ix, comboOf(c)); }
        }, icon('trash'));
      } else if (c.custom) {
        delBtn = el('button', {
          type: 'button',
          class: 'btn icon small ghost',
          title: 'Bỏ khỏi danh sách',
          onclick: (e) => {
            e.stopPropagation();
            rc.customCombos.delete(`${rc.weapon}|${rc.scope}|${rc.gesture}|${c.grip}|${c.muzzle}|${c.stock}`);
            if (active) rc.picked = null;
            redraw();
          }
        }, icon('x'));
      }

      return el('tr', { class: `pick${active ? ' active' : ''}`, onclick: async () => {
        if (!(await discardOk())) return;
        rc.picked = c;
        rc.editCurve = null;
        rc.dirty = false;
        redraw();
      } },
        el('td', { 'data-label': 'Tay cầm' }, optWithBadge('GRIPS', c.grip, coef), isNewCombo(comboOf(c), r) ? el('span', { class: 'tag warn', title: draft ? 'Đã tạo mốc, chưa lưu' : 'Tổ hợp mới, chưa lưu' }, draft ? 'chờ lưu' : 'mới') : null, draft && draft.suspect ? el('span', { class: 'tag danger', title: 'Lệch nhiều so với đường cong theo hệ số: nên xem lại' }, 'xem lại') : null, draft && (draft.source === 'add_points' || draft.source === 'retime') ? el('span', { class: 'tag warn', title: `${draft.source === 'retime' ? 'Đã chia đều thời gian' : 'Đã thêm mốc'}, chưa lưu (${draft.how})` }, draft.how) : draft && draft.review ? el('span', { class: 'tag warn', title: `AI đề xuất đổi ${Math.round((draft.change || 0) * 100)}% so với mục hiện tại, chưa lưu${draft.provider ? ` (${draft.provider})` : ''}.${draft.reasoning ? ` ${draft.reasoning}` : ''}` }, `AI đề xuất ${Math.round((draft.change || 0) * 100)}%`) : null, r.source === 'exact' && RL.comboProblems(rc.weapon, rc.scope, c).length ? el('span', { class: 'tag danger', title: RL.comboProblems(rc.weapon, rc.scope, c).map((p) => p.reason).join(' ') }, 'sai chuẩn') : null),
        el('td', { 'data-label': 'Nòng' }, optWithBadge('MUZZLES', c.muzzle, coef)),
        el('td', { 'data-label': 'Báng' }, optWithBadge('STOCKS', c.stock, coef)),
        el('td', { 'data-label': 'Nguồn' }, sourceTag(r), r.copies > 1 ? el('span', { class: 'tag', title: `${r.copies} mục trùng khóa, ${r.distinct} nội dung khác nhau; app dùng mục cuối` }, ` ×${r.copies}`) : null),
        el('td', { class: 'num', 'data-label': 'Giá trị t=0' }, num(st.v0)),
        el('td', { class: 'num', 'data-label': 'Giá trị cuối' }, num(st.vEnd)),
        el('td', { class: 'num', 'data-label': 'Thời lượng' }, `${st.duration} ms`),
        el('td', { class: 'num', 'data-label': 'Mốc' }, st.points),
        el('td', { class: 'act' }, el('div', { class: 'row-btns hover-actions' }, editBtn, delBtn)));
    });

    const fh = (label, col, o = {}) => el('th', { 'aria-sort': FU.ariaSort(rc.sort, col), }, FU.header({ label, col, rows: model, valueOf: cellValue, filters: rc.filters, sort: rc.sort, onChange: setView, ...o }));
    const table = el('table', { class: 'combo-table' },
      el('thead', {}, el('tr', {}, [
        fh('Tay cầm', 'grip'),
        fh('Nòng', 'muzzle'),
        fh('Báng', 'stock'),
        fh('Nguồn', 'source'),
        fh('Giá trị t=0', 'v0', { numeric: true, checklist: false }),
        fh('Giá trị cuối', 'vEnd', { numeric: true, checklist: false }),
        fh('Thời lượng', 'duration', { numeric: true }),
        fh('Mốc', 'points', { numeric: true }),
        el('th', {})
      ])),
      el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colspan: 9, class: 'muted' }, filtered ? el('span', {}, 'Không có tổ hợp nào khớp bộ lọc. ', el('button', { type: 'button', class: 'btn small', onclick: clearFilters }, 'Xóa bộ lọc')) : 'Không có tổ hợp nào.'))));
    const ghosts = ghostList(ix, new Set(combos.map((c) => comboId(c))), model);

    const gunDisabled = RL.isGunDisabled(rc.weapon);

    const addComboBtn = el('button', {
      type: 'button',
      class: 'btn primary small',
      disabled: zero || gunDisabled,
      title: zero ? 'Súng này luôn dùng đường cong 0 trong app' : gunDisabled ? 'Súng này đã bị tắt trong Tiêu chuẩn súng' : undefined,
      onclick: () => showComboModal(ix)
    }, icon('plus'), 'Thêm tổ hợp');
    const bulkDelBtn = el('button', {
      type: 'button', class: 'btn small', onclick: guard(() => showBulkDeleteModal(ix)),
      title: 'Chọn nhiều súng, tư thế, ống ngắm rồi xóa các mục riêng của chúng',
    }, icon('trash'), 'Xóa nhiều…');

    const refFieldsBtn = el('button', {
      type: 'button',
      class: 'btn small ghost',
      onclick: () => showAccessoryReferenceModal(ix)
    }, icon('layers'), 'Danh sách trường & hệ số');

    const aiBtn = el('button', {
      type: 'button', class: 'btn small', 'data-bulk': 'ai', disabled: zero || gunDisabled || !latest() || (!rc.bulk && !aiTargets().length),
      title: rc.bulk ? 'Dừng việc tạo mốc (các tổ hợp đã tạo xong vẫn giữ)' : gunDisabled ? 'Súng này đã bị tắt trong Tiêu chuẩn súng' : 'Tạo mốc cho mọi tổ hợp mới trong danh sách: AI trả lời thì dùng, không thì dùng kết quả của server. Chưa lưu gì.',
      onclick: guard(() => aiCreateAll()),
    }, icon(rc.bulk ? 'x' : 'sparkles'), el('span', { class: 'bulk-label' }, bulkLabel()));
    const fillBtn = el('button', {
      type: 'button', class: 'btn small', disabled: zero || gunDisabled || !latest() || Boolean(rc.bulk),
      title: gunDisabled ? 'Súng này đã bị tắt trong Tiêu chuẩn súng' : 'Quét MỌI ống ngắm × tư thế của súng này, tạo mốc cho mọi tổ hợp còn thiếu theo bảng chuẩn (AI/server/hệ số), kiểm tra lại rồi thêm vào danh sách. Chưa lưu gì: bấm "Lưu tất cả".',
      onclick: guard(() => fillGun(ix)),
    }, icon('layers'), 'Tạo đủ cho cả súng');
    const scanAllBtn = el('button', {
      type: 'button', class: 'btn small', disabled: zero || gunDisabled || !latest() || Boolean(rc.bulk),
      title: gunDisabled ? 'Súng này đã bị tắt trong Tiêu chuẩn súng' : 'Rà soát MỌI mục riêng của súng này (mọi ống ngắm × tư thế): server tìm mục lệch so với súng tương tự hoặc không nhất quán, AI xem lại từng mục theo bảng chuẩn và đề xuất mốc mới. Chưa lưu gì: bấm "Lưu tất cả".',
      onclick: guard(() => scanAll()),
    }, icon('search'), 'Quét tất cả');
    const aiSettingsBtn = el('button', {
      type: 'button', class: 'btn small ghost',
      title: 'Mở tab Cài đặt AI (địa chỉ, khóa API, model và thứ tự ưu tiên)',
      onclick: () => (window.goTo ? window.goTo('ai') : showAiSettings()),
    }, icon('sparkles'), 'Cài đặt AI');
    const saveAllBtn = saveAllButton(model);
    rc.model = model;
    const otherStats = weaponDraftStats(rc.weapon);
    const dropOthersBtn = otherStats.others > 0 ? el('button', {
      type: 'button', class: 'btn small ghost danger',
      title: `Xóa ${otherStats.others} bản nháp của các súng khác (${otherStats.otherWeapons.map((w) => RL.weaponLabel(w)).join(', ')}) đang lưu tạm trong bộ nhớ để không bị lưu nhầm`,
      onclick: async () => {
        const ok = await showModal({
          title: 'Xóa bản nháp của các súng khác?', tone: 'warn',
          body: el('p', {}, `Xóa ${otherStats.others} bản nháp của: ${otherStats.otherWeapons.map((w) => RL.weaponLabel(w)).join(', ')}? Các thay đổi chưa lưu của những súng này sẽ bị hủy. Súng hiện tại (${RL.weaponLabel(rc.weapon)}) được giữ nguyên.`),
          actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'drop', label: 'Xóa nháp súng khác', danger: true }],
        });
        if (ok === 'drop') {
          clearDraftsForOtherWeapons(rc.weapon);
          redraw();
          toast(`Đã xóa ${otherStats.others} bản nháp của các súng khác.`);
        }
      },
    }, icon('trash'), `Bỏ nháp súng khác (${otherStats.others})`) : null;
    const bulkRow = el('div', { class: 'row' }, aiBtn, fillBtn, scanAllBtn, saveAllBtn, dropOthersBtn, aiSettingsBtn, el('div', { class: 'bulk-box' }, ...bulkBoxNodes()));
    const audit = auditOf(ix);
    const mine = audit.filter((e) => e.weapon === rc.weapon);
    const auditBtn = el('button', {
      type: 'button', class: `btn small ${audit.length ? '' : 'ghost'}`, onclick: guard(() => showAuditModal(ix)),
      title: audit.length ? 'Liệt kê các mục riêng không đúng bảng phụ kiện chuẩn (cả các súng khác) và chọn xóa' : 'Mọi mục riêng đều đúng bảng phụ kiện chuẩn',
    }, icon(audit.length ? 'alert' : 'check'), `Kiểm tra theo chuẩn${audit.length ? ` (${audit.length})` : ''}`);
    const offList = RL.disabledEntries(ix.idx);
    const offBtn = el('button', {
      type: 'button', class: `btn small ${offList.length ? '' : 'ghost'}`, disabled: !offList.length, onclick: guard(() => showDisabledGunsModal(offList)),
      title: offList.length ? 'Xóa các tổ hợp của những súng đã tắt trong Tiêu chuẩn súng' : 'Không có tổ hợp nào của súng đã tắt',
    }, icon('trash'), `Xóa súng đã tắt${offList.length ? ` (${offList.length})` : ''}`);
    const auditNote = mine.length ? alert('warn', el('span', {}, `${RL.weaponLabel(rc.weapon)} có ${mine.length} mục riêng không đúng chuẩn phụ kiện (${[...new Set(mine.flatMap((e) => e.problems.map((p) => SLOT_VN[p.slot])))].join(', ')}). `,
      el('button', { type: 'button', class: 'btn small', onclick: guard(() => showAuditModal(ix)) }, 'Xem và xóa'))) : null;
    const disabledNote = gunDisabled ? alert('warn', el('span', {}, `Súng ${RL.weaponLabel(rc.weapon)} (${RL.WEAPONS[rc.weapon]}) đã bị TẮT KHÔNG SỬ DỤNG trong Tiêu chuẩn súng. Các chức năng Thêm tổ hợp, Tạo đủ cho cả súng, Quét tất cả và AI gợi ý mốc bị vô hiệu hóa cho súng này.`)) : null;
    const rule = RL.describeAttachments(rc.weapon);
    const selectors = el('div', { class: 'card' },
      el('div', { class: 'row selector-row' }, field('Loại súng', catSel), field('Súng', weaponSel), field('Tư thế', postureSeg), field('Bộ dữ liệu', modeSel), el('span', { class: 'spacer' }), offBtn, auditBtn, refFieldsBtn),
      el('div', { class: 'muted text-sm mb-2' }, 'Ống ngắm'),
      el('div', { class: 'chips' }, mainScopes.map(scopeChip)),
      el('details', { class: 'disclosure flat' }, el('summary', {}, `Ống ngắm khác (${otherScopes.length}) và phụ kiện ${RL.weaponLabel(rc.weapon)} lắp được`),
        el('div', { class: 'disclosure-body' },
          otherScopes.length ? el('div', { class: 'chips' }, otherScopes.map(scopeChip)) : null,
          el('p', { class: 'muted text-sm', title: rule ? `Nguồn: ${RL.attachmentsFor(rc.weapon).sourceLabel}. Bảng nằm ở admin/recoil.js (ATTACHMENT_RULES), tra cứu chi tiết ở docs/PhuKien_Sung_PUBG_Mobile.xlsx.` : undefined },
            rule ? `${rule}. Chỉ ảnh hưởng việc THÊM tổ hợp mới và gợi ý của server/AI; các mục riêng đã có trong file không bị đổi.` : 'Chưa có quy tắc phụ kiện cho súng này: mọi lựa chọn đều được phép.'))));

    const list = el('div', { class: 'recoil-list-col min-w-0' },
      el('div', { class: 'card' },
        el('div', { class: 'row' }, el('h2', {}, 'Tổ hợp phụ kiện'),
          el('span', { class: 'muted', title: filtered ? `Đang lọc: ${TF.describe(rc.filters, { grip: 'Tay cầm', muzzle: 'Nòng', stock: 'Báng', source: 'Nguồn', v0: 'Giá trị t=0', vEnd: 'Giá trị cuối', duration: 'Thời lượng', points: 'Mốc' })}` : undefined }, filtered ? `${visible.length}/${model.length}` : String(model.length)),
          filtered || rc.sort ? el('button', { type: 'button', class: 'btn small ghost', onclick: clearFilters }, icon('x'), `Xóa bộ lọc${filtered ? ` (${TF.countActive(rc.filters)})` : ''}`) : null,
          bulkDelBtn, addComboBtn),
        disabledNote,
        auditNote,
        bulkRow,
        el('label', { class: 'row auto-step' },
          el('input', { type: 'checkbox', checked: rc.showAll, onchange: (e) => { rc.showAll = e.target.checked; redraw(); } }),
          'Hiện cả tổ hợp tính từ hệ số'),
        el('div', { class: 'table-wrap' }, table),
        ghosts,
        el('p', { class: 'muted text-xs' }, 'Bấm một dòng để xem và sửa đường cong; bút để đổi phụ kiện của tổ hợp.')));
    const detail = rc.picked ? el('div', { class: 'recoil-detail-col' }, recoilDetail(ix, comboOf(rc.picked))) : null;
    return el('div', {}, selectors, el('div', { class: `layout recoil-layout${detail ? '' : ' single'}` }, list, detail));
  }

  const comboText = (o) => `${RL.weaponLabel(o.weapon)} · ${POSTURE_VN[o.gesture]} · ${RL.LABELS.SCOPES[o.scope]} · tay cầm: ${optText('GRIPS', o.grip)} · nòng: ${optText('MUZZLES', o.muzzle)} · báng: ${optText('STOCKS', o.stock)}`;

  // the key of a combination (its own gun, scope and posture when it has them: combinations of the whole gun are not only the ones shown)
  const recoilKey = (o) => `${o.weapon ?? rc.weapon}|${o.scope ?? rc.scope}|${o.gesture ?? rc.gesture}|${o.grip}|${o.muzzle}|${o.stock}|${rc.mode}`;

  // Asks the server and the AI at the same time for the points of a combination, shows both, and puts the one the user picks into the
  // editor as an unsaved change. Returns true when points were put in.
  async function suggestPoints(o) {
    if (!latest()) { toast('Chỉ tính được khi đang xem "Mới nhất".', true); return false; }
    if (RL.isZeroWeapon(o.weapon) || RL.isGunDisabled(o.weapon)) {
      toast(RL.isGunDisabled(o.weapon) ? 'Súng này đã bị tắt trong Tiêu chuẩn súng: không thể tính mốc.' : 'Súng này luôn dùng đường cong 0 trong app: không có gì để tính.', true);
      return false;
    }
    const status = await aiStatus();
    const res = await window.SuggestUi.compare({
      label: comboText(o),
      body: { id: S.sel.id, mode: rc.mode, combo: { weapon: o.weapon, scope: o.scope, gesture: o.gesture, grip: o.grip, muzzle: o.muzzle, stock: o.stock } },
      ai: status,
      current: rc.editCurve && rc.editKey === recoilKey(o) ? rc.editCurve : null,
    });
    if (!res) return false;
    if (!(await discardOk())) return false; // the editor has unsaved changes that these points would replace
    rc.picked = { grip: o.grip, muzzle: o.muzzle, stock: o.stock };
    rc.editKey = recoilKey(o);
    rc.editCurve = res.curve;
    rc.dirty = true;
    rc.fresh = isNewCombo(o, RL.resolve(rc.idx.idx, o));
    rc.freshBase = null;
    rc.bad.clear();
    redraw();
    toast(`Đã điền ${res.curve.length} mốc từ kết quả của ${res.source === 'ai' ? 'AI' : 'server'} (chưa lưu).`);
    return true;
  }

  // Writes the changed item back into the file on the server. The edit is applied to the item as the server holds it NOW
  // (a conflict reloads the page first), and the file is written with the etag that was read together with it.
  // stage(step, percent, text) says how far it is (a progress bar listens); onSaved() runs once the server has the file.
  // The page then updates from what it just wrote: no second download of the file and no empty page in between.
  async function putRecoilItem(updatedDoc, done, stage = () => {}, onSaved = () => {}) {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    stage(1, 50, 'Đang tạo file XML…');
    await frame();
    let newXml;
    try {
      newXml = CX.replaceMapItem(S.data.file.text, S.sel.id, updatedDoc);
    } catch (e) {
      toast(`Lỗi khi tạo XML: ${e.message}`, true);
      return false;
    }
    stage(2, 60, `Đang gửi ${fmtBytes(textBytes(newXml))} lên server…`);
    await frame();
    let saved;
    const fromOld = !latest();
    try {
      // from an older source the file is written over the newest one: its etag is read now (the owner confirmed the overwrite)
      const etag = fromOld ? (await api('GET', `/sync/databases/${encodeURIComponent(CACHE_FILE)}`)).etag : S.data.file.etag;
      saved = await api('PUT', `/sync/databases/${encodeURIComponent(CACHE_FILE)}`, { text: newXml, etag });
    } catch (err) {
      if (err.status === 409) {
        toast(fromOld ? 'File mới nhất trên server vừa thay đổi (có thể app vừa đồng bộ). Chưa lưu gì; bấm lưu lại để thử tiếp.' : 'File đã thay đổi trên server từ lúc bạn mở (có thể app vừa đồng bộ). Đã tải lại bản mới; kiểm tra rồi lưu lại.', true);
        if (!fromOld) await refresh();
        return false;
      }
      throw err;
    }
    stage(3, 92, 'Đang cập nhật trang…');
    await frame();
    toast(done);
    try { onSaved(); } catch (e) { toast(`Đã lưu vào server nhưng không dọn được bản nháp (${e.message || e}). Bấm "Tải lại" nếu thấy dữ liệu cũ.`, true); } // the file is saved whatever happens here
    rc.dirty = false;
    rc.fresh = false;
    rc.freshBase = null;
    rc.editCurve = null;
    rc.idx = null;
    rc.bad.clear();
    if (fromOld) { S.src = ''; try { await refresh(); } catch (e) { toast(`Đã lưu vào server nhưng chưa tải lại được trang (${e.message || e}). Bấm "Tải lại".`, true); } return true; }
    try {
      const at = new Date().toISOString();
      // read the new file first and replace file, parsed and analysis together: if reading fails, nothing is half replaced (the old etag then makes the
      // next save a conflict that reloads, instead of a save built on the old analysis that would undo this one)
      const parsed = CX.parse(newXml);
      const analysis = CX.analyze(parsed);
      S.data.file = { ...S.data.file, text: newXml, etag: saved.etag, bytes: textBytes(newXml), updated_at: at, web_edit: { at } };
      S.data.parsed = parsed;
      S.data.analysis = analysis;
      redraw({ smooth: true });
    } catch {
      // the file is saved; if it cannot be read here, read it again from the server; if even that fails the save is still a save
      try { await refresh(); } catch (e) { toast(`Đã lưu vào server nhưng chưa tải lại được trang (${e.message || e}). Bấm "Tải lại" để xem bản mới.`, true); }
    }
    return true;
  }

  async function saveRecoil(ix, o, curve) {
    if (rc.bad.size) { toast('Có ô nhập không phải số hợp lệ. Sửa các ô viền đỏ trước khi lưu.', true); return; }
    const checked = RL.checkCurve(curve);
    if (!checked.ok) { toast(checked.error, true); return; }
    const doc = S.data.analysis.docs.get(S.sel.id);
    if (!doc) { toast('Không tìm thấy dữ liệu mục này trong file.', true); return; }
    let edit;
    try { edit = RL.applyCurveEdit(doc, rc.mode, o, checked.curve); } catch (e) { toast(e.message, true); return; }

    const ok = await showModal({
      title: `Lưu thay đổi độ giật vào ${CACHE_FILE}?`,
      body: [
        el('p', {}, `Server sẽ lưu ${checked.curve.length} mốc của đường cong độ giật (bộ dữ liệu ${edit.key}) cho:`),
        el('p', { class: 'mono font-semibold ' }, comboText(o)),
        edit.created
          ? alert('info', el('span', {}, 'Tổ hợp này đang được tính từ hệ số. Lưu sẽ tạo một mục riêng cho nó: từ đó đổi hệ số phụ kiện sẽ không còn ảnh hưởng tổ hợp này (xóa mục riêng để quay lại).'))
          : edit.copies > 1 ? alert('info', el('span', {}, `Có ${edit.copies} mục trùng khóa; chỉ mục cuối (mục app dùng) được sửa.`)) : null,
        el('p', {}, 'Bản hiện tại trên server sẽ được giữ trong lịch sử (tối đa 10 bản cũ để khôi phục).'),
        alert('warn', window.Ui.webEditNote()),
      ],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'save', label: 'Lưu vào server', primary: true }],
    });
    if (ok !== 'save') return;
    if (!(await oldSourceOk())) return;
    const savedKey = recoilKey(o);
    // the same window with steps as "Lưu tất cả" and the other long writes: what is being done, and how far it is
    const bar = window.Ui.progressDialog({ title: `Đang lưu ${checked.curve.length} mốc độ giật…`, steps: ['Áp dụng thay đổi', 'Tạo file XML', 'Gửi lên server', 'Cập nhật trang'] });
    try {
      bar.update({ step: 0, pct: 20, detail: `Đã áp dụng đường cong vào bản sao của mục (${edit.created ? 'tạo mục riêng mới' : 'sửa mục riêng'})…` });
      await nextFrame();
      const saved = await putRecoilItem(edit.doc, `Đã lưu thay đổi độ giật vào ${CACHE_FILE} trên server`, (step, pct, detail) => bar.update({ step, pct, detail }), () => { rc.drafts.delete(savedKey); if (rc.customCombos) rc.customCombos.delete(RL.comboKey(o)); });
      if (saved) await bar.finish('Đã lưu độ giật vào server.'); else bar.close();
    } catch (e) {
      await bar.fail(`Không lưu được: ${e.message || e}. Chưa có gì được ghi vào server.`);
    }
  }

  async function deleteRecoil(ix, o) {
    const doc = S.data.analysis.docs.get(S.sel.id);
    if (!doc) { toast('Không tìm thấy dữ liệu mục này trong file.', true); return; }
    let edit;
    try { edit = RL.removeEntry(doc, rc.mode, o); } catch (e) { toast(e.message, true); return; }
    if (!edit.removed) { toast('Tổ hợp này không có mục riêng để xóa.'); return; }

    const ok = await showModal({
      title: 'Xóa mục riêng của tổ hợp này?',
      tone: 'danger',
      body: [
        el('p', {}, `Bạn có chắc muốn xóa ${edit.removed > 1 ? `${edit.removed} mục riêng (trùng khóa)` : 'mục riêng'} của tổ hợp độ giật:`),
        el('p', { class: 'mono font-semibold ' }, comboText(o)),
        el('p', {}, 'Sau khi xóa, app sẽ quay về dùng đường cong tính từ hệ số (đường cong nền × hệ số phụ kiện). Bản cũ trên server sẽ được lưu trong lịch sử khôi phục.'),
        alert('warn', window.Ui.webEditNote()),
      ],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'delete', label: 'Xóa mục riêng', danger: true }],
    });
    if (ok !== 'delete') return;
    if (!(await oldSourceOk())) return;
    // the same window with steps as the saves: what is being done, and how far it is
    const bar = window.Ui.progressDialog({ title: 'Đang xóa mục riêng…', steps: ['Áp dụng thay đổi', 'Tạo file XML', 'Gửi lên server', 'Cập nhật trang'] });
    try {
      bar.update({ step: 0, pct: 20, detail: `Đã bỏ ${edit.removed > 1 ? `${edit.removed} mục riêng` : 'mục riêng'} khỏi bản sao của mục…` });
      await nextFrame();
      const saved = await putRecoilItem(edit.doc, 'Đã xóa mục riêng và lưu vào server', (step, pct, detail) => bar.update({ step, pct, detail }));
      if (saved) await bar.finish('Đã xóa mục riêng.'); else bar.close();
    } catch (e) {
      await bar.fail(`Không xóa được: ${e.message || e}. Chưa có gì được ghi vào server.`);
    }
  }

  // ---------------------------------------------------------------- "Kiểm tra theo chuẩn": own entries that the table of accessories says cannot exist
  // (a grip on the M249, an 8x scope on a gun that stops at 6x). They are listed by gun; the user ticks what to delete (all of it with one box)
  // and everything ticked goes in ONE write, with a bar that says how far it is. The copy on the server before is kept in the file's history.
  const auditOf = (ix) => (ix.audit || (ix.audit = RL.auditEntries(ix.idx)));
  const auditKey = (e) => `${e.weapon}|${e.scope}|${e.grip}|${e.muzzle}|${e.stock}|${e.gesture}`;
  const auditLine = (e) => `${RL.LABELS.SCOPES[e.scope]} · ${POSTURE_VN[e.gesture]} · ${comboLine(e)}`;
  const SLOT_VN = { grip: 'tay cầm', muzzle: 'nòng', stock: 'báng', scope: 'ống ngắm' };

  async function showAuditModal(ix) {
    const all = auditOf(ix);
    if (!all.length) { toast('Mọi mục riêng đều đúng chuẩn phụ kiện.'); return; }
    const byGun = new Map();
    for (const e of all) { if (!byGun.has(e.weapon)) byGun.set(e.weapon, []); byGun.get(e.weapon).push(e); }
    const guns = [...byGun.keys()].sort((a, b) => (a === rc.weapon ? -1 : b === rc.weapon ? 1 : a - b)); // the gun being looked at first
    const sel = new Set();
    let ctl = null;

    const allBox = el('input', { type: 'checkbox', id: 'audit-all' });
    const counter = el('span', { class: 'muted' });
    const deleteBtn = el('button', { type: 'button', class: 'btn danger-fill', disabled: true, onclick: () => ctl && ctl.close('delete') });
    const sections = [];

    const reasons = (list) => {
      const n = {};
      for (const e of list) for (const p of e.problems) n[p.slot] = (n[p.slot] || 0) + 1;
      return Object.entries(n).map(([s, c]) => `${SLOT_VN[s]} ${c}`).join(', ');
    };

    function paintAll() {
      for (const s of sections) s.paint();
      const n = sel.size;
      allBox.checked = n === all.length;
      allBox.indeterminate = n > 0 && n < all.length;
      counter.textContent = n ? `Đã chọn ${n}/${all.length} mục` : `${all.length} mục sai chuẩn`;
      deleteBtn.replaceChildren(icon('trash'), `Xóa ${n} mục đã chọn`);
      deleteBtn.disabled = n === 0;
    }

    for (const w of guns) {
      const list = byGun.get(w);
      const gunBox = el('input', { type: 'checkbox', 'aria-label': `Chọn mọi mục sai chuẩn của ${RL.weaponLabel(w)}` });
      const body = el('div', { class: 'audit-items' });
      const details = el('details', { class: 'audit-gun' });
      const rows = new Map();
      const section = {
        paint() {
          const n = list.filter((e) => sel.has(auditKey(e))).length;
          gunBox.checked = n === list.length;
          gunBox.indeterminate = n > 0 && n < list.length;
          for (const [k, box] of rows) box.checked = sel.has(k);
        },
      };
      gunBox.onchange = () => { for (const e of list) { if (gunBox.checked) sel.add(auditKey(e)); else sel.delete(auditKey(e)); } paintAll(); };
      let built = false;
      details.addEventListener('toggle', () => {
        if (!details.open || built) return;
        built = true; // the entries of a gun are drawn when it is opened (some guns have dozens)
        body.replaceChildren(...list.map((e) => {
          const k = auditKey(e);
          const box = el('input', { type: 'checkbox', checked: sel.has(k), onchange: () => { if (box.checked) sel.add(k); else sel.delete(k); paintAll(); } });
          rows.set(k, box);
          return el('label', { class: 'audit-item' }, box, el('span', {}, auditLine(e), el('span', { class: 'muted' }, ` — ${e.problems.map((p) => SLOT_VN[p.slot]).join(', ')}${e.copies > 1 ? ` · ${e.copies} bản trùng` : ''}`)));
        }));
      });
      details.append(el('summary', {}, el('span', { class: 'audit-name' }, RL.weaponLabel(w)), el('span', { class: 'muted' }, ` ${list.length} mục: ${reasons(list)}`)),
        el('div', { class: 'disclosure-body' }, el('p', { class: 'muted text-sm' }, RL.describeAttachments(w) || ''), body));
      sections.push(section);
      section.node = el('div', { class: 'audit-row' }, gunBox, details);
    }
    allBox.onchange = () => { sel.clear(); if (allBox.checked) for (const e of all) sel.add(auditKey(e)); paintAll(); };
    paintAll();

    const choice = await showModal({
      title: 'Kiểm tra theo chuẩn phụ kiện', tone: 'warn', className: 'wide',
      body: [
        el('p', {}, `${all.length} mục riêng (${new Set(all.map((e) => e.weapon)).size} súng) của bộ dữ liệu "${ix.ds.key}" không đúng bảng phụ kiện chuẩn: gắn phụ kiện hoặc ống ngắm mà súng đó không có. Đó là mục dư; app dùng đường cong theo hệ số khi một tổ hợp không có mục riêng.`),
        el('label', { class: 'row audit-all' }, allBox, el('span', { class: 'font-semibold' }, 'Chọn tất cả mục dư'), counter),
        el('div', { class: 'audit-list' }, sections.map((s) => s.node)),
        el('div', { class: 'row' }, deleteBtn),
      ],
      actions: [{ id: 'close', label: 'Đóng' }],
      onOpen: (c) => { ctl = c; },
    });
    if (choice !== 'delete' || !sel.size) return;
    await deleteAudited(all.filter((e) => sel.has(auditKey(e))));
  }

  // "Xóa nhiều…": tick guns, postures and scopes (what is open now by default); every own entry matching all three goes
  async function showBulkDeleteModal(ix) {
    const own = RL.entriesWhere(ix.idx);
    if (!own.length) { toast('Mục này chưa có mục riêng nào để xóa.'); return; }
    const count = (key) => own.reduce((m, e) => m.set(e[key], (m.get(e[key]) || 0) + 1), new Map());
    const guns = [...count('weapon').keys()].sort((a, b) => a - b);
    const scopes = [...count('scope').keys()].sort((a, b) => a - b);
    const sel = { weapon: new Set(guns.includes(rc.weapon) ? [rc.weapon] : []), gesture: new Set([rc.gesture]), scope: new Set(scopes.includes(rc.scope) ? [rc.scope] : []) };
    const groups = [
      { key: 'weapon', title: 'Súng', values: guns, label: (v) => RL.weaponLabel(v) },
      { key: 'gesture', title: 'Tư thế', values: [0, 1, 2], label: (v) => POSTURE_VN[v] },
      { key: 'scope', title: 'Ống ngắm', values: scopes, label: (v) => RL.LABELS.SCOPES[v] },
    ];
    let ctl = null;
    const deleteBtn = el('button', { type: 'button', class: 'btn danger-fill', onclick: () => ctl && ctl.close('delete') });
    const summary = el('p', { class: 'muted' });
    const chips = [];
    const matches = () => RL.entriesWhere(ix.idx, { weapons: sel.weapon, gestures: sel.gesture, scopes: sel.scope });
    const paint = () => {
      const hit = matches();
      for (const g of groups) {
        // how many entries each value would remove given the OTHER two groups
        const others = { weapons: g.key === 'weapon' ? null : sel.weapon, gestures: g.key === 'gesture' ? null : sel.gesture, scopes: g.key === 'scope' ? null : sel.scope };
        const per = RL.entriesWhere(ix.idx, others).reduce((m, e) => m.set(e[g.key], (m.get(e[g.key]) || 0) + 1), new Map());
        for (const c of chips.filter((x) => x.g === g)) { c.input.checked = sel[g.key].has(c.v); c.n.textContent = String(per.get(c.v) || 0); }
      }
      const pickedNames = (g) => (sel[g.key].size === g.values.length ? `mọi ${g.title.toLowerCase()}` : sel[g.key].size ? [...sel[g.key]].sort((a, b) => a - b).slice(0, 4).map(g.label).join(', ') + (sel[g.key].size > 4 ? ` +${sel[g.key].size - 4}` : '') : `chưa chọn ${g.title.toLowerCase()}`);
      summary.textContent = hit.length ? `Sẽ xóa ${hit.length} mục riêng (${groups.map(pickedNames).join(' · ')}).` : `Không có mục riêng nào khớp (${groups.map(pickedNames).join(' · ')}).`;
      deleteBtn.replaceChildren(icon('trash'), `Xóa ${hit.length} mục`);
      deleteBtn.disabled = !hit.length;
    };
    const sections = groups.map((g) => {
      const boxes = g.values.map((v) => {
        const input = el('input', { type: 'checkbox', onchange: (e) => { if (e.target.checked) sel[g.key].add(v); else sel[g.key].delete(v); paint(); } });
        const n = el('span', { class: 'opt-chip-n' });
        chips.push({ g, v, input, n });
        return el('label', { class: 'opt-chip' }, input, el('span', {}, g.label(v)), n);
      });
      const quick = (text, fn) => el('button', { type: 'button', class: 'btn small ghost', onclick: () => { fn(); paint(); } }, text);
      return el('div', { class: 'bulk-del-group' }, el('div', { class: 'row' }, el('strong', {}, g.title),
        quick('Tất cả', () => { sel[g.key] = new Set(g.values); }), quick('Bỏ chọn', () => { sel[g.key] = new Set(); })),
      el('div', { class: 'opt-chips', role: 'group', 'aria-label': g.title }, boxes));
    });
    paint();
    const choice = await showModal({
      title: 'Xóa nhiều tổ hợp', tone: 'warn', className: 'wide',
      body: [el('p', {}, `Chọn súng, tư thế và ống ngắm của bộ dữ liệu "${ix.ds.key}". Chỉ các mục riêng khớp cả ba nhóm bị xóa; tổ hợp tính từ hệ số không bị ảnh hưởng. Số bên cạnh mỗi lựa chọn là số mục sẽ xóa nếu chọn nó.`),
        ...sections, summary, el('div', { class: 'row' }, deleteBtn)],
      actions: [{ id: 'close', label: 'Đóng' }],
      onOpen: (c) => { ctl = c; },
    });
    if (choice !== 'delete') return;
    await deleteAudited(matches(), 'đã chọn');
  }

  // the own entries of guns switched off in "Tiêu chuẩn súng": tick the guns, then the same deletion as the check against the table
  async function showDisabledGunsModal(all) {
    const byGun = new Map();
    for (const e of all) byGun.set(e.weapon, (byGun.get(e.weapon) || 0) + 1);
    const on = new Set(byGun.keys());
    const deleteBtn = el('button', { type: 'button', class: 'btn danger-fill', onclick: () => ctl && ctl.close('delete') });
    let ctl = null;
    const paint = () => { const n = all.filter((e) => on.has(e.weapon)).length; deleteBtn.replaceChildren(icon('trash'), `Xóa ${n} mục đã chọn`); deleteBtn.disabled = n === 0; };
    const rows = [...byGun].map(([w, n]) => el('label', { class: 'audit-item' },
      el('input', { type: 'checkbox', checked: true, onchange: (e) => { if (e.target.checked) on.add(w); else on.delete(w); paint(); } }),
      el('span', {}, RL.weaponLabel(w), el('span', { class: 'muted' }, ` — ${n} mục riêng`))));
    paint();
    const choice = await showModal({
      title: 'Xóa tổ hợp của súng đã tắt', tone: 'warn',
      body: [el('p', {}, `${all.length} mục riêng của ${byGun.size} súng đang tắt trong Tiêu chuẩn súng. Súng tắt không dùng trong app nên các mục này là dư. Chọn súng cần dọn:`),
        el('div', { class: 'audit-list' }, rows), el('div', { class: 'row' }, deleteBtn)],
      actions: [{ id: 'close', label: 'Đóng' }],
      onOpen: (c) => { ctl = c; },
    });
    if (choice !== 'delete') return;
    await deleteAudited(all.filter((e) => on.has(e.weapon)), 'của súng đã tắt');
  }

  async function deleteAudited(list, what = 'sai chuẩn') {
    if (!(await discardOk())) return;
    const doc = S.data.analysis.docs.get(S.sel.id);
    if (!doc) { toast('Không tìm thấy dữ liệu mục này trong file.', true); return; }
    const perGun = new Map();
    for (const e of list) perGun.set(e.weapon, (perGun.get(e.weapon) || 0) + 1);
    const lines = [...perGun].slice(0, 12).map(([w, n]) => el('li', {}, `${RL.weaponLabel(w)}: ${n} mục`));
    const go = await showModal({
      title: `Xóa ${list.length} mục riêng ${what}?`, tone: 'error',
      body: [
        el('p', {}, `Sẽ xóa ${list.length} mục riêng (kể cả các bản trùng khóa) của ${perGun.size} súng khỏi bộ dữ liệu của mục này trên server:`),
        el('ul', {}, lines),
        perGun.size > lines.length ? el('p', { class: 'muted' }, `… và ${perGun.size - lines.length} súng nữa.`) : null,
        el('p', { class: 'muted' }, 'Xóa một lần: bản hiện tại trên server được giữ một bản trong lịch sử (tối đa 10 bản cũ để khôi phục).'),
        alert('warn', window.Ui.webEditNote()),
      ],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'go', label: `Xóa ${list.length} mục`, danger: true }],
    });
    if (go !== 'go') return;
    if (!(await oldSourceOk())) return;

    const bar = window.Ui.progressDialog({ title: `Đang xóa ${list.length} mục ${what}…`, steps: ['Gom các mục cần xóa', 'Tạo file XML', 'Gửi lên server', 'Cập nhật trang'] });
    try {
      bar.update({ step: 0, pct: 10, detail: `Đang gom ${list.length} mục của ${perGun.size} súng…` });
      await nextFrame();
      const res = RL.removeEntries(doc, rc.mode, list);
      bar.update({ step: 0, pct: 45, detail: `Đã gom ${res.removed} mục (${res.keys} tổ hợp)` });
      const saved = await putRecoilItem(res.doc, `Đã xóa ${res.removed} mục ${what} khỏi ${CACHE_FILE} trên server`, (step, pct, detail) => bar.update({ step, pct, detail }), () => {
        rc.picked = null;
        for (const e of list) rc.drafts.delete(recoilKey(e));
      });
      if (saved) await bar.finish(`Đã xóa ${res.removed} mục.`); else bar.close();
    } catch (e) {
      await bar.fail(`Không xóa được: ${e.message || e}. Chưa có gì được ghi vào server.`);
    }
  }

  // ---------------------------------------------------------------- everything unsaved in the list, at once
  // "AI tạo mốc": the combinations added on this page get their points (the AI's, else the server's) as drafts; nothing is written.
  // "Lưu tất cả": the drafts, the added combinations as they are, and the open one if it was edited, written in ONE go (so the history of
  // the file keeps one old copy, not one per combination), with a bar that says what is being done.
  const rcCombo = (c) => ({ weapon: rc.weapon, scope: rc.scope, gesture: rc.gesture, grip: c.grip, muzzle: c.muzzle, stock: c.stock });
  const isNewCombo = (o, r) => Boolean(rc.customCombos && rc.customCombos.has(RL.comboKey(o))) && r.source !== 'exact' && !RL.isZeroWeapon(o.weapon);
  const comboLine = (o) => `tay cầm: ${optText('GRIPS', o.grip)} · nòng: ${optText('MUZZLES', o.muzzle)} · báng: ${optText('STOCKS', o.stock)}`;
  const fullLine = (o) => `${RL.weaponLabel(o.weapon)} · ${RL.LABELS.SCOPES[o.scope]} · ${POSTURE_VN[o.gesture]} · ${comboLine(o)}`;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  // every added combination of this item that has no own entry yet, whatever its gun, scope or posture: [{ o, r, key }]
  // (what "Lưu tất cả" saves and "AI tạo mốc" makes the points for is not only what the list shows now)
  function pendingCombos(weaponFilter = null) {
    const out = [];
    if (!rc.idx || !rc.customCombos) return out;
    for (const k of rc.customCombos) {
      const [weapon, scope, gesture, grip, muzzle, stock] = k.split('|').map(Number);
      if (weaponFilter !== null && weapon !== weaponFilter) continue;
      const o = { weapon, scope, gesture, grip, muzzle, stock };
      const r = RL.resolve(rc.idx.idx, o);
      if (isNewCombo(o, r)) out.push({ o, r, key: recoilKey(o) });
    }
    return out;
  }

  // [{ key, o, curve, how }] = what "Lưu tất cả" would write
  function pendingSaves(weaponFilter = null) {
    const items = [];
    for (const p of pendingCombos(weaponFilter)) {
      const open = rc.editKey === p.key && rc.editCurve;
      const draft = rc.drafts.get(p.key);
      items.push({ key: p.key, o: p.o, curve: open ? rc.editCurve : draft ? draft.curve : p.r.curve, how: draft ? ({ ai: 'AI', server: 'server', coef: 'theo hệ số' }[draft.source] || 'đã sửa') : open && rc.dirty && rc.freshBase && JSON.stringify(rc.editCurve) !== rc.freshBase ? 'đã sửa' : 'theo hệ số' });
    }
    // "Quét tất cả": proposals of the AI for entries that already exist (only those of the dataset shown: touch / gyro / raw)
    for (const [key, d] of rc.drafts) {
      if (!d.review || !key.endsWith(`|${rc.mode}`) || items.some((i) => i.key === key)) continue;
      const gun = d.o && typeof d.o.weapon === 'number' ? d.o.weapon : Number(key.split('|')[0]);
      if (weaponFilter !== null && gun !== weaponFilter) continue;
      const open = rc.editKey === key && rc.editCurve;
      items.push({ key, o: d.o, curve: open ? rc.editCurve : d.curve, how: 'AI đề xuất' });
    }
    // the open combination that already has an own entry and was edited
    if (rc.picked && rc.dirty && rc.editCurve && rc.editKey === recoilKey(rcCombo(rc.picked)) && !items.some((i) => i.key === rc.editKey)) {
      if (weaponFilter === null || rc.weapon === weaponFilter) {
        items.push({ key: rc.editKey, o: rcCombo(rc.picked), curve: rc.editCurve, how: 'đang sửa' });
      }
    }
    return items;
  }

  // the added combinations that have no points of their own yet (and are not being edited by hand)
  function aiTargets() {
    if (RL.isGunDisabled(rc.weapon)) return [];
    return pendingCombos(rc.weapon).filter((p) => p.o.weapon === rc.weapon && !rc.drafts.has(p.key) && !(rc.editKey === p.key && rc.freshBase && rc.editCurve && JSON.stringify(rc.editCurve) !== rc.freshBase));
  }

  const bulkLabel = () => {
    if (rc.bulk) return `Dừng (${rc.bulk.done}/${rc.bulk.total})`;
    const n = aiTargets().length;
    return `AI tạo mốc${n ? ` (${n})` : ''}`;
  };

  // the line and the bar under the buttons while the points are being made
  function bulkBoxNodes() {
    const b = rc.bulk;
    if (!b) return [];
    const bar = window.Ui.progressBar(b.total ? (b.done / b.total) * 100 : 0);
    if (b.review) return [bar.node, el('span', {}, `Đang rà soát ${b.done}/${b.total} · đề xuất đổi ${b.changed} · giữ nguyên ${b.same}${b.failed ? ` · lỗi ${b.failed}` : ''}`)];
    return [bar.node, el('span', {}, `Đang tạo mốc ${b.done}/${b.total} · AI ${b.ai} · server ${b.server}${b.failed ? ` · lỗi ${b.failed}` : ''}`)];
  }

  function paintBulk() {
    const box = document.querySelector('.bulk-box');
    if (box) box.replaceChildren(...bulkBoxNodes());
    const label = document.querySelector('[data-bulk="ai"] .bulk-label');
    if (label && rc.bulk) label.textContent = `Dừng (${rc.bulk.done}/${rc.bulk.total})`;
  }

  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  // how many AI questions this page keeps out at once: what the server allows (AI_CONCURRENCY), at most 4 (a free gateway answers slower models
  // when it is pushed harder, so more threads do not make it faster)
  const aiThreads = (status) => Math.max(1, Math.min(4, Number(status && status.concurrency) || 1));
  async function runPool(items, size, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const item = items[next++]; await fn(item); } }));
  }
  // one question to the AI. "busy" (the server's slots are taken) and 429 / 5xx (the free endpoint asks to slow down) are waited out, up to 4 tries.
  async function askAi(body, { signal, stopped = () => false, route = '/ai/suggest-curve' } = {}) {
    let last = null;
    for (let attempt = 0; attempt < 4 && !stopped(); attempt++) {
      try { last = await api('POST', route, body, { signal }); } catch (e) { return { ok: false, reason: e.message }; }
      if (last.ok) return last;
      const slowDown = /HTTP (429|5\d\d)/.test(last.reason || '');
      if (!last.busy && !slowDown) return last;
      await sleepMs(last.busy ? 1500 : 4000 * (attempt + 1));
    }
    return last || { ok: false, reason: 'Đã dừng.' };
  }

  async function aiCreateAll() {
    if (rc.bulk) { rc.bulk.ac.abort(); return; } // the second click stops it
    if (!latest()) { toast('Chỉ tính được khi đang xem "Mới nhất".', true); return; }
    const todo = aiTargets();
    if (!todo.length) { toast('Không có tổ hợp mới nào cần tạo mốc. Thêm tổ hợp bằng "Thêm tổ hợp", "Thêm tất cả" hoặc "Tạo đủ cho cả súng".'); return; }
    const status = await aiStatus();
    const itemId = S.sel.id;
    const ac = new AbortController();
    rc.bulk = { ac, done: 0, total: todo.length, failed: 0, ai: 0, server: 0 };
    redraw();
    await runPool(todo, status.enabled ? aiThreads(status) : 6, async (m) => {
      if (ac.signal.aborted || !active || !S.sel || S.sel.id !== itemId) return;
      const o = m.o;
      const body = { id: itemId, mode: rc.mode, combo: { weapon: o.weapon, scope: o.scope, gesture: o.gesture, grip: o.grip, muzzle: o.muzzle, stock: o.stock } };
      const [srv, ai] = await Promise.all([
        api('POST', '/recoil/suggest', body, { signal: ac.signal }).catch(() => null),
        status.enabled ? askAi(body, { signal: ac.signal, stopped: () => ac.signal.aborted }) : Promise.resolve(null),
      ]);
      if (ac.signal.aborted) return;
      let pick = null;
      for (const [source, res] of [['ai', ai], ['server', srv]]) {
        if (pick || !res || !res.ok) continue;
        const checked = RL.checkCurve(res.curve);
        if (checked.ok) pick = { source, curve: checked.curve };
      }
      if (pick) { rc.drafts.set(m.key, pick); rc.bulk[pick.source]++; } else rc.bulk.failed++;
      rc.bulk.done++;
      paintBulk();
    });
    const b = rc.bulk;
    rc.bulk = null;
    redraw();
    if (b) toast(`${b.ac.signal.aborted ? 'Đã dừng. ' : ''}Đã tạo mốc cho ${b.ai + b.server}/${b.total} tổ hợp (AI ${b.ai}, server ${b.server}${b.failed ? `, lỗi ${b.failed}` : ''}). Chưa lưu: bấm "Lưu tất cả".`, b.failed > 0 && b.ai + b.server === 0);
  }

  function saveAllButton(model) {
    const totalAll = pendingSaves().length;
    const currentGunPending = pendingSaves(rc.weapon).length;
    const otherCount = totalAll - currentGunPending;
    const title = totalAll
      ? (otherCount > 0
          ? `Lưu ${currentGunPending} tổ hợp của ${RL.weaponLabel(rc.weapon)} (${otherCount} tổ hợp súng khác)`
          : `Lưu ${totalAll} tổ hợp chưa lưu của ${RL.weaponLabel(rc.weapon)}`)
      : 'Không có tổ hợp nào chưa lưu';
    return el('button', {
      type: 'button', class: 'btn small primary', 'data-save-all': '1', disabled: !totalAll || Boolean(rc.bulk),
      title,
      onclick: guard(() => saveAll()),
    }, icon('check'), el('span', { class: 'save-all-label' }, otherCount > 0 ? `Lưu (${totalAll} · ${RL.weaponLabel(rc.weapon)}: ${currentGunPending})` : `Lưu tất cả${totalAll ? ` (${totalAll})` : ''}`));
  }

  // after a change that does not redraw the page (typing in the points): every "Lưu tất cả" button shows the new count
  function paintSaveAll() {
    if (!rc.model) return;
    const totalAll = pendingSaves().length;
    const currentGunPending = pendingSaves(rc.weapon).length;
    const otherCount = totalAll - currentGunPending;
    for (const b of document.querySelectorAll('[data-save-all]')) {
      b.disabled = !totalAll || Boolean(rc.bulk);
      b.title = totalAll
        ? (otherCount > 0
            ? `Lưu ${currentGunPending} tổ hợp của ${RL.weaponLabel(rc.weapon)} (${otherCount} tổ hợp súng khác)`
            : `Lưu ${totalAll} tổ hợp chưa lưu của ${RL.weaponLabel(rc.weapon)}`)
        : 'Không có tổ hợp nào chưa lưu';
      const label = b.querySelector('.save-all-label');
      if (label) {
        label.textContent = otherCount > 0
          ? `Lưu (${totalAll} · ${RL.weaponLabel(rc.weapon)}: ${currentGunPending})`
          : `Lưu tất cả${totalAll ? ` (${totalAll})` : ''}`;
      }
    }
  }

  async function saveAll(targetWeapon = null) {
    if (rc.bulk) { toast('Đang tạo mốc: đợi xong hoặc bấm "Dừng" rồi hãy lưu tất cả.', true); return; }
    if (rc.bad.size) { toast('Có ô nhập không phải số hợp lệ. Sửa các ô viền đỏ trước khi lưu.', true); return; }

    let allItems = pendingSaves();
    if (!allItems.length) { toast('Không có gì chưa lưu.'); return; }

    const guns = [...new Set(allItems.map((p) => p.o.weapon))];
    let selectedWeapon = targetWeapon;
    let dropOthers = false;

    // If targetWeapon was specified, enforce it. If not, and drafts exist for multiple guns, ask user!
    if (selectedWeapon === null && guns.length > 1) {
      const currentGun = rc.weapon;
      const currentItems = allItems.filter((p) => p.o.weapon === currentGun);
      const otherGuns = guns.filter((w) => w !== currentGun);
      const otherItemsCount = allItems.length - currentItems.length;

      const currentRadio = el('input', { type: 'radio', name: 'save-scope', value: 'current', checked: true });
      const allRadio = el('input', { type: 'radio', name: 'save-scope', value: 'all' });
      const dropCheckbox = el('input', { type: 'checkbox', checked: false });

      const saveCards = el('div', { class: 'choice-group' },
        choiceCard({
          input: currentRadio,
          title: `Chỉ lưu súng đang chọn: ${RL.weaponLabel(currentGun)}`,
          desc: `Chỉ ghi các thay đổi của ${RL.weaponLabel(currentGun)} vào server. Các súng khác được giữ nguyên trong bản nháp.`,
          badge: badge(`${currentItems.length} tổ hợp`, 'accent'),
          checked: true,
        }),
        choiceCard({
          input: allRadio,
          title: 'Lưu tất cả các súng',
          desc: `Ghi toàn bộ ${guns.length} súng (${guns.map((w) => `${RL.weaponLabel(w)}: ${allItems.filter((p) => p.o.weapon === w).length}`).join(', ')}) vào file trên server.`,
          badge: badge(`${allItems.length} tổ hợp`, 'info'),
        })
      );

      const dropCard = otherItemsCount > 0 ? el('div', { class: 'choice-group mt-2' },
        choiceCard({
          input: dropCheckbox,
          warn: true,
          title: 'Đồng thời xóa các bản nháp của súng khác',
          desc: `Hủy bỏ các thay đổi tạm thời của (${otherGuns.map((w) => RL.weaponLabel(w)).join(', ')}) để tránh nhầm lẫn sau này.`,
          badge: badge(`${otherItemsCount} tổ hợp sẽ hủy`, 'warn'),
        })
      ) : null;

      const choiceModal = await showModal({
        title: 'Chọn phạm vi lưu dữ liệu', tone: 'warn',
        body: [
          el('p', {}, `Phát hiện bản nháp chưa lưu của ${guns.length} súng khác nhau (${guns.map((w) => RL.weaponLabel(w)).join(', ')}). Bạn muốn lưu súng nào?`),
          saveCards,
          dropCard,
        ],
        actions: [
          { id: 'cancel', label: 'Hủy' },
          { id: 'proceed', label: 'Tiếp tục lưu', primary: true },
        ],
      });

      if (choiceModal !== 'proceed') return;
      if (currentRadio.checked) {
        selectedWeapon = currentGun;
      }
      dropOthers = Boolean(dropCheckbox.checked);
    }

    const items = selectedWeapon !== null ? allItems.filter((p) => p.o.weapon === selectedWeapon) : allItems;
    if (!items.length) { toast('Không có tổ hợp nào thuộc súng đã chọn cần lưu.'); return; }

    const doc = S.data.analysis.docs.get(S.sel.id);
    if (!doc) { toast('Không tìm thấy dữ liệu mục này trong file.', true); return; }
    // everything is checked before anything is written: one bad curve stops the whole save
    const plan = [];
    for (const it of items) {
      const checked = RL.checkCurve(it.curve);
      if (!checked.ok) { toast(`${fullLine(it.o)}: ${checked.error}`, true); return; }
      plan.push({ ...it, curve: checked.curve });
    }
    const places = new Set(plan.map((p) => `${p.o.weapon}|${p.o.scope}|${p.o.gesture}`)).size;
    const planGuns = new Set(plan.map((p) => p.o.weapon));
    const gunsText = [...planGuns].map((w) => RL.weaponLabel(w)).join(', ');
    const bySource = {};
    for (const p of plan) bySource[p.how] = (bySource[p.how] || 0) + 1;
    const statPills = el('div', { class: 'save-stat-pills' },
      el('span', { class: 'stat-pill' }, el('strong', {}, String(plan.length)), ' tổ hợp'),
      el('span', { class: 'stat-pill' }, el('strong', {}, String(planGuns.size)), ` súng (${gunsText})`),
      el('span', { class: 'stat-pill' }, el('strong', {}, String(places)), ' dạng ống ngắm × tư thế')
    );

    const shown = plan.slice(0, 8); // the window lists the first few; the rest is counted
    const planList = el('div', { class: 'save-plan-list' },
      shown.map((p) => el('div', { class: 'save-plan-item' },
        el('span', { class: 'save-plan-combo' }, fullLine(p.o)),
        badge(p.how || 'mới', 'accent')
      )),
      plan.length > shown.length ? el('div', { class: 'save-plan-more' }, `… và ${plan.length - shown.length} tổ hợp nữa`) : null
    );

    const ok = await showModal({
      title: `Lưu ${plan.length} tổ hợp vào ${CACHE_FILE}?`,
      tone: 'info',
      body: [
        el('p', { class: 'muted text-sm' }, `Mỗi tổ hợp sẽ được ghi thành một mục riêng trên server (tổ hợp đã có sẽ được cập nhật). Nguồn: ${Object.entries(bySource).map(([k, n]) => `${k} (${n})`).join(', ')}.`),
        statPills,
        el('div', { class: 'field mt-2' },
          el('span', { class: 'font-semibold text-sm' }, 'Xem trước các tổ hợp sẽ lưu:'),
          planList
        ),
        dropOthers ? el('div', { class: 'modal-callout warn' }, icon('alert'), el('div', { class: 'modal-callout-text' }, 'Sau khi lưu xong, các bản nháp chưa lưu của súng khác sẽ được tự động xóa bỏ theo lựa chọn của bạn.')) : null,
        el('div', { class: 'modal-callout info' }, icon('info'), el('div', { class: 'modal-callout-text' }, 'Bản hiện tại trên server được lưu tự động vào lịch sử trước khi ghi đè (tối đa 10 bản sao lưu để khôi phục). ' + window.Ui.webEditNote())),
      ],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'save', label: `Xác nhận lưu ${plan.length} tổ hợp`, primary: true }],
    });
    if (ok !== 'save') return;
    if (!(await oldSourceOk())) return;

    const bar = window.Ui.progressDialog({ title: `Đang lưu ${plan.length} tổ hợp…`, steps: ['Áp dụng từng tổ hợp', 'Tạo file XML', 'Gửi lên server', 'Cập nhật trang'] });
    try {
      bar.update({ step: 0, pct: 1, detail: 'Đang sao chép dữ liệu của mục này…' });
      await nextFrame();
      const editor = RL.curveEditor(doc, rc.mode); // one copy of the item for all the combinations
      for (let i = 0; i < plan.length; i++) {
        if (i % 10 === 0) { bar.update({ step: 0, pct: 2 + (i / plan.length) * 43, detail: `Tổ hợp ${i + 1}/${plan.length}: ${fullLine(plan[i].o)}` }); await nextFrame(); }
        editor.apply(plan[i].o, plan[i].curve);
      }
      bar.update({ step: 0, pct: 45, detail: `Đã áp dụng ${plan.length}/${plan.length} tổ hợp` });
      const saved = await putRecoilItem(editor.doc, `Đã lưu ${plan.length} tổ hợp vào ${CACHE_FILE} trên server`, (step, pct, detail) => bar.update({ step, pct, detail }), () => {
        for (const p of plan) { rc.drafts.delete(p.key); if (rc.customCombos) rc.customCombos.delete(RL.comboKey(p.o)); }
        if (dropOthers && selectedWeapon !== null) {
          clearDraftsForOtherWeapons(selectedWeapon);
        }
      });
      if (saved) await bar.finish(`Đã lưu ${plan.length} tổ hợp.`); else bar.close();
    } catch (e) {
      await bar.fail(`Không lưu được: ${e.message || e}. Chưa có gì được ghi vào server.`);
    }
  }


  // ---------------------------------------------------------------- "Quét tất cả": the AI reviews the entries the gun already has
  // 1. the server looks at every own entry of the gun (every scope and posture) without AI and says which look odd (far from similar guns,
  //    crouch/prone above standing, more accessories pulling harder); 2. the user picks: only those, or every entry, and how many at most;
  // 3. the AI reviews them one by one against the same evidence and the table of accessories, the answer checked against the current entry;
  // 4. a change of 3% or more becomes a draft "AI đề xuất" (nothing written). Then "Lưu tất cả" writes them in one go.
  const REVIEW_MIN_CHANGE = 0.03;
  async function scanAll() {
    if (!latest()) { toast('Chỉ làm được khi đang xem "Mới nhất".', true); return; }
    const weapon = rc.weapon;
    if (RL.isGunDisabled(weapon)) { toast('Súng này đã bị tắt trong Tiêu chuẩn súng.', true); return; }
    if (RL.isZeroWeapon(weapon)) { toast('Súng này luôn dùng đường cong 0 trong app: không có gì để rà soát.', true); return; }
    if (rc.bulk || rc.filling) return;
    if (!(await discardOk())) return;
    aiStatusP = null;
    const status = await aiStatus();
    if (!status.enabled) { toast('AI chưa được bật: vui lòng chuyển sang tab "Cài đặt AI" để bật và cấu hình.', true); return; }
    const gun = RL.weaponLabel(weapon);
    const itemId = S.sel.id;
    const mode = rc.mode;
    let scan;
    try { scan = await api('POST', '/recoil/review-scan', { id: itemId, mode, combo: { weapon, scope: rc.scope, gesture: rc.gesture } }); } catch (e) { toast(e.message, true); return; }
    if (!scan.total) { toast(`${gun}: chưa có mục riêng nào (ngoài đường cong nền) để rà soát.`); return; }
    const here = (f) => (f.scope === rc.scope && f.gesture === rc.gesture ? 0 : 1); // what is on screen first
    const flagged = [...scan.flagged].sort((a, b) => here(a) - here(b) || b.score - a.score);
    const flaggedKeys = new Set(flagged.map((f) => RL.comboKey({ weapon, ...f })));
    const rest = scan.entries.filter((e) => !flaggedKeys.has(RL.comboKey(e))).sort((a, b) => here(a) - here(b));
    const threads = aiThreads(status);

    const pick = { all: !flagged.length };
    const limitBox = el('input', { type: 'number', min: '1', step: '1', class: 'fp-num', 'aria-label': 'Tối đa bao nhiêu mục' });
    const estimate = el('p', { class: 'muted text-sm' });
    const paintEstimate = () => {
      const n = Math.max(0, Math.floor(Number(limitBox.value) || 0));
      estimate.textContent = `Ước tính khoảng ${Math.max(1, Math.ceil((n * 25) / threads / 60))} phút (mỗi mục 10–40 giây, ${threads} luồng song song). Mục đang xem (${RL.LABELS.SCOPES[rc.scope]} · ${POSTURE_VN[rc.gesture]}) được rà soát trước.`;
    };
    const setLimit = () => {
      const n = pick.all ? scan.total : flagged.length;
      limitBox.max = String(n);
      limitBox.value = String(Math.min(n, 30));
      paintEstimate();
    };
    limitBox.oninput = paintEstimate;
    const scanRadioFlagged = el('input', { type: 'radio', name: 'scan-pick', value: 'flagged', checked: !pick.all, disabled: !flagged.length });
    const scanRadioAll = el('input', { type: 'radio', name: 'scan-pick', value: 'all', checked: pick.all });

    scanRadioFlagged.onchange = () => { if (scanRadioFlagged.checked) { pick.all = false; setLimit(); } };
    scanRadioAll.onchange = () => { if (scanRadioAll.checked) { pick.all = true; setLimit(); } };

    const scanScopeCards = el('div', { class: 'choice-group' },
      choiceCard({
        input: scanRadioFlagged,
        title: 'Chỉ các mục server thấy lạ / nghi vấn',
        desc: 'Tập trung AI rà soát các tổ hợp có độ lệch lớn so với súng tương tự hoặc không nhất quán.',
        badge: badge(`${flagged.length} mục`, flagged.length ? 'warn' : 'neutral'),
        disabled: !flagged.length,
        checked: !pick.all,
      }),
      choiceCard({
        input: scanRadioAll,
        title: 'Tất cả mục riêng của súng',
        desc: 'Quét toàn bộ mọi mục riêng hiện có của súng để đối soát toàn diện.',
        badge: badge(`${scan.total} mục`, 'info'),
        checked: pick.all,
      })
    );

    const setLimitVal = (v) => {
      const max = Number(limitBox.max) || 30;
      limitBox.value = String(Math.max(1, Math.min(max, v)));
      paintEstimate();
    };

    const limitStepper = el('div', { class: 'stepper-wrap' },
      el('div', { class: 'stepper-control' },
        el('button', { type: 'button', class: 'btn icon small', 'aria-label': 'Giảm', onclick: () => setLimitVal((Number(limitBox.value) || 1) - 5) }, icon('back')),
        limitBox,
        el('button', { type: 'button', class: 'btn icon small', 'aria-label': 'Tăng', onclick: () => setLimitVal((Number(limitBox.value) || 1) + 5) }, icon('plus'))
      ),
      el('div', { class: 'stepper-presets' },
        [10, 20, 30, 50].map((num) => el('button', {
          type: 'button',
          class: 'pill-preset',
          onclick: () => setLimitVal(num),
        }, `${num} mục`))
      )
    );

    setLimit();
    const shown = flagged.slice(0, 8);
    const go = await showModal({
      title: `Quét tất cả: ${gun}`, tone: 'warn',
      body: [
        el('p', {}, `${gun} có ${scan.total} mục riêng (mọi ống ngắm × tư thế, không tính đường cong nền và mục sai bảng chuẩn). Server thấy ${flagged.length} mục đáng xem lại${flagged.length ? ':' : '.'}`),
        shown.length ? el('ul', {}, shown.map((f) => el('li', {}, `${RL.LABELS.SCOPES[f.scope]} · ${POSTURE_VN[f.gesture]} · ${comboLine(f)}: ${f.reasons.join('; ')}`))) : null,
        flagged.length > shown.length ? el('p', { class: 'muted' }, `… và ${flagged.length - shown.length} mục nữa.`) : null,
        scanScopeCards,
        el('div', { class: 'field mt-2' },
          el('span', { class: 'font-semibold text-sm' }, 'Rà soát tối đa bao nhiêu mục:'),
          limitStepper
        ),
        el('div', { class: 'modal-callout info' }, icon('clock'), el('div', { class: 'modal-callout-text' }, estimate)),
        el('p', { class: 'muted text-xs' }, `AI xem lại từng mục với dữ liệu súng tương tự, các mục khác của súng và bảng phụ kiện chuẩn. Câu trả lời được kiểm tra so với mục hiện tại; thay đổi dưới ${Math.round(REVIEW_MIN_CHANGE * 100)}% coi như giữ nguyên. Mọi đề xuất chỉ là bản nháp ("AI đề xuất"), chưa ghi gì.`),
      ],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'go', label: 'Bắt đầu rà soát', primary: true }],
    });
    if (go !== 'go') return;
    const pool = pick.all ? [...flagged, ...rest] : flagged;
    const todo = pool.slice(0, Math.max(1, Math.min(pool.length, Math.floor(Number(limitBox.value) || 0))));
    const reasonsOf = new Map(flagged.map((f) => [RL.comboKey({ weapon, ...f }), f.reasons]));

    const ac = new AbortController();
    rc.bulk = { ac, review: true, done: 0, total: todo.length, failed: 0, changed: 0, same: 0, ai: 0, server: 0 };
    const errors = [];
    redraw();
    await runPool(todo, threads, async (f) => {
      if (ac.signal.aborted || !active || !S.sel || S.sel.id !== itemId || rc.mode !== mode) return;
      const o = { weapon, scope: f.scope, gesture: f.gesture, grip: f.grip, muzzle: f.muzzle, stock: f.stock };
      const r = await askAi({ id: itemId, mode, combo: o }, { signal: ac.signal, stopped: () => ac.signal.aborted, route: '/ai/review-curve' });
      if (ac.signal.aborted || !rc.bulk) return;
      const checked = r && r.ok ? RL.checkCurve(r.curve) : null;
      if (checked && checked.ok) {
        if ((r.change || 0) >= REVIEW_MIN_CHANGE) {
          rc.drafts.set(recoilKey(o), { curve: checked.curve, source: 'ai', review: true, o, change: r.change, reasoning: r.reasoning || '', provider: r.provider || '', flags: reasonsOf.get(RL.comboKey(o)) || [] });
          rc.bulk.changed++;
        } else rc.bulk.same++;
      } else {
        rc.bulk.failed++;
        if (errors.length < 5) errors.push(`${fullLine(o)}: ${(r && r.reason) || (checked && checked.error) || 'lỗi'}`);
      }
      rc.bulk.done++;
      paintBulk();
    });
    const b = rc.bulk;
    rc.bulk = null;
    rc.picked = null; rc.editCurve = null; rc.dirty = false; rc.bad.clear();
    redraw();
    if (!b) return;
    const currentGunPending = pendingSaves(weapon).length;
    const totalAll = pendingSaves().length;
    const otherCount = totalAll - currentGunPending;
    const end = await showModal({
      title: `${b.ac.signal.aborted ? 'Đã dừng' : 'Rà soát xong'}: ${gun}`, tone: b.changed ? 'warn' : 'info',
      body: [
        el('p', {}, `Đã rà soát ${b.done}/${b.total} mục: AI đề xuất đổi ${b.changed}, giữ nguyên ${b.same}${b.failed ? `, không dùng được ${b.failed}` : ''}.`),
        b.changed ? el('p', {}, 'Các mục có đề xuất mang nhãn "AI đề xuất n%" trong bảng (đổi ống ngắm/tư thế để xem hết). Mở một dòng để xem đồ thị, sửa tiếp hoặc "Hoàn tác" để bỏ đề xuất đó.') : null,
        otherCount > 0 ? alert('warn', `Lưu ý: Có ${otherCount} bản nháp của súng khác đang lưu tạm trong bộ nhớ. Nút bấm dưới đây sẽ chỉ lưu riêng cho súng ${gun}.`) : null,
        errors.length ? el('ul', { class: 'muted text-sm' }, errors.map((x) => el('li', {}, x))) : null,
      ],
      actions: b.changed && currentGunPending ? [{ id: 'close', label: 'Đóng, xem lại trong bảng' }, { id: 'save', label: `Lưu ${gun} (${currentGunPending})`, primary: true }] : [{ id: 'close', label: 'Đóng', primary: true }],
    });
    if (end === 'save') await guard(() => saveAll(weapon))();
  }

  // ---------------------------------------------------------------- "Thêm mốc cho súng": batch add points across all scopes and postures
  // Puts a new curve for each combination into the drafts (nothing is written to the file). makeCurve(base, o) -> the new curve; base is what the
  // page holds now for that combination: its draft, the curve being edited, or what the app uses. -> how many combinations
  function applyToDrafts(ix, targets, makeCurve, { source, how }) {
    for (const o of targets) {
      const key = recoilKey(o);
      const draft = rc.drafts.get(key);
      const base = draft && draft.curve ? draft.curve : rc.editKey === key && rc.editCurve ? rc.editCurve : RL.resolve(ix.idx, o).curve;
      const curve = makeCurve(base, o);
      rc.drafts.set(key, { o, curve, review: true, source, how, change: 0 });
      if (rc.editKey === key && rc.editCurve) { rc.editCurve = curve; rc.dirty = true; }
    }
    return targets.length;
  }

  // "Chia đều thời gian cả súng": every own combination of the gun is spread evenly over one magazine (shape kept), as drafts
  async function showRetimeGunModal(ix) {
    if (!latest()) { toast('Chỉ làm được khi đang xem "Mới nhất".', true); return; }
    const weapon = rc.weapon;
    const fire = RL.fireOf(weapon);
    if (!fire) { toast('Súng này chưa có thời gian bắn hết băng (Tiêu chuẩn súng).', true); return; }
    if (RL.isGunDisabled(weapon) || RL.isZeroWeapon(weapon) || rc.bulk || rc.filling) return;
    const gunName = RL.weaponLabel(weapon);
    const targets = RL.batchCombos(ix.idx, rc.customCombos, weapon, scopesOf(weapon)).own;
    if (!targets.length) { toast(`${gunName}: chưa có mục riêng nào để chia đều.`, true); return; }
    const id = await showModal({
      title: `Chia đều thời gian cả súng ${gunName}?`, tone: 'info',
      body: [
        el('p', {}, `Mọi mục riêng của ${gunName} (${targets.length} tổ hợp, mọi ống ngắm và tư thế) được chia đều thời gian trên ${secondsText(fire.emptyMs)} s (${fire.magazine} viên × ${vn(fire.interval)} s). Số mốc và hình dạng đường cong giữ nguyên.`),
        el('p', { class: 'muted text-xs' }, 'Kết quả là bản nháp: xem lại rồi bấm "Lưu tất cả" để ghi vào server (có bản sao lưu lịch sử).'),
      ],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'apply', label: 'Chia đều', primary: true }],
    });
    if (id !== 'apply') return;
    if (!latest() || rc.bulk || rc.filling || rc.weapon !== weapon) { toast('Dữ liệu đã thay đổi khi hộp thoại đang mở: hãy thử lại.', true); return; }
    const n = applyToDrafts(ix, targets, (base) => RL.retime(base, fire.emptyMs), { source: 'retime', how: 'chia đều' });
    redraw();
    toast(`Đã chia đều thời gian cho ${n} tổ hợp của ${gunName}. Bấm "Lưu tất cả" để ghi vào server.`);
  }
  async function showBatchAddPointsModal(ix) {
    if (!latest()) { toast('Chỉ làm được khi đang xem "Mới nhất".', true); return; }
    const weapon = rc.weapon;
    if (RL.isGunDisabled(weapon)) { toast('Súng này đã bị tắt trong Tiêu chuẩn súng: không thể thêm mốc.', true); return; }
    if (RL.isZeroWeapon(weapon)) { toast('Súng này luôn dùng đường cong 0 trong app: không có gì để thêm.', true); return; }
    if (rc.bulk || rc.filling) return;

    const gunName = RL.weaponLabel(weapon);
    const fire = RL.fireOf(weapon); // time to empty one magazine, or null

    // own entries (any scope, saved or still custom) and every valid combination, once each; the scope picker also lists scopes the rules no longer allow
    const { own: ownCombos, all: allValidCombos, scopeList: scopes, extra: extraScopes } = RL.batchCombos(ix.idx, rc.customCombos, weapon, scopesOf(weapon));

    // Modal UI elements
    const countInput = el('input', {
      type: 'number',
      min: '1',
      max: '20',
      step: '1',
      value: '1',
      class: 'fp-num',
      'aria-label': 'Số lượng mốc cần thêm',
    });

    const setStepCount = (v) => {
      const cur = Math.max(1, Math.min(20, Math.floor(Number(v) || 1)));
      countInput.value = String(cur);
      updateSummary();
    };

    const stepper = el('div', { class: 'stepper-wrap' },
      el('div', { class: 'stepper-control' },
        el('button', {
          type: 'button',
          class: 'btn icon small',
          'aria-label': 'Giảm 1 mốc',
          onclick: () => setStepCount((Number(countInput.value) || 1) - 1),
        }, icon('back')),
        countInput,
        el('button', {
          type: 'button',
          class: 'btn icon small',
          'aria-label': 'Tăng 1 mốc',
          onclick: () => setStepCount((Number(countInput.value) || 1) + 1),
        }, icon('plus'))
      ),
      el('div', { class: 'stepper-presets' },
        [1, 2, 3, 5, 10].map((num) => el('button', {
          type: 'button',
          class: 'pill-preset',
          onclick: () => setStepCount(num),
        }, `+${num} mốc`))
      )
    );

    const methodTrend = el('input', { type: 'radio', name: 'batch-method', value: 'trend', checked: true });
    const methodStep = el('input', { type: 'radio', name: 'batch-method', value: 'step' });

    const scopeOwn = el('input', { type: 'radio', name: 'batch-scope', value: 'own', checked: ownCombos.length > 0 });
    const scopeAll = el('input', { type: 'radio', name: 'batch-scope', value: 'all', checked: ownCombos.length === 0 });

    // which scopes and postures get the points (all by default); the combination range above is the other half of the filter
    const selScopes = new Set(scopes);
    const selGestures = new Set([0, 1, 2]);
    const range = () => (scopeAll.checked ? allValidCombos : ownCombos);
    const currentTargets = () => RL.filterCombos(range(), { scopes: selScopes, gestures: selGestures });
    const countBy = (list, key) => list.reduce((m, c) => m.set(c[key], (m.get(c[key]) || 0) + 1), new Map());
    let setApplyDisabled = null;
    const pickBox = (label, on) => {
      const input = el('input', { type: 'checkbox', checked: true, onchange: (e) => on(e.target.checked) });
      const n = el('span', { class: 'opt-chip-n' });
      return { input, n, node: el('label', { class: 'opt-chip' }, input, el('span', {}, label), n) };
    };
    const toggle = (set, v, on) => { if (on) set.add(v); else set.delete(v); updateSummary(); };
    const scopePicks = scopes.map((sc) => ({ sc, ...pickBox(`${RL.LABELS.SCOPES[sc]}${extraScopes.has(sc) ? ' (ngoài quy tắc)' : ''}`, (on) => toggle(selScopes, sc, on)) }));
    const posturePicks = [0, 1, 2].map((ge) => ({ ge, ...pickBox(POSTURE_VN[ge], (on) => toggle(selGestures, ge, on)) }));
    const setPicks = (picks, set, key, values) => { set.clear(); for (const v of values) set.add(v); picks.forEach((x) => { x.input.checked = set.has(x[key]); }); updateSummary(); };
    const quick = (label, fn, title) => el('button', { type: 'button', class: 'btn small ghost', title, onclick: fn }, label);
    const scopeQuick = el('div', { class: 'opt-quick' },
      quick('Tất cả', () => setPicks(scopePicks, selScopes, 'sc', scopes)),
      quick('Bỏ chọn', () => setPicks(scopePicks, selScopes, 'sc', [])),
      scopes.includes(rc.scope) ? quick('Chỉ ống đang xem', () => setPicks(scopePicks, selScopes, 'sc', [rc.scope]), RL.LABELS.SCOPES[rc.scope]) : null);
    const postureQuick = el('div', { class: 'opt-quick' },
      quick('Tất cả', () => setPicks(posturePicks, selGestures, 'ge', [0, 1, 2])),
      quick('Bỏ chọn', () => setPicks(posturePicks, selGestures, 'ge', [])),
      [0, 1, 2].includes(rc.gesture) ? quick('Chỉ tư thế đang xem', () => setPicks(posturePicks, selGestures, 'ge', [rc.gesture]), POSTURE_VN[rc.gesture]) : null);
    const scopePickBox = el('div', { class: 'opt-chips', role: 'group', 'aria-label': 'Ống ngắm' }, scopePicks.map((x) => x.node));
    const posturePickBox = el('div', { class: 'opt-chips', role: 'group', 'aria-label': 'Tư thế' }, posturePicks.map((x) => x.node));

    const summaryText = el('div', { class: 'modal-callout-text' });
    const summaryCard = el('div', { class: 'modal-callout info' }, icon('sparkles'), summaryText);
    const names = (all, picked, labelOf, allText) => (picked.length === all ? allText : picked.length <= 4 ? picked.map(labelOf).join(', ') : `${picked.slice(0, 4).map(labelOf).join(', ')} +${picked.length - 4}`);

    function updateSummary() {
      const n = Math.max(1, Math.min(20, Math.floor(Number(countInput.value) || 1)));
      const targets = currentTargets();
      const inRange = range();
      const byScope = countBy(RL.filterCombos(inRange, { gestures: selGestures }), 'scope');
      const byGesture = countBy(RL.filterCombos(inRange, { scopes: selScopes }), 'gesture');
      scopePicks.forEach((x) => { x.n.textContent = String(byScope.get(x.sc) || 0); });
      posturePicks.forEach((x) => { x.n.textContent = String(byGesture.get(x.ge) || 0); });
      const method = fire ? `nội suy trên ${secondsText(fire.emptyMs)} s` : methodTrend.checked ? 'theo xu hướng mốc trước' : 'theo bước chuẩn ngẫu nhiên';
      let msg;
      if (!selScopes.size) msg = 'Chưa chọn ống ngắm nào.';
      else if (!selGestures.size) msg = 'Chưa chọn tư thế nào.';
      else if (!targets.length) msg = 'Không có tổ hợp nào khớp ống ngắm, tư thế và phạm vi đã chọn.';
      else msg = `Sẽ thêm ${n} mốc (${method}) vào ${targets.length} tổ hợp của ${gunName}: ${names(scopes.length, [...selScopes].sort((x, y) => x - y), (x) => RL.LABELS.SCOPES[x], 'mọi ống ngắm')} · ${names(3, [...selGestures].sort(), (x) => POSTURE_VN[x], 'cả 3 tư thế')} (bộ dữ liệu: ${MODE_VN[rc.mode]}).`;
      summaryText.textContent = msg;
      summaryCard.className = `modal-callout ${targets.length ? 'info' : 'warn'}`;
      if (setApplyDisabled) setApplyDisabled(!targets.length);
    }

    countInput.oninput = updateSummary;
    countInput.onchange = () => setStepCount(countInput.value); // what is shown is what is used
    methodTrend.onchange = updateSummary;
    methodStep.onchange = updateSummary;
    scopeOwn.onchange = updateSummary;
    scopeAll.onchange = updateSummary;
    updateSummary();

    const methodCards = el('div', { class: 'choice-group' },
      choiceCard({
        input: methodTrend,
        title: 'Theo xu hướng mốc trước',
        desc: 'Tính bước nhảy thời gian Δt và độ bù giật Δv giữa các mốc cuối của từng đường cong để kéo dài tự nhiên, mượt mà.',
        badge: badge('Khuyên dùng', 'accent'),
        checked: true,
      }),
      choiceCard({
        input: methodStep,
        title: 'Theo bước chuẩn của hệ thống',
        desc: `Thời gian +${RL.STEP.time[0]}..${RL.STEP.time[1]} ms, giá trị +${RL.STEP.value[0]}..${RL.STEP.value[1]} (hướng ${DIR_VN[rc.stepDir] || 'Tăng'}).`,
      })
    );

    const scopeCards = el('div', { class: 'choice-group' },
      choiceCard({
        input: scopeOwn,
        title: `Chỉ các mục riêng hiện có của ${gunName}`,
        desc: 'Chỉ cập nhật các đường cong đã được tạo và lưu riêng cho súng này.',
        badge: badge(`${ownCombos.length} tổ hợp`, ownCombos.length ? 'info' : 'neutral'),
        disabled: ownCombos.length === 0,
      }),
      choiceCard({
        input: scopeAll,
        title: `Tất cả tổ hợp hợp lệ của ${gunName}`,
        desc: 'Bao gồm cả các tổ hợp chưa có mục riêng (sẽ tạo bản nháp mới từ đường cong nền × hệ số).',
        badge: badge(`${allValidCombos.length} tổ hợp`, 'accent'),
      })
    );

    const choice = await showModal({
      title: `Thêm mốc cho súng ${gunName}`,
      tone: 'info',
      body: [
        el('p', { class: 'muted' }, `Thêm mốc nối tiếp cho ${gunName} ở các ống ngắm và tư thế bạn chọn.`),
        el('div', { class: 'field' },
          el('span', { class: 'font-semibold text-sm' }, 'Số lượng mốc cần thêm vào mỗi tổ hợp (1–20 mốc):'),
          stepper
        ),
        fire
          ? el('p', { class: 'muted' }, `Các mốc mới được nội suy lại trên thời gian bắn hết băng ${secondsText(fire.emptyMs)} s (${fire.magazine} viên × ${vn(fire.interval)} s): các mốc luôn chia đều thời gian, hình dạng đường cong giữ nguyên.`)
          : el('div', { class: 'field' },
            el('span', { class: 'font-semibold text-sm' }, 'Quy tắc tính mốc tiếp theo:'),
            methodCards
          ),
        el('div', { class: 'field' },
          el('span', { class: 'font-semibold text-sm' }, 'Ống ngắm (số tổ hợp bị thêm mốc):'),
          scopePickBox, scopeQuick
        ),
        el('div', { class: 'field' },
          el('span', { class: 'font-semibold text-sm' }, 'Tư thế:'),
          posturePickBox, postureQuick
        ),
        el('div', { class: 'field' },
          el('span', { class: 'font-semibold text-sm' }, 'Phạm vi tổ hợp áp dụng:'),
          scopeCards
        ),
        summaryCard,
        el('p', { class: 'muted text-xs' }, 'Lưu ý: Mọi thay đổi sau khi tính sẽ được lưu tạm thành bản nháp (chưa ghi đè trực tiếp). Bạn có thể xem lại biểu đồ của từng tổ hợp, sau đó bấm "Lưu tất cả" để ghi vào file trên server (có bản sao lưu lịch sử).'),
      ],
      actions: [
        { id: 'cancel', label: 'Hủy' },
        { id: 'apply', label: 'Bắt đầu thêm mốc', primary: true },
      ],
      onOpen: ({ setDisabled }) => { setApplyDisabled = (v) => setDisabled('apply', v); updateSummary(); },
    });

    if (choice !== 'apply') return;
    // the page may have changed while the window was open (reload, save, another gun): do not apply to stale combinations
    if (!latest() || rc.bulk || rc.filling || rc.weapon !== weapon || RL.isGunDisabled(weapon)) { toast('Dữ liệu đã thay đổi khi hộp thoại đang mở: hãy mở lại "Thêm mốc cho súng".', true); return; }

    const count = Math.max(1, Math.min(20, Math.floor(Number(countInput.value) || 1)));
    const method = methodTrend.checked ? 'trend' : 'step';
    const targets = currentTargets();

    if (!targets.length) {
      toast(`${gunName}: không có tổ hợp nào phù hợp với ống ngắm, tư thế và phạm vi đã chọn.`, true);
      return;
    }

    const modified = applyToDrafts(ix, targets, fire
      ? (base) => RL.resample(base, base.length + count, fire.emptyMs) // the shape is kept, the points are evenly spaced over one magazine
      : (base) => RL.extendCurve(base, count, { method, dir: rc.stepDir }), { source: 'add_points', how: `+${count} mốc` });

    redraw();
    toast(`Đã thêm ${count} mốc cho ${modified} tổ hợp của ${gunName}. Bấm "Lưu tất cả" để ghi vào server.`);
  }

  // ---------------------------------------------------------------- "Cài đặt AI": the endpoints and the order they are tried in
  async function showAiSettings() {
    let rows;
    try { rows = (await api('GET', '/ai/providers')).providers.map((p) => ({ ...p, apiKey: '', saved: true })); } catch (e) { toast(e.message, true); return; }
    const box = el('div', { class: 'ai-providers' });
    const note = el('p', { class: 'muted text-sm' }, 'Mỗi câu hỏi gửi tới nguồn đầu tiên đang bật; nguồn đó lỗi (không kết nối, lỗi HTTP, quá giờ, trả lời không hợp lệ) thì chuyển sang nguồn kế tiếp. Khóa chỉ nằm trên server: trang không bao giờ thấy lại khóa. Đổi địa chỉ của một nguồn thì phải nhập lại khóa.');
    const field = (label, input) => el('label', { class: 'field' }, label, input);
    const move = (i, d) => { const j = i + d; if (j < 0 || j >= rows.length) return; [rows[i], rows[j]] = [rows[j], rows[i]]; rows[i].dirty = rows[j].dirty = true; paint(); };
    async function test(p, out) {
      const say = (t) => { p.testMsg = t; out.textContent = t; }; // kept on the row: the list is drawn again on every change
      if (!p.saved || p.dirty) { say('Bấm "Lưu" trước rồi hãy thử.'); return; }
      say('Đang thử…');
      try {
        const r = await api('POST', '/ai/providers/test', { id: p.id });
        say(r.ok ? `Trả lời được (${r.model}, ${Math.round(r.ms / 100) / 10} giây).` : r.reason);
      } catch (e) { say(e.message); }
    }
    function paint() {
      box.replaceChildren(...rows.map((p, i) => {
        const out = el('div', { class: 'muted text-sm' }, p.testMsg || '');
        const set = (k) => (e) => { p[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; p.dirty = true; };
        const head = el('div', { class: 'row' },
          el('strong', {}, `${i + 1}. ${p.name || 'Nguồn mới'}`),
          p.builtin ? badge('Mặc định') : null,
          !p.saved ? badge('Chưa lưu', 'warn') : p.ready ? null : badge('Chưa đủ địa chỉ/khóa', 'warn'),
          el('label', { class: 'row' }, el('input', { type: 'checkbox', checked: p.enabled, onchange: set('enabled') }), 'Bật'),
          el('button', { type: 'button', class: 'btn icon small ghost', title: 'Ưu tiên cao hơn', 'aria-label': 'Ưu tiên cao hơn', disabled: i === 0, onclick: () => move(i, -1) }, icon('arrowUp')),
          el('button', { type: 'button', class: 'btn icon small ghost', title: 'Ưu tiên thấp hơn', 'aria-label': 'Ưu tiên thấp hơn', disabled: i === rows.length - 1, onclick: () => move(i, 1) }, icon('arrowDown')),
          el('button', { type: 'button', class: 'btn small ghost', onclick: () => test(p, out) }, 'Thử'),
          p.builtin ? null : el('button', { type: 'button', class: 'btn icon small ghost', title: 'Xóa nguồn này', 'aria-label': 'Xóa nguồn này', onclick: () => { rows.splice(i, 1); paint(); } }, icon('trash')));
        const body = p.builtin
          ? el('p', { class: 'muted text-sm' }, `FreeLLMAPI của server (biến AI_BASE_URL / AI_API_KEY), model ${p.model}. Địa chỉ và khóa không hiện ở đây; tắt hoặc đổi thứ tự được.`)
          : el('div', {},
            field('Tên', el('input', { type: 'text', value: p.name || '', maxlength: '60', oninput: set('name') })),
            field('Địa chỉ (tương thích OpenAI, tới /v1)', el('input', { type: 'url', value: p.baseUrl || '', placeholder: 'https://openrouter.ai/api/v1', oninput: set('baseUrl') })),
            field('Model', el('input', { type: 'text', value: p.model || '', placeholder: 'auto', oninput: set('model') })),
            field(p.hasKey ? `Khóa API (đang có ${p.keyHint}; để trống = giữ khóa cũ)` : 'Khóa API', el('input', { type: 'password', autocomplete: 'new-password', value: '', oninput: set('apiKey') })));
        return el('div', { class: 'card my-2' }, head, body, out);
      }), el('button', { type: 'button', class: 'btn small', disabled: rows.length > 8, onclick: () => { rows.push({ id: '', name: '', baseUrl: '', model: 'auto', apiKey: '', enabled: true, saved: false }); paint(); } }, icon('plus'), 'Thêm nguồn AI'));
    }
    paint();
    for (;;) {
      const id = await showModal({ title: 'Cài đặt AI', tone: 'info', className: 'wide', body: [note, box], actions: [{ id: 'cancel', label: 'Đóng' }, { id: 'save', label: 'Lưu', primary: true }] });
      if (id !== 'save') return;
      const list = rows.map((p) => (p.builtin ? { id: 'env', enabled: p.enabled } : { id: p.id || undefined, name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey, enabled: p.enabled }));
      try {
        const r = await api('PUT', '/ai/providers', { providers: list });
        aiStatusP = null;
        const first = r.providers.find((x) => x.enabled && x.ready);
        toast(`Đã lưu ${r.providers.length} nguồn AI. ${first ? `Hỏi trước: ${first.name}.` : 'Chưa có nguồn nào dùng được.'}`);
        return;
      } catch (e) { toast(e.message, true); } // the window opens again with what was typed
    }
  }

  // ---------------------------------------------------------------- "Tạo đủ cho cả súng": every scope and every posture of the gun, in one go
  // 1. the server says, for each scope the gun can take and each of the three postures, which combinations the gun can still take (the table of
  //    accessories decides) and the page does not have yet; 2. the points are made: from similar guns where the server can, else the coefficient
  //    curve, and the AI answers for the most important ones (it is slow); 3. everything is checked again (curves, the table, a second scan that
  //    must find nothing new); 4. the combinations go into the list as unsaved ones. Then "Lưu tất cả" writes them in one go.
  const FILL_POSTURES = [0, 1, 2];
  const scopesOf = (weapon) => RL.SCOPES.map((_, s) => s).filter((s) => !RL.comboProblems(weapon, s, {}).some((p) => p.slot === 'scope'));
  const priority = (m) => (m.gap ? 1000 + m.gap.support * 100 : 0) + (m.expectedError || 0) * 100;

  async function scanGun(weapon, onStep = () => {}) {
    const found = [];
    const skipped = [];
    const scopes = scopesOf(weapon);
    const total = scopes.length * FILL_POSTURES.length;
    let n = 0;
    for (const scope of scopes) {
      for (const gesture of FILL_POSTURES) {
        onStep(++n, total, scope, gesture);
        let r;
        try { r = await api('POST', '/recoil/combo-suggestions', { id: S.sel.id, mode: rc.mode, combo: { weapon, scope, gesture } }); } catch (e) { skipped.push({ scope, gesture, reason: e.message }); continue; }
        if (!r.ok) { skipped.push({ scope, gesture, reason: r.reason || '' }); continue; }
        for (const m of r.missing || []) found.push({ weapon, scope, gesture, grip: m.grip, muzzle: m.muzzle, stock: m.stock, gap: m.gap, expectedError: m.expectedError });
      }
    }
    return { found, skipped, scopes: scopes.length };
  }

  // is a curve believable next to the one the coefficients give? (start, end and duration within reach)
  function plausible(curve, ref) {
    if (!ref || !ref.length) return true;
    const a = RL.curveStats(curve);
    const b = RL.curveStats(ref);
    const near = (x, y, tol) => (Math.abs(y) < 1e-9 ? Math.abs(x) < 1e-6 : Math.abs(x / y - 1) <= tol);
    return near(a.v0, b.v0, 0.4) && near(a.vEnd, b.vEnd, 0.4) && near(a.duration, b.duration, 0.5);
  }

  async function fillGun(ix) {
    if (!latest()) { toast('Chỉ làm được khi đang xem "Mới nhất".', true); return; }
    const weapon = rc.weapon;
    if (RL.isGunDisabled(weapon)) { toast('Súng này đã bị tắt trong Tiêu chuẩn súng.', true); return; }
    if (RL.isZeroWeapon(weapon)) { toast('Súng này luôn dùng đường cong 0 trong app: không có gì để tạo.', true); return; }
    if (rc.bulk || rc.filling) return;
    if (!(await discardOk())) return;
    rc.filling = true;
    const gun = RL.weaponLabel(weapon);
    try {
      // ---- 1. scan (a quick pass: one request per scope and posture)
      const scanBar = window.Ui.progressDialog({ title: `Đang quét ${gun}…`, steps: ['Quét các ống ngắm và tư thế'] });
      let scan;
      try {
        scan = await scanGun(weapon, (n, total, scope, gesture) => scanBar.update({ step: 0, pct: (n / total) * 100, detail: `${RL.LABELS.SCOPES[scope]} · ${POSTURE_VN[gesture]} (${n}/${total})` }));
      } finally { scanBar.close(); }
      const have = rc.customCombos || new Set();
      const todo = scan.found.filter((f) => !have.has(RL.comboKey(f)));
      if (!todo.length) {
        toast(scan.found.length ? `${gun}: mọi tổ hợp còn thiếu đã nằm trong danh sách (chưa lưu). Bấm "Lưu tất cả".` : `${gun}: đã đủ mọi tổ hợp theo bảng chuẩn, không còn gì để thêm.`);
        return;
      }

      // ---- the question: how many for the AI
      const status = await aiStatus();
      const perScope = new Map();
      for (const f of todo) { const k = f.scope; if (!perScope.has(k)) perScope.set(k, [0, 0, 0]); perScope.get(k)[f.gesture]++; }
      const aiBox = el('input', { type: 'number', min: '0', max: String(todo.length), step: '1', value: String(status.enabled ? Math.min(10, todo.length) : 0), disabled: !status.enabled, 'aria-label': 'Số tổ hợp nhờ AI', class: 'fp-num' });
      const go = await showModal({
        title: `Tạo đủ tổ hợp cho ${gun}?`, tone: 'warn',
        body: [
          el('p', {}, `${gun} còn thiếu ${todo.length} tổ hợp trên ${scan.scopes} ống ngắm × 3 tư thế (theo bảng phụ kiện chuẩn).`),
          el('ul', {}, [...perScope].map(([s, c]) => el('li', {}, `${RL.LABELS.SCOPES[s]}: đứng ${c[0]}, ngồi ${c[1]}, nằm ${c[2]}`))),
          scan.skipped.length ? el('p', { class: 'muted' }, `Bỏ qua ${scan.skipped.length} cặp (không có đường cong nền của ống ngắm/tư thế đó): ${scan.skipped.slice(0, 6).map((s) => `${RL.LABELS.SCOPES[s.scope]} · ${POSTURE_VN[s.gesture]}`).join('; ')}${scan.skipped.length > 6 ? '…' : ''}.`) : null,
          el('label', { class: 'field' }, status.enabled ? `Nhờ AI cho bao nhiêu tổ hợp quan trọng nhất? (mỗi tổ hợp khoảng 10–40 giây, chạy ${aiThreads(status)} luồng song song; 0 = không dùng AI)` : 'AI chưa được bật trên server: mốc do server tính', aiBox),
          el('p', { class: 'muted text-sm' }, 'Mốc của các tổ hợp còn lại: server tính từ súng tương tự nếu có súng nào đã có mục riêng cho đúng tổ hợp đó, không thì lấy đường cong theo hệ số (đúng cái app đang dùng). Làm xong mọi thứ vẫn là bản nháp, chưa lưu; sau đó có bước kiểm tra lại.'),
        ],
        actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'go', label: `Tạo ${todo.length} tổ hợp`, primary: true }],
      });
      if (go !== 'go') return;
      const aiLimit = status.enabled ? Math.max(0, Math.min(todo.length, Math.floor(Number(aiBox.value) || 0))) : 0;

      // ---- 2. 3. 4.
      const bar = window.Ui.progressDialog({ title: `Đang tạo ${todo.length} tổ hợp cho ${gun}…`, steps: ['Tính mốc (súng tương tự, hệ số)', 'AI tạo mốc', 'Kiểm tra lại', 'Thêm vào danh sách'] });
      const made = new Map(); // comboKey -> { o, curve, source, ref }
      const itemId = S.sel.id;
      let stopAi = false;
      try {
        // points from the server, 6 at a time
        let done = 0;
        let cursor = 0;
        const runOne = async () => {
          while (cursor < todo.length) {
            const f = todo[cursor++];
            const o = { weapon, scope: f.scope, gesture: f.gesture, grip: f.grip, muzzle: f.muzzle, stock: f.stock };
            const ref = RL.resolve(ix.idx, o).curve.map(([t, v]) => [Number(t), Number(v)]);
            let pick = { source: 'coef', curve: ref };
            try {
              const r = await api('POST', '/recoil/suggest', { id: itemId, mode: rc.mode, combo: { weapon, scope: o.scope, gesture: o.gesture, grip: o.grip, muzzle: o.muzzle, stock: o.stock } });
              const c = r.ok ? RL.checkCurve(r.curve) : null;
              if (c && c.ok) pick = { source: 'server', curve: c.curve };
            } catch { /* the coefficient curve stays */ }
            made.set(RL.comboKey(o), { o, f, curve: pick.curve, source: pick.source, ref });
            done++;
            if (done % 8 === 0 || done === todo.length) bar.update({ step: 0, pct: 3 + (done / todo.length) * 40, detail: `Tính mốc ${done}/${todo.length}: ${RL.LABELS.SCOPES[o.scope]} · ${POSTURE_VN[o.gesture]}` });
          }
        };
        await Promise.all(Array.from({ length: Math.min(6, todo.length) }, runOne));

        // the AI, for the most important ones, one at a time
        const important = [...made.values()].sort((a, b) => priority(b.f) - priority(a.f)).slice(0, aiLimit);
        let aiOk = 0;
        let aiBad = 0;
        if (important.length) {
          bar.setStop('Dừng AI (phần còn lại dùng kết quả của server)', () => { stopAi = true; });
          let doneAi = 0;
          await runPool(important, aiThreads(status), async (m) => {
            if (stopAi) return;
            const r = await askAi({ id: itemId, mode: rc.mode, combo: { weapon, scope: m.o.scope, gesture: m.o.gesture, grip: m.o.grip, muzzle: m.o.muzzle, stock: m.o.stock } }, { stopped: () => stopAi });
            const c = r.ok ? RL.checkCurve(r.curve) : null;
            if (c && c.ok && plausible(c.curve, m.ref)) { m.curve = c.curve; m.source = 'ai'; aiOk++; } else aiBad++;
            doneAi++;
            bar.update({ step: 1, pct: 43 + (doneAi / important.length) * 37, detail: `AI ${doneAi}/${important.length} (${aiThreads(status)} luồng song song): ${fullLine(m.o)}` });
          });
          bar.setStop(null);
        }
        bar.update({ step: 2, pct: 82, detail: 'Kiểm tra từng đường cong…' });
        await nextFrame();

        // ---- the check: every curve, the table of accessories, and a second scan that must find nothing new
        let fixed = 0;
        let suspect = 0;
        let againstTable = 0;
        for (const m of made.values()) {
          const c = RL.checkCurve(m.curve);
          if (!c.ok) { m.curve = m.ref; m.source = 'coef'; fixed++; }
          if (RL.comboProblems(m.o.weapon, m.o.scope, m.o).length) againstTable++;
          m.suspect = !plausible(m.curve, m.ref);
          if (m.suspect) suspect++;
        }
        bar.update({ step: 2, pct: 86, detail: 'Quét lại các ống ngắm và tư thế…' });
        const again = await scanGun(weapon);
        const still = again.found.filter((f) => !made.has(RL.comboKey(f)) && !have.has(RL.comboKey(f)));

        // ---- into the list
        bar.update({ step: 3, pct: 95, detail: 'Thêm vào danh sách…' });
        await nextFrame();
        if (!rc.customCombos) rc.customCombos = new Set();
        for (const [k, m] of made) {
          rc.customCombos.add(k);
          rc.drafts.set(recoilKey(m.o), { curve: m.curve, source: m.source, suspect: m.suspect });
        }
        rc.picked = null; rc.editCurve = null; rc.dirty = false; rc.bad.clear();
        redraw();

        const by = { ai: 0, server: 0, coef: 0 };
        for (const m of made.values()) by[m.source]++;
        const lines = [
          `Đã thêm ${made.size} tổ hợp của ${gun} vào danh sách (chưa lưu): AI ${by.ai}, server (súng tương tự) ${by.server}, theo hệ số ${by.coef}.`,
          aiLimit ? `AI: ${aiOk} tổ hợp dùng được${aiBad ? `, ${aiBad} không dùng được (lệch quá hoặc lỗi) nên giữ kết quả của server/hệ số` : ''}${stopAi ? '; đã dừng sớm' : ''}.` : 'Không dùng AI.',
          `Kiểm tra lại: ${made.size - fixed}/${made.size} đường cong hợp lệ${fixed ? ` (${fixed} cái đã đổi về hệ số)` : ''}; ${againstTable ? `${againstTable} tổ hợp SAI bảng chuẩn` : 'không tổ hợp nào sai bảng chuẩn'}; quét lại ${still.length ? `còn thiếu ${still.length} tổ hợp` : 'không còn thiếu tổ hợp nào'}; ${suspect ? `${suspect} tổ hợp lệch nhiều so với hệ số (đánh dấu "xem lại" trong bảng)` : 'không có tổ hợp nào lệch bất thường'}.`,
        ];
        const currentGun = pendingSaves(rc.weapon).length;
        await bar.result(lines, [
          { label: `Lưu ${gun} (${currentGun})`, primary: true, onclick: () => guard(() => saveAll(rc.weapon))() },
          { label: 'Đóng, xem lại trong danh sách' },
        ]);
      } catch (e) {
        await bar.fail(`Không tạo được: ${e.message || e}. Chưa có gì được thêm hay ghi.`);
      }
    } finally {
      rc.filling = false;
    }
  }

  function recoilDetail(ix, o) {
    const r = RL.resolve(ix.idx, o);
    const comboKey = `${rc.weapon}|${rc.scope}|${rc.gesture}|${o.grip}|${o.muzzle}|${o.stock}|${rc.mode}`;
    if (!rc.editCurve || rc.editKey !== comboKey) {
      rc.editKey = comboKey;
      const draft = rc.drafts.get(comboKey);
      rc.editCurve = draft ? draft.curve : r.curve.map(([t, v]) => [Number(t), Number(v)]);
      // a combination added on this page (by hand or from a suggestion) has no entry in the file yet: saving it is what is left to do, so the button is lit
      const fresh = rc.customCombos && rc.customCombos.has(RL.comboKey(o)) && r.source !== 'exact' && !RL.isZeroWeapon(o.weapon) && latest();
      rc.fresh = Boolean(fresh);
      rc.freshBase = fresh && !draft ? JSON.stringify(rc.editCurve) : null;
      rc.dirty = Boolean(fresh) || Boolean(draft && draft.review && latest()); // an "AI đề xuất" is a change not saved yet
      rc.bad.clear();
    }
    const curve = rc.editCurve;
    const label = comboText(o);
    const zero = RL.isZeroWeapon(o.weapon); // the app ignores this gun's data: nothing to save
    const fire = zero ? null : RL.fireOf(o.weapon); // time to empty one magazine: the length of the curve, its points are spread evenly over it
    const canSave = () => rc.dirty && !zero && rc.bad.size === 0;

    const chartWrap = el('div', { class: 'chart-box my-3' });
    const ptsSlot = el('div', { class: 'table-wrap my-2 overflow-x-auto' });
    const summarySlot = el('span', {}, '');
    const fireSlot = el('div', { class: 'meta fire-line' });
    const dirtyBadgeSlot = el('span', {}, '');

    // two buttons (a node can only sit in one place): one beside the title, one under the table of points; both follow canSave()
    const makeSaveBtn = () => el('button', {
      type: 'button',
      class: 'btn primary',
      disabled: !canSave(),
      onclick: guard(() => saveRecoil(ix, o, curve)),
    }, icon('check'), 'Lưu độ giật vào server');
    const saveBtns = [makeSaveBtn(), makeSaveBtn()];

    const resetBtn = el('button', {
      type: 'button',
      class: 'btn small ghost',
      disabled: !rc.dirty,
      onclick: () => {
        curve.splice(0, curve.length, ...r.curve.map(([t, v]) => [Number(t), Number(v)])); // in place: the boxes and the chart hold this very array
        rc.drafts.delete(rc.editKey);
        rc.freshBase = rc.fresh ? JSON.stringify(curve) : null;
        rc.dirty = rc.fresh; // an added combination stays unsaved
        rc.bad.clear();
        renderPts();
        updateLive();
      },
    }, 'Hoàn tác');

    const openHistory = guard(() => {
      if (window.Ui.restoreFromHistory) {
        window.Ui.restoreFromHistory(CACHE_FILE, async () => {
          rc.dirty = false;
          rc.editCurve = null;
          rc.idx = null;
          await refresh();
        });
      }
    });

    // the chart can be dragged: a point moved there is put in the boxes of its row at once, and the picture is drawn again when it is dropped
    const dragOpts = {
      get lockX() { return Boolean(fire); }, // the times are spread evenly over one magazine: only the values are dragged
      onMove(i) {
        const ref = refs[i];
        if (ref) {
          ref.t.value = String(curve[i][0]);
          ref.v.value = String(Number(curve[i][1].toFixed(2)));
          for (const b of [ref.t, ref.v]) { b.setAttribute('aria-invalid', 'false'); b.title = ''; }
        }
        rc.bad.delete(`${i}:0`);
        rc.bad.delete(`${i}:1`);
        paintRow(i);
        paintRow(i + 1);
        rc.dirty = true;
      },
      onEnd(i) { rc.dirty = true; updateLive(i); },
    };
    function updateLive(focusIdx = null) {
      const st = RL.curveStats(curve);
      chartWrap.replaceChildren(chart(curve, dragOpts));
      if (focusIdx !== null) { const h = chartWrap.querySelector(`.dot-hit[data-i="${focusIdx}"]`); if (h) h.focus({ preventScroll: true }); }
      summarySlot.textContent = `${st.points} mốc, ${st.duration} ms, giá trị ${num(st.min)} … ${num(st.max)}`;
      if (!zero) {
        const gap = fire ? RL.durationGap(curve, fire.emptyMs) : 0;
        fireSlot.replaceChildren(...[fire ? el('span', {}, `Hết băng: ${secondsText(fire.emptyMs)} s (${fire.magazine} viên × ${vn(fire.interval)} s)`) : el('span', { class: 'muted' }, 'Súng này chưa có thời gian bắn hết băng (Tiêu chuẩn súng): các mốc dùng bước thời gian cũ.'),
          gap > 0.05 ? badge(`Thời lượng ${secondsText(st.duration)} s, lệch ${Math.round(gap * 100)}% so với băng đạn`, 'warn', { dot: true }) : null].filter(Boolean));
      }
      for (const b of saveBtns) b.disabled = !canSave();
      resetBtn.disabled = !rc.dirty;
      const untouched = rc.freshBase && JSON.stringify(curve) === rc.freshBase;
      dirtyBadgeSlot.replaceChildren(rc.dirty ? badge(untouched ? 'Tổ hợp mới, chưa lưu vào server' : 'Có thay đổi chưa lưu', 'warn', { dot: true }) : badge('Đã đồng bộ', 'ok'));
      paintSaveAll();
    }

    // A box was typed in. Only a finite number (and a time of 0 or more) goes into the curve; anything else keeps the old
    // number there, marks the box and blocks saving, so a half-typed or absurd value (1e999) can never be written to the file.
    function typed(e, i, col) {
      const text = e.target.value.trim();
      const n = text === '' ? NaN : Number(text);
      const ok = Number.isFinite(n) && (col === 1 || n >= 0);
      const k = `${i}:${col}`;
      if (ok) { curve[i][col] = n; rc.bad.delete(k); } else rc.bad.add(k);
      e.target.setAttribute('aria-invalid', ok ? 'false' : 'true');
      e.target.title = ok ? '' : col === 0 ? 'Cần một số từ 0 trở lên' : 'Cần một số hữu hạn';
      paintRow(i);
      paintRow(i + 1);
      rc.dirty = true;
      updateLive();
    }

    // The boxes of the drawn rows, so recomputed points can be shown in place: a full redraw would drop the focus when the user tabs on.
    let refs = [];
    const deltaText = (i) => (i ? `${curve[i][1] - curve[i - 1][1] >= 0 ? '+' : ''}${(curve[i][1] - curve[i - 1][1]).toFixed(2)} / ${curve[i][0] - curve[i - 1][0]} ms` : '—');
    const ORDER_HINT = 'Thời gian không lớn hơn mốc trước: đường cong nên tăng dần theo thời gian.';
    function paintRow(i) {
      const ref = refs[i];
      if (!ref) return;
      const disordered = i > 0 && curve[i][0] <= curve[i - 1][0];
      ref.tr.className = disordered ? 'warnrow' : '';
      if (disordered) ref.tr.title = ORDER_HINT; else ref.tr.removeAttribute('title');
      ref.delta.textContent = deltaText(i);
    }
    // the later points were recomputed: put them in the boxes that are already on the page
    function syncRows(from) {
      for (let j = from; j < curve.length; j++) {
        const ref = refs[j];
        if (!ref) continue;
        ref.t.value = String(curve[j][0]);
        ref.v.value = String(Number(curve[j][1].toFixed(2)));
        for (const b of [ref.t, ref.v]) { b.setAttribute('aria-invalid', 'false'); b.title = ''; }
        rc.bad.delete(`${j}:0`);
        rc.bad.delete(`${j}:1`);
        paintRow(j);
      }
    }
    // A box was left (or Enter): with "Tự tính các mốc sau" on, every later point of THAT column continues from the one before it.
    function committed(i, col) {
      if (!rc.autoStep || rc.bad.has(`${i}:${col}`)) return;
      // a gun with fire data: the later TIMES are spread evenly from this one to the end of the magazine; the values keep adding up step by step
      const changed = col === 0 && fire ? RL.spreadAfter(curve, i, fire.emptyMs) : RL.cascadeFrom(curve, i, col, Math.random, rc.stepDir);
      if (changed) { rc.dirty = true; syncRows(i + 1); updateLive(); }
    }

    function renderPts() {
      rc.bad.clear(); // the boxes are drawn again from the curve, which only holds good numbers
      refs = [];
      const rows = curve.map(([t, v], i) => {
        const tInput = el('input', {
          type: 'number',
          min: '0',
          step: '1',
          value: t,
          class: 'text-xs',
          'aria-label': `Thời gian mốc ${i + 1}`,
          oninput: (e) => typed(e, i, 0),
          onchange: () => committed(i, 0),
        });

        const vInput = el('input', {
          type: 'number',
          step: 'any',
          value: Number(v.toFixed(2)),
          class: 'text-xs',
          'aria-label': `Giá trị mốc ${i + 1}`,
          oninput: (e) => typed(e, i, 1),
          onchange: () => committed(i, 1),
        });

        const delBtn = el('button', {
          type: 'button',
          class: 'btn icon small danger',
          title: 'Xóa mốc này',
          disabled: curve.length <= 1,
          onclick: () => {
            curve.splice(i, 1);
            if (fire) curve.splice(0, curve.length, ...RL.withEvenTimes(curve, fire.emptyMs)); // the rest stay evenly spaced over the magazine
            rc.dirty = true;
            renderPts();
            updateLive();
          },
        }, icon('trash'));

        const delta = el('td', { class: 'col-delta num muted text-xs' }, '');
        const tr = el('tr', {},
          el('td', { class: 'col-num num' }, i + 1),
          el('td', { class: 'col-time' }, tInput),
          el('td', { class: 'col-val' }, vInput),
          delta,
          el('td', { class: 'col-act act' }, delBtn));
        refs[i] = { tr, t: tInput, v: vInput, delta };
        return tr;
      });

      const table = el('table', { class: 'curve-table w-full' },
        el('thead', {}, el('tr', {}, [
          el('th', { class: 'col-num' }, '#'),
          el('th', { class: 'col-time' }, 'Thời gian (ms)'),
          el('th', { class: 'col-val' }, 'Giá trị'),
          el('th', { class: 'col-delta' }, 'Δ so với mốc trước'),
          el('th', { class: 'col-act' }, ''),
        ])),
        el('tbody', {}, rows));

      ptsSlot.replaceChildren(table);
      curve.forEach((_, i) => paintRow(i));
    }

    renderPts();
    updateLive();

    // "Thêm mốc": the new point continues from the last one (extrapolated from previous points or step)
    const addBtn = el('button', {
      type: 'button',
      class: 'btn small',
      title: fire ? 'Thêm 1 mốc: các mốc chia đều trên thời gian bắn hết băng, hình dạng đường cong giữ nguyên' : 'Thêm 1 mốc dựa vào xu hướng các mốc trước đó (hoặc bước chuẩn)',
      onclick: () => {
        if (fire) {
          curve.splice(0, curve.length, ...RL.resample(curve, curve.length + 1, fire.emptyMs)); // one more point, the shape is kept, all points evenly spaced
        } else {
        const ext = RL.extendCurve(curve, 1, { method: 'trend', dir: rc.stepDir });
        if (ext.length > curve.length) {
          curve.push(ext[ext.length - 1]);
        } else {
          curve.push(RL.nextPoint(curve, Math.random, rc.stepDir));
        }
        }
        rc.dirty = true;
        renderPts();
        updateLive();
        const last = refs[refs.length - 1];
        if (last) last.t.focus();
      },
    }, icon('plus'), 'Thêm mốc');

    const retimeBtn = el('button', {
      type: 'button',
      class: 'btn small',
      disabled: !fire,
      title: fire ? `Chia đều các mốc trên thời gian bắn hết băng (${secondsText(fire.emptyMs)} s); hình dạng đường cong giữ nguyên, chưa ghi vào file` : 'Súng này chưa có thời gian bắn hết băng (Tiêu chuẩn súng)',
      onclick: () => {
        curve.splice(0, curve.length, ...RL.retime(curve, fire.emptyMs));
        rc.dirty = true;
        renderPts();
        updateLive();
        toast(`Đã chia đều ${curve.length} mốc trên ${secondsText(fire.emptyMs)} s. Bấm Lưu để ghi vào file.`);
      },
    }, icon('clock'), 'Chia đều thời gian theo băng đạn');

    const gunDisabled = RL.isGunDisabled(o.weapon);
    const batchAddPointsBtn = el('button', {
      type: 'button',
      class: 'btn small',
      disabled: zero || gunDisabled || !latest() || Boolean(rc.bulk),
      title: gunDisabled ? 'Súng này đã bị tắt trong Tiêu chuẩn súng' : 'Thêm mốc nối tiếp cho súng này ở tất cả tư thế và ống ngắm dựa vào dữ liệu mốc trước đó.',
      onclick: guard(() => showBatchAddPointsModal(ix)),
    }, icon('plus'), 'Thêm mốc cho súng');
    const retimeGunBtn = el('button', {
      type: 'button',
      class: 'btn small',
      disabled: zero || gunDisabled || !latest() || Boolean(rc.bulk) || !RL.fireOf(o.weapon),
      title: RL.fireOf(o.weapon) ? 'Chia đều thời gian của mọi mục riêng của súng này trên thời gian bắn hết băng (bản nháp, chưa ghi file).' : 'Súng này chưa có thời gian bắn hết băng (Tiêu chuẩn súng)',
      onclick: guard(() => showRetimeGunModal(ix)),
    }, icon('clock'), 'Chia đều thời gian cả súng');
    const suggestBtn = el('button', {
      type: 'button',
      class: 'btn small',
      disabled: !latest() || zero || gunDisabled,
      title: gunDisabled ? 'Súng này đã bị tắt trong Tiêu chuẩn súng' : 'Server tính từ các súng tương tự và AI tính song song; bạn so sánh rồi chọn một kết quả để điền vào bảng bên dưới (chưa lưu).',
      onclick: guard(() => suggestPoints(o)),
    }, icon('sparkles'), 'Tính mốc (server + AI)');

    const autoBox = el('label', { class: 'auto-step', title: `Khi sửa thời gian (hoặc giá trị) của một mốc, các mốc sau tự tính lại từ mốc đứng trước nó. ${stepHint()}` },
      el('input', { type: 'checkbox', checked: rc.autoStep, onchange: (e) => { rc.autoStep = e.target.checked; try { localStorage.setItem(AUTO_KEY, rc.autoStep ? 'on' : 'off'); } catch { /* private mode */ } } }),
      el('span', {}, 'Tự tính các mốc sau'));
    const dirBox = el('label', { class: 'auto-step', title: `Hướng của GIÁ TRỊ khi tự tính (thời gian luôn tăng). ${stepHint()}` },
      el('span', {}, 'Giá trị:'),
      el('select', { 'aria-label': 'Hướng của giá trị khi tự tính', class: 'text-xs', onchange: (e) => { rc.stepDir = RL.DIRECTIONS.includes(e.target.value) ? e.target.value : 'up'; try { localStorage.setItem(DIR_KEY, rc.stepDir); } catch { /* private mode */ } } },
        RL.DIRECTIONS.map((d) => el('option', { value: d, selected: d === rc.stepDir }, DIR_VN[d]))));

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

    // what the app does with this combination: an own entry, or the base curve times the coefficients
    const how = r.source === 'exact' ? 'App dùng đúng mục này.' : r.source === 'computed' ? 'Chưa có mục riêng: đường cong nền (đứng, không phụ kiện) × hệ số. Lưu để tạo mục riêng.' : '';
    const parts = r.multiplier != null ? (r.parts.length ? `${r.parts.map((p) => `${p.label} ${Number(p.value.toFixed(4))}`).join(' × ')} = ${r.multiplier.toFixed(4)}` : '1 (không có hệ số áp dụng)') : '';
    const more = menuButton([
      { label: 'Lịch sử & khôi phục', icon: 'history', onclick: openHistory },
      { label: 'Sao chép đường cong (JSON)', icon: 'copy', onclick: () => copyText(JSON.stringify(curve), 'Đã sao chép đường cong (JSON)') },
      ...(r.source === 'exact' ? [{ separator: true }, { label: 'Xóa mục riêng…', icon: 'trash', danger: true, onclick: guard(() => deleteRecoil(ix, o)) }] : []),
    ], { label: 'Thao tác khác' });

    return el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('h2', {}, el('span', { class: 'sr-only' }, `${RL.weaponLabel(o.weapon)} · ${POSTURE_VN[o.gesture]} · ${RL.LABELS.SCOPES[o.scope]} · `), `Tay cầm: ${optText('GRIPS', o.grip)} · Nòng: ${optText('MUZZLES', o.muzzle)} · Báng: ${optText('STOCKS', o.stock)}`),
        el('div', { class: 'head-actions' }, dirtyBadgeSlot, saveBtns[0], more)),
      el('div', { class: 'meta' }, sourceTag(r), summarySlot),
      zero ? null : fireSlot,
      r.copies > 1 ? alert('info', el('span', {}, `Có ${r.copies} mục trùng khóa (${r.distinct} nội dung khác nhau). App dùng mục xuất hiện cuối cùng.`)) : null,
      r.notes.length ? el('ul', { class: 'muted text-xs' }, r.notes.map((n) => el('li', {}, n))) : null,
      chartWrap,
      el('p', { class: 'muted text-xs chart-hint' }, fire ? 'Kéo một chấm lên xuống để đổi giá trị của mốc (thời gian chia đều trên băng đạn nên không kéo ngang). Chọn chấm bằng phím Tab rồi dùng mũi tên ↑ ↓ (giữ Shift: bước lớn).' : 'Kéo một chấm để đổi giá trị (lên xuống) và thời gian (ngang, giữa hai mốc bên cạnh). Chọn chấm bằng phím Tab rồi dùng mũi tên ↑ ↓ ← → (giữ Shift: bước lớn).'),
      el('h2', {}, 'Từng mốc'),
      ptsSlot,
      el('div', { class: 'row' }, addBtn, retimeBtn, batchAddPointsBtn, retimeGunBtn, suggestBtn, resetBtn),
      el('div', { class: 'row' }, saveBtns[1]),
      el('details', { class: 'disclosure' }, el('summary', {}, 'Tùy chọn khi sửa các mốc'),
        el('div', { class: 'disclosure-body' }, el('div', { class: 'row' }, autoBox, dirBox), el('p', { class: 'muted text-xs' }, fire ? `Thời gian các mốc chia đều trên ${secondsText(fire.emptyMs)} s (hết một băng); sửa thời gian một mốc thì các mốc sau chia đều từ mốc đó. ${stepHint()}` : stepHint()))),
      el('details', { class: 'disclosure' }, el('summary', {}, 'Cách tính và hệ số'),
        el('div', { class: 'disclosure-body' }, how ? el('p', { class: 'muted' }, how) : null, parts ? el('p', { class: 'mono' }, `Hệ số nhân: ${parts}`) : null,
          el('h2', {}, 'So sánh tư thế (cùng phụ kiện, ống ngắm)'), compare,
          el('h2', {}, `Hệ số của ${RL.weaponLabel(o.weapon)} / ${RL.LABELS.SCOPES[o.scope]}`), coefTable)));
  }

  async function refresh() { await load(); redraw({ smooth: true }); }

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
    async view() { active = true; aiStatusP = null; S.sel = null; await load(); return draw(); },
    leave() { active = false; if (lay.ro) { lay.ro.disconnect(); lay.ro = null; } stopSuggestions(); clearInterval(pollTimer); pollTimer = null; if (typeof lay !== 'undefined' && lay?.bg?.url) { URL.revokeObjectURL(lay.bg.url); lay.bg.url = null; } },
    discardOk,
  };
})();
