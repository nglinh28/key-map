'use strict';
// "Kiểm tra đồng bộ": the server compares what it holds with the newest backup day, hands out manifests for the app to compare against,
// and can ask the tablet app to check itself (a command). Delete commands now carry the names of the items.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { withServer, raw } = require('./harness');

const W = { 'X-Admin-Request': '1' };
const T0 = Date.UTC(2026, 9, 10, 20, 30); // 2026-10-11 in Vietnam
const DAY = 24 * 3600 * 1000;
const A = { 'X-Device-Id': 'tablet-0001', 'X-Device-Name': encodeURIComponent('Galaxy Tab') };
const xml = (v) => `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <int name="x" value="${v}" />\n</map>\n`;
const push = (port, files, headers = A) => raw(port, 'POST', '/admin/api/sync/databases/push', { headers: { ...W, ...headers }, body: { folder: '/storage/emulated/0/Documents/jya2/databases', files } });
const verify = async (port) => (await raw(port, 'GET', '/admin/api/sync/verify')).json;
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const dayDir = (dir, day = '2026-10-11') => path.join(dir, 'backups', day, 'databases');
const hello = (port, headers = A) => raw(port, 'POST', '/admin/api/sync/hello', { headers: { ...W, ...headers }, body: { id: headers['X-Device-Id'], name: 'x', state: 'idle' } });
const listCommands = async (port) => (await raw(port, 'GET', '/admin/api/cache/commands')).json.commands;

test('server check: the latest copy equals the newest backup day', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, [{ name: 'a.xml', text: xml(1) }, { name: 'Cài đặt cơ bản.xml', text: xml(2) }]);
    const r = await verify(port);
    assert.deepEqual([r.ok, r.day, r.checked, r.same, r.problems], [true, '2026-10-11', 2, 2, []]);
    assert.match(r.at, /^\d{4}-\d\d-\d\dT/);
  }, { clock: () => T0 });
});

test('server check: finds a file that differs, one missing from the day and an extra one in the day', async () => {
  await withServer({}, async ({ port, dir }) => {
    await push(port, [{ name: 'a.xml', text: xml(1) }, { name: 'b.xml', text: xml(2) }, { name: 'c.xml', text: xml(3) }]);
    fs.writeFileSync(path.join(dayDir(dir), 'a.xml'), xml(9)); // changed behind the server's back
    fs.rmSync(path.join(dayDir(dir), 'b.xml')); // lost
    fs.writeFileSync(path.join(dayDir(dir), 'zzz.xml'), xml(5)); // not in the latest copy
    const r = await verify(port);
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems.map((p) => [p.name, p.kind]).sort(), [['a.xml', 'different'], ['b.xml', 'missing_in_day'], ['zzz.xml', 'extra_in_day']]);
    assert.deepEqual([r.checked, r.same], [3, 1]);
    const a = r.problems.find((p) => p.name === 'a.xml');
    assert.deepEqual([a.latest_sha256, a.day_sha256], [sha(xml(1)), sha(xml(9))]);
  }, { clock: () => T0 });
});

test('server check uses the NEWEST day, not today by name', async () => {
  const c = { now: T0 };
  await withServer({}, async ({ port, dir }) => {
    await push(port, [{ name: 'a.xml', text: xml(1) }]);
    c.now += DAY;
    await push(port, [{ name: 'a.xml', text: xml(2) }]);
    fs.writeFileSync(path.join(dayDir(dir, '2026-10-11'), 'a.xml'), xml(7)); // the older day is damaged: not our business
    const r = await verify(port);
    assert.deepEqual([r.ok, r.day], [true, '2026-10-12']);
  }, { clock: () => c.now });
});

test('server check with nothing stored says so instead of passing', async () => {
  await withServer({}, async ({ port }) => {
    const r = await verify(port);
    assert.deepEqual([r.ok, r.reason, r.checked], [false, 'no_backup_day', 0]);
  });
});

test('manifest: names, utf-8 byte sizes and sha-256 of the latest copy and of the newest day', async () => {
  await withServer({}, async ({ port }) => {
    const t = xml('Tiếng Việt 中文');
    await push(port, [{ name: 'Cài đặt cơ bản.xml', text: t }, { name: 'a.xml', text: xml(1) }]);
    const r = (await raw(port, 'GET', '/admin/api/sync/manifest')).json;
    const want = [{ name: 'a.xml', bytes: Buffer.byteLength(xml(1)), sha256: sha(xml(1)) }, { name: 'Cài đặt cơ bản.xml', bytes: Buffer.byteLength(t), sha256: sha(t) }]
      .sort((x, y) => (x.name < y.name ? -1 : 1)); // sorted by character code, the same on every machine
    assert.deepEqual(r.latest, want);
    assert.deepEqual([r.day.date, r.day.files], ['2026-10-11', want]);
  }, { clock: () => T0 });
  await withServer({}, async ({ port }) => {
    const r = (await raw(port, 'GET', '/admin/api/sync/manifest')).json;
    assert.deepEqual([r.latest, r.day], [[], null]);
  });
});

