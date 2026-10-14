'use strict';
// The logic behind the Excel-like filter buttons of the tables: a list of values to tick (with how many rows have each), number bounds, sorting.
// Works in the browser (window.TableFilter) and in Node (tests). Nothing here touches the page.
//
// A filter is { values: Set<string> | null, min: number | null, max: number | null } for one column; "filters" maps column -> filter.
//   * values === null: every value is allowed; an EMPTY set hides every row (as when you untick everything in Excel);
//   * min / max are inclusive; a value that is not a number never passes a bound;
//   * the list of values of a column is built from the rows the OTHER columns' filters let through, like Excel.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TableFilter = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const isEmpty = (v) => v === null || v === undefined || v === '';

  // 5, '7', '7.5' -> a number; '', null, 'abc', NaN, Infinity -> null
  function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  function isActive(f) {
    return Boolean(f && (f.values || (f.min !== null && f.min !== undefined) || (f.max !== null && f.max !== undefined)));
  }

  function matches(value, f) {
    if (f.values && !f.values.has(isEmpty(value) ? '' : String(value))) return false;
    const hasMin = f.min !== null && f.min !== undefined;
    const hasMax = f.max !== null && f.max !== undefined;
    if (hasMin || hasMax) {
      const n = toNumber(value);
      if (n === null) return false;
      if (hasMin && n < f.min) return false;
      if (hasMax && n > f.max) return false;
    }
    return true;
  }

  // rows that pass every active filter (the column named in \`except\` is skipped). A new array; the rows are not changed.
  function applyFilters(rows, filters, valueOf, except = null) {
    const active = Object.entries(filters || {}).filter(([col, f]) => col !== except && isActive(f));
    if (!active.length) return rows.slice();
    return rows.filter((r) => active.every(([col, f]) => matches(valueOf(r, col), f)));
  }

  const rank = (v) => (isEmpty(v) ? 0 : toNumber(v) !== null ? 1 : 2);
  const compareValues = (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return toNumber(a) - toNumber(b);
    if (ra === 2) return String(a).localeCompare(String(b), 'vi', { numeric: true, sensitivity: 'accent' });
    return 0;
  };

  // [{ value, count }] of one column, in order (numbers by value, text in Vietnamese order, empty first)
  function distinct(rows, col, valueOf, filters) {
    const counts = new Map();
    for (const r of applyFilters(rows, filters, valueOf, col)) {
      const raw = valueOf(r, col);
      const value = isEmpty(raw) ? '' : raw;
      const key = String(value);
      const hit = counts.get(key);
      if (hit) hit.count++; else counts.set(key, { value, count: 1 });
    }
    return [...counts.values()].sort((a, b) => compareValues(a.value, b.value));
  }

  // sort = { col, dir: 'asc' | 'desc' } or null. Stable: rows with equal values keep their order, also when descending.
  function sortRows(rows, sort, valueOf) {
    const out = rows.slice();
    if (!sort || !sort.col) return out;
    const sign = sort.dir === 'desc' ? -1 : 1;
    return out
      .map((r, i) => ({ r, i, v: valueOf(r, sort.col) }))
      .sort((a, b) => sign * compareValues(a.v, b.v) || a.i - b.i)
      .map((x) => x.r);
  }

  const cleanFilters = (filters) => Object.fromEntries(Object.entries(filters || {}).filter(([, f]) => isActive(f)));
  const countActive = (filters) => Object.values(filters || {}).filter(isActive).length;

  // one line telling what is filtered, for a tooltip or a note above the table
  function describe(filters, labels = {}) {
    const parts = [];
    for (const [col, f] of Object.entries(filters || {})) {
      if (!isActive(f)) continue;
      const name = labels[col] || col;
      if (f.values) parts.push(`${name}: ${f.values.size ? `${f.values.size} giá trị` : 'không chọn gì (0 giá trị)'}`);
      const hasMin = f.min !== null && f.min !== undefined;
      const hasMax = f.max !== null && f.max !== undefined;
      if (hasMin && hasMax) parts.push(`${name}: ${f.min} ≤ … ≤ ${f.max}`);
      else if (hasMin) parts.push(`${name}: ≥ ${f.min}`);
      else if (hasMax) parts.push(`${name}: ≤ ${f.max}`);
    }
    return parts.join('; ');
  }

  return { toNumber, isActive, matches, applyFilters, distinct, sortRows, cleanFilters, countActive, describe };
});
