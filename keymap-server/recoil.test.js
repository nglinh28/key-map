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
  assert.equal(L.GRIPS[G('HALF')], 'Tay cầm Hồng (Tay cầm nửa)');
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

// ---- editing a curve from the web page
const combo = (o = {}) => ({ weapon: AUG, scope: S('X1'), grip: 0, muzzle: 0, stock: 0, gesture: 0, ...o });
const docWith = (fill, modes = true) => {
  const doc = { name: 'cfg', recoil_data: dataset(fill) };
  if (modes) doc.ft_recoil_mode_profiles = { normal_touch_recoil_data: dataset(fill), gyro_recoil_data: dataset(fill) };
  return doc;
};
const seeded = (g) => { g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 100], [50, 80]])); };
const curveOf = (doc, mode, o = combo()) => R.resolve(R.indexData(R.pickDataset(doc, mode).data), o);

test('checkCurve: finite numbers only, time from 0, sorted by time, never Infinity/NaN/null', () => {
  assert.deepEqual(R.checkCurve([[50, 2], [0, 1]]), { ok: true, curve: [[0, 1], [50, 2]] });
  assert.deepEqual(R.checkCurve([['10', '2.5']]), { ok: true, curve: [[10, 2.5]] }, 'numeric text from the input boxes');
  for (const bad of [[[0, Infinity]], [[0, NaN]], [[Infinity, 1]], [[0, null]], [[0, '']], [[-1, 1]], [[0]], [[0, 1, 2]], [], null, 'x', [null]]) {
    const r = R.checkCurve(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.error.length > 0);
  }
  assert.match(R.checkCurve([[0, 1], [1e999, 1]]).error, /Mốc #2/);
  assert.equal(JSON.stringify(R.checkCurve([[0, 1]]).curve), '[[0,1]]', 'what is stored contains no null');
});

test('applyCurveEdit: changes the LAST entry of the key, only in the dataset on screen, and does not touch the input', () => {
  const doc = docWith((g) => { seeded(g); g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 90]])); });
  const before = JSON.stringify(doc);
  const r = R.applyCurveEdit(doc, 'touch', combo(), [[0, 1], [10, 2]]);
  assert.equal(JSON.stringify(doc), before, 'the original is not mutated');
  assert.equal(r.key, 'normal_touch_recoil_data');
  assert.equal(r.created, false);
  assert.deepEqual(curveOf(r.doc, 'touch').curve, [[0, 1], [10, 2]]);
  const first = R.pickDataset(r.doc, 'touch').data[AUG].v[0].recoilValue;
  assert.deepEqual(first, [[0, 100], [50, 80]], 'the earlier duplicate stays as it was');
  assert.deepEqual(curveOf(r.doc, 'gyro').curve, [[0, 90]], 'gyro dataset untouched');
  assert.deepEqual(curveOf(r.doc, 'raw').curve, [[0, 90]], 'raw dataset untouched');
  const g = R.applyCurveEdit(doc, 'gyro', combo(), [[0, 7]]);
  assert.equal(g.key, 'gyro_recoil_data');
  assert.deepEqual(curveOf(g.doc, 'gyro').curve, [[0, 7]]);
  assert.deepEqual(curveOf(g.doc, 'touch').curve, [[0, 90]]);
  assert.equal(R.applyCurveEdit(doc, 'raw', combo(), [[0, 5]]).key, 'recoil_data');
});

test('applyCurveEdit: edits the dataset the page shows, also when the file has no mode profiles', () => {
  const doc = docWith(seeded, false);
  const r = R.applyCurveEdit(doc, 'touch', combo(), [[0, 3]]);
  assert.equal(r.key, 'recoil_data', 'same fallback as pickDataset');
  assert.equal(R.pickDataset(doc, 'touch').key, 'recoil_data');
  assert.deepEqual(curveOf(r.doc, 'touch').curve, [[0, 3]]);
});

