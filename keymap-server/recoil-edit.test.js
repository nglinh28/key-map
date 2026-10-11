'use strict';
// Applying the edits made in the "Phân tích độ giật" tab back into a recoil/config document.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('./admin/recoil');
const E = require('./admin/edit');

const W = (n) => R.WEAPONS.indexOf(n);
const S = (n) => R.SCOPES.indexOf(n);
const G = (n) => R.GRIPS.indexOf(n);
const M = (n) => R.MUZZLES.indexOf(n);
const K = (n) => R.STOCKS.indexOf(n);
const P = (n) => R.POSTURES.indexOf(n);
const AUG = W('AUG');

const COEF = {
  compensatorMuzzle: 0.9, flashHidderMuzzle: 0.8, suppressorMuzzle: 0.95, verticalGrip: 0.85, horizontalGrip: 0.97, halfGrip: 0.93,
  lightGrip: 0.98, thumbGrip: 0.8, laserGrip: 0.99, generalStock: 0.9, crouch: 0.8, prone: 0.6, stand: 1,
};
const entry = (grip, muzzle, stock, scope, gesture, recoilValue) => ({ grip, muzzle, stock, scope, gesture, recoilValue });
const dataset = (fill) => {
  const groups = Array.from({ length: 70 }, () => ({ v: [], coefficients: Array.from({ length: 13 }, () => ({ ...COEF })) }));
  fill(groups);
  return groups;
};
const combo = (o = {}) => ({ weapon: AUG, scope: S('X1'), grip: 0, muzzle: 0, stock: 0, gesture: 0, ...o });
const docWith = (fill) => ({ recoil_value_coefficient: 100, recoil_data: dataset(fill) });
const resolveIn = (data, c) => R.resolve(R.indexData(data), c);

test('edit an exact entry: only the LAST duplicate (the one the app uses) changes', () => {
  const doc = docWith((g) => {
    g[AUG].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 70]]));
    g[AUG].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 71]]));
    g[AUG].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 72]]));
  });
  const before = JSON.stringify(doc);
  const c = combo({ grip: G('THUMB'), muzzle: M('COMPENSATOR') });
  const out = R.applyRecoilEdits(doc, { mode: 'raw', curves: [{ combo: c, curve: [[0, 99], [200, 105]] }], coefs: [], mirror: false });
  assert.equal(JSON.stringify(doc), before, 'input untouched');
  assert.deepEqual(out.next.recoil_data[AUG].v.map((e) => e.recoilValue), [[[0, 70]], [[0, 71]], [[0, 99], [200, 105]]]);
  assert.equal(out.created, 0);
  assert.deepEqual(resolveIn(out.next.recoil_data, c).curve, [[0, 99], [200, 105]]);
});

test('editing a combination that has no entry creates one (grip, scope, muzzle, stock, gesture, recoilValue)', () => {
  const doc = docWith((g) => { g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 100]])); });
  const c = combo({ grip: G('THUMB'), muzzle: M('COMPENSATOR'), gesture: P('PRONE') });
  assert.equal(resolveIn(doc.recoil_data, c).source, 'computed');
  const out = R.applyRecoilEdits(doc, { mode: 'raw', curves: [{ combo: c, curve: [[0, 50], [300, 55]] }], coefs: [], mirror: false });
  assert.equal(out.created, 1);
  const added = out.next.recoil_data[AUG].v[1];
  assert.deepEqual(Object.keys(added), ['grip', 'scope', 'muzzle', 'stock', 'gesture', 'recoilValue']);
  assert.deepEqual([added.grip, added.scope, added.muzzle, added.stock, added.gesture], [G('THUMB'), S('X1'), M('COMPENSATOR'), 0, P('PRONE')]);
  const r = resolveIn(out.next.recoil_data, c);
  assert.equal(r.source, 'exact');
  assert.deepEqual(r.curve, [[0, 50], [300, 55]]);
});

test('editing a coefficient changes every computed combination that uses it, and grows a short list like the app does', () => {
  const doc = docWith((g) => { g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 100]])); });
  const c = combo({ muzzle: M('COMPENSATOR') });
  const out = R.applyRecoilEdits(doc, { mode: 'raw', curves: [], coefs: [{ weapon: AUG, scope: S('X1'), name: 'compensatorMuzzle', value: 0.5 }], mirror: false });
  assert.equal(resolveIn(out.next.recoil_data, c).curve[0][1], 50);
  assert.equal(doc.recoil_data[AUG].coefficients[S('X1')].compensatorMuzzle, 0.9, 'input untouched');
  const short = docWith(() => {});
  short.recoil_data[AUG].coefficients = [{ ...COEF }];
  const grown = R.applyRecoilEdits(short, { mode: 'raw', curves: [], coefs: [{ weapon: AUG, scope: S('X4'), name: 'crouch', value: 0.7 }], mirror: false });
  assert.equal(grown.next.recoil_data[AUG].coefficients.length, S('X4') + 1);
  assert.equal(grown.next.recoil_data[AUG].coefficients[S('X4')].crouch, 0.7);
  assert.equal(grown.next.recoil_data[AUG].coefficients[S('X4')].prone, 0.6, 'new entries start as copies of the first');
});

