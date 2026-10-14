'use strict';
// When the table is filtered, the suggestions follow the filter: the server picks its candidates INSIDE it, and the AI is told about it.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./admin/recoil');
const S = require('./suggest');
const { buildRankMessages } = require('./ai');

const W = (n) => R.WEAPONS.indexOf(n);
const SC = R.SCOPES.indexOf('X1');
const G = (n) => R.GRIPS.indexOf(n);
const M = (n) => R.MUZZLES.indexOf(n);
const COEF = { compensatorMuzzle: 0.9, flashHidderMuzzle: 0.8, suppressorMuzzle: 0.95, verticalGrip: 0.85, horizontalGrip: 0.97, halfGrip: 0.93, lightGrip: 0.98, thumbGrip: 0.8, laserGrip: 0.99, generalStock: 0.9, crouch: 0.8, prone: 0.6, stand: 1 };
const BASE = [[0, 100], [100, 80], [200, 60]];
const times = (c, k) => c.map(([t, v]) => [t, v * k]);
function build(guns) {
  const groups = Array.from({ length: 70 }, () => ({ v: [], coefficients: Array.from({ length: 13 }, () => ({ ...COEF })) }));
  for (const [name, entries] of Object.entries(guns)) groups[W(name)].v.push(...entries);
  return R.indexData(groups);
}
const e = (grip, muzzle, stock, k) => ({ scope: SC, grip, muzzle, stock, gesture: 0, recoilValue: times(BASE, k) });
// M416 takes everything; the similar guns own a few combinations (grip + muzzle: the kind that the coefficients get wrong by 20%)
function idxFor() {
  const gun = (k) => [e(0, 0, 0, k), e(G('VERTICAL'), M('COMPENSATOR'), 0, 0.85 * 0.9 * 0.8 * k), e(G('THUMB'), M('FLASH_HIDER'), 0, 0.8 * 0.8 * 0.8 * k), e(G('LIGHT'), M('SUPPRESSOR'), 0, 0.98 * 0.95 * 0.8 * k)];
  return build({ M416: [e(0, 0, 0, 1)], Scar: gun(0.95), QBZ: gun(1.02), G36C: gun(1.05) });
}
const target = { weapon: W('M416'), scope: SC, gesture: 0 };
const opts = { minKindSamples: 2, minError: 0.06, limit: 100, perKind: 100 };
const key = (c) => `${R.GRIPS[c.grip]}/${R.MUZZLES[c.muzzle]}/${R.STOCKS[c.stock]}`;

test('constraints: only combinations whose grip, muzzle and stock are all inside the chosen sets are candidates', () => {
  const idx = idxFor();
  const free = S.comboCandidates(idx, target, opts);
  assert.ok(free.candidates.length > 6);
  const vertical = S.comboCandidates(idx, target, { ...opts, constraints: { grips: [G('VERTICAL')] } });
  assert.ok(vertical.candidates.length > 0);
  assert.ok(vertical.candidates.every((c) => c.grip === G('VERTICAL')), vertical.candidates.map(key).join(' '));
  const both = S.comboCandidates(idx, target, { ...opts, constraints: { grips: [G('VERTICAL'), G('LIGHT')], muzzles: [M('COMPENSATOR')] } });
  assert.ok(both.candidates.length > 0 && both.candidates.every((c) => [G('VERTICAL'), G('LIGHT')].includes(c.grip) && c.muzzle === M('COMPENSATOR')), both.candidates.map(key).join(' '));
  const stock = S.comboCandidates(idx, target, { ...opts, constraints: { stocks: [0] } });
  assert.ok(stock.candidates.every((c) => c.stock === 0));
  assert.deepEqual(S.comboCandidates(idx, target, { ...opts, constraints: { grips: [] } }).candidates, [], 'nothing allowed: nothing suggested');
  assert.deepEqual(S.comboCandidates(idx, target, { ...opts, constraints: {} }).candidates.map(key), free.candidates.map(key), 'no constraint on a slot = free');
  assert.ok(vertical.total < free.total, 'the pool shrinks with the filter');
});

test('constraints are added to the accessory rules, never instead of them', () => {
  const idx = idxFor();
  const aug = { weapon: W('AUG'), scope: SC, gesture: 0 }; // takes no stock
  const r = S.comboCandidates(build({ AUG: [e(0, 0, 0, 1)], Scar: [e(0, 0, 0, 0.95)] }), aug, { ...opts, constraints: { stocks: [R.STOCKS.indexOf('GENERAL')] } });
  assert.deepEqual(r.candidates, [], 'the filter asks for a stock, the gun cannot take one');
  assert.equal(idx.map.size > 0, true);
});