test('applyCurveEdit: a combination without its own entry gets one; the curve is sorted and checked', () => {
  const doc = docWith(seeded);
  const o = combo({ muzzle: M('COMPENSATOR'), gesture: P('CROUCH') });
  assert.equal(curveOf(doc, 'touch', o).source, 'computed');
  const r = R.applyCurveEdit(doc, 'touch', o, [[20, 5], [0, 6]]);
  assert.equal(r.created, true);
  const now = curveOf(r.doc, 'touch', o);
  assert.equal(now.source, 'exact');
  assert.deepEqual(now.curve, [[0, 6], [20, 5]]);
  assert.throws(() => R.applyCurveEdit(doc, 'touch', o, [[0, Infinity]]), /Mốc #1/);
  assert.throws(() => R.applyCurveEdit(doc, 'touch', o, []), /ít nhất 1 mốc/);
});

test('applyCurveEdit: refuses what the app would ignore or what the file cannot hold', () => {
  const doc = docWith(seeded);
  assert.throws(() => R.applyCurveEdit(doc, 'touch', combo({ weapon: W('MORTAR') }), [[0, 1]]), /luôn dùng đường cong 0/);
  assert.throws(() => R.applyCurveEdit(doc, 'touch', combo({ weapon: W('Empty') }), [[0, 1]]), /luôn dùng đường cong 0/);
  const short = { recoil_data: [{ v: [], coefficients: [] }] };
  assert.throws(() => R.applyCurveEdit(short, 'raw', combo(), [[0, 1]]), /chưa có nhóm dữ liệu/, 'no empty groups are invented');
  assert.throws(() => R.applyCurveEdit({ name: 'x' }, 'raw', combo(), [[0, 1]]), /không có recoil_data/);
  assert.equal(short.recoil_data.length, 1);
});

test('removeEntry: drops every entry of the key and only those', () => {
  const doc = docWith((g) => { seeded(g); g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 90]]), entry(1, 0, 0, S('X1'), 0, [[0, 70]])); });
  const r = R.removeEntry(doc, 'touch', combo());
  assert.equal(r.removed, 2);
  assert.notEqual(curveOf(r.doc, 'touch').source, 'exact');
  assert.equal(curveOf(r.doc, 'touch', combo({ grip: 1 })).source, 'exact', 'a neighbour stays');
  assert.equal(curveOf(r.doc, 'gyro').source, 'exact', 'the other dataset stays');
  assert.equal(R.removeEntry(doc, 'touch', combo({ scope: S('X2') })).removed, 0);
  assert.equal(JSON.stringify(doc).includes('"recoilValue":[[0,90]]'), true, 'input not mutated');
});

test('isZeroWeapon: the two guns the app always zeroes', () => {
  assert.equal(R.isZeroWeapon(W('Empty')) && R.isZeroWeapon(W('MORTAR')), true);
  assert.equal(R.isZeroWeapon(AUG), false);
});

// ---- points added or recomputed by the page (time + 450..678 ms; value + or - 1.02..1.35; cumulative)
const lo = () => 0, hi = () => 0.9999999;
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };
const near = (a, b) => Math.abs(a - b) < 1e-6;

test('step ranges: time +450..678 ms in whole ms, value +1.02..1.35 (or minus), both ends reachable', () => {
  assert.deepEqual(R.STEP, { time: [450, 678], value: [1.02, 1.35] });
  assert.equal(R.stepTime(100, lo), 550);
  assert.equal(R.stepTime(100, hi), 778);
  assert.ok(near(R.stepValue(85.71, lo), 86.73));
  assert.ok(near(R.stepValue(85.71, hi), 87.06));
  assert.ok(near(R.stepValue(85.71, lo, 'down'), 84.69));
  assert.ok(near(R.stepValue(85.71, hi, 'down'), 84.36));
  for (let i = 0; i < 3000; i++) {
    const t = R.stepTime(500) - 500;
    assert.ok(Number.isInteger(t) && t >= 450 && t <= 678, `dt ${t}`);
    const up = R.stepValue(3.14159, Math.random, 'up') - 3.14159;
    const down = 3.14159 - R.stepValue(3.14159, Math.random, 'down');
    assert.ok(up >= 1.02 - 1e-6 && up <= 1.35 + 1e-6, `up ${up}`);
    assert.ok(down >= 1.02 - 1e-6 && down <= 1.35 + 1e-6, `down ${down}`);
  }
});

