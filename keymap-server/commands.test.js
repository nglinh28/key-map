'use strict';
// Deleting items of gamwing_keymap_cache.xml from the web page, and handing the same deletion to the tablet through the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Commands } = require('./commands');
const C = require('./admin/cachexml');
const { withServer, raw } = require('./harness');

const W = { 'X-Admin-Request': '1' };
const CACHE = 'gamwing_keymap_cache.xml';
const KM = 'com.vng.pubgmobile';
const RC = 'com.zjx.pubg.rcConfig2';
const id = (c) => c.repeat(32);
const T0 = Date.UTC(2026, 9, 10, 20, 30);
const DAY = 24 * 3600 * 1000;

const str = (name, value) => `<string name="${C.escapeXml(name)}">${C.escapeXml(value)}</string>`;
const prefs = (...lines) => `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n${lines.map((l) => `    ${l}`).join('\n')}\n</map>\n`;
const keymap = { version: '1', components: [{ 'base:componentIdentifier': 'com.zjx.app:joystick' }] };
const item = (i, game, name) => ({ id: i, name: '2026-01-01 00:00:00', game, public: false, meta: JSON.stringify({ name }) });
// a = listed keymap, b = orphan keymap, c = selected recoil config, d = second recoil config (not selected)
const cacheXml = () => prefs(
  str(`list|${KM}`, JSON.stringify({ selected: id('a'), items: [item(id('a'), KM, 'Mine')] })),
  str(`map|${id('a')}`, JSON.stringify(keymap)),
  str(`map|${id('b')}`, JSON.stringify({ ...keymap, version: 'old' })),
  str(`list|${RC}`, JSON.stringify({ selected: id('c'), items: [item(id('c'), RC, 'Recoil C'), item(id('d'), RC, 'Recoil D')] })),
  str(`map|${id('c')}`, JSON.stringify({ name: 'Recoil C', recoil_data: [] })),
  str(`map|${id('d')}`, JSON.stringify({ name: 'Recoil D', recoil_data: [] })),
);
const other = '<?xml version=\'1.0\' ?>\n<map>\n    <int name="x" value="1" />\n</map>\n';
const A = { 'X-Device-Id': 'tablet-0001', 'X-Device-Name': encodeURIComponent('Galaxy Tab') };
const B = { 'X-Device-Id': 'phone-00002', 'X-Device-Name': 'Phone' };

const push = (port, name, text, headers = A, folder = '/storage/emulated/0/Documents/jya2/databases') => raw(port, 'POST', '/admin/api/sync/databases/push', { headers: { ...W, ...headers }, body: { folder, files: [{ name, text }] } });
const getFile = async (port, name = CACHE) => (await raw(port, 'GET', `/admin/api/sync/databases/${encodeURIComponent(name)}`)).json;
const hello = (port, headers = A) => raw(port, 'POST', '/admin/api/sync/hello', { headers: { ...W, ...headers }, body: { id: headers['X-Device-Id'], name: 'x', state: 'idle' } });
const del = (port, body, headers = W) => raw(port, 'POST', '/admin/api/cache/delete', { headers, body });
const report = (port, cmdId, body, headers = A) => raw(port, 'POST', `/admin/api/sync/commands/${cmdId}/result`, { headers: { ...W, ...headers }, body });
const commands = async (port) => (await raw(port, 'GET', '/admin/api/cache/commands')).json.commands;

