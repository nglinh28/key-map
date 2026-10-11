'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('./admin/edit');

test('paths: parse and format round-trip, including awkward keys', () => {
  assert.deepEqual(E.parsePath('$'), []);
  assert.deepEqual(E.parsePath('$.recoil_data[18].v[3].recoilValue'), ['recoil_data', 18, 'v', 3, 'recoilValue']);
  assert.deepEqual(E.parsePath('$["base:x"][0]'), ['base:x', 0]);
  for (const segs of [[], ['a'], ['a', 0, 'b'], ['base:componentIdentifier'], ['we"ird', 'sp ace', 3], ['1abc']]) {
    assert.deepEqual(E.parsePath(E.formatPath(segs)), segs, JSON.stringify(segs));
  }
  assert.equal(E.formatPath(['recoil_data', 18, 'v']), '$.recoil_data[18].v');
  assert.equal(E.formatPath(['base:x']), '$["base:x"]');
  assert.equal(E.childPath('$.a', 'b'), '$.a.b');
  assert.equal(E.childPath('$.a', 2), '$.a[2]');
  assert.throws(() => E.parsePath('a.b'), /đường dẫn/i);
  assert.throws(() => E.parsePath('$.a['), /đường dẫn/i);
  assert.throws(() => E.parsePath('$..a'), /đường dẫn/i);
});

test('getAt / setAt', () => {
  const doc = { a: { b: [10, 20, { c: 1 }] } };
  assert.equal(E.getAt(doc, E.parsePath('$.a.b[2].c')), 1);
  assert.equal(E.getAt(doc, E.parsePath('$.a.zzz')), undefined);
  assert.equal(E.setAt(doc, E.parsePath('$.a.b[0]'), 99), doc, 'in place, returns the root');
  assert.equal(doc.a.b[0], 99);
  E.setAt(doc, E.parsePath('$.a.b[2]'), { c: 2 });
  assert.deepEqual(doc.a.b[2], { c: 2 });
  assert.equal(E.setAt(doc, [], 'whole'), 'whole', 'empty path replaces the root');
  assert.throws(() => E.setAt({ a: 1 }, E.parsePath('$.x.y'), 1), /không tồn tại/);
  assert.throws(() => E.setAt({ a: [1] }, E.parsePath('$.a[5]'), 1), /không tồn tại/);
  assert.throws(() => E.setAt({}, ['__proto__', 'polluted'], 1), /không hợp lệ/);
  assert.equal({}.polluted, undefined);
});

test('diff lists changed / added / removed leaves with paths', () => {
  const a = { name: 'x', list: [1, 2, 3], nested: { k: 1, gone: true } };
  const b = { name: 'y', list: [1, 5], nested: { k: 1, fresh: 'n' }, extra: [7] };
  const d = E.diff(a, b);
  const by = Object.fromEntries(d.changes.map((c) => [c.path, c]));
  assert.equal(by['$.name'].kind, 'changed');
  assert.deepEqual([by['$.name'].before, by['$.name'].after], ['x', 'y']);
  assert.equal(by['$.list[1]'].kind, 'changed');
  assert.equal(by['$.list[2]'].kind, 'removed');
  assert.equal(by['$.nested.gone'].kind, 'removed');
  assert.equal(by['$.nested.fresh'].kind, 'added');
  assert.equal(by['$.extra'].kind, 'added');
  assert.equal(d.total, d.changes.length);
  assert.equal(E.diff(a, JSON.parse(JSON.stringify(a))).total, 0);
});

test('diff caps the listed changes but still counts them all', () => {
  const a = { v: Array.from({ length: 1000 }, (_, i) => i) };
  const b = { v: Array.from({ length: 1000 }, (_, i) => i + 1) };
  const d = E.diff(a, b, { limit: 50 });
  assert.equal(d.total, 1000);
  assert.equal(d.changes.length, 50);
  assert.equal(d.truncated, true);
});

// ---- structure checks (warnings only; the UI lets the user save after reading them)
const COEF = {
  compensatorMuzzle: 0.9, flashHidderMuzzle: 0.9, suppressorMuzzle: 1, verticalGrip: 0.83, horizontalGrip: 0.97, halfGrip: 0.93,
  lightGrip: 0.97, thumbGrip: 0.9, laserGrip: 1, generalStock: 0.9, stand: 1, crouch: 0.8, prone: 0.6,
};
const goodRecoil = () => ({
  recoil_value_coefficient: 100, sensitivity: [100, 50, 30, 22, 14, 12, 10], version: '0.0.5',
  recoil_data: [{
    v: [{ grip: 0, muzzle: 0, stock: 0, scope: 1, gesture: 0, recoilValue: [[0, 80], [100, 82.5], [400, 90]] }],
    coefficients: Array.from({ length: 13 }, () => ({ ...COEF })),
  }],
});
const msgs = (issues) => issues.map((i) => `${i.level}:${i.path}`);

