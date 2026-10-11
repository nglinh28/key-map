'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('./admin/recoil');

const W = (name) => R.WEAPONS.indexOf(name);
const S = (name) => R.SCOPES.indexOf(name);
const G = (name) => R.GRIPS.indexOf(name);
const M = (name) => R.MUZZLES.indexOf(name);
const K = (name) => R.STOCKS.indexOf(name);
const P = (name) => R.POSTURES.indexOf(name);

const entry = (grip, muzzle, stock, scope, gesture, recoilValue) => ({ grip, muzzle, stock, scope, gesture, recoilValue });
const COEF = {
  compensatorMuzzle: 0.9, flashHidderMuzzle: 0.8, suppressorMuzzle: 0.95,
  verticalGrip: 0.85, horizontalGrip: 0.97, halfGrip: 0.93, lightGrip: 0.98, thumbGrip: 0.8, laserGrip: 0.99,
  generalStock: 0.9, crouch: 0.8, prone: 0.6, stand: 1,
};
// 70 groups like the real file; only the ones a test cares about carry data
function dataset(fill) {
  const groups = Array.from({ length: 70 }, () => ({ v: [], coefficients: Array.from({ length: 13 }, () => ({ ...COEF })) }));
  fill(groups);
  return groups;
}
const AUG = W('AUG');
const resolve = (idx, o) => R.resolve(idx, { weapon: AUG, scope: S('X1'), grip: 0, muzzle: 0, stock: 0, gesture: 0, ...o });

test('enum tables match C8712c.java when the decompiled source is next to the server', (t) => {
  const file = path.join(__dirname, '..', 'java_src', 'com', 'zjx', 'jyandroid', 'Extensions', 'pubg', 'C8712c.java');
  if (!fs.existsSync(file)) return t.skip('java_src not available');
  const java = fs.readFileSync(file, 'utf8');
  const en = (n) => {
    const m = /public enum (\w+) \{(.*?)\n    \}/gs;
    for (let x = m.exec(java); x; x = m.exec(java)) if (x[1] === n) return x[2].split(',').map((s) => s.trim()).filter(Boolean);
    throw new Error(`enum ${n} not found`);
  };
  assert.deepEqual(R.WEAPONS, en('l'));
  assert.deepEqual(R.SCOPES, en('g'));
  assert.deepEqual(R.GRIPS, en('c'));
  assert.deepEqual(R.MUZZLES, en('d'));
  assert.deepEqual(R.STOCKS, en('h'));
  assert.deepEqual(R.POSTURES, en('b'));
});

test('an exact entry is used as-is, and the LAST duplicate of a key wins (HashMap.put in the app)', () => {
  const idx = R.indexData(dataset((g) => {
    g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 100]]));
    g[AUG].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 70], [200, 75]]));
    g[AUG].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 71]])); // duplicate key, different content
    g[AUG].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 72]])); // last one wins
  }));
  const r = resolve(idx, { grip: G('THUMB'), muzzle: M('COMPENSATOR') });
  assert.equal(r.source, 'exact');
  assert.deepEqual(r.curve, [[0, 72]]);
  assert.deepEqual([r.copies, r.distinct], [3, 3]);
  assert.equal(resolve(idx, {}).copies, 1);
});

test('without an exact entry the value is the bare standing curve times the product of the coefficients', () => {
  const idx = R.indexData(dataset((g) => { g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 100], [100, 110]])); }));
  const r = resolve(idx, { grip: G('THUMB'), muzzle: M('COMPENSATOR') });
  assert.equal(r.source, 'computed');
  assert.ok(Math.abs(r.multiplier - 0.8 * 0.9) < 1e-9);
  assert.deepEqual(r.curve.map((p) => p[0]), [0, 100], 'times are untouched');
  assert.ok(Math.abs(r.curve[0][1] - 72) < 1e-9 && Math.abs(r.curve[1][1] - 79.2) < 1e-9);
  assert.deepEqual(r.parts.map((p) => p.key), ['compensatorMuzzle', 'thumbGrip']);

  const prone = resolve(idx, { gesture: P('PRONE'), stock: K('GENERAL') });
  assert.ok(Math.abs(prone.multiplier - 0.9 * 0.6) < 1e-9, 'stock x prone');
  const crouch = resolve(idx, { gesture: P('CROUCH') });
  assert.ok(Math.abs(crouch.multiplier - 0.8) < 1e-9);
  // BRAKE, ERGONOMIC grip and GENERAL_NEW stock have no coefficient in the app's code: factor 1
  const none = resolve(idx, { muzzle: M('BRAKE'), grip: G('ERGONOMIC'), stock: K('GENERAL_NEW') });
  assert.equal(none.multiplier, 1);
  assert.deepEqual(none.curve, [[0, 100], [100, 110]]);
});