test('store: a command is for the devices known when it was made, until each one reports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftcmd-'));
  const now = { t: T0 };
  const s = new Commands({ file: path.join(dir, 'commands.json'), clock: () => now.t });
  const c = s.create({ type: 'delete_cache_items', file: CACHE, ids: [id('b')], labels: ['Old'], targets: [{ id: 'tablet-0001', name: 'Tab' }, { id: 'phone-00002', name: 'Phone' }] });
  assert.match(c.id, /^cmd_[0-9a-f]{16}$/);
  assert.deepEqual(s.pendingFor('tablet-0001').map((x) => x.id), [c.id]);
  assert.deepEqual(s.pendingFor('nobody-0001'), []);
  assert.equal(s.list()[0].status, 'pending');
  s.report(c.id, 'tablet-0001', { removed: [id('b')], missing: [], reappeared: [], skipped: [], error: '', backup: '/x' });
  assert.deepEqual(s.pendingFor('tablet-0001'), []);
  assert.equal(s.list()[0].status, 'pending', 'the phone has not answered yet');
  s.report(c.id, 'phone-00002', { removed: [], missing: [id('b')], error: '' });
  assert.equal(s.list()[0].status, 'done');
  // a result with a problem needs attention; one with no target at all is only a server change
  const d = s.create({ type: 'delete_cache_items', file: CACHE, ids: [id('c')], targets: [{ id: 'tablet-0001', name: 'Tab' }] });
  s.report(d.id, 'tablet-0001', { removed: [], reappeared: [id('c')] });
  assert.equal(s.list().find((x) => x.id === d.id).status, 'attention');
  const e = s.create({ type: 'delete_cache_items', file: CACHE, ids: [id('d')], targets: [] });
  assert.equal(s.list().find((x) => x.id === e.id).status, 'server_only');
  // survives a restart, old commands are not handed out any more
  const again = new Commands({ file: path.join(dir, 'commands.json'), clock: () => now.t });
  assert.equal(again.list().length, 3);
  const f = again.create({ type: 'delete_cache_items', file: CACHE, ids: [id('a')], targets: [{ id: 'tablet-0001', name: 'Tab' }] });
  now.t += 15 * DAY;
  assert.deepEqual(again.pendingFor('tablet-0001'), [], 'expired');
  assert.equal(again.list().find((x) => x.id === f.id).status, 'expired');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: a device that is forgotten no longer holds commands back; what it already answered is kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftcmd-'));
  const s = new Commands({ file: path.join(dir, 'commands.json'), clock: () => T0 });
  const c = s.create({ type: 'delete_cache_items', file: CACHE, ids: [id('b')], targets: [{ id: 'tablet-0001', name: 'Tab' }, { id: 'old-device-3', name: 'Tab' }] });
  s.report(c.id, 'tablet-0001', { removed: [], missing: [id('b')] });
  assert.equal(s.list()[0].status, 'pending', 'the old device never answers');
  assert.equal(s.dropTarget('old-device-3'), 1);
  assert.equal(s.list()[0].status, 'done');
  assert.deepEqual(s.list()[0].targets.map((t) => t.id), ['tablet-0001']);
  assert.deepEqual(s.pendingFor('old-device-3'), []);
  // a device that answered stays in the command (its answer is history); a command left with nobody is a server-only change
  assert.equal(s.dropTarget('tablet-0001'), 0, 'already answered: kept');
  const d = s.create({ type: 'verify_sync', file: '', ids: [], targets: [{ id: 'old-device-3', name: 'Tab' }] });
  assert.equal(s.dropTarget('old-device-3'), 1);
  assert.equal(s.list().find((x) => x.id === d.id).status, 'server_only');
  assert.equal(s.dropTarget('nobody-0001'), 0);
  assert.equal(new Commands({ file: path.join(dir, 'commands.json'), clock: () => T0 }).list().find((x) => x.id === d.id).targets.length, 0, 'saved');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('forgetting a device on the web page releases the commands that were waiting for it', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, CACHE, cacheXml(), A);
    await hello(port, B);
    const made = (await del(port, { file: CACHE, ids: [id('b')], etag: (await getFile(port)).etag })).json;
    assert.equal(made.command.targets, 2);
    await report(port, made.command.id, { removed: [id('b')] }, A);
    assert.equal((await commands(port))[0].status, 'pending', 'the phone has not answered');
    const gone = await raw(port, 'DELETE', `/admin/api/sync/devices/${B['X-Device-Id']}`, { headers: W });
    assert.equal(gone.status, 200);
    const after = (await commands(port))[0];
    assert.equal(after.status, 'done');
    assert.deepEqual(after.targets.map((t) => t.id), ['tablet-0001']);
  });
});

