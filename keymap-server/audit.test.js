'use strict';
// Checking the entries of a dataset against the table of accessories, and deleting the surplus ones in one go.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./admin/recoil');

const W = (n) => R.WEAPONS.indexOf(n);
const X1 = R.SCOPES.indexOf('X1');
const X8 = R.SCOPES.indexOf('X8');
const G = (n) => R.GRIPS.indexOf(n);
const M = (n) => R.MUZZLES.indexOf(n);
const CUR = [[0, 10], [100, 8]];
const e = (scope, grip, muzzle, stock, gesture = 0) => ({ scope, grip, muzzle, stock, gesture, recoilValue: CUR });
function groups(guns) {
  const out = Array.from({ length: R.WEAPONS.length }, () => ({ v: [], coefficients: [] }));
  for (const [name, entries] of Object.entries(guns)) out[W(name)].v.push(...entries);
  return out;
}
const sample = () => groups({
  M249: [e(X1, 0, 0, 0), e(X1, G('THUMB'), 0, 0), e(X1, 0, M('COMPENSATOR'), 0), e(X1, 0, 0, 0, 1), e(X8, 0, 0, 0), e(X1, G('THUMB'), 0, 0)], // a copy of one key
  AUG: [e(X1, G('VERTICAL'), M('COMPENSATOR'), 0), e(X1, 0, 0, R.STOCKS.indexOf('GENERAL'))], // the second: AUG takes no stock
  M417: [e(X1, G('THUMB'), 0, 0)], // no rule for this gun in the table
});

test('auditEntries: lists the keys the table says cannot exist, with the reasons and how many copies there are', () => {
  const a = R.auditEntries(R.indexData(sample()));
  const m249 = a.filter((x) => x.weapon === W('M249'));
  assert.deepEqual(m249.map((x) => [x.scope, x.grip, x.muzzle, x.stock, x.gesture, x.copies]).sort(), [
    [X1, 0, M('COMPENSATOR'), 0, 0, 1], [X1, G('THUMB'), 0, 0, 0, 2], [X8, 0, 0, 0, 0, 1],
  ].sort());
  assert.deepEqual(m249.find((x) => x.scope === X8).problems.map((p) => p.slot), ['scope']);
  assert.deepEqual(m249.find((x) => x.grip === G('THUMB')).problems.map((p) => p.slot), ['grip']);
  assert.deepEqual(a.filter((x) => x.weapon === W('AUG')).map((x) => x.problems[0].slot), ['stock']);
  assert.equal(a.some((x) => x.weapon === W('M417')), false, 'a gun without a rule has nothing reported');
  assert.equal(a.length, 4); // 3 keys of the M249 and 1 of the AUG
  // gun order
  assert.deepEqual(a.map((x) => x.weapon), [...a.map((x) => x.weapon)].sort((p, q) => p - q));
});

test('auditEntries: nothing to report for data that follows the table', () => {
  assert.deepEqual(R.auditEntries(R.indexData(groups({ M249: [e(X1, 0, 0, 0)], AUG: [e(X1, G('VERTICAL'), M('COMPENSATOR'), 0)] }))), []);
});

test('removeEntries: every copy of every listed key goes, the rest stays, the document it was given is not changed', () => {
  const doc = { recoil_data: sample() };
  const before = JSON.stringify(doc);
  const bad = R.auditEntries(R.indexData(doc.recoil_data));
  const r = R.removeEntries(doc, 'raw', bad);
  assert.equal(JSON.stringify(doc), before);
  assert.equal(r.removed, 5); // 4 keys, one of them twice
  assert.equal(r.keys, 4);
  assert.equal(r.key, 'recoil_data');
  const left = R.indexData(r.doc.recoil_data);
  assert.deepEqual(R.auditEntries(left), []);
  assert.equal(left.map.size, 4); // M249 plain and prone, the AUG one that fits, the M417 one
  assert.ok(left.map.has([W('M249'), X1, 0, 0, 0, 0].join('|')), 'the plain M249 entry stays');
  assert.ok(left.map.has([W('M249'), X1, 0, 0, 0, 1].join('|')), 'and its other posture');
  assert.ok(left.map.has([W('M417'), X1, G('THUMB'), 0, 0, 0].join('|')), 'a gun without a rule is never touched');
});

