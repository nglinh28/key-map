'use strict';
// "Server" suggestion for the points of a combination: the coefficient curve of the gun, corrected by how the REAL data of similar guns
// differs from their own coefficient curves for that same combination.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./admin/recoil');
const S = require('./suggest');

const W = (n) => R.WEAPONS.indexOf(n);
const SC = R.SCOPES.indexOf('X1');
const MUZ = R.MUZZLES.indexOf('COMPENSATOR');
const COEF = { compensatorMuzzle: 0.9, flashHidderMuzzle: 0.8, suppressorMuzzle: 0.95, verticalGrip: 0.85, horizontalGrip: 0.97, halfGrip: 0.93, lightGrip: 0.98, thumbGrip: 0.8, laserGrip: 0.99, generalStock: 0.9, crouch: 0.8, prone: 0.6, stand: 1 };
const E = (grip, muzzle, stock, gesture, recoilValue) => ({ scope: SC, grip, muzzle, stock, gesture, recoilValue });
const times = (c, k) => c.map(([t, v]) => [t, v * k]);

// guns: { name: [entries] }; every one of the 70 groups exists (the app indexes by weapon)
function build(guns) {
  const groups = Array.from({ length: 70 }, () => ({ v: [], coefficients: Array.from({ length: 13 }, () => ({ ...COEF })) }));
  for (const [name, entries] of Object.entries(guns)) groups[W(name)].v.push(...entries);
  return R.indexData(groups);
}
const BASE = [[0, 100], [100, 80], [200, 60]];
const target = (o = {}) => ({ weapon: W('AUG'), scope: SC, gesture: 0, grip: 0, muzzle: MUZ, stock: 0, ...o });
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

test('interp: linear between points, flat outside', () => {
  const c = [[0, 10], [100, 20]];
  assert.equal(S.interp(c, 50), 15);
  assert.equal(S.interp(c, -5), 10);
  assert.equal(S.interp(c, 500), 20);
  assert.equal(S.interp([[0, 7]], 30), 7);
});

test('similarGuns: nearest base curves first; the target, zero guns and guns without the combo or a base are left out', () => {
  const combo = (k) => E(0, MUZ, 0, 0, times(BASE, k * 0.9));
  const idx = build({
    AUG: [E(0, 0, 0, 0, BASE)],
    M416: [E(0, 0, 0, 0, times(BASE, 1.05)), combo(1.05)],
    Scar: [E(0, 0, 0, 0, times(BASE, 0.95)), combo(0.95)],
    AKM: [E(0, 0, 0, 0, [[0, 10], [3000, 500]]), combo(1)], // very different shape
    M762: [E(0, 0, 0, 0, times(BASE, 1.02))], // has no entry for the combo
    QBZ: [combo(1)], // has the combo but no base
    MORTAR: [E(0, 0, 0, 0, BASE), combo(1)], // always zero in the app
  });
  const sims = S.similarGuns(idx, target(), { limit: 5 });
  assert.equal(sims.length, 3);
  assert.deepEqual(sims.slice(0, 2).map((s) => s.name).sort(), ['M416', 'Scar']);
  assert.equal(sims[2].name, 'AKM');
  assert.ok(sims[0].distance <= sims[1].distance && sims[1].distance < sims[2].distance);
  assert.ok(near(sims.reduce((n, s) => n + s.weight, 0), 1, 1e-9), 'weights add up to 1');
  assert.ok(sims[0].weight > sims[2].weight);
  assert.deepEqual(S.similarGuns(idx, target(), { limit: 2 }).map((s) => s.name).sort(), ['M416', 'Scar']);
});

test('analogCurve: when similar guns deviate from their coefficient curve by 0.8, so does the candidate', () => {
  // computed for a gun = base x 0.9 (compensator); the real entries are base x 0.72, i.e. 0.8 of the computed one
  const real = (k) => E(0, MUZ, 0, 0, times(BASE, k * 0.72));
  const idx = build({
    AUG: [E(0, 0, 0, 0, BASE)],
    M416: [E(0, 0, 0, 0, times(BASE, 1.05)), real(1.05)],
    Scar: [E(0, 0, 0, 0, times(BASE, 0.95)), real(0.95)],
    AKM: [E(0, 0, 0, 0, [[0, 10], [3000, 500]]), E(0, MUZ, 0, 0, [[0, 7.2], [3000, 360]])],
  });
  const r = S.analogCurve(idx, target(), { limit: 2 });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.curve.map((p) => p[0]), [0, 100, 200], 'same time grid: durations agree');
  r.curve.forEach(([, v], i) => assert.ok(near(v, BASE[i][1] * 0.72), `${v} vs ${BASE[i][1] * 0.72}`));
  assert.deepEqual(r.computed.map(([t, v]) => [t, Math.round(v * 100) / 100]), [[0, 90], [100, 72], [200, 54]]);
  assert.ok(near(r.factor.mean, 0.8, 1e-6));
  assert.deepEqual(r.similar.map((s) => s.name).sort(), ['M416', 'Scar']);
  assert.equal(R.checkCurve(r.curve).ok, true);
});

