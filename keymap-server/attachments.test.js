'use strict';
// Which accessories a gun supports: the official Tencent data of 和平精英 (checked against the table the user supplied), matched to the gun codes of the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./admin/recoil');

const W = (n) => R.WEAPONS.indexOf(n);
const S = (n) => R.SCOPES.indexOf(n);
const G = (n) => R.GRIPS.indexOf(n);
const M = (n) => R.MUZZLES.indexOf(n);
const K = (n) => R.STOCKS.indexOf(n);
const COEF = { compensatorMuzzle: 0.9, flashHidderMuzzle: 0.8, suppressorMuzzle: 0.95, verticalGrip: 0.85, horizontalGrip: 0.97, halfGrip: 0.93, lightGrip: 0.98, thumbGrip: 0.8, laserGrip: 0.99, generalStock: 0.9, crouch: 0.8, prone: 0.6, stand: 1 };
const groups = (fill) => {
  const g = Array.from({ length: 70 }, () => ({ v: [], coefficients: Array.from({ length: 13 }, () => ({ ...COEF })) }));
  fill(g);
  return g;
};
const entry = (grip, muzzle, stock, scope, gesture, recoilValue) => ({ grip, muzzle, stock, scope, gesture, recoilValue });

const allowed = (name, slot) => [...R.attachmentsFor(W(name))[slot]].map((i) => ({ grips: R.GRIPS, muzzles: R.MUZZLES, stocks: R.STOCKS }[slot][i])).sort();
const GRIPS6 = ['HALF', 'HORIZONTAL', 'LASER', 'LIGHT', 'THUMB', 'VERTICAL']; // Tencent puts the laser sight in the grip slot
const GRIPS5 = ['HALF', 'HORIZONTAL', 'LIGHT', 'THUMB', 'VERTICAL'];
const MZ = ['COMPENSATOR', 'FLASH_HIDER', 'SUPPRESSOR'];
const shape = (name) => [allowed(name, 'muzzles'), allowed(name, 'grips'), allowed(name, 'stocks'), R.attachmentsFor(W(name)).maxZoom];
const NONE = [];

test('table: every gun and option in it exists in the app enums; 36 guns are covered', () => {
  const names = Object.keys(R.ATTACHMENT_RULES);
  assert.equal(names.length, 36);
  for (const name of names) {
    assert.ok(R.WEAPONS.includes(name), `unknown gun code ${name}`);
    const a = R.attachmentsFor(W(name));
    for (const i of a.grips) assert.ok(i > 0 && i < R.GRIPS.length);
    for (const i of a.muzzles) assert.ok(i > 0 && i < R.MUZZLES.length);
    for (const i of a.stocks) assert.ok(i > 0 && i < R.STOCKS.length);
    assert.ok(['official', 'appmedia', 'user'].includes(a.source), `${name}: source ${a.source}`);
    assert.ok(a.sourceLabel && a.note, name);
    assert.ok(a.maxZoom === null || (Number.isInteger(a.maxZoom) && a.maxZoom >= 0 && a.maxZoom <= 8), `${name}: zoom ${a.maxZoom}`);
  }
  assert.equal(R.WEAPONS.filter((n) => !R.ATTACHMENT_RULES[n]).length, R.WEAPONS.length - 36);
});

test('guns without a source have no rule: nothing is refused for them (waiting for a decision or for data)', () => {
  for (const g of ['Mosin', 'M1014', 'MP5K', 'P90', 'AMR', 'M417', 'JS9', 'PKM', 'HB', 'Empty']) assert.equal(R.attachmentsFor(W(g)), null, g);
});