test('a missing bare curve gives zeros and says so; Empty and MORTAR are always zero', () => {
  const idx = R.indexData(dataset(() => {}));
  const r = resolve(idx, { grip: G('THUMB') });
  assert.equal(r.source, 'computed');
  assert.equal(r.baseMissing, true);
  assert.deepEqual(r.curve, [[0, 0]]);
  for (const w of ['Empty', 'MORTAR']) {
    const z = R.resolve(R.indexData(dataset((g) => g[W(w)].v.push(entry(0, 0, 0, 1, 0, [[0, 50]])))), { weapon: W(w), scope: 1, grip: 0, muzzle: 0, stock: 0, gesture: 0 });
    assert.equal(z.source, 'zero', w);
    assert.deepEqual(z.curve, [[0, 0]]);
  }
});

test('coefficient lists shorter than the scope index fall back to the first scope', () => {
  const groups = dataset((g) => { g[AUG].v.push(entry(0, 0, 0, S('X6'), 0, [[0, 10]])); });
  groups[AUG].coefficients = [{ ...COEF, thumbGrip: 0.5 }]; // only one entry
  const r = resolve(R.indexData(groups), { scope: S('X6'), grip: G('THUMB') });
  assert.equal(r.multiplier, 0.5);
});

test('pickDataset follows ModeRecoilProfiles: touch -> normal_touch_recoil_data, gyro -> gyro_recoil_data, else recoil_data', () => {
  const raw = [{ v: [], coefficients: [] }];
  const touch = [{ v: [], coefficients: [], t: 1 }];
  const gyro = [{ v: [], coefficients: [], g: 1 }];
  const withBlock = { recoil_data: raw, ft_recoil_mode_profiles: { normal_touch_recoil_data: touch, gyro_recoil_data: gyro } };
  assert.equal(R.pickDataset(withBlock, 'touch').data, touch);
  assert.equal(R.pickDataset(withBlock, 'gyro').data, gyro);
  assert.equal(R.pickDataset(withBlock, 'raw').data, raw);
  const plain = { recoil_data: raw };
  assert.equal(R.pickDataset(plain, 'gyro').data, raw, 'no block: the app copies recoil_data into both modes');
  assert.equal(R.pickDataset(plain, 'gyro').key, 'recoil_data');
  assert.equal(R.pickDataset({}, 'touch'), null);
});

test('curveStats', () => {
  assert.deepEqual(R.curveStats([[0, 5], [300, 9], [1000, 7]]), { v0: 5, vEnd: 7, min: 5, max: 9, duration: 1000, points: 3 });
});

// ---- against the real file pulled from the phone (skipped when it is not there)
const REAL = path.join(__dirname, '..', 'keymap_analysis', 'raw', 'map%7Ca83e86a5d225446abb635d68c940192a.json');

test('real AUG data: last duplicate wins, prone is computed from the bare curve', (t) => {
  if (!fs.existsSync(REAL)) return t.skip('backup file not available');
  const doc = JSON.parse(fs.readFileSync(REAL, 'utf8'));
  const { data } = R.pickDataset(doc, 'touch');
  const idx = R.indexData(data);
  const aug = data[AUG];
  // independent expectation: scan the entries backwards for the key
  const lastOf = (g, m, st, sc, ge) => [...aug.v].reverse().find((e) => e.grip === g && e.muzzle === m && e.stock === st && e.scope === sc && e.gesture === ge);

  const key = [G('HORIZONTAL'), M('COMPENSATOR'), 0, S('X3'), P('CROUCH')];
  const r = R.resolve(idx, { weapon: AUG, grip: key[0], muzzle: key[1], stock: key[2], scope: key[3], gesture: key[4] });
  assert.equal(r.source, 'exact');
  assert.deepEqual(r.curve, lastOf(...key).recoilValue);
  assert.ok(r.copies > 1 && r.distinct === 2, `copies=${r.copies} distinct=${r.distinct}`);

  const prone = R.resolve(idx, { weapon: AUG, scope: S('X1'), grip: 0, muzzle: 0, stock: 0, gesture: P('PRONE') });
  const base = lastOf(0, 0, 0, S('X1'), 0).recoilValue;
  const coef = aug.coefficients[S('X1')].prone;
  assert.equal(prone.source, 'computed');
  assert.ok(Math.abs(prone.curve[0][1] - base[0][1] * coef) < 1e-9);
});