test('removeEntries: only the chosen ones go (a gun, or a few entries), and a missing gun group is skipped', () => {
  const doc = { recoil_data: sample() };
  const m249Only = R.auditEntries(R.indexData(doc.recoil_data)).filter((x) => x.weapon === W('M249'));
  const r = R.removeEntries(doc, 'raw', m249Only);
  assert.equal(r.removed, 4);
  assert.equal(R.auditEntries(R.indexData(r.doc.recoil_data)).length, 1, 'the AUG stock entry is still there');
  assert.equal(R.removeEntries(doc, 'raw', [{ weapon: 999, scope: 0, grip: 0, muzzle: 0, stock: 0, gesture: 0 }]).removed, 0);
  assert.throws(() => R.removeEntries({}, 'raw', []), /recoil_data/);
});

test('removeEntries works on the dataset of the chosen mode', () => {
  const doc = { recoil_data: groups({ M249: [e(X1, G('THUMB'), 0, 0)] }), ft_recoil_mode_profiles: { normal_touch_recoil_data: groups({ M249: [e(X1, G('THUMB'), 0, 0), e(X1, 0, 0, 0)] }) } };
  const r = R.removeEntries(doc, 'touch', R.auditEntries(R.indexData(R.pickDataset(doc, 'touch').data)));
  assert.equal(r.key, 'normal_touch_recoil_data');
  assert.equal(r.removed, 1);
  assert.equal(r.doc.ft_recoil_mode_profiles.normal_touch_recoil_data[W('M249')].v.length, 1);
  assert.equal(r.doc.recoil_data[W('M249')].v.length, 1, 'the other datasets are not touched');
});

test('M249 stops at 6x: the 8x and the 4-8x scopes (also the tactical ones) are all reported, 3-6x and LPVO are not', () => {
  const m = W('M249');
  const names = ['X8', 'X84', 'tactic', 'tactic_84'];
  const keep = ['hippie', 'X1', 'X2', 'X3', 'X4', 'X6', 'X63', 'LPVO'];
  const data = groups({ M249: [...names, ...keep].map((n) => e(R.SCOPES.indexOf(n), 0, 0, 0)) });
  const a = R.auditEntries(R.indexData(data));
  assert.deepEqual(a.map((x) => R.SCOPES[x.scope]).sort(), [...names].sort());
  assert.ok(a.every((x) => x.weapon === m && x.problems[0].slot === 'scope'));
});

test('curveEditor: many combinations are set on ONE copy; the document it was given is not changed; errors are thrown like applyCurveEdit', () => {
  const doc = { recoil_data: groups({ AUG: [e(X1, 0, 0, 0)] }) };
  const before = JSON.stringify(doc);
  const ed = R.curveEditor(doc, 'raw');
  const a = ed.apply({ weapon: W('AUG'), scope: X1, gesture: 0, grip: G('VERTICAL'), muzzle: 0, stock: 0 }, [[0, 5], [100, 4]]);
  const b = ed.apply({ weapon: W('AUG'), scope: X1, gesture: 0, grip: 0, muzzle: 0, stock: 0 }, [[0, 9], [100, 8]]); // already there: changed
  assert.deepEqual([a.created, a.copies, b.created, b.copies], [true, 0, false, 1]);
  assert.equal(JSON.stringify(doc), before);
  assert.equal(ed.doc.recoil_data[W('AUG')].v.length, 2);
  assert.deepEqual(ed.doc.recoil_data[W('AUG')].v[0].recoilValue, [[0, 9], [100, 8]]);
  assert.throws(() => ed.apply({ weapon: W('AUG'), scope: X1, gesture: 0, grip: 0, muzzle: 0, stock: R.STOCKS.indexOf('GENERAL') }, [[0, 1]]), /báng/); // AUG takes no stock
  assert.throws(() => ed.apply({ weapon: W('AUG'), scope: X1, gesture: 0, grip: 0, muzzle: 0, stock: 0 }, [[0, NaN]]), /hữu hạn/);
  // the one-combination form gives the same result as before
  const one = R.applyCurveEdit(doc, 'raw', { weapon: W('AUG'), scope: X1, gesture: 0, grip: G('VERTICAL'), muzzle: 0, stock: 0 }, [[0, 5], [100, 4]]);
  assert.deepEqual([one.created, one.copies, one.key], [true, 0, 'recoil_data']);
});
