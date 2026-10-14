'use strict';
// The AI is told what each gun can take, and is never asked about what it cannot.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./admin/recoil');
const S = require('./suggest');
const { buildMessages, buildRankMessages } = require('./ai');

const W = (n) => R.WEAPONS.indexOf(n);
const SC = R.SCOPES.indexOf('X1');
const G = (n) => R.GRIPS.indexOf(n);
const M = (n) => R.MUZZLES.indexOf(n);
const K = (n) => R.STOCKS.indexOf(n);
const COEF = { compensatorMuzzle: 0.9, flashHidderMuzzle: 0.8, suppressorMuzzle: 0.95, verticalGrip: 0.85, horizontalGrip: 0.97, halfGrip: 0.93, lightGrip: 0.98, thumbGrip: 0.8, laserGrip: 0.99, generalStock: 0.9, crouch: 0.8, prone: 0.6, stand: 1 };
const BASE = [[0, 100], [100, 80], [200, 60]];
const E = (grip, muzzle, stock, recoilValue) => ({ scope: SC, grip, muzzle, stock, gesture: 0, recoilValue });
function build(guns) {
  const groups = Array.from({ length: 70 }, () => ({ v: [], coefficients: Array.from({ length: 13 }, () => ({ ...COEF })) }));
  for (const [name, entries] of Object.entries(guns)) groups[W(name)].v.push(...entries);
  return R.indexData(groups);
}
const idx = build({
  AUG: [E(0, 0, 0, BASE)], M416: [E(0, 0, 0, BASE), E(0, M('COMPENSATOR'), 0, BASE)], Scar: [E(0, 0, 0, BASE), E(0, M('COMPENSATOR'), 0, BASE)],
  PKM: [E(0, 0, 0, BASE)], AKM: [E(0, 0, 0, BASE)],
});
const json = (message) => JSON.parse(message.content.slice(message.content.indexOf('{')));

test('the curve question carries what the gun can take, where it comes from, and whether the combination fits', () => {
  const aug = json(buildMessages(idx, { weapon: W('AUG'), scope: SC, gesture: 0, grip: 0, muzzle: M('COMPENSATOR'), stock: 0 })[1]).target;
  assert.equal(aug.accessory_rules.known, true);
  assert.deepEqual(aug.accessory_rules.stocks, [], 'AUG takes no stock');
  assert.ok(aug.accessory_rules.grips.includes('LASER') && aug.accessory_rules.grips.includes('VERTICAL'));
  assert.deepEqual(aug.accessory_rules.muzzles.slice().sort(), ['COMPENSATOR', 'FLASH_HIDER', 'SUPPRESSOR']);
  assert.equal(aug.accessory_rules.max_scope_zoom, 6);
  assert.match(aug.accessory_rules.source, /chính thức/);
  assert.deepEqual(aug.combination_problems, []);
  // a combination the gun cannot take is said so
  const bad = json(buildMessages(idx, { weapon: W('AKM'), scope: SC, gesture: 0, grip: G('THUMB'), muzzle: 0, stock: K('GENERAL') })[1]).target;
  assert.equal(bad.combination_problems.length, 2);
  assert.match(bad.combination_problems.join(' '), /AKM không hỗ trợ tay cầm/);
  // a gun that no source covers: the AI is told not to invent a restriction
  const pkm = json(buildMessages(idx, { weapon: W('PKM'), scope: SC, gesture: 0, grip: 0, muzzle: M('COMPENSATOR'), stock: 0 })[1]).target;
  assert.equal(pkm.accessory_rules.known, false);
  assert.match(pkm.accessory_rules.note, /do not assume/i);
  assert.match(buildMessages(idx, { weapon: W('AUG'), scope: SC, gesture: 0, grip: 0, muzzle: 0, stock: 0 })[0].content, /accessory_rules/);
});

test('the ranking question carries the same rules, and candidates that break them are never sent', () => {
  const target = { weapon: W('AUG'), scope: SC, gesture: 0 };
  const found = S.comboCandidates(idx, target, { minKindSamples: 1, minError: 0, limit: 50, perKind: 50 });
  assert.ok(found.candidates.length > 0);
  const msgs = buildRankMessages(idx, target, found.candidates);
  const data = json(msgs[1]);
  assert.equal(data.accessory_rules.known, true);
  assert.deepEqual(data.accessory_rules.stocks, []);
  assert.ok(data.candidates.every((c) => c.accessories.stock === 'None' || c.accessories.stock === R.STOCKS[0]), JSON.stringify(data.candidates.map((c) => c.accessories.stock)));
  assert.ok(data.candidates.every((c) => !['ERGONOMIC', 'BRAKE'].includes(c.accessories.grip) && !['BRAKE', 'EXTENDER', 'BRAKE_NEW'].includes(c.accessories.muzzle)));
  assert.ok(found.candidates.every((c) => R.comboProblems(target.weapon, target.scope, c).length === 0));
  assert.match(msgs[0].content, /accessory_rules/);
  // for a gun without a rule the message says so
  const pkm = json(buildRankMessages(idx, { weapon: W('PKM'), scope: SC, gesture: 0 }, [{ grip: 0, muzzle: M('COMPENSATOR'), stock: 0, expectedError: 0.1, multiplier: 0.9, gap: null }])[1]);
  assert.equal(pkm.accessory_rules.known, false);
});