test('where each rule comes from: the official data, AppMedia for FAMAS and MK12, the user for ACE32 only', () => {
  const src = (n) => R.attachmentsFor(W(n)).source;
  assert.deepEqual(['ACE32', 'FAMAS', 'MK12'].map(src), ['user', 'appmedia', 'appmedia']);
  assert.ok(Object.keys(R.ATTACHMENT_RULES).filter((n) => !['ACE32', 'FAMAS', 'MK12'].includes(n)).every((n) => src(n) === 'official'));
  assert.match(R.attachmentsFor(W('M416')).sourceLabel, /chính thức/);
  assert.match(R.attachmentsFor(W('FAMAS')).sourceLabel, /AppMedia/);
  assert.match(R.attachmentsFor(W('ACE32')).sourceLabel, /người dùng/);
});

test('table: what the official data says for each group of guns [muzzles, grips, stocks, highest scope]', () => {
  assert.deepEqual(shape('M416'), [MZ, GRIPS6, ['GENERAL'], 6], 'M416 has everything');
  for (const g of ['Scar', 'G36C', 'QBZ', 'AUG', 'M762']) assert.deepEqual(shape(g), [MZ, GRIPS6, NONE, 6], `${g}: no stock`);
  assert.deepEqual(shape('ACE32'), [MZ, GRIPS5, NONE, 6], 'ACE32 is not in the official data: the user\'s table stays');
  assert.deepEqual(shape('MK47'), [MZ, GRIPS6, ['GENERAL'], 6], 'the Mk47 takes the tactical stock');
  assert.deepEqual(shape('M16'), [MZ, NONE, ['GENERAL'], 6], 'the M16A4 takes the tactical stock, no grip');
  for (const g of ['AKM', 'FAMAS']) assert.deepEqual(shape(g), [MZ, NONE, NONE, 6], `${g}: muzzle only`);
  assert.deepEqual(shape('Groza'), [['SUPPRESSOR'], NONE, NONE, 6], 'the Groza takes only a suppressor');
  assert.deepEqual(shape('UZI'), [MZ, NONE, ['GENERAL'], 1], 'the Micro UZI: its own stock, Red Dot and Holographic only');
  assert.deepEqual(shape('Vector'), [MZ, ['HALF', 'LASER', 'LIGHT', 'VERTICAL'], ['GENERAL'], 6], 'the Vector has no angled or thumb grip');
  assert.deepEqual(shape('UMP45'), [MZ, GRIPS6, NONE, 6]);
  assert.deepEqual(shape('Thomson'), [['SUPPRESSOR'], ['VERTICAL'], NONE, 1], 'the Tommy Gun: suppressor and vertical grip, 1x');
  assert.deepEqual(shape('Bison'), [MZ, NONE, NONE, 6]);
  for (const g of ['Kar98K', 'M24', 'AWM']) assert.deepEqual(shape(g), [MZ, NONE, NONE, 8], `${g}: cheek pad / bullet loops are not in the app`);
  assert.deepEqual(shape('SKS'), [MZ, GRIPS6, NONE, 8], 'only the SKS of the DMRs takes grips');
  for (const g of ['MK14', 'SLR', 'Mini14', 'QBU', 'MK12']) assert.deepEqual(shape(g), [MZ, NONE, NONE, 8], `${g}: muzzle, no grip`);
  assert.deepEqual(shape('VSS'), [NONE, NONE, NONE, 0], 'the VSS has a built-in suppressor and scope: nothing to fit');
  assert.deepEqual(shape('S12K'), [MZ, NONE, NONE, 6], 'the S12K takes the rifle muzzles (and the Duckbill, which the app does not have)');
  for (const g of ['S1897', 'S686']) assert.deepEqual(shape(g), [NONE, NONE, NONE, 0], `${g}: choke, duckbill, bullet loops are not in the app; no scope`);
  assert.deepEqual(shape('DBS'), [NONE, NONE, NONE, 6]);
  for (const g of ['DP28', 'MG3', 'CrossBow']) assert.deepEqual(shape(g), [NONE, NONE, NONE, 6], `${g}: scope only`);
  assert.deepEqual(shape('Win94'), [NONE, NONE, NONE, 0], 'the Win94 cannot take a scope');
});

