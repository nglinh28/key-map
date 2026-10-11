'use strict';
// Sync endpoints used by the Android companion app: info, push (phone -> server, keeps old versions), pull (server -> phone).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { withServer, raw } = require('./harness');

const W = { 'X-Admin-Request': '1' };
const DEFAULT_ACC = `c_${'0'.repeat(32)}`;
const NS = 'com.vng.pubgmobile';
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

const info = (port) => raw(port, 'GET', '/admin/api/sync/info');
const push = (port, files) => raw(port, 'POST', '/admin/api/sync/push', { headers: W, body: { files } });
const pull = (port) => raw(port, 'GET', '/admin/api/sync/pull');
const listFile = (ns, selected, items) => ({ name: `list%7C${ns}.json`, text: JSON.stringify({ selected, items }) });
const mapFile = (id, body) => ({ name: `map%7C${id}.json`, text: JSON.stringify(body) });
const item = (id, name, meta, pub = false) => ({ id, name, game: NS, public: pub, ...(meta === undefined ? {} : { meta: JSON.stringify(meta) }) });
const history = async (port, id) => (await raw(port, 'GET', `/admin/api/accounts/${DEFAULT_ACC}/docs/${id}/history`)).json.versions;
const getDoc = async (port, id) => (await raw(port, 'GET', `/admin/api/accounts/${DEFAULT_ACC}/docs/${id}`)).json;

const basic = () => [
  listFile(NS, B, [item(A, '2026-01-01 10:00:00', { name: 'Official', componentCount: 1 }, true), item(B, '2026-02-02 11:00:00', { name: 'Mine' })]),
  mapFile(A, { version: '1', components: [1] }),
  mapFile(B, { version: '1', components: [1, 2] }),
];

test('info reports the server, the default sync account and the counts', async () => {
  await withServer({}, async ({ port }) => {
    const r = await info(port);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.ok, r.json.server, r.json.account, r.json.accounts, r.json.docs], [true, 'ft-keymap-server', DEFAULT_ACC, 0, 0]);
    assert.match(r.json.version, /^\d+\.\d+\.\d+$/);
    await push(port, basic());
    const r2 = await info(port);
    assert.deepEqual([r2.json.accounts, r2.json.docs], [1, 2]);
  });
  const custom = `c_${'1'.repeat(32)}`;
  await withServer({ SYNC_ACCOUNT: custom }, async ({ port }) => {
    assert.equal((await info(port)).json.account, custom);
  });
  await withServer({ SYNC_ACCOUNT: 'not-valid' }, async ({ port }) => {
    assert.equal((await info(port)).json.account, DEFAULT_ACC, 'an invalid setting falls back to the default');
  });
});

test('push needs the admin header and a files array', async () => {
  await withServer({}, async ({ port }) => {
    assert.equal((await raw(port, 'POST', '/admin/api/sync/push', { body: { files: basic() } })).status, 403);
    assert.equal((await raw(port, 'POST', '/admin/api/sync/push', { headers: W, body: {} })).status, 400);
    assert.equal((await raw(port, 'POST', '/admin/api/sync/push', { headers: W, body: { files: [{ name: 1 }] } })).status, 400);
  });
});

test('push creates documents in the default account and pull gives back the same files', async () => {
  await withServer({}, async ({ port }) => {
    const r = await push(port, basic());
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.imported.map((d) => d.id), [A, B]);
    assert.deepEqual([r.json.updated.length, r.json.unchanged, r.json.skipped.length, r.json.snapshots], [0, 0, 0, 0]);

    const p = await pull(port);
    assert.equal(p.status, 200);
    const files = Object.fromEntries(p.json.files.map((f) => [f.name, JSON.parse(f.text)]));
    assert.deepEqual(Object.keys(files).sort(), [`list%7C${NS}.json`, `map%7C${A}.json`, `map%7C${B}.json`].sort());
    assert.deepEqual(files[`map%7C${A}.json`], { version: '1', components: [1] });
    const list = files[`list%7C${NS}.json`];
    assert.equal(list.selected, B);
    assert.deepEqual(list.items.map((i) => i.id), [A, B]);
    assert.deepEqual(list.items[0], { id: A, name: '2026-01-01 10:00:00', game: NS, public: true, meta: JSON.stringify({ name: 'Official', componentCount: 1 }) });
    assert.equal(list.items[1].public, false);
  });
});

test('a recognition-style item without meta stays without meta', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, [listFile('com.zjx.pubg.recognition.com.vng.pubgmobile', A, [{ id: A, name: '2026-03-03 12:00:00', game: 'com.zjx.pubg.recognition.com.vng.pubgmobile', public: false }]), mapFile(A, { components: [] })]);
    const list = JSON.parse((await pull(port)).json.files.find((f) => f.name.startsWith('list')).text);
    assert.equal('meta' in list.items[0], false);
  });
});

test('pushing the same files again changes nothing and creates no history', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, basic());
    const r = await push(port, basic());
    assert.deepEqual([r.json.imported.length, r.json.updated.length, r.json.unchanged, r.json.snapshots], [0, 0, 2, 0]);
    assert.deepEqual(await history(port, A), []);
  });
});