test('direction: "random" picks up or down at random; anything unknown means up; values may go below zero', () => {
  assert.deepEqual(R.DIRECTIONS, ['up', 'down', 'random']);
  // random: first draw is the step, second decides the direction (below 0.5 = down)
  assert.ok(near(R.stepValue(10, seq(0, 0.2), 'random'), 8.98));
  assert.ok(near(R.stepValue(10, seq(0, 0.7), 'random'), 11.02));
  let ups = 0, downs = 0;
  for (let i = 0; i < 2000; i++) { const v = R.stepValue(10, Math.random, 'random'); if (v > 10) ups++; else downs++; }
  assert.ok(ups > 700 && downs > 700, `${ups} up / ${downs} down`);
  assert.ok(near(R.stepValue(10, lo, 'sideways'), 11.02));
  assert.ok(near(R.stepValue(0.5, lo, 'down'), -0.52), 'a value near zero simply goes negative');
});

test('nextPoint continues from the last point; an empty curve starts at 0,0', () => {
  const p = R.nextPoint([[0, 10], [200, 12]], lo);
  assert.equal(p[0], 650);
  assert.ok(near(p[1], 13.02));
  assert.ok(near(R.nextPoint([[0, 10], [200, 12]], lo, 'down')[1], 10.98));
  assert.deepEqual(R.nextPoint([], lo), [0, 0]);
});

test('cascadeFrom: only the points after the edited one change, one column at a time, each from the one before (cumulative)', () => {
  const base = () => [[0, 10], [300, 11], [600, 12], [900, 13]];
  const t = base();
  assert.equal(R.cascadeFrom(t, 1, 0, lo), 2);
  assert.deepEqual(t.map((p) => p[0]), [0, 300, 750, 1200], 'times: +450 each, starting from the edited time');
  assert.deepEqual(t.map((p) => p[1]), [10, 11, 12, 13], 'values untouched');
  const v = base();
  assert.equal(R.cascadeFrom(v, 0, 1, hi), 3);
  assert.deepEqual(v.map((p) => p[0]), [0, 300, 600, 900], 'times untouched');
  assert.deepEqual(v.map((p) => p[1]), [10, 11.35, 12.7, 14.05], '+1.35 each time, from the previous value');
  const d = base();
  R.cascadeFrom(d, 1, 1, lo, 'down');
  assert.deepEqual(d.map((p) => p[1]), [10, 11, 9.98, 8.96], '-1.02 each time');
  assert.equal(R.cascadeFrom(base(), 3, 0, lo), 0, 'nothing after the last point');
  assert.equal(R.cascadeFrom(base(), 9, 1, lo), 0);
  // random, many times: every step stays inside the ranges, and the curve stays ascending in time
  const r = [[0, 40], [1, 41], [2, 42], [3, 43], [4, 44]];
  for (let n = 0; n < 200; n++) {
    R.cascadeFrom(r, 0, 0);
    R.cascadeFrom(r, 0, 1, Math.random, 'random');
    for (let i = 1; i < r.length; i++) {
      const dt = r[i][0] - r[i - 1][0];
      const dv = Math.abs(r[i][1] - r[i - 1][1]);
      assert.ok(dt >= 450 && dt <= 678, `dt ${dt}`);
      assert.ok(dv >= 1.02 - 1e-6 && dv <= 1.35 + 1e-6, `dv ${dv}`);
    }
  }
  assert.equal(R.checkCurve(r).ok, true);
});

