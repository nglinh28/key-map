'use strict';
// The logic behind the Excel-like filter buttons of the tables: value lists with counts, number ranges, sorting.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./admin/tablefilter');

const ROWS = [
  { id: 1, grip: 'Tay cầm đứng', muzzle: 'Nòng hãm giật', source: 'Có mục riêng', v0: 85.71, points: 11 },
  { id: 2, grip: 'Tay cầm đứng', muzzle: 'không', source: 'Tính từ hệ số', v0: 77.14, points: 11 },
  { id: 3, grip: 'không', muzzle: 'Nòng hãm giật', source: 'Có mục riêng', v0: 90.4, points: 5 },
  { id: 4, grip: 'Tay cầm nhẹ', muzzle: 'Nòng ẩn tia lửa', source: 'Có mục riêng', v0: 64.8, points: 3 },
  { id: 5, grip: 'không', muzzle: 'không', source: 'Tính từ hệ số', v0: 58.32, points: 11 },
];
const valueOf = (r, col) => r[col];
const ids = (rows) => rows.map((r) => r.id);

test('isActive: a filter counts only when it restricts something', () => {
  assert.equal(T.isActive(undefined), false);
  assert.equal(T.isActive({ values: null, min: null, max: null }), false);
  assert.equal(T.isActive({ values: new Set(['a']) }), true);
  assert.equal(T.isActive({ values: new Set() }), true, 'nothing ticked is a filter too: it hides every row, as in Excel');
  assert.equal(T.isActive({ min: 0 }), true);
  assert.equal(T.isActive({ max: 0 }), true);
});

test('applyFilters: ticked values, number bounds, and all columns together (AND)', () => {
  assert.deepEqual(ids(T.applyFilters(ROWS, {}, valueOf)), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids(T.applyFilters(ROWS, { grip: { values: new Set(['không']) } }, valueOf)), [3, 5]);
  assert.deepEqual(ids(T.applyFilters(ROWS, { grip: { values: new Set(['không', 'Tay cầm nhẹ']) } }, valueOf)), [3, 4, 5]);
  assert.deepEqual(ids(T.applyFilters(ROWS, { grip: { values: new Set(['không']) }, source: { values: new Set(['Có mục riêng']) } }, valueOf)), [3]);
  assert.deepEqual(ids(T.applyFilters(ROWS, { v0: { min: 77.14 } }, valueOf)), [1, 2, 3], 'bounds are inclusive');
  assert.deepEqual(ids(T.applyFilters(ROWS, { v0: { max: 64.8 } }, valueOf)), [4, 5]);
  assert.deepEqual(ids(T.applyFilters(ROWS, { v0: { min: 60, max: 80 } }, valueOf)), [2, 4]);
  assert.deepEqual(ids(T.applyFilters(ROWS, { points: { values: new Set(['11']) } }, valueOf)), [1, 2, 5], 'numbers are ticked by their text');
  assert.deepEqual(ids(T.applyFilters(ROWS, { grip: { values: new Set() } }, valueOf)), [], 'nothing ticked hides everything');
  assert.deepEqual(ids(T.applyFilters(ROWS, { grip: { values: null, min: null, max: null } }, valueOf)), [1, 2, 3, 4, 5], 'an empty filter does nothing');
  assert.deepEqual(ids(T.applyFilters(ROWS, { v0: { min: 0 }, nope: { values: new Set(['x']) } }, (r, c) => (c === 'nope' ? undefined : r[c]))), [], 'a value that is missing never matches a filter');
});

test('applyFilters: a text where a number is expected never passes a bound; and the input rows are not changed', () => {
  const rows = [{ id: 1, n: 5 }, { id: 2, n: 'abc' }, { id: 3, n: null }, { id: 4, n: NaN }, { id: 5, n: '7' }];
  assert.deepEqual(ids(T.applyFilters(rows, { n: { min: 0 } }, valueOf)), [1, 5], 'numeric text is a number, the rest is not');
  const before = JSON.stringify(ROWS);
  T.applyFilters(ROWS, { grip: { values: new Set(['không']) } }, valueOf);
  assert.equal(JSON.stringify(ROWS), before);
});

test('applyFilters: "except" leaves one column out (the list of that column is shown without its own filter)', () => {
  const f = { grip: { values: new Set(['không']) }, source: { values: new Set(['Có mục riêng']) } };
  assert.deepEqual(ids(T.applyFilters(ROWS, f, valueOf, 'grip')), [1, 3, 4]);
  assert.deepEqual(ids(T.applyFilters(ROWS, f, valueOf, 'source')), [3, 5]);
});

