'use strict';
// Daily backups: one folder per day (data/backups/YYYY-MM-DD), overwritten during the day, a new folder on a new day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const B = require('./backup');
const { withServer, raw } = require('./harness');

const W = { 'X-Admin-Request': '1' };
const DEFAULT_ACC = `c_${'0'.repeat(32)}`;
const NS = 'com.vng.pubgmobile';
const A = 'a'.repeat(32);
const BID = 'b'.repeat(32);
const HOUR = 3600 * 1000;
const T0 = Date.UTC(2026, 9, 10, 20, 30); // 20:30 UTC = 03:30 on 2026-10-11 in Vietnam

const listFile = (selected, items) => ({ name: `list%7C${NS}.json`, text: JSON.stringify({ selected, items }) });
const mapFile = (id, body) => ({ name: `map%7C${id}.json`, text: JSON.stringify(body) });
const item = (id, meta) => ({ id, name: '2026-01-01 10:00:00', game: NS, public: false, meta: JSON.stringify(meta) });
const basic = (v = '1') => [listFile(BID, [item(A, { name: 'One' }), item(BID, { name: 'Two' })]), mapFile(A, { version: v, n: 1 }), mapFile(BID, { version: v, n: 2 })];
const device = { 'X-Device-Id': 'tablet-0001', 'X-Device-Name': encodeURIComponent('Galaxy Tab S8') };
const push = (port, files, headers = {}) => raw(port, 'POST', '/admin/api/sync/push', { headers: { ...W, ...headers }, body: { files } });
const days = (dir) => (fs.existsSync(path.join(dir, 'backups')) ? fs.readdirSync(path.join(dir, 'backups')).sort() : []);
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));

function clock(start = T0) {
  const c = { now: start, fn: () => c.now };
  return c;
}

test('dayString follows the configured time zone', () => {
  assert.equal(B.dayString(T0, 'Asia/Ho_Chi_Minh'), '2026-10-11');
  assert.equal(B.dayString(T0, 'UTC'), '2026-10-10');
  assert.equal(B.dayString(Date.UTC(2026, 11, 31, 16, 59), 'Asia/Ho_Chi_Minh'), '2026-12-31');
  assert.equal(B.dayString(Date.UTC(2026, 11, 31, 17, 0), 'Asia/Ho_Chi_Minh'), '2027-01-01');
  assert.match(B.dayString(T0, 'Not/AZone'), /^\d{4}-\d\d-\d\d$/, 'a bad zone falls back instead of throwing');
});

test('the first push creates today\'s folder with the cache files and a manifest', async () => {
  const c = clock();
  await withServer({}, async ({ port, dir }) => {
    await push(port, basic(), device);
    assert.deepEqual(days(dir), ['2026-10-11']);
    const day = path.join(dir, 'backups', '2026-10-11');
    assert.deepEqual(fs.readdirSync(day).sort(), ['_manifest.json', `list%7C${NS}.json`, `map%7C${A}.json`, `map%7C${BID}.json`].sort());
    assert.deepEqual(readJson(day, `map%7C${A}.json`), { version: '1', n: 1 });
    const m = readJson(day, '_manifest.json');
    assert.deepEqual([m.date, m.docs, m.files, m.last_actor], ['2026-10-11', 2, 3, 'Galaxy Tab S8']);
    assert.equal(m.updated_at, new Date(T0).toISOString());
    assert.ok(m.bytes > 0);
  }, { clock: c.fn });
});

test('during the same day the folder is overwritten, not duplicated', async () => {
  const c = clock();
  await withServer({}, async ({ port, dir }) => {
    await push(port, basic('1'));
    c.now += 2 * HOUR; // still 2026-10-11 in Vietnam
    await push(port, basic('2'));
    assert.deepEqual(days(dir), ['2026-10-11']);
    const day = path.join(dir, 'backups', '2026-10-11');
    assert.deepEqual(readJson(day, `map%7C${A}.json`), { version: '2', n: 1 });
    assert.equal(readJson(day, '_manifest.json').updated_at, new Date(T0 + 2 * HOUR).toISOString());
    assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')).filter((n) => n.startsWith('.')), [], 'no temporary folders left behind');
  }, { clock: c.fn });
});

test('a new day creates a new folder and leaves the old one as it was', async () => {
  const c = clock();
  await withServer({}, async ({ port, dir }) => {
    await push(port, basic('1'));
    c.now += 24 * HOUR;
    await push(port, basic('2'));
    assert.deepEqual(days(dir), ['2026-10-11', '2026-10-12']);
    assert.deepEqual(readJson(dir, 'backups', '2026-10-11', `map%7C${A}.json`), { version: '1', n: 1 }, 'yesterday is untouched');
    assert.deepEqual(readJson(dir, 'backups', '2026-10-12', `map%7C${A}.json`), { version: '2', n: 1 });
  }, { clock: c.fn });
});

test('a new day gets its folder even when nothing changed (first activity of the day)', async () => {
  const c = clock();
  await withServer({}, async ({ port, dir }) => {
    await push(port, basic());
    c.now += 24 * HOUR;
    assert.deepEqual(days(dir), ['2026-10-11']);
    await raw(port, 'GET', '/admin/api/sync/info');
    assert.deepEqual(days(dir), ['2026-10-11', '2026-10-12']);
    assert.deepEqual(readJson(dir, 'backups', '2026-10-12', `map%7C${BID}.json`), { version: '1', n: 2 });
  }, { clock: c.fn });
});

