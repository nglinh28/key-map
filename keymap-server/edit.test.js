'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./admin/edit');

test('formatPath writes identifiers with dots and other keys in brackets', () => {
  assert.equal(E.formatPath([]), '$');
  assert.equal(E.formatPath(['a', 'b', 3, 'odd key', 'x-y']), '$.a.b[3]["odd key"]["x-y"]');
  assert.equal(E.childPath('$.a', 0), '$.a[0]');
  assert.equal(E.childPath('$', 'k'), '$.k');
});

test('diff: added, removed and changed values with their paths', () => {
  const a = { keep: 1, gone: 2, chg: { x: [1, 2, 3] }, arr: [1, 2] };
  const b = { keep: 1, chg: { x: [1, 9] }, arr: [1, 2, 3], added: 'n' };
  const d = E.diff(a, b);
  assert.equal(d.total, 5);
  assert.deepEqual(d.changes.map((c) => [c.kind, c.path]).sort(), [['added', '$.added'], ['added', '$.arr[2]'], ['changed', '$.chg.x[1]'], ['removed', '$.chg.x[2]'], ['removed', '$.gone']].sort());
  assert.deepEqual(E.diff(a, a), { total: 0, changes: [], truncated: false });
  assert.equal(E.diff(1, 2).changes[0].path, '$');
  assert.equal(E.diff([], {}).total, 1, 'an array and an object are different values');
});

test('diff: stops listing after the limit but keeps counting', () => {
  const a = Array.from({ length: 50 }, (_, i) => i);
  const b = a.map((v) => v + 1);
  const d = E.diff(a, b, { limit: 10 });
  assert.deepEqual([d.total, d.changes.length, d.truncated], [50, 10, true]);
});