test('analogCurve: the time axis stretches like the similar guns do', () => {
  const idx = build({
    AUG: [E(0, 0, 0, 0, BASE)],
    M416: [E(0, 0, 0, 0, BASE), E(0, MUZ, 0, 0, [[0, 90], [150, 72], [300, 54]])], // same values as computed, but 1.5 x as long
  });
  const r = S.analogCurve(idx, target());
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.curve.map((p) => p[0]), [0, 150, 300]);
  assert.ok(near(r.stretch, 1.5, 1e-9));
  r.curve.forEach(([, v], i) => assert.ok(near(v, [90, 72, 54][i])));
});

test('analogCurve: times stay strictly ascending whatever the stretch, and a zero start is kept', () => {
  const idx = build({
    AUG: [E(0, 0, 0, 0, [[0, 100], [1, 99], [2, 98], [3, 97]])],
    M416: [E(0, 0, 0, 0, [[0, 100], [1, 99], [2, 98], [3, 97]]), E(0, MUZ, 0, 0, [[0, 90], [1, 89], [2, 88], [2.2, 87]])],
  });
  const r = S.analogCurve(idx, target());
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.curve[0][0], 0);
  for (let i = 1; i < r.curve.length; i++) assert.ok(r.curve[i][0] > r.curve[i - 1][0], JSON.stringify(r.curve));
  assert.equal(R.checkCurve(r.curve).ok, true);
});

test('analogCurve: says why when it cannot', () => {
  const noBase = build({ M416: [E(0, 0, 0, 0, BASE), E(0, MUZ, 0, 0, times(BASE, 0.9))] });
  assert.match(S.analogCurve(noBase, target()).reason, /đường cong nền/);
  const noSimilar = build({ AUG: [E(0, 0, 0, 0, BASE)], M416: [E(0, 0, 0, 0, BASE)] });
  const r = S.analogCurve(noSimilar, target());
  assert.equal(r.ok, false);
  assert.match(r.reason, /súng tương tự/);
  assert.deepEqual(r.computed.map((p) => p[0]), [0, 100, 200], 'the coefficient curve is still given');
  assert.match(S.analogCurve(noSimilar, target({ weapon: W('MORTAR') })).reason, /luôn dùng đường cong 0/);
});

// these tests use accessories on AUG regardless of what AUG takes: the rules are switched off (they have their own tests below)
const free = (o = {}) => ({ allowed: () => true, ...o });
const gaps = (idx, tg, o) => S.comboGaps(idx, tg, free(o));
const cands = (idx, tg, o) => S.comboCandidates(idx, tg, free(o));

// ---- which combinations to suggest ADDING: the ones similar guns have an own entry for and this gun has not
const FLASH = R.MUZZLES.indexOf('FLASH_HIDER');
const VERT = R.GRIPS.indexOf('VERTICAL');
const GEN = R.STOCKS.indexOf('GENERAL');
const Ex = (g, m, st, ge = 0, k = 1) => E(g, m, st, ge, times(BASE, k));
const gapTarget = (o = {}) => ({ weapon: W('AUG'), scope: SC, gesture: 0, ...o });

function gapIdx() {
  return build({
    AUG: [Ex(0, 0, 0), Ex(VERT, FLASH, 0)], // owns the vertical + flash hider combination
    M416: [Ex(0, 0, 0, 0, 1.05), Ex(0, MUZ, 0), Ex(VERT, FLASH, 0), Ex(0, 0, GEN), Ex(0, MUZ, 0, 1)], // the last one is crouching
    Scar: [Ex(0, 0, 0, 0, 0.95), Ex(0, MUZ, 0), Ex(0, 0, GEN)],
    QBZ: [Ex(0, 0, 0, 0, 1.02), Ex(0, MUZ, 0)],
    AKM: [Ex(0, 0, 0, 0, 1), Ex(VERT, 0, 0)], // only AKM has this one
    MORTAR: [Ex(0, 0, 0), Ex(0, MUZ, 0), Ex(0, 0, GEN)],
  });
}