test('a changed map keeps the old version in the history (newest first) and updates the document', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, basic());
    const r1 = await push(port, [mapFile(B, { version: '2', components: [1, 2, 3] })]);
    assert.deepEqual(r1.json.updated.map((d) => d.id), [B]);
    assert.equal(r1.json.snapshots, 1);
    assert.deepEqual((await getDoc(port, B)).keymap, { version: '2', components: [1, 2, 3] });
    const r2 = await push(port, [mapFile(B, { version: '3', components: [] })]);
    assert.equal(r2.json.snapshots, 1);
    const versions = await history(port, B);
    assert.equal(versions.length, 2);
    const newest = (await raw(port, 'GET', `/admin/api/accounts/${DEFAULT_ACC}/docs/${B}/history/${versions[0].version}`)).json;
    const oldest = (await raw(port, 'GET', `/admin/api/accounts/${DEFAULT_ACC}/docs/${B}/history/${versions[1].version}`)).json;
    assert.deepEqual(newest.keymap, { version: '2', components: [1, 2, 3] });
    assert.deepEqual(oldest.keymap, { version: '1', components: [1, 2] }, 'the very first version is still there');
    assert.deepEqual(oldest.metadata, { name: 'Mine' });
  });
});

test('a map for an unknown document is skipped, and nothing is ever deleted by a push', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, basic());
    const r = await push(port, [mapFile('c'.repeat(32), { x: 1 })]);
    assert.equal(r.json.imported.length, 0);
    assert.equal(r.json.skipped[0].reason, 'no list entry for this map');
    await push(port, [listFile(NS, A, [item(A, '2026-01-01 10:00:00', { name: 'Official', componentCount: 1 }, true)])]); // B is not in this list
    assert.ok((await getDoc(port, B)).keymap, 'B survives a list that does not mention it');
    assert.equal((await info(port)).json.docs, 2);
  });
});

test('list-only changes (rename, selection) are applied; a rename keeps the old metadata in the history', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, basic());
    const r = await push(port, [listFile(NS, A, [item(A, '2026-01-01 10:00:00', { name: 'Official', componentCount: 1 }, true), item(B, '2026-02-02 11:00:00', { name: 'Renamed' })])]);
    assert.deepEqual(r.json.updated.map((d) => d.id), [B]);
    assert.equal((await getDoc(port, B)).metadata.name, 'Renamed');
    const v = (await history(port, B));
    assert.equal(v.length, 1);
    const snap = (await raw(port, 'GET', `/admin/api/accounts/${DEFAULT_ACC}/docs/${B}/history/${v[0].version}`)).json;
    assert.equal(snap.metadata.name, 'Mine');
    const sel = JSON.parse((await pull(port)).json.files.find((f) => f.name.startsWith('list')).text).selected;
    assert.equal(sel, A, 'the selection from the list file is applied');
  });
});

test('the app API (what Gamwing itself talks to) sees pushed documents', async () => {
  await withServer({}, async ({ port, call }) => {
    await push(port, basic());
    const c = '0'.repeat(32);
    const list = await call('GET', `/v2/keymap_list/${NS}`, { client: c });
    assert.deepEqual(list.json.keymaps.map((k) => k.id), [A, B]);
    assert.equal(list.json.selected_keymap_id, B);
  });
});

test('pull on an empty server is an empty list', async () => {
  await withServer({}, async ({ port }) => {
    const p = await pull(port);
    assert.equal(p.status, 200);
    assert.deepEqual(p.json.files, []);
  });
});

test('pulled file names are always safe to create on the phone', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, basic());
    for (const f of (await pull(port)).json.files) assert.match(f.name, /^(list|map)%7C[A-Za-z0-9._-]+\.json$/);
  });
});

const RAW = path.join(__dirname, '..', 'keymap_analysis', 'raw');
test('real backup: push all 12 files then pull gives the same content back', async (t) => {
  if (!fs.existsSync(RAW)) return t.skip('backup folder not available');
  const files = fs.readdirSync(RAW).filter((n) => n.endsWith('.json')).map((name) => ({ name, text: fs.readFileSync(path.join(RAW, name), 'utf8') }));
  await withServer({}, async ({ port }) => {
    const r = await push(port, files);
    assert.equal(r.json.skipped.length, 0, JSON.stringify(r.json.skipped));
    assert.equal(r.json.imported.length, 9);
    const pulled = Object.fromEntries((await pull(port)).json.files.map((f) => [f.name, JSON.parse(f.text)]));
    assert.equal(Object.keys(pulled).length, files.length);
    for (const f of files) {
      const orig = JSON.parse(f.text);
      const back = pulled[f.name];
      assert.ok(back, `missing ${f.name}`);
      if (f.name.startsWith('map')) {
        assert.ok(isDeepStrictEqual(orig, back), `${f.name} differs`);
      } else {
        assert.equal(back.selected, orig.selected, f.name);
        assert.deepEqual(back.items.map((i) => i.id), orig.items.map((i) => i.id), f.name);
        orig.items.forEach((o, i) => {
          const b = back.items[i];
          assert.deepEqual([b.name, b.game, b.public], [o.name, o.game, o.public], `${f.name} item ${i}`);
          assert.deepEqual(b.meta === undefined ? undefined : JSON.parse(b.meta), o.meta === undefined ? undefined : JSON.parse(o.meta), `${f.name} meta ${i}`);
        });
      }
    }
    // pushing what we just pulled changes nothing
    const again = await push(port, (await pull(port)).json.files);
    assert.deepEqual([again.json.imported.length, again.json.updated.length, again.json.snapshots], [0, 0, 0]);
  });
});