test('extendCurve: adds N points based on previous points trend or step', () => {
  // trend from last 2 points
  const base = [[0, 10], [200, 15]]; // dt = 200, dv = 5
  const ext2 = R.extendCurve(base, 2, { method: 'trend' });
  assert.equal(ext2.length, 4);
  assert.deepEqual(ext2, [[0, 10], [200, 15], [400, 20], [600, 25]]);

  // count 0 returns copy
  assert.deepEqual(R.extendCurve(base, 0), [[0, 10], [200, 15]]);

  // 1-point curve falls back to step
  const one = [[0, 20]];
  const extOne = R.extendCurve(one, 1, { method: 'trend', rnd: lo });
  assert.equal(extOne.length, 2);
  assert.equal(extOne[1][0], 450); // 0 + 450
  assert.ok(near(extOne[1][1], 21.02)); // 20 + 1.02

  // step method
  const stepExt = R.extendCurve([[0, 10], [100, 12]], 1, { method: 'step', rnd: lo });
  assert.equal(stepExt.length, 3);
  assert.equal(stepExt[2][0], 550); // 100 + 450
  assert.ok(near(stepExt[2][1], 13.02)); // 12 + 1.02
});

// ---- adding a combination that is already there
const keyOf2 = (o) => `${o.weapon}|${o.scope}|${o.gesture}|${o.grip}|${o.muzzle}|${o.stock}`;
test('findDuplicateCombo: an own entry, one added on the page, or the default row counts as already there', () => {
  const idx = R.indexData(dataset((g) => { seeded(g); g[AUG].v.push(entry(G('VERTICAL'), 0, 0, S('X1'), 0, [[0, 1]])); }));
  const custom = new Set([keyOf2(combo({ muzzle: M('SUPPRESSOR') }))]);
  assert.equal(keyOf2(combo()), `${AUG}|${S('X1')}|0|0|0|0`);
  assert.deepEqual(R.findDuplicateCombo(idx, custom, combo({ grip: G('VERTICAL') })), { kind: 'exact', copies: 1 });
  assert.deepEqual(R.findDuplicateCombo(idx, custom, combo({ muzzle: M('SUPPRESSOR') })), { kind: 'custom', copies: 0 });
  assert.deepEqual(R.findDuplicateCombo(idx, new Set(), combo({ scope: S('X2'), grip: G('HALF') })), null, 'no entry, not listed: a new combination');
  assert.deepEqual(R.findDuplicateCombo(idx, new Set(), combo({ grip: G('LIGHT') })), null);
  // (none, none, none) is always listed: exact when the file has it, otherwise the default row
  const noDefault = R.indexData(dataset((g) => { g[AUG].v.push(entry(G('VERTICAL'), 0, 0, S('X1'), 0, [[0, 1]])); }));
  assert.deepEqual(R.findDuplicateCombo(noDefault, new Set(), combo()), { kind: 'default', copies: 0 });
  assert.equal(R.comboKey(combo({ grip: 1, muzzle: 2, stock: 1, gesture: 2 })), `${AUG}|${S('X1')}|2|1|2|1`);
});

// ---- the curve the app computes from the coefficients, even when the combination has an own entry
test('computedFor: base curve times the coefficients, ignoring any own entry; resolve still prefers the own entry', () => {
  const idx = R.indexData(dataset((g) => {
    g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 100], [50, 80]]));
    g[AUG].v.push(entry(0, M('COMPENSATOR'), 0, S('X1'), 0, [[0, 55], [50, 44]])); // own entry, differs from base x 0.9
  }));
  const o = combo({ muzzle: M('COMPENSATOR') });
  const c = R.computedFor(idx, o);
  assert.deepEqual(c.curve.map(([t, v]) => [t, Math.round(v * 100) / 100]), [[0, 90], [50, 72]]);
  assert.ok(Math.abs(c.multiplier - 0.9) < 1e-9);
  assert.equal(c.baseMissing, false);
  assert.equal(R.resolve(idx, o).source, 'exact');
  assert.deepEqual(R.resolve(idx, o).curve, [[0, 55], [50, 44]]);
  // no base: zeros, flagged
  const none = R.computedFor(R.indexData(dataset(() => {})), o);
  assert.equal(none.baseMissing, true);
  assert.deepEqual(none.curve, [[0, 0]]);
  // the zero guns
  assert.deepEqual(R.computedFor(idx, combo({ weapon: W('MORTAR') })).curve, [[0, 0]]);
});

