'use strict';
// "Tiêu chuẩn súng" → "Sửa tiêu chuẩn": the user's corrections win over the built-in table everywhere, are kept on disk, and can be undone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('./admin/recoil');
const { GunStandards } = require('./gun-standards');

const W = (n) => R.WEAPONS.indexOf(n);
const X6 = R.SCOPES.indexOf('X6');
const VERTICAL = R.GRIPS.indexOf('VERTICAL');
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'std-')), 'gun-standards.json');

test.afterEach(() => {
  R.setRuleOverrides({}); // RecoilLib is shared by the whole process
  R.setDisabledGuns([]);
  R.setFireOverrides({});
});

test('a correction changes what the checks allow, is kept on disk, and "Khôi phục mặc định" brings the table back', () => {
  const file = tmpFile();
  const s = new GunStandards({ file });
  assert.equal(R.comboProblems(W('AUG'), X6, { grip: VERTICAL }).length, 0, 'the official table: AUG takes a vertical grip and a 6x');
  assert.equal(s.set('AUG', { muzzles: ['COMPENSATOR'], grips: [], stocks: [], maxZoom: 4, note: 'thực tế trong game' }).ok, true);
  const a = R.attachmentsFor(W('AUG'));
  assert.equal(a.edited, true);
  assert.equal(a.source, 'edited');
  assert.deepEqual(R.comboProblems(W('AUG'), X6, { grip: VERTICAL }).map((p) => p.slot).sort(), ['grip', 'scope']);
  // a new server (restart) reads it back
  R.setRuleOverrides({});
  const again = new GunStandards({ file });
  assert.equal(R.attachmentsFor(W('AUG')).maxZoom, 4);
  assert.deepEqual(Object.keys(again.list()), ['AUG']);
  // back to the table
  assert.equal(again.reset('AUG').ok, true);
  assert.equal(R.attachmentsFor(W('AUG')).edited, false);
  assert.equal(R.comboProblems(W('AUG'), X6, { grip: VERTICAL }).length, 0);
  assert.equal(again.reset('AUG').ok, false, 'nothing left to undo');
});

test('a gun without a rule can get one, and a rule can be switched off (null = nothing refused)', () => {
  const s = new GunStandards({ file: tmpFile() });
  assert.equal(R.attachmentsFor(W('Mosin')), null);
  assert.equal(s.set('Mosin', { muzzles: ['SUPPRESSOR'], grips: [], stocks: [], maxZoom: 8 }).ok, true);
  assert.equal(R.comboProblems(W('Mosin'), X6, { muzzle: R.MUZZLES.indexOf('COMPENSATOR') }).length, 1);
  assert.equal(s.set('M416', null).ok, true);
  assert.equal(R.attachmentsFor(W('M416')), null);
});

test('disabling and enabling a gun is persisted and reflected in RecoilLib.isGunDisabled', () => {
  const file = tmpFile();
  const s = new GunStandards({ file });
  assert.equal(R.isGunDisabled('AUG'), false);
  assert.equal(R.isGunDisabled(W('AUG')), false);
  assert.deepEqual(s.listDisabled(), []);

  const res = s.setDisabled('AUG', true);
  assert.equal(res.ok, true);
  assert.deepEqual(res.disabled, ['AUG']);
  assert.deepEqual(s.listDisabled(), ['AUG']);
  assert.equal(R.isGunDisabled('AUG'), true);
  assert.equal(R.isGunDisabled(W('AUG')), true);
  assert.equal(R.attachmentsFor(W('AUG')).disabled, true);

  // A new instance (simulating server restart) reads disabled guns back
  R.setDisabledGuns([]);
  assert.equal(R.isGunDisabled('AUG'), false);
  const again = new GunStandards({ file });
  assert.deepEqual(again.listDisabled(), ['AUG']);
  assert.equal(R.isGunDisabled('AUG'), true);
  assert.equal(R.isGunDisabled(W('AUG')), true);

  // Re-enable the gun
  assert.equal(again.setDisabled('AUG', false).ok, true);
  assert.deepEqual(again.listDisabled(), []);
  assert.equal(R.isGunDisabled('AUG'), false);
  assert.equal(R.isGunDisabled(W('AUG')), false);

  // Bad weapon code is refused
  assert.equal(s.setDisabled('NOPE', true).ok, false);
  assert.equal(s.setDisabled(R.WEAPONS[0], true).ok, false);
  assert.equal(s.setDisabled(123, true).ok, false);
});