test('similarByBase: the nearest base curves first, with weights, whether or not they have a given combination', () => {
  const sims = S.similarByBase(gapIdx(), gapTarget(), { limit: 3 });
  assert.equal(sims.length, 3);
  assert.ok(sims.every((s) => s.name !== 'AUG' && s.name !== 'MORTAR'));
  assert.ok(sims[0].distance <= sims[1].distance && sims[1].distance <= sims[2].distance);
  assert.ok(near(sims.reduce((n, s) => n + s.weight, 0), 1, 1e-9));
  assert.deepEqual(S.similarByBase(build({ M416: [Ex(0, 0, 0)] }), gapTarget(), {}), [], 'the target has no base curve');
});

test('comboGaps: combinations that several similar guns have and this gun does not, best supported first', () => {
  const r = gaps(gapIdx(), gapTarget(), { similar: 4, minSupport: 2 });
  assert.equal(r.ok, true, r.reason);
  const keys = r.candidates.map((c) => `${c.grip}/${c.muzzle}/${c.stock}`);
  assert.deepEqual(keys, [`0/${MUZ}/0`, `0/0/${GEN}`], 'compensator (3 guns) before general stock (2 guns); the owned combo, the one only AKM has and the base are left out');
  const [a, b] = r.candidates;
  assert.equal(a.n, 3);
  assert.equal(b.n, 2);
  assert.equal(a.of, 4);
  assert.ok(a.support > b.support && a.support <= 1 && b.support > 0);
  assert.deepEqual(a.names.slice().sort(), ['M416', 'QBZ', 'Scar']);
  assert.equal(r.similar.length, 4);
});

test('comboGaps: posture is respected, the support threshold and the limit apply, and it says why when it cannot', () => {
  const crouch = gaps(gapIdx(), gapTarget({ gesture: 1 }), { similar: 4, minSupport: 1 });
  assert.deepEqual(crouch.candidates.map((c) => `${c.grip}/${c.muzzle}/${c.stock}`), [`0/${MUZ}/0`], 'only M416 has a crouching entry');
  const loose = gaps(gapIdx(), gapTarget(), { similar: 4, minSupport: 1 });
  assert.equal(loose.candidates.length, 3, 'with a threshold of one gun AKM\'s combination appears too');
  assert.equal(gaps(gapIdx(), gapTarget(), { similar: 4, minSupport: 1, limit: 1 }).candidates.length, 1);
  assert.equal(gaps(gapIdx(), gapTarget(), { similar: 4, minSupport: 9 }).candidates.length, 0, 'asking for more guns than were compared means all of them: nothing has 4 of 4');
  assert.equal(gaps(gapIdx(), gapTarget(), { similar: 1, minSupport: 9 }).candidates.length >= 0, true);
  assert.match(gaps(gapIdx(), gapTarget({ weapon: W('MORTAR') })).reason, /luôn dùng đường cong 0/);
  assert.match(gaps(build({ M416: [Ex(0, 0, 0)] }), gapTarget()).reason, /đường cong nền/);
  const empty = gaps(build({ AUG: [Ex(0, 0, 0)] }), gapTarget());
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /súng nào để so sánh/);
});

// ---- worth adding even when no similar gun has it: where the coefficient curve is usually wrong
const HALF = R.GRIPS.indexOf('HALF');
const SUP = R.MUZZLES.indexOf('SUPPRESSOR');
const THUMB = R.GRIPS.indexOf('THUMB');
// own entries = coefficient curve x k; the coefficients here: VERTICAL 0.85, FLASH 0.8, COMPENSATOR 0.9, HALF 0.93, SUPPRESSOR 0.95
const own = (g, m, st, mult, k, ge = 0) => E(g, m, st, ge, times(BASE, mult * k));

function worthIdx() {
  const gun = (scale) => [
    Ex(0, 0, 0, 0, scale),
    own(VERT, FLASH, 0, 0.85 * 0.8 * scale, 0.8), // real data is 20% under the coefficient curve for grip + muzzle
    own(0, MUZ, 0, 0.9 * scale, 1), // muzzle only: the coefficient is exact
  ];
  return build({
    AUG: [Ex(0, 0, 0)],
    M416: [...gun(1.05), own(HALF, SUP, 0, 0.93 * 0.95 * 1.05, 0.7)], // only M416 has half grip + suppressor, 30% under
    Scar: gun(0.95),
    QBZ: gun(1.02),
  });
}
const key = (c) => `${c.grip}/${c.muzzle}/${c.stock}`;

test('kindErrors: the mean error of the coefficient curve for each kind of combination, measured on the data', () => {
  const k = S.kindErrors(worthIdx());
  const gm = k.get('0|110');
  const m = k.get('0|010');
  assert.equal(gm.n, 4);
  assert.ok(gm.mean > 0.15 && gm.mean < 0.4, `${gm.mean}`);
  assert.equal(m.n, 3);
  assert.ok(m.mean < 1e-6, 'muzzle only: the coefficient curve is exact');
  assert.equal(k.get('0|000'), undefined, 'the base is not a combination');
});