test('validate: a well-formed recoil document has no issues', () => {
  assert.deepEqual(E.validate('recoil', goodRecoil()), []);
});

test('validate: recoil problems are reported with a path and a level', () => {
  const k = goodRecoil();
  k.recoil_data[0].v[0].scope = 99; // out of the 13 scopes
  k.recoil_data[0].v[0].recoilValue = [[0, 5], [300, 'x'], [200, 7]];
  delete k.recoil_data[0].coefficients[2].crouch;
  k.sensitivity = [1, 2];
  const issues = E.validate('recoil', k);
  const keys = msgs(issues);
  assert.ok(keys.includes('error:$.recoil_data[0].v[0].scope'), keys.join('\n'));
  assert.ok(keys.includes('error:$.recoil_data[0].v[0].recoilValue[1]'), 'non numeric value');
  assert.ok(keys.includes('warn:$.recoil_data[0].v[0].recoilValue[2]'), 'time going backwards');
  assert.ok(keys.includes('error:$.recoil_data[0].coefficients[2].crouch'), 'missing coefficient the app reads');
  assert.ok(keys.includes('warn:$.sensitivity'));
  assert.ok(issues.every((i) => i.message && typeof i.message === 'string'));
});

test('validate: recoil_data missing or wrong shape', () => {
  assert.ok(msgs(E.validate('recoil', { recoil_data: 'x' })).includes('error:$.recoil_data'));
  assert.ok(msgs(E.validate('recoil', {})).includes('error:$.recoil_data'));
  const k = goodRecoil();
  k.recoil_data[0] = { v: 'no', coefficients: {} };
  const keys = msgs(E.validate('recoil', k));
  assert.ok(keys.includes('error:$.recoil_data[0].v') && keys.includes('error:$.recoil_data[0].coefficients'));
  const k2 = goodRecoil();
  k2.ft_recoil_mode_profiles = { gyro_recoil_data: 5 };
  assert.ok(msgs(E.validate('recoil', k2)).includes('error:$.ft_recoil_mode_profiles.gyro_recoil_data'));
});

test('validate: the number of reported issues is capped', () => {
  const k = goodRecoil();
  k.recoil_data[0].v = Array.from({ length: 500 }, () => ({ grip: 99, muzzle: 99, stock: 99, scope: 99, gesture: 99, recoilValue: [[0, 1]] }));
  const issues = E.validate('recoil', k);
  assert.ok(issues.length <= 61);
  assert.match(issues[issues.length - 1].message, /và \d+ vấn đề nữa/);
});

test('validate: keymap and recognition basics', () => {
  const good = { version: '1.0.0', components: [{ 'base:componentIdentifier': 'com.zjx.app:ntp', 'base:x': 1, 'base:y': 2, 'base:width': 3, 'base:height': 4 }] };
  assert.deepEqual(E.validate('keymap', good), []);
  const bad = { version: 1, components: [{ 'base:x': 'a' }] };
  const keys = msgs(E.validate('keymap', bad));
  assert.ok(keys.includes('warn:$.components[0]["base:componentIdentifier"]'));
  assert.ok(keys.includes('warn:$.components[0]["base:x"]'));
  assert.ok(msgs(E.validate('keymap', { version: '1' })).includes('error:$.components'));
  assert.ok(msgs(E.validate('keymap', [1])).includes('error:$'));

  const rec = { weaponSize: 259, scopeSize: 56, components: [{ 'base:x': 1, 'base:y': 1, 'base:width': 5, 'base:height': 5, type: 0 }] };
  assert.deepEqual(E.validate('recognition', rec), []);
  assert.ok(msgs(E.validate('recognition', { weaponSize: 'big', components: [{ type: 'x' }] })).includes('warn:$.weaponSize'));
});

test('newIssues keeps only what the edit introduced', () => {
  const before = [{ level: 'warn', path: '$.a', message: 'm1' }, { level: 'error', path: '$.b', message: 'm2' }];
  const after = [{ level: 'warn', path: '$.a', message: 'm1' }, { level: 'error', path: '$.c', message: 'm3' }];
  assert.deepEqual(E.newIssues(before, after), [{ level: 'error', path: '$.c', message: 'm3' }]);
});

test('real recoil file: validate runs and only flags the known oddities', (t) => {
  const file = path.join(__dirname, '..', 'keymap_analysis', 'raw', 'map%7Ca83e86a5d225446abb635d68c940192a.json');
  if (!fs.existsSync(file)) return t.skip('backup file not available');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const issues = E.validate('recoil', doc);
  assert.ok(Array.isArray(issues));
  assert.ok(!issues.some((i) => i.level === 'error'), `the app runs on this file, so no "error": ${JSON.stringify(issues.filter((i) => i.level === 'error').slice(0, 3))}`);
});