test('comboProblems: names the accessory a gun does not take and why; options and scopes beyond the table', () => {
  const o = (weapon, scope, grip = 0, muzzle = 0, stock = 0) => R.comboProblems(W(weapon), S(scope), { grip, muzzle, stock });
  assert.deepEqual(o('M416', 'X1', G('VERTICAL'), M('COMPENSATOR'), K('GENERAL')), [], 'M416 takes all of it');
  assert.deepEqual(o('M416', 'X1', G('LASER')), [], 'the laser sight is a grip the official data lists');
  const stock = o('AUG', 'X1', 0, 0, K('GENERAL'));
  assert.deepEqual(stock.map((p) => p.slot), ['stock']);
  assert.match(stock[0].reason, /AUG không hỗ trợ báng/);
  assert.deepEqual(o('AKM', 'X1', G('THUMB'), M('FLASH_HIDER'), 0).map((p) => p.slot), ['grip'], 'AKM: the muzzle is fine, the grip is not');
  assert.match(o('M416', 'X1', G('ERGONOMIC'))[0].reason, /không nằm trong/, 'in no source');
  assert.match(o('M416', 'X1', 0, M('BRAKE'))[0].reason, /không nằm trong/);
  assert.deepEqual(o('Thomson', 'X1', 0, M('COMPENSATOR')).map((p) => p.slot), ['muzzle']);
  assert.deepEqual(o('Thomson', 'X1', G('VERTICAL'), M('SUPPRESSOR')), []);
  assert.match(o('Thomson', 'X1', G('THUMB'))[0].reason, /không nằm trong/);
  assert.deepEqual(o('Groza', 'X6', 0, M('SUPPRESSOR')), []);
  assert.deepEqual(o('Groza', 'X6', 0, M('COMPENSATOR')).map((p) => p.slot), ['muzzle']);
  // highest magnification per gun
  for (const g of ['M416', 'Scar', 'G36C', 'QBZ', 'ACE32', 'AUG', 'Vector', 'UMP45', 'AKM', 'S12K', 'DP28', 'MG3', 'DBS', 'CrossBow']) {
    assert.deepEqual(o(g, 'X6'), [], `${g}: 6x is fine`);
    assert.deepEqual(o(g, 'X8').map((p) => p.slot), ['scope'], `${g}: 8x is too much`);
  }
  assert.match(o('AKM', 'X8')[0].reason, /tối đa 6x/);
  assert.deepEqual(o('AKM', 'X84').map((p) => p.slot), ['scope'], '4-8x goes up to 8x');
  assert.deepEqual(o('AKM', 'X63'), [], '3-6x');
  for (const g of ['Kar98K', 'M24', 'AWM', 'SKS', 'SLR', 'MK14', 'Mini14', 'QBU', 'MK12']) for (const s of ['X8', 'X84', 'tactic', 'tactic_84']) assert.deepEqual(o(g, s), [], `${g}: ${s}`);
  for (const g of ['UZI', 'Thomson']) { assert.deepEqual(o(g, 'X1'), []); assert.deepEqual(o(g, 'hippie'), []); assert.deepEqual(o(g, 'X2').map((p) => p.slot), ['scope'], `${g}: Red Dot and Holographic only`); }
  for (const g of ['S1897', 'S686', 'Win94', 'VSS']) { assert.deepEqual(o(g, 'hippie'), [], `${g}: hip fire only`); assert.deepEqual(o(g, 'X1').map((p) => p.slot), ['scope'], `${g}: no scope`); }
  assert.deepEqual(o('DP28', 'X1', G('THUMB'), M('COMPENSATOR'), K('GENERAL')).map((p) => p.slot).sort(), ['grip', 'muzzle', 'stock']);
  assert.deepEqual(o('PKM', 'X8', G('LASER'), M('BRAKE'), K('GENERAL_NEW')), [], 'no rule for this gun: nothing is refused');
  assert.equal(o('AKM', 'X8', G('THUMB'), 0, K('GENERAL')).length, 3, 'all the problems are listed');
});