test('the web page can ask the tablet to check itself; the tablet answers with what it found', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, [{ name: 'a.xml', text: xml(1) }]);
    assert.equal((await raw(port, 'POST', '/admin/api/sync/verify-request', { body: {} })).status, 403, 'the write guard applies');
    const r = await raw(port, 'POST', '/admin/api/sync/verify-request', { headers: W, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.command.targets, 1);
    const cmd = (await hello(port)).json.commands[0];
    assert.deepEqual([cmd.type, cmd.ids, cmd.id], ['verify_sync', [], r.json.command.id]);
    assert.equal((await listCommands(port))[0].status, 'pending');
    const ans = await raw(port, 'POST', `/admin/api/sync/commands/${cmd.id}/result`, { headers: { ...W, ...A }, body: { verify: { day: '2026-10-11', checked: 3, same: 1, different: ['a.xml'], only_tablet: ['new.xml', 5], only_server: [], day_different: ['a.xml'], error: '' } } });
    assert.equal(ans.status, 200);
    const c = (await listCommands(port))[0];
    assert.equal(c.status, 'attention', 'differences need a look');
    assert.deepEqual(c.results['tablet-0001'].verify, { day: '2026-10-11', checked: 3, same: 1, different: ['a.xml'], only_tablet: ['new.xml'], only_server: [], day_different: ['a.xml'], error: '' });
    assert.deepEqual((await hello(port)).json.commands, [], 'answered commands are not handed out again');
  }, { clock: () => T0 });
});

test('a tablet that is fully in sync makes the verify command done', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, [{ name: 'a.xml', text: xml(1) }]);
    await raw(port, 'POST', '/admin/api/sync/verify-request', { headers: W, body: {} });
    const cmd = (await hello(port)).json.commands[0];
    await raw(port, 'POST', `/admin/api/sync/commands/${cmd.id}/result`, { headers: { ...W, ...A }, body: { verify: { day: '2026-10-11', checked: 1, same: 1, different: [], only_tablet: [], only_server: [], day_different: [], error: '' } } });
    assert.equal((await listCommands(port))[0].status, 'done');
  }, { clock: () => T0 });
});

test('a verify request with no known tablet only tells so', async () => {
  await withServer({}, async ({ port }) => {
    const r = await raw(port, 'POST', '/admin/api/sync/verify-request', { headers: W, body: {} });
    assert.deepEqual([r.status, r.json.command.targets], [200, 0]);
    assert.equal((await listCommands(port))[0].status, 'server_only');
  });
});

test('a delete command carries the names of the items, in the order of its ids and without duplicates', async () => {
  const C = require('./admin/cachexml');
  const id = (c) => c.repeat(32);
  const str = (n, v) => `<string name="${C.escapeXml(n)}">${C.escapeXml(v)}</string>`;
  const item = (i) => ({ id: i, name: '2026-01-01 00:00:00', game: 'com.zjx.pubg.rcConfig2', public: false, meta: JSON.stringify({ name: `n-${i[0]}` }) });
  const cache = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    ${str('list|com.zjx.pubg.rcConfig2', JSON.stringify({ selected: id('a'), items: [item(id('a')), item(id('b'))] }))}\n    ${str(`map|${id('a')}`, '{"x":1}')}\n    ${str(`map|${id('b')}`, '{"x":2}')}\n    ${str(`map|${id('c')}`, '{"x":3}')}\n</map>\n`;
  await withServer({}, async ({ port }) => {
    await push(port, [{ name: 'gamwing_keymap_cache.xml', text: cache }]);
    await hello(port);
    const etag = (await raw(port, 'GET', '/admin/api/sync/databases/gamwing_keymap_cache.xml')).json.etag;
    const r = await raw(port, 'POST', '/admin/api/cache/delete', { headers: W, body: { file: 'gamwing_keymap_cache.xml', ids: [id('c'), id('b')], etag, items: [{ id: id('c'), label: 'Mồ côi C' }, { id: id('b'), label: 'Bản B' }] } });
    assert.equal(r.status, 200, r.text);
    const cmd = (await hello(port)).json.commands[0];
    assert.deepEqual([cmd.ids, cmd.labels], [[id('c'), id('b')], ['Mồ côi C', 'Bản B']]);
  });
});
