'use strict';
// Daily backups: one folder per day (data/backups/YYYY-MM-DD/databases), overwritten during the day, a new folder on a new day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const B = require('./backup');
const { withServer, raw } = require('./harness');

const W = { 'X-Admin-Request': '1' };
const HOUR = 3600 * 1000;
const T0 = Date.UTC(2026, 9, 10, 20, 30); // 20:30 UTC = 03:30 on 2026-10-11 in Vietnam
const xml = (v) => `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <int name="x" value="${v}" />\n</map>\n`;
const file = (name, v = 1) => ({ name, text: xml(v) });
const device = { 'X-Device-Id': 'tablet-0001', 'X-Device-Name': encodeURIComponent('Galaxy Tab S8') };
const push = (port, files, headers = {}) => raw(port, 'POST', '/admin/api/sync/databases/push', { headers: { ...W, ...headers }, body: { files } });
const days = (dir) => (fs.existsSync(path.join(dir, 'backups')) ? fs.readdirSync(path.join(dir, 'backups')).sort() : []);
const dbNames = (dir, day) => fs.readdirSync(path.join(dir, 'backups', day, 'databases')).map(decodeURIComponent).sort();
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

test("the first push creates today's folder with the files and a manifest", async () => {
  const c = clock();
  await withServer({}, async ({ port, dir }) => {
    await push(port, [file('ADBKey.xml'), file('Cài đặt cơ bản.xml')], device);
    assert.deepEqual(days(dir), ['2026-10-11']);
    assert.deepEqual(dbNames(dir, '2026-10-11'), ['ADBKey.xml', 'Cài đặt cơ bản.xml']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'backups', '2026-10-11')).sort(), ['_manifest.json', 'databases']);
    const m = readJson(dir, 'backups', '2026-10-11', '_manifest.json');
    assert.deepEqual([m.date, m.databases, m.last_actor], ['2026-10-11', 2, 'Galaxy Tab S8']);
    assert.equal(m.updated_at, new Date(T0).toISOString());
    assert.ok(m.bytes > 0);
  }, { clock: c.fn });
});

test('during the same day the folder is overwritten, not duplicated', async () => {
  const c = clock();
  await withServer({}, async ({ port, dir }) => {
    await push(port, [file('a.xml', 1), file('b.xml', 1)]);
    c.now += 2 * HOUR;
    await push(port, [file('a.xml', 2)]);
    assert.deepEqual(days(dir), ['2026-10-11']);
    assert.deepEqual(dbNames(dir, '2026-10-11'), ['a.xml', 'b.xml'], 'b.xml is still part of the set');
    assert.equal(fs.readFileSync(path.join(dir, 'backups', '2026-10-11', 'databases', 'a.xml'), 'utf8'), xml(2));
    assert.equal(readJson(dir, 'backups', '2026-10-11', '_manifest.json').updated_at, new Date(T0 + 2 * HOUR).toISOString());
    assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')).filter((n) => n.startsWith('.')), [], 'no temporary folders left behind');
  }, { clock: c.fn });
});

test('a new day creates a new folder and leaves the old one as it was', async () => {
  const c = clock();
  await withServer({}, async ({ port, dir }) => {
    await push(port, [file('a.xml', 1)]);
    c.now += 24 * HOUR;
    await push(port, [file('a.xml', 2)]);
    assert.deepEqual(days(dir), ['2026-10-11', '2026-10-12']);
    const read = (day) => fs.readFileSync(path.join(dir, 'backups', day, 'databases', 'a.xml'), 'utf8');
    assert.equal(read('2026-10-11'), xml(1), 'yesterday is untouched');
    assert.equal(read('2026-10-12'), xml(2));
  }, { clock: c.fn });
});

test('a new day gets its folder even when nothing changed (first activity of the day)', async () => {
  const c = clock();
  await withServer({}, async ({ port, dir }) => {
    await push(port, [file('a.xml')]);
    c.now += 24 * HOUR;
    assert.deepEqual(days(dir), ['2026-10-11']);
    await raw(port, 'GET', '/admin/api/sync/info');
    assert.deepEqual(days(dir), ['2026-10-11', '2026-10-12']);
    assert.deepEqual(dbNames(dir, '2026-10-12'), ['a.xml']);
  }, { clock: c.fn });
});

test('nothing is backed up while there are no files', async () => {
  const c = clock();
  await withServer({}, async ({ port, dir }) => {
    await raw(port, 'GET', '/admin/api/sync/info');
    assert.deepEqual(days(dir), []);
    assert.equal((await raw(port, 'GET', '/admin/api/sync/backups')).json.days.length, 0);
  }, { clock: c.fn });
});

