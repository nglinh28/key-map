'use strict';
// The funnel button in a column header and the Excel-like box it opens: sort, number range, search, a list of values to tick (with counts).
// The logic is in tablefilter.js. The table owns the state ({ filters, sort }) and draws itself again in onChange; the box is applied with OK
// (so the page is drawn once), and closes with Esc, Cancel, or a click outside.
(() => {
  const { el, icon } = window.Ui;
  const TF = window.TableFilter;

  // for searching in the list: no accents, đ = d
  const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

  let current = null; // { close }

  function closeCurrent() { if (current) current.close(); }

  function open(anchor, cfg) {
    closeCurrent();
    const { label, col, numeric, checklist, rows, valueOf, filters, sort, onChange } = cfg;
    const f = filters[col] || {};
    const all = checklist ? TF.distinct(rows, col, valueOf, filters) : [];
    const draft = { sel: new Set(f.values ? [...f.values] : all.map((x) => String(x.value))), q: '' };

    // ---- sort
    const dirOf = sort && sort.col === col ? sort.dir : null;
    const sortBtn = (dir, text) => el('button', {
      type: 'button', class: `btn small${dirOf === dir ? ' primary' : ''}`, 'aria-pressed': String(dirOf === dir),
      onclick: () => { close(); onChange({ filters, sort: dirOf === dir ? null : { col, dir } }); },
    }, icon(dir === 'asc' ? 'arrowUp' : 'arrowDown'), text);
    const sortRow = el('div', { class: 'fp-row' }, sortBtn('asc', numeric ? 'Nhỏ → lớn' : 'A → Z'), sortBtn('desc', numeric ? 'Lớn → nhỏ' : 'Z → A'));

    // ---- number range
    const num = (value, aria) => el('input', { type: 'number', step: 'any', value: value === null || value === undefined ? '' : String(value), 'aria-label': aria, class: 'fp-num' });
    const minIn = numeric ? num(f.min, `${label}: từ`) : null;
    const maxIn = numeric ? num(f.max, `${label}: đến`) : null;
    const rangeRow = numeric ? el('div', { class: 'fp-row fp-range' }, el('span', {}, 'Từ'), minIn, el('span', {}, 'đến'), maxIn) : null;

    // ---- list of values
    const search = checklist ? el('input', { type: 'search', placeholder: 'Tìm trong danh sách…', 'aria-label': `Tìm giá trị của cột ${label}`, class: 'fp-search', oninput: (e) => { draft.q = e.target.value; drawList(); } }) : null;
    const listBox = el('div', { class: 'fp-list', role: 'group', 'aria-label': `Giá trị của cột ${label}` });
    const selectAll = el('input', { type: 'checkbox', id: 'fp-all' });
    const visible = () => all.filter((x) => !draft.q || fold(x.value === '' ? '(trống)' : x.value).includes(fold(draft.q)));
    function drawList() {
      const vis = visible();
      const on = vis.filter((x) => draft.sel.has(String(x.value))).length;
      selectAll.checked = vis.length > 0 && on === vis.length;
      selectAll.indeterminate = on > 0 && on < vis.length;
      selectAll.onchange = () => { for (const x of visible()) { if (selectAll.checked) draft.sel.add(String(x.value)); else draft.sel.delete(String(x.value)); } drawList(); };
      listBox.replaceChildren(
        el('label', { class: 'fp-item fp-all' }, selectAll, el('span', {}, draft.q ? '(Chọn tất cả kết quả tìm)' : '(Chọn tất cả)')),
        ...vis.map((x) => {
          const key = String(x.value);
          const box = el('input', { type: 'checkbox', checked: draft.sel.has(key), onchange: (e) => { if (e.target.checked) draft.sel.add(key); else draft.sel.delete(key); drawList(); } });
          return el('label', { class: 'fp-item' }, box, el('span', { class: 'fp-val' }, x.value === '' ? '(Trống)' : String(x.value)), el('span', { class: 'fp-count' }, x.count));
        }),
        ...(vis.length ? [] : [el('div', { class: 'muted text-xs fp-none' }, 'Không có giá trị nào khớp.')]));
    }
    if (checklist) drawList();

    // ---- footer
    function apply() {
      let values = null;
      if (checklist) {
        const keys = all.map((x) => String(x.value));
        values = keys.every((k) => draft.sel.has(k)) ? null : new Set(keys.filter((k) => draft.sel.has(k)));
      }
      const nf = { values, min: numeric ? TF.toNumber(minIn.value) : null, max: numeric ? TF.toNumber(maxIn.value) : null };
      const next = { ...filters };
      if (TF.isActive(nf)) next[col] = nf; else delete next[col];
      close();
      onChange({ filters: next, sort });
    }
    const clearBtn = el('button', { type: 'button', class: 'btn small', disabled: !TF.isActive(filters[col]), onclick: () => { const next = { ...filters }; delete next[col]; close(); onChange({ filters: next, sort }); } }, 'Xóa bộ lọc');
    const footer = el('div', { class: 'fp-row fp-foot' }, clearBtn, el('span', { class: 'fp-spacer' }), el('button', { type: 'button', class: 'btn small', onclick: () => close() }, 'Hủy'), el('button', { type: 'button', class: 'btn small primary', onclick: apply }, 'OK'));

    const pop = el('div', { class: 'filter-pop', role: 'dialog', 'aria-label': `Lọc và sắp xếp cột ${label}` },
      el('div', { class: 'fp-title' }, label), sortRow, rangeRow, search, checklist ? listBox : null, footer);
    document.body.append(pop);
    anchor.setAttribute('aria-expanded', 'true');

    // placed under the button, kept inside the window
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      const top = r.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4;
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    };
    place();

    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); }
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); apply(); }
    };
    const onDown = (e) => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
    // the page or the table moving takes the box away from its button: close it. Scrolling INSIDE the box (a long list of values, like the
    // 67 guns of "Tiêu chuẩn súng") must not: the capturing listener sees that scroll too.
    const onMove = (e) => { if (e && e.type === 'scroll' && e.target instanceof Node && pop.contains(e.target)) return; close(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    function close() {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      pop.remove();
      anchor.setAttribute('aria-expanded', 'false');
      if (current && current.pop === pop) current = null;
    }
    current = { close, pop };
    (search || minIn || pop.querySelector('button')).focus();
  }

  // The content of a <th>: the label, a ▲/▼ when the table is sorted by this column, and the funnel button.
  function header({ label, col, numeric = false, checklist = true, rows, valueOf, filters, sort, onChange }) {
    const active = TF.isActive(filters[col]);
    const dir = sort && sort.col === col ? sort.dir : null;
    const btn = el('button', {
      type: 'button', class: `col-filter${active ? ' active' : ''}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      'aria-label': `Lọc và sắp xếp cột ${label}${active ? ' (đang lọc)' : ''}`, title: active ? `Đang lọc: ${TF.describe({ [col]: filters[col] }, { [col]: label })}` : `Lọc và sắp xếp cột ${label}`,
      onclick: (e) => { e.stopPropagation(); open(btn, { label, col, numeric, checklist, rows, valueOf, filters, sort, onChange }); },
    }, icon('filter'));
    return el('div', { class: 'th-filter' }, el('span', {}, label), dir ? el('span', { class: 'sort-mark', 'aria-hidden': 'true' }, dir === 'asc' ? '▲' : '▼') : null, btn);
  }

  const ariaSort = (sort, col) => (sort && sort.col === col ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none');

  window.FilterUi = { header, ariaSort, closeAll: closeCurrent };
})();