test('nothing is backed up while the account is empty, and an empty state never replaces the backup', async () => {
  const c = clock();
  await withServer({}, async ({ port, dir }) => {
    await raw(port, 'GET', '/admin/api/sync/info');
    assert.deepEqual(days(dir), [], 'an empty account creates no folder');
    await push(port, basic());
    const day = path.join(dir, 'backups', '2026-10-11');
    // deleting one keymap is an ordinary change: today's folder follows it (latest state of the day)
    await raw(port, 'DELETE', `/admin/api/accounts/${DEFAULT_ACC}/docs/${A}`, { headers: W });
    assert.ok(!fs.existsSync(path.join(day, `map%7C${A}.json`)));
    assert.ok(fs.existsSync(path.join(day, `map%7C${BID}.json`)));
    // deleting the last one leaves an EMPTY state, which must not wipe the folder: the last non-empty state stays
    await raw(port, 'DELETE', `/admin/api/accounts/${DEFAULT_ACC}/docs/${BID}`, { headers: W });
    assert.equal((await raw(port, 'GET', '/admin/api/sync/info')).json.docs, 0);
    assert.ok(fs.existsSync(path.join(day, `map%7C${BID}.json`)), 'the last non-empty backup of the day is still there');
  }, { clock: c.fn });
});

test('list and read endpoints', async () => {
  const c = clock();
  await withServer({}, async ({ port }) => {
    await push(port, basic('1'), device);
    c.now += 24 * HOUR;
    await push(port, basic('2'), device);
    const list = (await raw(port, 'GET', '/admin/api/sync/backups')).json.days;
    assert.deepEqual(list.map((d) => d.date), ['2026-10-12', '2026-10-11'], 'newest first');
    assert.deepEqual([list[0].files, list[0].docs, list[0].last_actor], [3, 2, 'Galaxy Tab S8']);
    assert.ok(list[0].bytes > 0 && list[0].updated_at);

    const old = (await raw(port, 'GET', '/admin/api/sync/backups/2026-10-11')).json;
    assert.equal(old.date, '2026-10-11');
    const m = Object.fromEntries(old.files.map((f) => [f.name, JSON.parse(f.text)]));
    assert.deepEqual(m[`map%7C${A}.json`], { version: '1', n: 1 });
    assert.ok(!('_manifest.json' in m), 'the manifest is not a cache file');
    assert.equal(old.files.length, 3);

    assert.equal((await raw(port, 'GET', '/admin/api/sync/backups/2026-10-01')).status, 404);
    for (const bad of ['..', '2026-10-1', '../accounts', '2026-13-45x', 'abc']) {
      const r = await raw(port, 'GET', `/admin/api/sync/backups/${bad}`);
      assert.ok([400, 404].includes(r.status), `${bad} -> ${r.status}`);
      assert.ok(!r.text.includes('"files"'), bad);
    }
  }, { clock: c.fn });
});

test('BACKUP_KEEP_DAYS keeps only the newest days', async () => {
  const c = clock();
  await withServer({ BACKUP_KEEP_DAYS: '2' }, async ({ port, dir }) => {
    for (let i = 0; i < 4; i++) { await push(port, basic(String(i))); c.now += 24 * HOUR; }
    assert.deepEqual(days(dir), ['2026-10-13', '2026-10-14']);
  }, { clock: c.fn });
  const c2 = clock();
  await withServer({}, async ({ port, dir }) => {
    for (let i = 0; i < 4; i++) { await push(port, basic(String(i))); c2.now += 24 * HOUR; }
    assert.equal(days(dir).length, 4, 'by default nothing is deleted');
  }, { clock: c2.fn });
});

test('an edit made in the web page is part of today\'s backup and the manifest says it came from the web', async () => {
  const c = clock();
  await withServer({}, async ({ port, dir }) => {
    await push(port, basic(), device);
    const d = (await raw(port, 'GET', `/admin/api/accounts/${DEFAULT_ACC}/docs/${A}`)).json;
    const r = await raw(port, 'PUT', `/admin/api/accounts/${DEFAULT_ACC}/docs/${A}`, { headers: W, body: { etag: d.etag, keymap: { version: 'edited', n: 1 } } });
    assert.equal(r.status, 200);
    const day = path.join(dir, 'backups', '2026-10-11');
    assert.deepEqual(readJson(day, `map%7C${A}.json`), { version: 'edited', n: 1 });
    assert.equal(readJson(day, '_manifest.json').last_actor, 'Giao diện web');
  }, { clock: c.fn });
});

test('info tells how many days are backed up', async () => {
  const c = clock();
  await withServer({}, async ({ port }) => {
    assert.equal((await raw(port, 'GET', '/admin/api/sync/info')).json.backup_days, 0);
    await push(port, basic());
    c.now += 24 * HOUR;
    await push(port, basic('2'));
    assert.equal((await raw(port, 'GET', '/admin/api/sync/info')).json.backup_days, 2);
  }, { clock: c.fn });
});