test('store: results are cleaned, unknown commands and devices are ignored, only the newest 50 are kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftcmd-'));
  const s = new Commands({ file: path.join(dir, 'commands.json'), clock: () => T0 });
  const c = s.create({ type: 'delete_cache_items', file: CACHE, ids: [id('b')], targets: [{ id: 'tablet-0001', name: 'Tab' }] });
  assert.equal(s.report('cmd_unknown', 'tablet-0001', {}), null);
  assert.equal(s.report(c.id, 'someone-else', {}), null, 'not a target');
  s.report(c.id, 'tablet-0001', { removed: [id('b'), 5, '../x'], error: `bad\u0000${'e'.repeat(500)}`, backup: { evil: 1 }, skipped: [{ id: id('a'), reason: 'đang trong danh sách' }, 'junk'] });
  const r = s.list()[0].results['tablet-0001'];
  assert.deepEqual(r.removed, [id('b')]);
  assert.equal(r.error.length, 300);
  assert.equal(r.backup, '');
  assert.deepEqual(r.skipped, [{ id: id('a'), reason: 'đang trong danh sách' }]);
  for (let i = 0; i < 60; i++) s.create({ type: 'delete_cache_items', file: CACHE, ids: [id('b')], targets: [] });
  assert.equal(s.list().length, 50);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deleting an orphan: the server file changes at once, with history and backup, and the tablet gets a command', async () => {
  await withServer({}, async ({ port, dir }) => {
    await push(port, CACHE, cacheXml());
    await hello(port, A);
    const before = await getFile(port);
    const r = await del(port, { file: CACHE, ids: [id('b')], etag: before.etag });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.removedMaps, r.json.lists, r.json.missing], [[id('b')], [], []]);
    const after = await getFile(port);
    assert.deepEqual(C.parse(after.text).entries.map((e) => e.name), C.parse(before.text).entries.map((e) => e.name).filter((n) => n !== `map|${id('b')}`));
    assert.equal(after.folder, '/storage/emulated/0/Documents/jya2/databases', 'where the file lives is not lost');
    // the old text is kept as a version, and today's backup holds the new one
    const v = (await raw(port, 'GET', `/admin/api/sync/databases/${CACHE}/history`)).json.versions;
    assert.equal(v.length, 1);
    assert.equal((await raw(port, 'GET', `/admin/api/sync/databases/${CACHE}/history/${v[0].version}`)).json.text, before.text);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'backups', '2026-10-11', '_manifest.json'), 'utf8'));
    assert.equal(manifest.last_actor, 'Giao diện web');
    // the tablet is told in its next heartbeat; another device that was never seen is not
    const beat = (await hello(port, A)).json;
    assert.equal(beat.commands.length, 1);
    assert.deepEqual([beat.commands[0].type, beat.commands[0].file, beat.commands[0].ids], ['delete_cache_items', CACHE, [id('b')]]);
    assert.deepEqual((await hello(port, B)).json.commands, []);
    const list = await commands(port);
    assert.deepEqual([list.length, list[0].status, list[0].targets.map((t) => t.id), list[0].ids], [1, 'pending', ['tablet-0001'], [id('b')]]);
  }, { clock: () => T0 });
});

test('the tablet reports its result, the command is done and is not handed out again', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, CACHE, cacheXml());
    await hello(port, A);
    const e = (await getFile(port)).etag;
    await del(port, { file: CACHE, ids: [id('b')], etag: e });
    const cmd = (await hello(port, A)).json.commands[0];
    const rep = await report(port, cmd.id, { removed: [id('b')], missing: [], reappeared: [], skipped: [], error: '', backup: '/storage/emulated/0/Documents/FTKeymapSync/backup/20261011-103000/databases' });
    assert.equal(rep.status, 200);
    assert.deepEqual((await hello(port, A)).json.commands, []);
    const c = (await commands(port))[0];
    assert.equal(c.status, 'done');
    assert.deepEqual(c.results['tablet-0001'].removed, [id('b')]);
    assert.equal((await report(port, 'cmd_0000000000000000', {})).status, 404);
    assert.equal((await raw(port, 'POST', `/admin/api/sync/commands/${cmd.id}/result`, { headers: { 'X-Admin-Request': '1' }, body: {} })).status, 400, 'a device must say who it is');
    assert.equal((await raw(port, 'POST', `/admin/api/sync/commands/${cmd.id}/result`, { headers: A, body: {} })).status, 403, 'the write guard applies');
  });
});