test('filterCombos: by scope and posture together; null means any, an empty set means none', () => {
  const list = [{ scope: 1, gesture: 0 }, { scope: 1, gesture: 1 }, { scope: 2, gesture: 0 }, { scope: 3, gesture: 2 }];
  assert.equal(R.filterCombos(list).length, 4);
  assert.deepEqual(R.filterCombos(list, { scopes: new Set([1]) }).map((c) => c.gesture), [0, 1]);
  assert.deepEqual(R.filterCombos(list, { gestures: new Set([0]) }).map((c) => c.scope), [1, 2]);
  assert.deepEqual(R.filterCombos(list, { scopes: new Set([1, 3]), gestures: new Set([0, 2]) }), [{ scope: 1, gesture: 0 }, { scope: 3, gesture: 2 }]);
  assert.deepEqual(R.filterCombos(list, { scopes: new Set() }), []);
});

test('batchCombos: own entries of any scope plus custom ones once each; all = allowed scopes x postures; extra scopes are listed', () => {
  const W = R.WEAPONS.indexOf('M416');
  const groups = Array.from({ length: 70 }, () => ({ v: [], coefficients: [] }));
  const e = (scope, grip, muzzle, stock, gesture) => ({ scope, grip, muzzle, stock, gesture, recoilValue: [[0, 1]] });
  groups[W].v.push(e(1, 0, 0, 0, 0), e(1, 0, 1, 0, 0), e(5, 0, 0, 0, 1)); // scope 5 is not allowed below
  groups[R.WEAPONS.indexOf('AKM')].v.push(e(1, 0, 0, 0, 0)); // another gun: never mixed in
  const idx = R.indexData(groups);
  const custom = new Set([`${W}|2|0|1|0|0`, `${W}|1|0|0|0|0`, `${W + 1}|1|0|0|0|0`]); // key layout: w|scope|gesture|grip|muzzle|stock; the 2nd is already saved
  const r = R.batchCombos(idx, custom, W, [1, 2]);
  assert.equal(r.own.length, 4, '3 saved + 1 custom (the saved one is not counted twice, the other gun is left out)');
  assert.ok(r.own.every((o) => o.weapon === W));
  assert.deepEqual([...r.extra], [5]);
  assert.deepEqual(r.scopeList, [1, 2, 5]);
  assert.ok(r.all.every((o) => o.scope === 1 || o.scope === 2), 'all = allowed scopes only');
  for (const sc of [1, 2]) for (const ge of [0, 1, 2]) assert.equal(r.all.filter((o) => o.scope === sc && o.gesture === ge && !o.grip && !o.muzzle && !o.stock).length, 1, `bare combo once for scope ${sc} posture ${ge}`);
  assert.equal(r.all.filter((o) => o.scope === 1 && o.gesture === 0).length, 2, 'bare + the saved muzzle one');
  assert.deepEqual(R.batchCombos(idx, null, W, [1, 2]).own.length, 3);
});

// ---- fire parameters (magazine, seconds between shots) and the time T to empty one magazine
test.afterEach(() => { R.setFireOverrides({}); R.setDisabledGuns([]); });

test('fireOf: defaults give T = (magazine - 1) x interval, in whole ms', () => {
  const m = R.fireOf('M416');
  assert.deepEqual([m.magazine, m.interval, m.emptyMs, m.source, m.edited], [30, 0.085, 2465, 'default', false]);
  assert.equal(R.fireOf('AWM').emptyMs, 7400);
  assert.equal(R.fireOf('S686').emptyMs, 200);
  assert.equal(R.fireOf(R.WEAPONS.indexOf('AKM')).emptyMs, 2900, 'a gun index works as well as a code');
  assert.equal(R.fireOf('P90'), null, 'no default for this gun');
  assert.equal(R.fireOf('MORTAR'), null, 'a zero gun has no fire data');
  assert.equal(R.fireOf('Nope'), null);
});

test('FIRE_DEFAULTS: 36 guns, every code is a gun of the app, every entry passes checkFire', () => {
  const codes = Object.keys(R.FIRE_DEFAULTS);
  assert.equal(codes.length, 36);
  for (const c of codes) {
    assert.ok(R.WEAPONS.includes(c), c);
    assert.equal(R.checkFire(R.FIRE_DEFAULTS[c]).ok, true, c);
  }
});