test('bad corrections are refused and change nothing', () => {
  const s = new GunStandards({ file: tmpFile() });
  assert.equal(s.set('NOPE', { muzzles: [], grips: [], stocks: [] }).ok, false);
  assert.equal(s.set('AUG', { muzzles: ['LASER'], grips: [], stocks: [] }).ok, false, 'a grip is not a muzzle');
  assert.equal(s.set('AUG', { muzzles: [], grips: ['None'], stocks: [] }).ok, false);
  assert.equal(s.set('AUG', { muzzles: [], grips: [], stocks: [], maxZoom: 5 }).ok, false);
  assert.equal(s.set('AUG', 'x').ok, false);
  assert.deepEqual(s.list(), {});
  assert.equal(R.attachmentsFor(W('AUG')).edited, false);
});


test('fire parameters: kept on disk, read back by a new server, undone by resetFire', () => {
  const file = tmpFile();
  const s = new GunStandards({ file });
  assert.equal(s.setFire('M416', { magazine: 40, interval: 0.09 }).ok, true);
  assert.equal(R.fireOf('M416').emptyMs, 3510);
  R.setFireOverrides({}); // a new server (restart) reads it back
  const again = new GunStandards({ file });
  assert.equal(R.fireOf('M416').emptyMs, 3510);
  assert.deepEqual(again.listFire(), { M416: { magazine: 40, interval: 0.09 } });
  assert.equal(again.resetFire('M416').ok, true);
  assert.equal(R.fireOf('M416').emptyMs, 2465, 'back to the default');
  assert.equal(again.resetFire('M416').ok, false, 'nothing left to undo');
  assert.match(again.resetFire('M416').error, /chưa được sửa/);
});

test('fire parameters: null removes the data of a gun; a bad code or bad numbers are refused and change nothing', () => {
  const s = new GunStandards({ file: tmpFile() });
  assert.equal(s.setFire('AKM', null).ok, true);
  assert.equal(R.fireOf('AKM'), null);
  for (const [code, fire] of [['Foo', { magazine: 5, interval: 1 }], ['Empty', { magazine: 5, interval: 1 }], [7, { magazine: 5, interval: 1 }], ['M416', { magazine: 9999, interval: 1 }], ['M416', { magazine: 30, interval: 0 }], ['M416', 'x']]) {
    const r = s.setFire(code, fire);
    assert.equal(r.ok, false, JSON.stringify([code, fire]));
    assert.equal(typeof r.error, 'string');
  }
  assert.deepEqual(s.listFire(), { AKM: null });
});

test('an old gun-standards.json without "fire" loads, and rubbish in "fire" is dropped without an error', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ overrides: {}, disabled: [] }));
  assert.deepEqual(new GunStandards({ file }).listFire(), {});
  fs.writeFileSync(file, JSON.stringify({ overrides: {}, disabled: [], fire: { M416: { magazine: 0, interval: 1 }, X: 3, AKM: { magazine: 20, interval: 0.1 } } }));
  const s = new GunStandards({ file });
  assert.deepEqual(s.listFire(), { AKM: { magazine: 20, interval: 0.1 } });
  fs.writeFileSync(file, JSON.stringify({ overrides: {}, disabled: [], fire: 5 }));
  assert.deepEqual(new GunStandards({ file }).listFire(), {});
});