test('comboCandidates: combinations the similar guns have (gap), then those where the coefficient curve is usually wrong (impact); never the ones that are fine', () => {
  const r = cands(worthIdx(), gapTarget(), { minKindSamples: 2, minError: 0.06 });
  assert.equal(r.ok, true, r.reason);
  const keys = r.candidates.map(key);
  // gap: VERTICAL+FLASH (3 guns) and COMPENSATOR (3 guns) come first; impact: HALF+SUPPRESSOR (grip+muzzle kind is ~20% off)
  assert.deepEqual(keys.slice(0, 2).sort(), [`${VERT}/${FLASH}/0`, `0/${MUZ}/0`].sort());
  const impact = r.candidates.find((c) => key(c) === `${HALF}/${SUP}/0`);
  assert.ok(impact, 'HALF + SUPPRESSOR is worth adding on impact');
  assert.equal(impact.gap, null);
  assert.ok(impact.expectedError > 0.06);
  assert.ok(Math.abs(impact.multiplier - 0.93 * 0.95) < 1e-6);
  assert.ok(r.candidates.slice(0, 2).every((c) => c.gap && c.gap.n === 3));
  assert.ok(!keys.includes(`0/${FLASH}/0`) && !keys.includes(`0/${SUP}/0`), 'muzzle-only combinations are exact: not suggested');
  assert.ok(!keys.includes(`${THUMB}/0/0`), 'a kind with no data is not guessed');
  assert.ok(r.candidates.every((c, i, a) => i === 0 || (a[i - 1].gap ? 1 : 0) >= (c.gap ? 1 : 0)), 'gap ones before impact ones');
  assert.ok(r.total > 100, 'the pool is every combination the gun does not own');
});

test('comboCandidates: owned combinations are never suggested; limit and thresholds apply; reasons when it cannot', () => {
  const idx = worthIdx();
  const withOwn = build({ ...{ AUG: [Ex(0, 0, 0), own(HALF, SUP, 0, 0.93 * 0.95, 0.7)] }, M416: [Ex(0, 0, 0, 0, 1.05), own(VERT, FLASH, 0, 0.85 * 0.8 * 1.05, 0.8), own(HALF, SUP, 0, 0.93 * 0.95 * 1.05, 0.7)], Scar: [Ex(0, 0, 0, 0, 0.95), own(VERT, FLASH, 0, 0.85 * 0.8 * 0.95, 0.8)] });
  assert.ok(!cands(withOwn, gapTarget(), { minKindSamples: 1 }).candidates.map(key).includes(`${HALF}/${SUP}/0`));
  assert.equal(cands(idx, gapTarget(), { minKindSamples: 2, limit: 1 }).candidates.length, 1);
  assert.equal(cands(idx, gapTarget(), { minKindSamples: 2, minError: 0.9 }).candidates.every((c) => c.gap), true, 'nothing passes on impact alone; only gaps remain');
  assert.equal(cands(idx, gapTarget(), { minKindSamples: 99 }).candidates.every((c) => c.gap), true, 'kinds with too few samples are not trusted');
  assert.match(cands(idx, gapTarget({ weapon: W('MORTAR') })).reason, /luôn dùng đường cong 0/);
  assert.match(cands(build({ M416: [Ex(0, 0, 0)] }), gapTarget()).reason, /đường cong nền/);
});

test('comboCandidates: impact candidates are spread over kinds (at most perKind of each)', () => {
  const idx = build({
    AUG: [Ex(0, 0, 0)],
    M416: [Ex(0, 0, 0, 0, 1.05), own(VERT, FLASH, 0, 0.85 * 0.8 * 1.05, 0.8), own(VERT, 0, GEN, 0.85 * 0.9 * 1.05, 0.7), own(0, MUZ, 0, 0.9 * 1.05, 1)],
    Scar: [Ex(0, 0, 0, 0, 0.95), own(VERT, FLASH, 0, 0.85 * 0.8 * 0.95, 0.8), own(VERT, 0, GEN, 0.85 * 0.9 * 0.95, 0.7)],
  });
  const r = cands(idx, gapTarget(), { minKindSamples: 2, perKind: 2, limit: 20 });
  const impact = r.candidates.filter((c) => !c.gap);
  const per = {};
  for (const c of impact) per[c.kind] = (per[c.kind] || 0) + 1;
  assert.ok(Object.values(per).every((n) => n <= 2), JSON.stringify(per));
  assert.ok(Object.keys(per).length >= 2, 'two kinds are both far off: both appear');
});