test('checkFire: magazine is a whole number 2..200, interval is finite 0.02..3, and the message is in Vietnamese', () => {
  assert.deepEqual(R.checkFire({ magazine: 30, interval: 0.0856789 }), { ok: true, fire: { magazine: 30, interval: 0.0857 } });
  for (const bad of [{ magazine: 1, interval: 0.1 }, { magazine: 201, interval: 0.1 }, { magazine: 1.5, interval: 0.1 }, { magazine: '30', interval: 0.1 },
    { magazine: 30, interval: 0.01 }, { magazine: 30, interval: 4 }, { magazine: 30, interval: NaN }, { magazine: 30, interval: Infinity }, null, 5, {}]) {
    const r = R.checkFire(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /[a-zà-ỹ]/i);
  }
  assert.equal(R.emptyMsOf({ magazine: 2, interval: 0.2 }), 200);
});

test('setFireOverrides: an edit wins over the default, null removes the data, bad entries are dropped', () => {
  R.setFireOverrides({ M416: { magazine: 40, interval: 0.09 } });
  const e = R.fireOf('M416');
  assert.deepEqual([e.emptyMs, e.source, e.edited], [3510, 'edited', true]);
  assert.deepEqual(R.getFireOverrides(), { M416: { magazine: 40, interval: 0.09 } });
  R.setFireOverrides({ M416: null });
  assert.equal(R.fireOf('M416'), null);
  R.setFireOverrides({ P90: { magazine: 50, interval: 0.06 } });
  assert.equal(R.fireOf('P90').emptyMs, 2940, 'an edit can give a gun that has no default');
  R.setFireOverrides({ M416: { magazine: 0, interval: 0.09 }, Foo: { magazine: 5, interval: 1 }, Empty: { magazine: 5, interval: 1 }, AKM: { magazine: 'x', interval: 0.1 } });
  assert.deepEqual(R.getFireOverrides(), {});
  assert.equal(R.fireOf('M416').source, 'default');
});

test('fireOf: a disabled gun has none, unless the caller asks to ignore that', () => {
  R.setDisabledGuns(['M416']);
  assert.equal(R.fireOf('M416'), null);
  assert.equal(R.fireOf('M416', { ignoreDisabled: true }).emptyMs, 2465);
  assert.equal(R.fireOf('MORTAR', { ignoreDisabled: true }), null, 'a zero gun never has it');
});

// ---- the even time axis
test('evenTimes: n points spread over T in whole ms, strictly increasing, the last one at T', () => {
  assert.deepEqual(R.evenTimes(2465, 11), [0, 247, 493, 740, 986, 1233, 1479, 1726, 1972, 2219, 2465]);
  assert.deepEqual(R.evenTimes(1000, 2), [0, 1000]);
  assert.deepEqual(R.evenTimes(5, 1), [0]);
  assert.deepEqual(R.evenTimes(5, 0), []);
  const t = R.evenTimes(100, 60);
  assert.equal(t[59], 100);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1], `point ${i}`);
});

test('evenTimes: a T too small for n pushes the points up by 1 ms rather than repeating a time (the last one is then beyond T)', () => {
  assert.deepEqual(R.evenTimes(0, 3), [0, 1, 2]);
  const t = R.evenTimes(10, 20);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1], `point ${i}`);
  assert.equal(t[19], 19);
});

test('resample: evenly spaced, shape kept (linear on the normalised time), both end values exact', () => {
  const r = R.resample([[0, 0], [1000, 10]], 5, 2000);
  assert.deepEqual(r.map((p) => p[0]), [0, 500, 1000, 1500, 2000]);
  assert.deepEqual(r.map((p) => p[1]), [0, 2.5, 5, 7.5, 10]);
  const odd = [[0, 3.3], [100, 4], [900, 9], [1000, 7.7]]; // uneven times: the values are read at t / T x old duration
  for (const n of [2, 3, 7, 25]) {
    const q = R.resample(odd, n, 2465);
    assert.equal(q.length, n);
    assert.equal(q[0][1], 3.3);
    assert.equal(q[n - 1][1], 7.7);
    assert.equal(q[n - 1][0], 2465);
  }
});