test('deleting a listed item also takes it out of its list and moves the selection', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, CACHE, cacheXml(), {}); // no device identity: the server has never seen a tablet
    const r = await del(port, { file: CACHE, ids: [id('c')], etag: (await getFile(port)).etag });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.lists, [{ ns: RC, removed: [id('c')], selectedBefore: id('c'), selectedAfter: id('d') }]);
    const a = C.analyze(C.parse((await getFile(port)).text));
    const rc = a.namespaces.find((n) => n.ns === RC);
    assert.deepEqual([rc.selected, rc.items.map((i) => i.id)], [id('d'), [id('d')]]);
    assert.ok(!a.docs.has(id('c')));
    assert.deepEqual((await commands(port))[0].status, 'server_only', 'no tablet had been seen yet');
  });
});

test('bad requests change nothing', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, CACHE, cacheXml());
    await push(port, 'Other.xml', other);
    const e = (await getFile(port)).etag;
    const keep = (await getFile(port)).text;
    const check = async (body, status, headers) => {
      const r = await del(port, body, headers);
      assert.equal(r.status, status, `${JSON.stringify(body)} -> ${r.status} ${r.text}`);
      assert.equal((await getFile(port)).text, keep, 'the file is untouched');
    };
    await check({ file: CACHE, ids: [id('b')], etag: e }, 403, {}); // no write guard
    await check({ file: CACHE, ids: [], etag: e }, 400, W);
    await check({ file: CACHE, ids: 'x', etag: e }, 400, W);
    await check({ file: CACHE, ids: ['../x'], etag: e }, 400, W);
    await check({ file: CACHE, ids: Array.from({ length: 201 }, (_, i) => `id${i}`), etag: e }, 400, W);
    await check({ file: CACHE, ids: [id('9')], etag: e }, 404, W); // nowhere in the file
    await check({ file: CACHE, ids: [id('b')], etag: 'a'.repeat(16) }, 409, W); // someone changed the file since the page was loaded
    await check({ file: CACHE, ids: [id('b')] }, 409, W); // no etag at all
    await check({ file: 'nope.xml', ids: [id('b')], etag: e }, 404, W);
    await check({ file: '../x.xml', ids: [id('b')], etag: e }, 404, W);
    assert.deepEqual(await commands(port), []);
    // a file that is not a preferences file with items is refused too
    const o = await getFile(port, 'Other.xml');
    assert.equal((await del(port, { file: 'Other.xml', ids: [id('b')], etag: o.etag }, W)).status, 404);
    await push(port, 'Weird.xml', '<root/>');
    const w = await getFile(port, 'Weird.xml');
    assert.equal((await del(port, { file: 'Weird.xml', ids: [id('b')], etag: w.etag }, W)).status, 400);
  });
});

test('until the tablet has reported, a push of that file from the tablet cannot bring the deleted items back', async () => {
  await withServer({}, async ({ port }) => {
    const old = cacheXml();
    await push(port, CACHE, old);
    await hello(port, A);
    await del(port, { file: CACHE, ids: [id('b'), id('d')], etag: (await getFile(port)).etag });
    // the tablet still has the old file and pushes it again (for instance because Gamwing wrote it) before it heard of the command
    await push(port, CACHE, old.replace('"version":', '"version":'), A);
    let names = C.parse((await getFile(port)).text).entries.map((e) => e.name);
    assert.ok(!names.includes(`map|${id('b')}`) && !names.includes(`map|${id('d')}`), 'items stay deleted');
    assert.ok(names.includes(`map|${id('a')}`) && names.includes(`map|${id('c')}`), 'everything else is stored as pushed');
    // a device that is not a target is not touched by the command
    await push(port, CACHE, old, B);
    names = C.parse((await getFile(port)).text).entries.map((e) => e.name);
    assert.ok(names.includes(`map|${id('b')}`));
    // once the tablet has reported, its pushes are stored as they are
    await push(port, CACHE, old, A);
    const cmd = (await hello(port, A)).json.commands[0];
    await report(port, cmd.id, { removed: [id('b'), id('d')] });
    await push(port, CACHE, old, A);
    assert.ok(C.parse((await getFile(port)).text).entries.some((e) => e.name === `map|${id('b')}`));
  });
});
