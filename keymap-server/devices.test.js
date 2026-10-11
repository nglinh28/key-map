'use strict';
// App <-> web awareness: the phone app sends heartbeats, the web page sends presence pings, both can see the other.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withServer, raw } = require('./harness');
const { createServer, loadConfig } = require('./server');

const W = { 'X-Admin-Request': '1' };
const T0 = Date.UTC(2026, 9, 11, 3, 0, 0);
const SEC = 1000;
const hello = (port, body, headers = W) => raw(port, 'POST', '/admin/api/sync/hello', { headers, body });
const devices = (port) => raw(port, 'GET', '/admin/api/sync/devices');
const presence = (port, session) => raw(port, 'POST', '/admin/api/presence', { headers: W, body: { session } });
const tablet = { id: 'tablet-0001', name: 'Galaxy Tab S8 Ultra', model: 'SM-X906B', android: '15', app_version: '1.0.0', auto_push: true, folder: 'Documents/jya2/databases', state: 'watching', ip: '192.168.4.21' };

function clock(start = T0) {
  const c = { now: start, fn: () => c.now };
  return c;
}

test('hello registers the device and it is online until 40 seconds without a heartbeat', async () => {
  const c = clock();
  await withServer({}, async ({ port }) => {
    const r = await hello(port, tablet);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.ok, r.json.online, r.json.web.sessions], [true, 1, 0]);

    let list = (await devices(port)).json;
    assert.equal(list.devices.length, 1);
    const d = list.devices[0];
    assert.deepEqual([d.id, d.name, d.model, d.android, d.app_version, d.auto_push, d.state, d.ip, d.online], ['tablet-0001', 'Galaxy Tab S8 Ultra', 'SM-X906B', '15', '1.0.0', true, 'watching', '192.168.4.21', true]);
    assert.equal(d.last_seen, new Date(T0).toISOString());

    c.now += 39 * SEC;
    assert.equal((await devices(port)).json.devices[0].online, true);
    c.now += 2 * SEC;
    list = (await devices(port)).json;
    assert.equal(list.devices[0].online, false, 'no heartbeat for 41 s');
    assert.equal(list.devices[0].last_seen, new Date(T0).toISOString(), 'the last time it was seen is kept');

    await hello(port, tablet);
    assert.equal((await devices(port)).json.devices[0].online, true, 'a new heartbeat brings it back');
  }, { clock: c.fn });
});

test('the sync endpoints also count as a sign of life when the app sends its identity headers', async () => {
  const c = clock();
  await withServer({}, async ({ port }) => {
    const ident = { 'X-Device-Id': 'tablet-0002', 'X-Device-Name': encodeURIComponent('Máy tính bảng của tôi') };
    await raw(port, 'GET', '/admin/api/sync/info', { headers: ident });
    let d = (await devices(port)).json.devices;
    assert.deepEqual([d.length, d[0].id, d[0].name, d[0].online], [1, 'tablet-0002', 'Máy tính bảng của tôi', true]);
    c.now += 60 * SEC;
    assert.equal((await devices(port)).json.devices[0].online, false);
    await raw(port, 'GET', '/admin/api/sync/databases', { headers: ident });
    assert.equal((await devices(port)).json.devices[0].online, true);
    // no or bad identity: nothing is registered
    await raw(port, 'GET', '/admin/api/sync/info');
    await raw(port, 'GET', '/admin/api/sync/info', { headers: { 'X-Device-Id': 'x' } });
    await raw(port, 'GET', '/admin/api/sync/info', { headers: { 'X-Device-Id': '../../etc' } });
    assert.equal((await devices(port)).json.devices.length, 1);
  }, { clock: c.fn });
});

test('the last push and the last read of a backup day by a device are remembered', async () => {
  const c = clock();
  await withServer({}, async ({ port }) => {
    const ident = { ...W, 'X-Device-Id': 'tablet-0003', 'X-Device-Name': 'Tab' };
    const xml = '<map><int name="x" value="1" /></map>';
    await raw(port, 'POST', '/admin/api/sync/databases/push', { headers: ident, body: { files: [{ name: 'a.xml', text: xml }, { name: 'b.xml', text: xml }, { name: 'license.xml', text: xml }] } });
    c.now += 5 * SEC;
    await raw(port, 'POST', '/admin/api/sync/databases/push', { headers: ident, body: { files: [{ name: 'a.xml', text: xml }] } });
    let d = (await devices(port)).json.devices[0];
    assert.deepEqual([d.last_push.saved, d.last_push.unchanged, d.last_push.skipped], [0, 1, 0], 'the latest push is the one remembered');
    c.now += 5 * SEC;
    await raw(port, 'POST', '/admin/api/sync/databases/push', { headers: ident, body: { files: [{ name: 'a.xml', text: xml.replace('1', '2') }, { name: 'license.xml', text: xml }] } });
    d = (await devices(port)).json.devices[0];
    assert.deepEqual([d.last_push.saved, d.last_push.unchanged, d.last_push.skipped], [1, 0, 1]);
    assert.equal(d.last_push.at, new Date(T0 + 10 * SEC).toISOString());
    assert.equal(d.last_pull, null);
    c.now += 5 * SEC;
    const today = (await raw(port, 'GET', '/admin/api/sync/backups')).json.days[0].date;
    await raw(port, 'GET', `/admin/api/sync/backups/${today}/databases`, { headers: ident });
    d = (await devices(port)).json.devices[0];
    assert.deepEqual([d.last_pull.files, d.last_pull.at], [2, new Date(T0 + 15 * SEC).toISOString()]);
  }, { clock: c.fn });
});