test('the edit goes to the dataset of the chosen mode and is mirrored into recoil_data only when they were identical', () => {
  const groups = () => dataset((g) => { g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 100]])); });
  const doc = {
    recoil_data: groups(),
    ft_recoil_mode_profiles: { schema_version: 1, normal_touch_recoil_data: groups(), gyro_recoil_data: dataset((g) => { g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 60]])); }) },
  };
  const edit = { curves: [{ combo: combo(), curve: [[0, 123]] }], coefs: [] };
  const val = (d, mode) => resolveIn(R.pickDataset(d, mode).data, combo()).curve[0][1];

  const touch = R.applyRecoilEdits(doc, { mode: 'touch', mirror: true, ...edit });
  assert.deepEqual([touch.primary, touch.mirrored], ['normal_touch_recoil_data', ['recoil_data']]);
  assert.deepEqual([val(touch.next, 'touch'), val(touch.next, 'raw'), val(touch.next, 'gyro')], [123, 123, 60], 'gyro differs, so it is left alone');

  const noMirror = R.applyRecoilEdits(doc, { mode: 'touch', mirror: false, ...edit });
  assert.deepEqual([val(noMirror.next, 'touch'), val(noMirror.next, 'raw')], [123, 100]);
  assert.deepEqual(noMirror.mirrored, []);

  const gyro = R.applyRecoilEdits(doc, { mode: 'gyro', mirror: true, ...edit });
  assert.deepEqual(gyro.mirrored, [], 'gyro differs from everything else');
  assert.deepEqual([val(gyro.next, 'gyro'), val(gyro.next, 'touch')], [123, 100]);

  const plain = R.applyRecoilEdits({ recoil_data: groups() }, { mode: 'touch', mirror: true, ...edit });
  assert.equal(plain.primary, 'recoil_data', 'without the mode block the app copies recoil_data into both modes');
});

test('mirrorTargets tells which other datasets are identical to the one being edited', () => {
  const groups = () => dataset((g) => { g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 100]])); });
  const doc = { recoil_data: groups(), ft_recoil_mode_profiles: { normal_touch_recoil_data: groups(), gyro_recoil_data: dataset(() => {}) } };
  assert.deepEqual(R.mirrorTargets(doc, 'touch'), ['recoil_data']);
  assert.deepEqual(R.mirrorTargets(doc, 'raw'), ['normal_touch_recoil_data']);
  assert.deepEqual(R.mirrorTargets(doc, 'gyro'), []);
  assert.deepEqual(R.mirrorTargets({ recoil_data: groups() }, 'touch'), []);
  assert.deepEqual(R.mirrorTargets({}, 'touch'), []);
});

test('invalid edits are refused', () => {
  const doc = docWith(() => {});
  const bad = (curve) => () => R.applyRecoilEdits(doc, { mode: 'raw', curves: [{ combo: combo(), curve }], coefs: [], mirror: false });
  assert.throws(bad([]), /không hợp lệ/);
  assert.throws(bad([[0, 'x']]), /không hợp lệ/);
  assert.throws(bad([[-5, 1]]), /không hợp lệ/);
  assert.throws(bad([[NaN, 1]]), /không hợp lệ/);
  assert.throws(() => R.applyRecoilEdits(doc, { mode: 'raw', curves: [{ combo: combo({ weapon: 99 }), curve: [[0, 1]] }], coefs: [], mirror: false }), /không tồn tại/);
  assert.throws(() => R.applyRecoilEdits({}, { mode: 'raw', curves: [], coefs: [], mirror: false }), /recoil_data/);
  assert.throws(() => R.applyRecoilEdits(doc, { mode: 'raw', curves: [], coefs: [{ weapon: AUG, scope: 1, name: 'crouch', value: 'x' }], mirror: false }), /không hợp lệ/);
});

test('curveDiff lists changed, added and removed points', () => {
  const a = [[0, 10], [100, 20], [200, 30]];
  assert.deepEqual(R.curveDiff(a, a), []);
  assert.deepEqual(R.curveDiff(a, [[0, 10], [100, 25], [200, 30]]), [{ kind: 'changed', index: 1, before: [100, 20], after: [100, 25] }]);
  assert.deepEqual(R.curveDiff(a, [[0, 10]]).map((d) => [d.kind, d.index]), [['removed', 1], ['removed', 2]]);
  assert.deepEqual(R.curveDiff([[0, 1]], [[0, 1], [50, 2]]), [{ kind: 'added', index: 1, after: [50, 2] }]);
});

test('comboKey matches the key the index uses', () => {
  const idx = R.indexData(dataset((g) => { g[AUG].v.push(entry(G('THUMB'), M('FLASH_HIDER'), K('GENERAL'), S('X3'), P('CROUCH'), [[0, 5]])); }));
  const c = combo({ grip: G('THUMB'), muzzle: M('FLASH_HIDER'), stock: K('GENERAL'), scope: S('X3'), gesture: P('CROUCH') });
  assert.ok(idx.map.has(R.comboKey(c)));
});

const REAL = path.join(__dirname, '..', 'keymap_analysis', 'raw', 'map%7Ca83e86a5d225446abb635d68c940192a.json');

test('real file: editing one AUG point changes exactly that point (and its recoil_data mirror), nothing else', (t) => {
  if (!fs.existsSync(REAL)) return t.skip('backup file not available');
  const doc = JSON.parse(fs.readFileSync(REAL, 'utf8'));
  const c = combo({ scope: S('X3'), grip: G('HORIZONTAL'), muzzle: M('COMPENSATOR') });
  const cur = resolveIn(R.pickDataset(doc, 'touch').data, c).curve;
  const edited = cur.map((p) => [...p]);
  edited[3][1] = 999;
  const out = R.applyRecoilEdits(doc, { mode: 'touch', curves: [{ combo: c, curve: edited }], coefs: [], mirror: true });
  assert.deepEqual(out.mirrored, ['recoil_data']);
  assert.equal(E.diff(doc, out.next).total, 2, 'one point in the touch dataset + the same point in recoil_data');
  assert.deepEqual(out.next.ft_recoil_mode_profiles.gyro_recoil_data, doc.ft_recoil_mode_profiles.gyro_recoil_data);
  assert.equal(resolveIn(R.pickDataset(out.next, 'touch').data, c).curve[3][1], 999);
});