test('distinct: the values of a column with how many rows have each, counted among the rows the OTHER filters let through', () => {
  assert.deepEqual(T.distinct(ROWS, 'grip', valueOf, {}), [{ value: 'không', count: 2 }, { value: 'Tay cầm đứng', count: 2 }, { value: 'Tay cầm nhẹ', count: 1 }]);
  // filtering "source" shrinks the counts of "grip", but filtering "grip" itself does not shrink its own list
  const f = { source: { values: new Set(['Có mục riêng']) }, grip: { values: new Set(['không']) } };
  assert.deepEqual(T.distinct(ROWS, 'grip', valueOf, f), [{ value: 'không', count: 1 }, { value: 'Tay cầm đứng', count: 1 }, { value: 'Tay cầm nhẹ', count: 1 }]);
  assert.deepEqual(T.distinct(ROWS, 'points', valueOf, {}), [{ value: 3, count: 1 }, { value: 5, count: 1 }, { value: 11, count: 3 }], 'numbers are listed in numeric order');
  assert.deepEqual(T.distinct([], 'grip', valueOf, {}), []);
  assert.deepEqual(T.distinct([{ x: null }, { x: undefined }, { x: '' }], 'x', (r, c) => r[c], {}), [{ value: '', count: 3 }], 'empty values are listed as one empty entry');
});

test('sortRows: ascending or descending, numbers by value, text in Vietnamese order, stable, and no sort leaves the order', () => {
  assert.deepEqual(ids(T.sortRows(ROWS, null, valueOf)), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids(T.sortRows(ROWS, { col: 'v0', dir: 'asc' }, valueOf)), [5, 4, 2, 1, 3]);
  assert.deepEqual(ids(T.sortRows(ROWS, { col: 'v0', dir: 'desc' }, valueOf)), [3, 1, 2, 4, 5]);
  assert.deepEqual(ids(T.sortRows(ROWS, { col: 'points', dir: 'asc' }, valueOf)), [4, 3, 1, 2, 5], 'equal values keep their order');
  assert.deepEqual(ids(T.sortRows(ROWS, { col: 'points', dir: 'desc' }, valueOf)), [1, 2, 5, 3, 4], 'also in descending order');
  assert.deepEqual(ids(T.sortRows(ROWS, { col: 'grip', dir: 'asc' }, valueOf)), [3, 5, 1, 2, 4], 'không, đứng, nhẹ: đ comes before n');
  const rows = [{ id: 1, v: 'Ê' }, { id: 2, v: 'E' }, { id: 3, v: 'Đ' }, { id: 4, v: 'D' }, { id: 5, v: 'A' }];
  assert.deepEqual(ids(T.sortRows(rows, { col: 'v', dir: 'asc' }, valueOf)), [5, 4, 3, 2, 1], 'A D Đ E Ê');
  assert.deepEqual(ids(T.sortRows([{ id: 1, v: 10 }, { id: 2, v: 9 }, { id: 3, v: 'x' }, { id: 4, v: null }], { col: 'v', dir: 'asc' }, valueOf)), [4, 2, 1, 3], 'empty first, then numbers, then text');
  const before = ROWS.map((r) => r.id).join();
  T.sortRows(ROWS, { col: 'v0', dir: 'asc' }, valueOf);
  assert.equal(ROWS.map((r) => r.id).join(), before, 'a new array is returned');
});

test('cleanFilters, countActive and describe', () => {
  const f = { a: { values: null, min: null, max: null }, b: { values: new Set(['x', 'y']) }, c: { min: 5, max: null }, d: { values: new Set(), min: 1, max: 2 } };
  assert.deepEqual(Object.keys(T.cleanFilters(f)), ['b', 'c', 'd']);
  assert.equal(T.countActive(f), 3);
  assert.equal(T.countActive({}), 0);
  const text = T.describe(f, { a: 'A', b: 'B', c: 'C', d: 'D' });
  assert.match(text, /B: 2 giá trị/);
  assert.match(text, /C: ≥ 5/);
  assert.match(text, /D: 1 ≤ … ≤ 2/);
  assert.match(text, /không chọn gì|0 giá trị/);
  assert.equal(T.describe({}, {}), '');
});

test('numeric: reads "85,71 ms" style text and plain numbers; anything else is not a number', () => {
  assert.equal(T.toNumber(5), 5);
  assert.equal(T.toNumber('7'), 7);
  assert.equal(T.toNumber('7.5'), 7.5);
  assert.equal(T.toNumber(''), null);
  assert.equal(T.toNumber(null), null);
  assert.equal(T.toNumber('abc'), null);
  assert.equal(T.toNumber(NaN), null);
  assert.equal(T.toNumber(Infinity), null);
});