test('describeAttachments: one line for the page', () => {
  assert.equal(R.describeAttachments(W('PKM')), null);
  const akm = R.describeAttachments(W('AKM'));
  assert.match(akm, /Đầu nòng:.*Nòng hãm giật/);
  assert.match(akm, /Tay cầm: không hỗ trợ/);
  assert.match(akm, /Báng: không hỗ trợ/);
  assert.match(akm, /tối đa 6x/);
  assert.match(R.describeAttachments(W('Thomson')), /tối đa 1x/);
  assert.match(R.describeAttachments(W('DP28')), /Đầu nòng: không hỗ trợ · Tay cầm: không hỗ trợ · Báng: không hỗ trợ · Ống ngắm: tối đa 6x/);
  assert.match(R.describeAttachments(W('AWM')), /tối đa 8x/);
  assert.match(R.describeAttachments(W('M416')), /Báng: Báng súng/);
  assert.match(R.describeAttachments(W('M416')), /Tay cầm laser/);
});

test('applyCurveEdit: a NEW entry for an accessory the gun does not take is refused; an existing one can still be edited', () => {
  const data = groups((g) => { g[W('AKM')].v.push(entry(G('THUMB'), 0, 0, S('X1'), 0, [[0, 50], [100, 40]])); });
  const doc = { name: 'cfg', recoil_data: data, ft_recoil_mode_profiles: { normal_touch_recoil_data: data, gyro_recoil_data: data } };
  const akm = (o = {}) => ({ weapon: W('AKM'), scope: S('X1'), grip: 0, muzzle: 0, stock: 0, gesture: 0, ...o });
  assert.doesNotThrow(() => R.applyCurveEdit(doc, 'touch', akm({ grip: G('THUMB') }), [[0, 1]]), 'the entry exists: editing it is allowed');
  assert.throws(() => R.applyCurveEdit(doc, 'touch', akm({ grip: G('VERTICAL') }), [[0, 1]]), /AKM không hỗ trợ tay cầm/);
  assert.throws(() => R.applyCurveEdit(doc, 'touch', akm({ stock: K('GENERAL') }), [[0, 1]]), /báng/);
  assert.throws(() => R.applyCurveEdit(doc, 'touch', akm({ scope: S('X8') }), [[0, 1]]), /tối đa 6x/);
  assert.doesNotThrow(() => R.applyCurveEdit(doc, 'touch', akm({ muzzle: M('SUPPRESSOR') }), [[0, 1]]), 'a supported accessory: a new entry is fine');
  assert.doesNotThrow(() => R.applyCurveEdit(doc, 'touch', akm({ grip: G('VERTICAL') }), [[0, 1]], { allowUnsupported: true }), 'the escape hatch');
  assert.doesNotThrow(() => R.applyCurveEdit(doc, 'touch', { weapon: W('PKM'), scope: S('X1'), grip: G('LASER'), muzzle: 0, stock: 0, gesture: 0 }, [[0, 1]]), 'a gun without rules: not refused');
});

test('M249 takes no grip, muzzle or stock (official data: scopes only, up to 6x), so entries that give it one are against the table', () => {
  const m = W('M249');
  const a = R.attachmentsFor(m);
  assert.equal(a.source, 'official');
  assert.deepEqual([a.grips.size, a.muzzles.size, a.stocks.size, a.maxZoom], [0, 0, 0, 6]);
  const X1 = R.SCOPES.indexOf('X1');
  assert.deepEqual(R.comboProblems(m, X1, {}), []);
  assert.equal(R.comboProblems(m, X1, { grip: R.GRIPS.indexOf('THUMB') })[0].slot, 'grip');
  assert.equal(R.comboProblems(m, X1, { muzzle: R.MUZZLES.indexOf('COMPENSATOR') })[0].slot, 'muzzle');
  assert.equal(R.comboProblems(m, X1, { stock: R.STOCKS.indexOf('GENERAL') })[0].slot, 'stock');
  assert.equal(R.comboProblems(m, R.SCOPES.indexOf('X8'), {})[0].slot, 'scope');
});