test('with a filter the best candidates INSIDE it come first (not the overall best that the filter then hides)', () => {
  const idx = idxFor();
  const limited = { ...opts, limit: 3, perKind: 3 };
  const overall = S.comboCandidates(idx, target, limited).candidates;
  const light = S.comboCandidates(idx, target, { ...limited, constraints: { grips: [G('LIGHT')] } }).candidates;
  assert.equal(light.length, 3, 'a full list even though few of the overall best have the light grip');
  assert.ok(light.every((c) => c.grip === G('LIGHT')));
  assert.ok(overall.filter((c) => c.grip === G('LIGHT')).length < 3, 'filtering the overall top 3 afterwards would have left fewer');
});

test('candidates carry the numbers of their coefficient curve, so the number columns can filter them', () => {
  const c = S.comboCandidates(idxFor(), target, opts).candidates[0];
  for (const k of ['v0', 'vEnd', 'duration', 'points']) assert.equal(typeof c.stats[k], 'number', k);
  assert.equal(c.stats.points, 3);
  assert.equal(c.stats.duration, 200);
  assert.ok(c.stats.v0 > 0 && c.stats.vEnd > 0 && c.stats.v0 > c.stats.vEnd);
  const comp = R.computedFor(idxFor(), { ...target, grip: c.grip, muzzle: c.muzzle, stock: c.stock });
  assert.ok(Math.abs(c.stats.v0 - comp.curve[0][1]) < 1e-9);
});

test('the AI is told about the filter, and asked to start over when the user presses "AI tạo lại"', () => {
  const idx = idxFor();
  const found = S.comboCandidates(idx, target, { ...opts, constraints: { grips: [G('VERTICAL')] } });
  const userFilter = { grips: ['VERTICAL'], muzzles: null, stocks: null, text: 'Tay cầm: Tay cầm đứng' };
  const plain = JSON.parse(buildRankMessages(idx, target, found.candidates)[1].content.split('\n').slice(1).join('\n'));
  assert.equal(plain.user_filter, undefined, 'no filter, nothing said');
  assert.equal(plain.regenerate, undefined);
  const msgs = buildRankMessages(idx, target, found.candidates, { userFilter, regenerate: true });
  const data = JSON.parse(msgs[1].content.split('\n').slice(1).join('\n'));
  assert.deepEqual(data.user_filter, userFilter);
  assert.equal(data.regenerate, true);
  assert.match(msgs[0].content, /user_filter/);
  assert.match(msgs[0].content, /regenerate/);
});

test('missing lists EVERY combination the gun can still take; the candidates are only the best few of them', () => {
  const idx = idxFor();
  const r = S.comboCandidates(idx, target, { minKindSamples: 2, minError: 0.06, limit: 2, perKind: 1 });
  assert.equal(r.missing.length, r.total, 'one entry per combination without an own entry');
  assert.ok(r.candidates.length <= 2 && r.missing.length > r.candidates.length);
  for (const c of r.candidates) assert.ok(r.missing.some((m) => key(m) === key(c)), 'every candidate is also in the full list');
  assert.equal(new Set(r.missing.map(key)).size, r.missing.length, 'no combination twice');
  assert.ok(!r.missing.some((m) => key(m) === `${R.GRIPS[0]}/${R.MUZZLES[0]}/${R.STOCKS[0]}`), 'the base curve is not a missing combination');
  assert.ok(r.missing.every((m) => m.stats && typeof m.stats.v0 === 'number'), 'each one carries the numbers of its coefficient curve');
  // the table filter narrows the whole list, not only the candidates
  const vertical = S.comboCandidates(idx, target, { minKindSamples: 2, minError: 0.06, limit: 2, constraints: { grips: [G('VERTICAL')] } });
  assert.ok(vertical.missing.length > 0 && vertical.missing.every((m) => m.grip === G('VERTICAL')));
  assert.equal(vertical.missing.length, vertical.total);
  // the attachment rules of the gun narrow it too: AUG takes no stock
  const aug = S.comboCandidates(build({ AUG: [e(0, 0, 0, 1)], Scar: [e(0, 0, 0, 0.95)] }), { weapon: W('AUG'), scope: SC, gesture: 0 }, opts);
  assert.ok(aug.missing.length > 0 && aug.missing.every((m) => m.stock === 0));
});