test('resample: adding then removing points keeps a smooth curve within 3% of its largest value', () => {
  const para = Array.from({ length: 11 }, (_, i) => [i * 100, 100 * (i / 10) ** 2]);
  const back = R.resample(R.resample(para, 16, 1000), 11, 1000);
  assert.deepEqual(back.map((p) => p[0]), para.map((p) => p[0]));
  const worst = Math.max(...back.map((p, i) => Math.abs(p[1] - para[i][1]))) / 100;
  assert.ok(worst < 0.03, `worst ${worst}`);
});

test('resample: a curve of one point, of zero duration, or nothing never gives NaN', () => {
  assert.deepEqual(R.resample([[0, 7]], 4, 1000).map((p) => p[1]), [7, 7, 7, 7]);
  for (const bad of [[[0, 1], [0, 2]], [[5, 1], [5, 2], [5, 3]]]) {
    const r = R.resample(bad, 3, 100);
    assert.equal(r.length, 3);
    assert.ok(r.every(([t, v]) => Number.isFinite(t) && Number.isFinite(v)), JSON.stringify(r));
  }
  assert.deepEqual(R.resample([], 3, 100), []);
});

test('retime keeps the number of points; withEvenTimes keeps the values as they are', () => {
  const c = [[0, 1], [10, 5], [11, 9]];
  assert.equal(R.retime(c, 1000).length, 3);
  assert.deepEqual(R.retime([[0, 0], [1000, 10]], 1000), [[0, 0], [1000, 10]]);
  assert.deepEqual(R.withEvenTimes(c, 1000), [[0, 1], [500, 5], [1000, 9]]);
  assert.deepEqual(c, [[0, 1], [10, 5], [11, 9]], 'the input is not changed');
});

test('spreadAfter: the points after one are spread evenly from it to T, in place; nothing happens when it is already at or beyond T', () => {
  const c = [[0, 1], [100, 2], [150, 3], [160, 4], [170, 5]];
  assert.equal(R.spreadAfter(c, 1, 1000), 3);
  assert.deepEqual(c.map((p) => p[0]), [0, 100, 400, 700, 1000]);
  const d = [[0, 1], [1000, 2], [1100, 3]];
  assert.equal(R.spreadAfter(d, 1, 1000), 0);
  assert.deepEqual(d.map((p) => p[0]), [0, 1000, 1100]);
  assert.equal(R.spreadAfter(d, 9, 1000), 0);
  assert.equal(R.spreadAfter(d, -1, 1000), 0);
});

test('durationGap: how far the length of a curve is from T (0.05 = 5%)', () => {
  assert.equal(R.durationGap([[0, 0], [2000, 1]], 2000), 0);
  assert.equal(R.durationGap([[0, 0], [4000, 1]], 2000), 1);
  assert.equal(R.durationGap([[0, 0], [1900, 1]], 2000), 0.05);
  assert.equal(R.durationGap([[0, 0], [1900, 1]], 0), 0);
  assert.equal(R.durationGap([], 2000), 1);
});

test('disabledEntries: the own entries of the guns switched off, with their copies; removeEntries takes every copy', () => {
  const M416 = R.WEAPONS.indexOf('M416');
  const doc = dataset((g) => {
    g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 100]]));
    g[M416].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 70]]));
    g[M416].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 71]]));
    g[M416].v.push(entry(0, 0, 0, S('X1'), 1, [[0, 60]]));
  });
  const idx = R.indexData(doc);
  try {
    assert.deepEqual(R.disabledEntries(idx), []);
    R.setDisabledGuns(['M416']);
    const list = R.disabledEntries(idx);
    assert.deepEqual(list.map((e) => [e.weapon, e.scope, e.gesture, e.copies]), [[M416, 1, 0, 2], [M416, 1, 1, 1]]);
    const res = R.removeEntries({ recoil_data: doc }, 'raw', list);
    assert.equal(res.removed, 3);
    assert.equal(res.keys, 2);
    const ds = R.pickDataset(res.doc, 'raw');
    assert.equal(ds.data[M416].v.length, 0);
    assert.equal(ds.data[AUG].v.length, 1, 'other guns keep their entries');
  } finally { R.setDisabledGuns([]); }
});