test('real file: gyro dataset is smaller than touch and only differs in a few curves', (t) => {
  if (!fs.existsSync(REAL)) return t.skip('backup file not available');
  const doc = JSON.parse(fs.readFileSync(REAL, 'utf8'));
  const count = (d) => d.reduce((s, g) => s + g.v.length, 0);
  assert.equal(count(R.pickDataset(doc, 'touch').data), 1858);
  assert.equal(count(R.pickDataset(doc, 'gyro').data), 928);
  assert.equal(R.pickDataset(doc, 'touch').data, doc.ft_recoil_mode_profiles.normal_touch_recoil_data);
});

// ---- Vietnamese display names (the raw enum names stay available for tooltips and for matching the JSON)
test('every enum has a unique, non-empty Vietnamese label in the same order', () => {
  const pairs = [['SCOPES', R.SCOPES], ['GRIPS', R.GRIPS], ['MUZZLES', R.MUZZLES], ['STOCKS', R.STOCKS], ['POSTURES', R.POSTURES]];
  for (const [name, raw] of pairs) {
    const vi = R.LABELS[name];
    assert.equal(vi.length, raw.length, `${name} length`);
    assert.ok(vi.every((s) => typeof s === 'string' && s.trim()), `${name} non-empty`);
    assert.equal(new Set(vi).size, vi.length, `${name} unique`);
    // LPVO is an acronym, kept as is on purpose
    assert.ok(!vi.some((s, i) => i > 0 && s === raw[i] && s !== 'LPVO'), `${name}: no label may still be the raw English enum name`);
  }
});

test('Vietnamese names follow the agreed table', () => {
  const L = R.LABELS;
  assert.equal(L.MUZZLES[M('COMPENSATOR')], 'Nòng hãm giật');
  assert.equal(L.MUZZLES[M('FLASH_HIDER')], 'Nòng ẩn tia lửa');
  assert.equal(L.MUZZLES[M('SUPPRESSOR')], 'Nòng giảm thanh');
  assert.equal(L.GRIPS[G('VERTICAL')], 'Tay cầm đứng');
  assert.equal(L.GRIPS[G('HORIZONTAL')], 'Tay cầm tam giác');
  assert.equal(L.GRIPS[G('THUMB')], 'Tay cầm ngón cái');
  assert.equal(L.GRIPS[G('LIGHT')], 'Tay cầm nhẹ');
  assert.equal(L.STOCKS[K('GENERAL')], 'Báng súng (Tactical Stock)');
  assert.equal(L.SCOPES[S('hippie')], 'Bắn hông (không ngắm)');
  assert.equal(L.SCOPES[S('X1')], '1x (Red Dot, Holo)');
  assert.equal(L.SCOPES[S('X4')], '4x');
  assert.equal(L.SCOPES[S('X63')], '3–6x (đang ở 6x)');
  assert.deepEqual(L.POSTURES, ['Đứng', 'Ngồi', 'Nằm']);
});

test('weapon names: gun names stay as they are, the odd ones are translated', () => {
  assert.equal(R.weaponLabel(W('AUG')), 'AUG');
  assert.equal(R.weaponLabel(W('M416')), 'M416');
  assert.equal(R.weaponLabel(W('Empty')), '(Không súng)');
  assert.equal(R.weaponLabel(W('CrossBow')), 'Nỏ');
  assert.equal(R.weaponLabel(W('Bow')), 'Cung');
  assert.equal(R.weaponLabel(W('SHIELD')), 'Khiên');
  assert.equal(R.weaponLabel(W('MORTAR')), 'Cối');
  assert.equal(R.weaponLabel(68), '(nhóm 68)');
});

test('coefficient keys get Vietnamese labels and unknown keys fall back to themselves', () => {
  assert.equal(R.coefLabel('compensatorMuzzle'), 'Nòng hãm giật');
  assert.equal(R.coefLabel('crouch'), 'Tư thế ngồi');
  assert.equal(R.coefLabel('somethingNew'), 'somethingNew');
});

test('the factor breakdown is written in Vietnamese', () => {
  const idx = R.indexData(dataset((g) => { g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 100]])); }));
  const r = resolve(idx, { grip: G('THUMB'), muzzle: M('COMPENSATOR'), stock: K('GENERAL'), gesture: P('PRONE') });
  assert.deepEqual(r.parts.map((p) => p.label), ['Nòng: Nòng hãm giật', 'Tay cầm: Tay cầm ngón cái', 'Báng: Báng súng (Tactical Stock)', 'Tư thế: Nằm']);
});
