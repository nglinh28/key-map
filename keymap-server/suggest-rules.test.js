'use strict';
// Suggestions never propose an accessory the gun does not take.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./admin/recoil');
const S = require('./suggest');

const W = (n) => R.WEAPONS.indexOf(n);
const SC = (n) => R.SCOPES.indexOf(n);
const G = (n) => R.GRIPS.indexOf(n);
const M = (n) => R.MUZZLES.indexOf(n);
const K = (n) => R.STOCKS.indexOf(n);
const COEF = { compensatorMuzzle: 0.9, flashHidderMuzzle: 0.8, suppressorMuzzle: 0.95, verticalGrip: 0.85, horizontalGrip: 0.97, halfGrip: 0.93, lightGrip: 0.98, thumbGrip: 0.8, laserGrip: 0.99, generalStock: 0.9, crouch: 0.8, prone: 0.6, stand: 1 };
const BASE = [[0, 100], [100, 80], [200, 60]];
const times = (c, k) => c.map(([t, v]) => [t, v * k]);

test.afterEach(() => {
  R.setDisabledGuns([]);
});

function build(guns) {
  const groups = Array.from({ length: 70 }, () => ({ v: [], coefficients: Array.from({ length: 13 }, () => ({ ...COEF })) }));
  for (const [name, entries] of Object.entries(guns)) groups[W(name)].v.push(...entries);
  return R.indexData(groups);
}
const own = (scope, grip, muzzle, stock, mult, k, ge = 0) => ({ scope: SC(scope), grip, muzzle, stock, gesture: ge, recoilValue: times(BASE, mult * k) });
const base = (scope, k = 1) => ({ scope: SC(scope), grip: 0, muzzle: 0, stock: 0, gesture: 0, recoilValue: times(BASE, k) });

// similar guns that own every kind of combination, the way the real data does
function template(scope) {
  const gun = (k) => [base(scope, k), own(scope, G('VERTICAL'), M('FLASH_HIDER'), 0, 0.85 * 0.8 * k, 0.8), own(scope, 0, M('COMPENSATOR'), 0, 0.9 * k, 1), own(scope, 0, 0, K('GENERAL'), 0.9 * k, 0.8), own(scope, G('THUMB'), 0, K('GENERAL'), 0.8 * 0.9 * k, 0.8), own(scope, G('LASER'), M('BRAKE'), 0, 0.99 * k, 0.9)];
  return { M416: gun(1.05), Scar: gun(0.95), QBZ: gun(1.02) };
}
const all = (o = {}) => ({ minKindSamples: 2, minError: 0, limit: 200, perKind: 200, ...o });
const keys = (r) => r.candidates.map((c) => `${R.GRIPS[c.grip]}/${R.MUZZLES[c.muzzle]}/${R.STOCKS[c.stock]}`);

test('AUG takes no stock: a combination with one is never a candidate, however well the similar guns support it', () => {
  const idx = build({ AUG: [base('X1')], ...template('X1') });
  const r = S.comboCandidates(idx, { weapon: W('AUG'), scope: SC('X1'), gesture: 0 }, all());
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.candidates.length > 0);
  assert.ok(r.candidates.every((c) => c.stock === 0), keys(r).filter((k) => !k.endsWith('/None')).join(' '));
  assert.ok(r.candidates.every((c) => R.comboProblems(W('AUG'), SC('X1'), c).length === 0));
  assert.ok(!keys(r).some((k) => k.includes('BRAKE') || k.includes('ERGONOMIC')), 'accessories that no source lists are not suggested either');
  assert.deepEqual(R.comboProblems(W('AUG'), SC('X1'), { grip: G('LASER') }), [], 'the laser sight is a grip AUG takes');
  const free = S.comboCandidates(idx, { weapon: W('AUG'), scope: SC('X1'), gesture: 0 }, all({ allowed: () => true }));
  assert.ok(free.candidates.some((c) => c.stock !== 0), 'without the rules the stock combinations would be there');
  assert.ok(free.total > r.total, 'the pool shrinks by what the gun cannot take');
});