test('entriesWhere: filters the own entries by gun, posture and scope; a missing set means any', () => {
  const M416 = R.WEAPONS.indexOf('M416');
  const idx = R.indexData(dataset((g) => {
    g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 100]]));
    g[AUG].v.push(entry(0, 0, 0, S('X1'), 1, [[0, 90]]));
    g[M416].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 70]]));
    g[M416].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 71]]));
  }));
  assert.equal(R.entriesWhere(idx).length, 3);
  assert.equal(R.entriesWhere(idx, { weapons: new Set([AUG]) }).length, 2);
  assert.equal(R.entriesWhere(idx, { weapons: new Set([AUG]), gestures: new Set([1]) }).length, 1);
  assert.deepEqual(R.entriesWhere(idx, { weapons: new Set([M416]) }).map((e) => e.copies), [2]);
  assert.equal(R.entriesWhere(idx, { scopes: new Set([S('X1')]) }).length, 3);
  assert.equal(R.entriesWhere(idx, { weapons: new Set() }).length, 0, 'an empty set matches nothing');
});

test('duplicateGroups and dedupeEntries: several entries with one key, the last one is kept', () => {
  const M416 = R.WEAPONS.indexOf('M416');
  const doc = { recoil_data: dataset((g) => {
    g[AUG].v.push(entry(0, 0, 0, S('X1'), 0, [[0, 100]]));
    g[M416].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 70]]));
    g[M416].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 71]]));
    g[M416].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 70]]));
    g[M416].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 72]]));
    g[M416].v.push(entry(0, 0, 0, S('X1'), 1, [[0, 60]]));
  }) };
  const idx = R.indexData(doc.recoil_data);
  const groups = R.duplicateGroups(idx);
  assert.equal(groups.length, 1);
  assert.deepEqual([groups[0].copies, groups[0].distinct], [4, 3]);
  assert.deepEqual(groups[0].curves.map((c) => [c.count, c.last]), [[2, false], [1, false], [1, true]]);
  const res = R.dedupeEntries(doc, 'raw', groups);
  assert.deepEqual([res.removed, res.keys], [3, 1]);
  const after = R.indexData(R.pickDataset(res.doc, 'raw').data);
  assert.equal(R.duplicateGroups(after).length, 0);
  assert.deepEqual(after.map.get([groups[0].weapon, groups[0].scope, groups[0].grip, groups[0].muzzle, groups[0].stock, groups[0].gesture].join('|')).map((e) => e.recoilValue), [[[0, 72]]], 'the last copy is the one that stays');
  assert.equal(R.pickDataset(res.doc, 'raw').data[M416].v.length, 2, 'other keys are untouched');
  assert.equal(doc.recoil_data[M416].v.length, 5, 'the input is not changed');
});

test('dedupeEntries: an entry with a missing field is matched, and equal numbers on two guns do not mix', () => {
  const M416 = R.WEAPONS.indexOf('M416');
  const doc = { recoil_data: dataset((g) => {
    const a = entry(5, 1, 0, S('X1'), 0, [[0, 1]]);
    const b = entry(5, 1, 0, S('X1'), 0, [[0, 2]]);
    delete a.stock; delete b.stock; // a field the file does not have
    g[M416].v.push(a, b);
    g[AUG].v.push(entry(5, 1, 0, S('X1'), 0, [[0, 3]]), entry(5, 1, 0, S('X1'), 0, [[0, 4]]));
  }) };
  const groups = R.duplicateGroups(R.indexData(doc.recoil_data));
  assert.equal(groups.length, 2);
  const res = R.dedupeEntries(doc, 'raw', groups.filter((g) => g.weapon === M416));
  assert.deepEqual([res.removed, res.keys], [1, 1], 'the entry without a field is deduplicated');
  const ds = R.pickDataset(res.doc, 'raw').data;
  assert.equal(ds[M416].v.length, 1);
  assert.equal(ds[AUG].v.length, 2, 'the other gun is untouched');
});