test('the web page announces itself and the app can see how many pages are open', async () => {
  const c = clock();
  await withServer({}, async ({ port }) => {
    assert.equal((await presence(port, 'session-aaaa')).json.sessions, 1);
    assert.equal((await presence(port, 'session-bbbb')).json.sessions, 2);
    assert.equal((await presence(port, 'session-aaaa')).json.sessions, 2, 'the same page twice counts once');
    assert.equal((await raw(port, 'GET', '/admin/api/sync/info')).json.web.sessions, 2, 'the app sees it in info');
    assert.equal((await hello(port, tablet)).json.web.sessions, 2, 'and in every heartbeat answer');
    assert.equal((await devices(port)).json.web.sessions, 2);
    c.now += 31 * SEC;
    assert.equal((await raw(port, 'GET', '/admin/api/sync/info')).json.web.sessions, 0, 'pages that stopped pinging are gone');
    await presence(port, 'session-bbbb');
    assert.equal((await raw(port, 'GET', '/admin/api/sync/info')).json.web.sessions, 1);
  }, { clock: c.fn });
});

test('info reports how many devices are online', async () => {
  const c = clock();
  await withServer({}, async ({ port }) => {
    assert.equal((await raw(port, 'GET', '/admin/api/sync/info')).json.devices_online, 0);
    await hello(port, tablet);
    await hello(port, { ...tablet, id: 'phone-00001', name: 'Phone' });
    assert.equal((await raw(port, 'GET', '/admin/api/sync/info')).json.devices_online, 2);
    c.now += 50 * SEC;
    await hello(port, tablet);
    assert.equal((await raw(port, 'GET', '/admin/api/sync/info')).json.devices_online, 1);
  }, { clock: c.fn });
});

test('the device list survives a server restart (but nobody is online any more)', async () => {
  const c = clock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftks-dev-'));
  const start = async () => {
    const server = createServer({ ...loadConfig({ DATA_DIR: dir }), clock: c.fn });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, port: server.address().port };
  };
  const stop = (s) => new Promise((r) => s.server.close(r));
  try {
    let s = await start();
    await hello(s.port, tablet);
    await stop(s);
    c.now += 120 * SEC;
    s = await start();
    const d = (await devices(s.port)).json.devices;
    assert.deepEqual([d.length, d[0].id, d[0].name, d[0].online], [1, 'tablet-0001', 'Galaxy Tab S8 Ultra', false]);
    assert.equal(d[0].last_seen, new Date(T0).toISOString());
    await stop(s);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a device can be forgotten', async () => {
  await withServer({}, async ({ port }) => {
    await hello(port, tablet);
    assert.equal((await raw(port, 'DELETE', '/admin/api/sync/devices/tablet-0001', { headers: W })).status, 200);
    assert.equal((await devices(port)).json.devices.length, 0);
    assert.equal((await raw(port, 'DELETE', '/admin/api/sync/devices/tablet-0001', { headers: W })).status, 404);
    assert.equal((await raw(port, 'DELETE', '/admin/api/sync/devices/tablet-0001')).status, 403, 'needs the admin header');
  });
});

test('input is validated and cleaned', async () => {
  await withServer({}, async ({ port }) => {
    assert.equal((await hello(port, { name: 'no id' })).status, 400);
    assert.equal((await hello(port, { id: 'bad id with spaces' })).status, 400);
    assert.equal((await hello(port, { id: '../../x/y/z/w' })).status, 400);
    assert.equal((await hello(port, tablet, {})).status, 403, 'needs the admin header');
    assert.equal((await presence(port, 'x')).status, 400);
    const r = await hello(port, { id: 'weird-name-1', name: `  A\u0000B\u0007${'x'.repeat(200)}  `, model: 5, auto_push: 'yes', state: 'bogus' });
    assert.equal(r.status, 200);
    const d = (await devices(port)).json.devices[0];
    assert.ok(d.name.startsWith('AB') && d.name.length <= 60 && !/[\u0000-\u001f]/.test(d.name));
    assert.equal(d.model, '', 'a wrong type becomes empty');
    assert.equal(d.auto_push, false);
    assert.equal(d.state, 'idle', 'unknown states are normalised');
  });
});

test('the number of remembered devices is capped (the oldest offline ones go first)', async () => {
  const c = clock();
  await withServer({}, async ({ port }) => {
    for (let i = 0; i < 55; i++) { await hello(port, { ...tablet, id: `device-${String(i).padStart(4, '0')}`, name: `D${i}` }); c.now += 60 * SEC; }
    const list = (await devices(port)).json.devices;
    assert.equal(list.length, 50);
    assert.ok(list.some((d) => d.id === 'device-0054'), 'the newest is kept');
    assert.ok(!list.some((d) => d.id === 'device-0000'), 'the oldest is dropped');
  }, { clock: c.fn });
});