test('the same data gives M416 its stock combinations, and AKM neither stock nor grip', () => {
  const idx = build({ M416: [base('X1', 1.05), own('X1', G('VERTICAL'), M('FLASH_HIDER'), 0, 0.85 * 0.8 * 1.05, 0.8)], AKM: [base('X1')], ...Object.fromEntries(Object.entries(template('X1')).filter(([n]) => n !== 'M416')) });
  const m416 = S.comboCandidates(idx, { weapon: W('M416'), scope: SC('X1'), gesture: 0 }, all());
  assert.ok(m416.candidates.some((c) => c.stock === K('GENERAL')), 'M416 takes the tactical stock');
  const akm = S.comboCandidates(idx, { weapon: W('AKM'), scope: SC('X1'), gesture: 0 }, all());
  assert.ok(akm.candidates.length > 0);
  assert.ok(akm.candidates.every((c) => c.grip === 0 && c.stock === 0), keys(akm).join(' '));
  assert.ok(akm.candidates.every((c) => c.muzzle === M('COMPENSATOR') || c.muzzle === M('FLASH_HIDER') || c.muzzle === M('SUPPRESSOR')));
});

test('a scope beyond what the gun takes gives no candidates at all; a gun without rules is not restricted', () => {
  const idx = build({ AKM: [base('X8')], M416: [base('X8', 1.05), own('X8', 0, M('COMPENSATOR'), 0, 0.9 * 1.05, 1)], Scar: [base('X8', 0.95), own('X8', 0, M('COMPENSATOR'), 0, 0.9 * 0.95, 1)], PKM: [base('X8')] });
  assert.equal(S.comboCandidates(idx, { weapon: W('AKM'), scope: SC('X8'), gesture: 0 }, all()).candidates.length, 0, 'AKM stops at 6x');
  const mg = S.comboCandidates(idx, { weapon: W('PKM'), scope: SC('X8'), gesture: 0 }, all());
  assert.ok(mg.candidates.length > 0, 'PKM is not in the table');
  assert.ok(mg.candidates.some((c) => c.grip === G('LASER') || c.muzzle === M('BRAKE') || c.stock === K('GENERAL_NEW')) || mg.candidates.length > 0);
});

test('gaps respect the rules too', () => {
  const idx = build({ AUG: [base('X1')], ...template('X1') });
  const g = S.comboGaps(idx, { weapon: W('AUG'), scope: SC('X1'), gesture: 0 }, { minSupport: 2 });
  assert.ok(g.candidates.every((c) => c.stock === 0 && c.grip !== G('LASER')), JSON.stringify(g.candidates.map((c) => [c.grip, c.muzzle, c.stock])));
  assert.equal(S.comboGaps(idx, { weapon: W('AUG'), scope: SC('X1'), gesture: 0 }, { minSupport: 2, allowed: () => true }).candidates.some((c) => c.stock !== 0), true);
});

test('disabled guns are excluded from candidates, gaps, analogCurve, and similar guns', () => {
  const idx = build({ AUG: [base('X1')], Scar: [base('X1', 0.95)], ...template('X1') });
  R.setDisabledGuns(['AUG']);

  // Disabled target weapon is rejected
  const cand = S.comboCandidates(idx, { weapon: W('AUG'), scope: SC('X1'), gesture: 0 }, all());
  assert.equal(cand.ok, false);
  assert.match(cand.reason, /đã bị tắt/);
  assert.deepEqual(cand.candidates, []);

  const gaps = S.comboGaps(idx, { weapon: W('AUG'), scope: SC('X1'), gesture: 0 }, { minSupport: 2 });
  assert.equal(gaps.ok, false);
  assert.match(gaps.reason, /đã bị tắt/);
  assert.deepEqual(gaps.candidates, []);

  const curve = S.analogCurve(idx, { weapon: W('AUG'), scope: SC('X1'), gesture: 0, grip: 0, muzzle: 0, stock: 0 });
  assert.equal(curve.ok, false);
  assert.match(curve.reason, /đã bị tắt/);

  // When another weapon asks for similar guns, the disabled gun AUG is not included
  const sim = S.similarGuns(idx, { weapon: W('Scar'), scope: SC('X1'), gesture: 0, grip: 0, muzzle: 0, stock: 0 });
  assert.ok(!sim.some((g) => g.weapon === W('AUG')), 'AUG should not be among similar guns');

  const simByBase = S.similarByBase(idx, W('Scar'), SC('X1'));
  assert.ok(!simByBase.some((g) => g.weapon === W('AUG')), 'AUG should not be in similarByBase');
});

