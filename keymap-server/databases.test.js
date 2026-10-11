'use strict';
// The app's preference files (Documents/jya2/databases/*.xml): storage, name checks, daily backups, endpoints.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('./databases');
const { withServer, raw } = require('./harness');

const W = { 'X-Admin-Request': '1' };
const T0 = Date.UTC(2026, 9, 10, 20, 30); // 03:30 on 2026-10-11 in Vietnam
const DAY = 24 * 3600 * 1000;
const xml = (v) => `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <int name="x" value="${v}" />\n</map>\n`;
const file = (name, v = 1) => ({ name, text: xml(v) });
const pushDb = (port, files, headers = {}) => raw(port, 'POST', '/admin/api/sync/databases/push', { headers: { ...W, ...headers }, body: { files } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ftdb-'));

test('names: only safe .xml names are accepted, license and session files are refused', () => {
  for (const ok of ['PubgSettings.xml', 'Cài đặt cơ bản.xml', '睙ubgSettings.xml', 'ADBKey.xml', 'com.facebook.ads.flash.xml', 'A.XML']) {
    assert.equal(D.nameProblem(ok), null, ok);
  }
  for (const bad of ['', '.xml.', 'a.txt', '../x.xml', 'a/b.xml', 'a\\b.xml', '.hidden.xml', '..', '.', 'a\u0000.xml', 'x'.repeat(130) + '.xml', 'gamwing_entitlement.xml', 'gamwing_ipc_session.xml', 'License.xml', 'ipc-session.xml', 'IPCSESSION.xml']) {
    assert.notEqual(D.nameProblem(bad), null, JSON.stringify(bad));
  }
  assert.notEqual(D.nameProblem(null), null);
  assert.notEqual(D.nameProblem(42), null);
});

test('store: saves, detects unchanged, never deletes, keeps names with spaces and accents', () => {
  const dir = tmp();
  const s = new D.DatabasesStore({ dir });
  let r = s.put([file('Cài đặt cơ bản.xml', 1), file('ADBKey.xml', 2), file('gamwing_entitlement.xml', 3), { name: 'x.txt', text: 'a' }]);
  assert.deepEqual([r.saved, r.unchanged, r.skipped.map((k) => k.name)], [2, 0, ['gamwing_entitlement.xml', 'x.txt']]);
  assert.deepEqual(s.list().map((f) => f.name), ['ADBKey.xml', 'Cài đặt cơ bản.xml']);
  r = s.put([file('ADBKey.xml', 2), file('Cài đặt cơ bản.xml', 9)]);
  assert.deepEqual([r.saved, r.unchanged, r.changed], [1, 1, ['Cài đặt cơ bản.xml']]);
  assert.equal(s.read('Cài đặt cơ bản.xml').text, xml(9));
  s.put([]); // a push without a file never removes it
  assert.equal(s.list().length, 2);
  assert.equal(s.read('../ADBKey.xml'), null);
  assert.equal(s.read('missing.xml'), null);
  // nothing outside the folder, no temp leftovers
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.tmp')), []);
  assert.ok(fs.readdirSync(dir).every((n) => !n.includes('/') && !n.includes('\\')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: the same name in two Unicode forms is one file, size and count limits hold', () => {
  const dir = tmp();
  const s = new D.DatabasesStore({ dir });
  s.put([file('Cài.xml', 1)]);
  s.put([file('Cài.xml', 2)]); // decomposed "à"
  assert.equal(s.list().length, 1);
  assert.equal(s.read('Cài.xml').text, xml(2));
  const big = { name: 'big.xml', text: 'x'.repeat(D.MAX_FILE_BYTES + 1) };
  assert.match(s.put([big]).skipped[0].reason, /quá lớn/);
  const many = Array.from({ length: D.MAX_FILES + 5 }, (_, i) => file(`f${i}.xml`));
  const r = s.put(many);
  assert.equal(s.list().length, D.MAX_FILES);
  assert.ok(r.skipped.length >= 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('endpoint: push, list and read a file, with the same write guard as the other sync calls', async () => {
  await withServer({}, async ({ port }) => {
    const denied = await raw(port, 'POST', '/admin/api/sync/databases/push', { body: { files: [file('a.xml')] } });
    assert.equal(denied.status, 403);
    let r = await pushDb(port, [file('PubgSettings.xml', 1), file('Cài đặt cơ bản.xml', 2), file('gamwing_entitlement.xml', 3)]);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.saved, r.json.unchanged, r.json.skipped.map((k) => k.name)], [2, 0, ['gamwing_entitlement.xml']]);
    r = await pushDb(port, [file('PubgSettings.xml', 1)]);
    assert.deepEqual([r.json.saved, r.json.unchanged], [0, 1]);
    const list = await raw(port, 'GET', '/admin/api/sync/databases');
    assert.deepEqual(list.json.files.map((f) => f.name), ['Cài đặt cơ bản.xml', 'PubgSettings.xml']);
    const got = await raw(port, 'GET', `/admin/api/sync/databases/${encodeURIComponent('Cài đặt cơ bản.xml')}`);
    assert.deepEqual([got.status, got.json.text], [200, xml(2)]);
    assert.equal((await raw(port, 'GET', '/admin/api/sync/databases/nope.xml')).status, 404);
    assert.equal((await raw(port, 'GET', `/admin/api/sync/databases/${encodeURIComponent('../server.js')}`)).status, 404);
    assert.equal((await pushDb(port, 'oops')).status, 400);
    assert.equal((await raw(port, 'POST', '/admin/api/sync/databases/push', { headers: W, body: { files: [{ name: 1 }] } })).status, 400);
  });
});

test('daily backup: preference files go into the day\'s databases folder, overwritten within the day', async () => {
  const c = { now: T0 };
  await withServer({}, async ({ port, dir }) => {
    await pushDb(port, [file('ADBKey.xml', 1), file('Cài đặt cơ bản.xml', 1)], { 'X-Device-Id': 'tablet-0001', 'X-Device-Name': encodeURIComponent('Galaxy Tab S8') });
    const day = path.join(dir, 'backups', '2026-10-11');
    assert.deepEqual(fs.readdirSync(path.join(day, 'databases')).map(decodeURIComponent).sort(), ['ADBKey.xml', 'Cài đặt cơ bản.xml']);
    const m = JSON.parse(fs.readFileSync(path.join(day, '_manifest.json'), 'utf8'));
    assert.deepEqual([m.databases, m.last_actor], [2, 'Galaxy Tab S8']);
    await pushDb(port, [file('ADBKey.xml', 7)]);
    const names = fs.readdirSync(path.join(day, 'databases'));
    assert.equal(names.length, 2);
    assert.equal(fs.readFileSync(path.join(day, 'databases', 'ADBKey.xml'), 'utf8'), xml(7));
    const list = await raw(port, 'GET', '/admin/api/sync/backups');
    assert.equal(list.json.days[0].databases, 2);
    const read = await raw(port, 'GET', '/admin/api/sync/backups/2026-10-11/databases');
    assert.deepEqual(read.json.files.map((f) => f.name), ['ADBKey.xml', 'Cài đặt cơ bản.xml']);
    assert.equal(read.json.files[0].text, xml(7));
    assert.equal((await raw(port, 'GET', '/admin/api/sync/backups/2026-01-01/databases')).status, 404);
    assert.equal((await raw(port, 'GET', '/admin/api/sync/backups/..%2f..%2fx/databases')).status, 400);
  }, { clock: () => c.now });
});

test('daily backup: a new day gets its own folder, the old day keeps its files', async () => {
  const c = { now: T0 };
  await withServer({}, async ({ port, dir }) => {
    await pushDb(port, [file('a.xml', 1)]);
    c.now += DAY;
    await pushDb(port, [file('a.xml', 2)]);
    const read = (day) => fs.readFileSync(path.join(dir, 'backups', day, 'databases', 'a.xml'), 'utf8');
    assert.equal(read('2026-10-11'), xml(1));
    assert.equal(read('2026-10-12'), xml(2));
  }, { clock: () => c.now });
});

const putDb = (port, name, body) => raw(port, 'PUT', `/admin/api/sync/databases/${encodeURIComponent(name)}`, { headers: W, body });
const getDb = (port, name) => raw(port, 'GET', `/admin/api/sync/databases/${encodeURIComponent(name)}`);

test('web edit: needs the current etag, keeps the old text as a version, updates today\'s backup', async () => {
  const c = { now: T0 };
  await withServer({}, async ({ port, dir }) => {
    await pushDb(port, [file('PubgSettings.xml', 1)]);
    const first = (await getDb(port, 'PubgSettings.xml')).json;
    assert.match(first.etag, /^[0-9a-f]{16}$/);
    const edited = await putDb(port, 'PubgSettings.xml', { text: xml(2), etag: first.etag });
    assert.deepEqual([edited.status, edited.json.saved, edited.json.history], [200, 1, 1]);
    assert.equal((await getDb(port, 'PubgSettings.xml')).json.text, xml(2));
    // a stale etag is refused and nothing changes (the phone may have pushed a newer copy in the meantime)
    const stale = await putDb(port, 'PubgSettings.xml', { text: xml(3), etag: first.etag });
    assert.deepEqual([stale.status, stale.json.error], [409, 'Conflict']);
    assert.equal((await getDb(port, 'PubgSettings.xml')).json.text, xml(2));
    assert.equal((await putDb(port, 'PubgSettings.xml', { text: xml(3) })).status, 409, 'no etag at all is refused too');
    // history: the previous text is readable and can be put back
    const list = (await raw(port, 'GET', '/admin/api/sync/databases/PubgSettings.xml/history')).json.versions;
    assert.equal(list.length, 1);
    const old = await raw(port, 'GET', `/admin/api/sync/databases/PubgSettings.xml/history/${list[0].version}`);
    assert.equal(old.json.text, xml(1));
    const cur = (await getDb(port, 'PubgSettings.xml')).json;
    assert.equal((await putDb(port, 'PubgSettings.xml', { text: old.json.text, etag: cur.etag })).status, 200);
    assert.equal((await getDb(port, 'PubgSettings.xml')).json.text, xml(1));
    // today's backup holds the edited file and says who did it
    const day = path.join(dir, 'backups', '2026-10-11');
    assert.equal(fs.readFileSync(path.join(day, 'databases', 'PubgSettings.xml'), 'utf8'), xml(1));
    assert.equal(JSON.parse(fs.readFileSync(path.join(day, '_manifest.json'), 'utf8')).last_actor, 'Giao diện web');
    // not for files that do not exist, not without the write guard, not for refused names, not with a wrong body
    assert.equal((await putDb(port, 'nope.xml', { text: 'x', etag: 'a'.repeat(16) })).status, 404);
    assert.equal((await putDb(port, 'gamwing_entitlement.xml', { text: 'x', etag: 'a'.repeat(16) })).status, 400);
    assert.equal((await putDb(port, 'PubgSettings.xml', { text: 5, etag: cur.etag })).status, 400);
    assert.equal((await raw(port, 'PUT', '/admin/api/sync/databases/PubgSettings.xml', { body: { text: 'x', etag: cur.etag } })).status, 403);
    assert.equal((await raw(port, 'GET', '/admin/api/sync/databases/nope.xml/history')).status, 404);
    assert.equal((await raw(port, 'GET', '/admin/api/sync/databases/PubgSettings.xml/history/..%2f..%2fx')).status, 404);
  }, { clock: () => c.now });
});

test('web edit: only the newest versions are kept', async () => {
  const dir = tmp();
  const s = new D.DatabasesStore({ dir });
  s.put([file('a.xml', 0)]);
  for (let i = 1; i <= D.MAX_VERSIONS + 5; i++) s.put([file('a.xml', i)]);
  const v = s.versions('a.xml');
  assert.equal(v.length, D.MAX_VERSIONS);
  assert.equal(s.readVersion('a.xml', v[0].version).text, xml(D.MAX_VERSIONS + 4), 'newest version is the text just before the last save');
  assert.deepEqual(s.names(), ['a.xml'], 'the history folder is never listed as a file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wipe: needs the typed confirmation, empties everything, keeps only the last wipe aside', async () => {
  await withServer({}, async ({ port, dir }) => {
    await pushDb(port, [file('a.xml', 1)], { 'X-Device-Id': 'tablet-0001', 'X-Device-Name': 'Tab' });
    assert.equal((await raw(port, 'POST', '/admin/api/sync/wipe', { headers: W, body: {} })).status, 400);
    assert.equal((await raw(port, 'POST', '/admin/api/sync/wipe', { headers: W, body: { confirm: 'xoa' } })).status, 400);
    assert.equal((await raw(port, 'POST', '/admin/api/sync/wipe', { body: { confirm: 'XOA TAT CA' } })).status, 403, 'the write guard applies');
    assert.equal(JSON.parse((await raw(port, 'GET', '/admin/api/sync/info')).text).files, 1, 'nothing was deleted by the refused calls');

    const r = await raw(port, 'POST', '/admin/api/sync/wipe', { headers: W, body: { confirm: 'XOA TAT CA' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.moved.sort(), ['backups', 'databases']);
    const info = JSON.parse((await raw(port, 'GET', '/admin/api/sync/info')).text);
    assert.deepEqual([info.files, info.backup_days], [0, 0]);
    assert.deepEqual((await raw(port, 'GET', '/admin/api/sync/databases')).json.files, []);
    assert.equal((await raw(port, 'GET', '/admin/api/sync/devices')).json.devices.length, 1, 'the list of devices is not data to wipe');
    const kept = fs.readdirSync(path.join(dir, '_wiped'));
    assert.equal(kept.length, 1);
    assert.ok(fs.existsSync(path.join(dir, '_wiped', kept[0], 'backups')));
    assert.ok(fs.existsSync(path.join(dir, '_wiped', kept[0], 'databases')));

    // the server works again right away, and a second wipe replaces the first one in _wiped
    await pushDb(port, [file('b.xml', 2)]);
    assert.equal((await raw(port, 'POST', '/admin/api/sync/wipe', { headers: W, body: { confirm: 'XOA TAT CA' } })).status, 200);
    const again = fs.readdirSync(path.join(dir, '_wiped'));
    assert.equal(again.length, 1);
    assert.notEqual(again[0], kept[0]);
    assert.ok(fs.existsSync(path.join(dir, '_wiped', again[0], 'databases', encodeURIComponent('b.xml'))));
    // wiping an empty server is fine too
    assert.equal((await raw(port, 'POST', '/admin/api/sync/wipe', { headers: W, body: { confirm: 'XOA TAT CA' } })).status, 200);
  }, { clock: () => T0 });
});

// ---- where each file lives on the tablet
const FOLDER = '/storage/emulated/0/Documents/jya2/databases';
const pushFrom = (port, files, folder, headers = {}) => raw(port, 'POST', '/admin/api/sync/databases/push', { headers: { ...W, ...headers }, body: { folder, files } });

test('store: remembers the tablet folder of every file it was given, also for unchanged files', () => {
  const dir = tmp();
  const s = new D.DatabasesStore({ dir, clock: () => T0 });
  s.put([file('a.xml', 1), file('b.xml', 1)], { folder: FOLDER, device: 'Galaxy Tab' });
  assert.deepEqual(s.list().map((f) => [f.name, f.folder, f.device]), [['a.xml', FOLDER, 'Galaxy Tab'], ['b.xml', FOLDER, 'Galaxy Tab']]);
  assert.equal(s.read('a.xml').folder, FOLDER);
  // the same text pushed from another folder (unchanged content) still updates where it lives
  const r = s.put([file('a.xml', 1)], { folder: '/sdcard/other', device: 'Phone' });
  assert.deepEqual([r.saved, r.unchanged], [0, 1]);
  assert.deepEqual([s.read('a.xml').folder, s.read('a.xml').device, s.read('b.xml').folder], ['/sdcard/other', 'Phone', FOLDER]);
  // no source given (older app): nothing is forgotten
  s.put([file('a.xml', 2)]);
  assert.equal(s.read('a.xml').folder, '/sdcard/other');
  // the bookkeeping file is never listed as a preference file and files that were never given a folder say so
  assert.deepEqual(s.names(), ['a.xml', 'b.xml']);
  s.put([file('c.xml', 1)]);
  assert.equal(s.read('c.xml').folder, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: a folder from the network is cleaned and capped, anything that is not text is ignored', () => {
  const dir = tmp();
  const s = new D.DatabasesStore({ dir });
  s.put([file('a.xml')], { folder: `  /sdcard/x\u0000y\u0007z${'q'.repeat(400)}  `, device: 5 });
  const f = s.read('a.xml');
  assert.equal(f.folder.startsWith('/sdcard/xyz'), true);
  assert.equal(f.folder.length, 300);
  assert.equal(f.device, '');
  s.put([file('b.xml')], { folder: { evil: 1 } });
  assert.equal(s.read('b.xml').folder, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('endpoint: the folder travels with the push and comes back in the list, the file and the device name', async () => {
  await withServer({}, async ({ port }) => {
    await pushFrom(port, [file('PubgSettings.xml', 1), file('Cài đặt cơ bản.xml', 2)], FOLDER, { 'X-Device-Id': 'tablet-0001', 'X-Device-Name': encodeURIComponent('Galaxy Tab S8') });
    const list = (await raw(port, 'GET', '/admin/api/sync/databases')).json.files;
    assert.deepEqual(list.map((f) => [f.name, f.folder, f.device]), [['Cài đặt cơ bản.xml', FOLDER, 'Galaxy Tab S8'], ['PubgSettings.xml', FOLDER, 'Galaxy Tab S8']]);
    const one = (await getDb(port, 'PubgSettings.xml')).json;
    assert.deepEqual([one.folder, one.device], [FOLDER, 'Galaxy Tab S8']);
    // a web edit does not move the file to another folder
    await putDb(port, 'PubgSettings.xml', { text: xml(9), etag: one.etag });
    assert.equal((await getDb(port, 'PubgSettings.xml')).json.folder, FOLDER);
    // an older app (no folder in the body) keeps working and does not erase the folder
    await pushFrom(port, [file('PubgSettings.xml', 3)], undefined);
    assert.equal((await getDb(port, 'PubgSettings.xml')).json.folder, FOLDER);
  });
});

test('daily backup: the manifest remembers the folder of every file and the day lists give it back', async () => {
  const c = { now: T0 };
  await withServer({}, async ({ port, dir }) => {
    await pushFrom(port, [file('a.xml', 1), file('Cài đặt cơ bản.xml', 1)], FOLDER, { 'X-Device-Id': 'tablet-0001', 'X-Device-Name': 'Tab' });
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'backups', '2026-10-11', '_manifest.json'), 'utf8'));
    assert.deepEqual(m.sources, { 'a.xml': { folder: FOLDER, device: 'Tab' }, 'Cài đặt cơ bản.xml': { folder: FOLDER, device: 'Tab' } });
    const day = (await raw(port, 'GET', '/admin/api/sync/backups/2026-10-11/databases')).json.files;
    assert.deepEqual(day.map((f) => [f.name, f.folder]), [['a.xml', FOLDER], ['Cài đặt cơ bản.xml', FOLDER]]);
    const one = (await raw(port, 'GET', `/admin/api/sync/backups/2026-10-11/databases/${encodeURIComponent('Cài đặt cơ bản.xml')}`)).json;
    assert.deepEqual([one.folder, one.text], [FOLDER, xml(1)]);
    // a day written before folders were recorded has none, and says so with an empty value
    fs.writeFileSync(path.join(dir, 'backups', '2026-10-11', '_manifest.json'), JSON.stringify({ date: '2026-10-11', databases: 2 }));
    assert.equal((await raw(port, 'GET', '/admin/api/sync/backups/2026-10-11/databases/a.xml')).json.folder, '');
  }, { clock: () => c.now });
});