test('list and read endpoints', async () => {
  const c = clock();
  await withServer({}, async ({ port }) => {
    await push(port, [file('a.xml', 1), file('Cài đặt cơ bản.xml', 1)], device);
    c.now += 24 * HOUR;
    await push(port, [file('a.xml', 2)], device);
    const list = (await raw(port, 'GET', '/admin/api/sync/backups')).json.days;
    assert.deepEqual(list.map((d) => d.date), ['2026-10-12', '2026-10-11'], 'newest first');
    assert.deepEqual([list[0].databases, list[0].last_actor], [2, 'Galaxy Tab S8']);
    assert.ok(list[0].bytes > 0 && list[0].updated_at);

    const old = (await raw(port, 'GET', '/admin/api/sync/backups/2026-10-11/databases')).json;
    assert.deepEqual(old.files.map((f) => f.name), ['a.xml', 'Cài đặt cơ bản.xml']);
    assert.equal(old.files[0].text, xml(1));

    const one = await raw(port, 'GET', `/admin/api/sync/backups/2026-10-11/databases/${encodeURIComponent('Cài đặt cơ bản.xml')}`);
    assert.deepEqual([one.status, one.json.name, one.json.text], [200, 'Cài đặt cơ bản.xml', xml(1)]);
    assert.equal((await raw(port, 'GET', '/admin/api/sync/backups/2026-10-11/databases/nope.xml')).status, 404);
    assert.equal((await raw(port, 'GET', '/admin/api/sync/backups/2026-10-01/databases/a.xml')).status, 404);
    assert.equal((await raw(port, 'GET', '/admin/api/sync/backups/2026-10-11/databases/..%2f..%2fx.xml')).status, 404);
    assert.equal((await raw(port, 'GET', '/admin/api/sync/backups/..%2f..%2fx/databases/a.xml')).status, 400);

    assert.equal((await raw(port, 'GET', '/admin/api/sync/backups/2026-10-01/databases')).status, 404);
    for (const bad of ['2026-10-1', '..%2faccounts', '2026-13-45x', 'abc']) {
      const r = await raw(port, 'GET', `/admin/api/sync/backups/${bad}/databases`);
      assert.ok([400, 404].includes(r.status), `${bad} -> ${r.status}`);
      assert.ok(!r.text.includes('"files"'), bad);
    }
  }, { clock: c.fn });
});

test('BACKUP_KEEP_DAYS keeps only the newest days', async () => {
  const c = clock();
  await withServer({ BACKUP_KEEP_DAYS: '2' }, async ({ port, dir }) => {
    for (let i = 0; i < 4; i++) { await push(port, [file('a.xml', i)]); c.now += 24 * HOUR; }
    assert.deepEqual(days(dir), ['2026-10-13', '2026-10-14']);
  }, { clock: c.fn });
  const c2 = clock();
  await withServer({}, async ({ port, dir }) => {
    for (let i = 0; i < 4; i++) { await push(port, [file('a.xml', i)]); c2.now += 24 * HOUR; }
    assert.equal(days(dir).length, 4, 'by default nothing is deleted');
  }, { clock: c2.fn });
});

test('info tells how many days are backed up', async () => {
  const c = clock();
  await withServer({}, async ({ port }) => {
    assert.equal((await raw(port, 'GET', '/admin/api/sync/info')).json.backup_days, 0);
    await push(port, [file('a.xml')]);
    c.now += 24 * HOUR;
    await push(port, [file('a.xml', 2)]);
    assert.equal((await raw(port, 'GET', '/admin/api/sync/info')).json.backup_days, 2);
  }, { clock: c.fn });
});

test('old backup days with the earlier layout still list and read', async () => {
  await withServer({}, async ({ port, dir }) => {
    const day = path.join(dir, 'backups', '2026-01-02');
    fs.mkdirSync(path.join(day, 'databases'), { recursive: true });
    fs.writeFileSync(path.join(day, 'databases', 'a.xml'), xml(1));
    fs.writeFileSync(path.join(day, `map%7C${'a'.repeat(32)}.json`), '{}'); // keymap files of the earlier versions: ignored
    fs.writeFileSync(path.join(day, '_manifest.json'), JSON.stringify({ date: '2026-01-02', docs: 1, files: 2, databases: 1, bytes: 40, updated_at: '2026-01-02T01:00:00.000Z', last_actor: 'x' }));
    const d = (await raw(port, 'GET', '/admin/api/sync/backups')).json.days.find((x) => x.date === '2026-01-02');
    assert.deepEqual([d.databases, d.bytes, d.last_actor], [1, 40, 'x']);
    assert.deepEqual((await raw(port, 'GET', '/admin/api/sync/backups/2026-01-02/databases')).json.files.map((f) => f.name), ['a.xml']);
  });
});

test('deleting days of backups frees them and leaves the rest alone', async () => {
  const c = clock();
  await withServer({}, async ({ port, dir }) => {
    await push(port, [file('A.xml', 1)]);
    c.now += 30 * HOUR; await push(port, [file('A.xml', 2)]);
    c.now += 30 * HOUR; await push(port, [file('A.xml', 3)]);
    const before = days(dir);
    assert.equal(before.length, 3);
    const r = await raw(port, 'POST', '/admin/api/sync/backups/delete', { headers: W, body: { days: [before[0], before[1], '2020-01-01'] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.deleted, [before[0], before[1]]);
    assert.deepEqual(r.json.missing, ['2020-01-01']);
    assert.ok(r.json.freed > 0);
    assert.deepEqual(days(dir), [before[2]]);
    const t = await raw(port, 'POST', '/admin/api/sync/backups/delete', { headers: W, body: { days: [before[2]] } });
    assert.deepEqual(t.json.kept, [before[2]], 'today is never deleted');
    assert.deepEqual(days(dir), [before[2]]);
    for (const bad of [{}, { days: [] }, { days: ['../x'] }, { days: ['2026-1-1'] }, { days: [5] }]) {
      assert.equal((await raw(port, 'POST', '/admin/api/sync/backups/delete', { headers: W, body: bad })).status, 400);
    }
    assert.deepEqual(days(dir), [before[2]]);
  }, { clock: c.fn });
});
