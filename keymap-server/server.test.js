'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer, loadConfig } = require('./server');

const NS = 'com.zjx.pubg.rcConfig2';
const CLIENT_A = 'a'.repeat(32);
const CLIENT_B = 'b'.repeat(32);
const TOKEN = 'login-token-1234';

async function withServer(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftks-'));
  const server = createServer(loadConfig({ DATA_DIR: dir, ...env }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { body, client = CLIENT_A, token = TOKEN, headers = {} } = {}) => {
    const sep = p.includes('?') ? '&' : '?';
    const url = `${base}${p}${client ? `${sep}ft_client=${client}` : ''}`;
    const h = { 'Content-Type': 'application/json; charset=utf-8', ...headers };
    if (token) h['Login-Token'] = token;
    const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  try {
    await fn({ call, dir, base });
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const post = (call, p, body, opts) => call('POST', p, { body, ...opts });

test('every response carries the markers the client checks', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('GET', `/v2/keymap_list/${NS}?oui=jyandroid2`);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.success, r.json.ft_server, r.json.ft_verified], [true, true, true]);
    assert.equal(r.json.selected_keymap_id, '');
    assert.deepEqual(r.json.keymaps, []);
  });
});

test('create, list, get, update, select, delete', async () => {
  await withServer({}, async ({ call }) => {
    const a = await post(call, `/v2/keymap/${NS}`, { keymap: { k: 1 }, metadata: { name: 'one' } });
    const b = await post(call, `/v2/keymap/${NS}`, { keymap: { k: 2 }, metadata: { name: 'two' } });
    assert.equal(a.json.success, true);
    assert.match(a.json.keymap_id, /^[A-Za-z0-9._-]{1,128}$/);

    let list = await call('GET', `/v2/keymap_list/${NS}`);
    assert.deepEqual(list.json.keymaps.map((k) => k.id), [a.json.keymap_id, b.json.keymap_id]);
    assert.equal(list.json.selected_keymap_id, b.json.keymap_id);
    const entry = list.json.keymaps[0];
    assert.equal(typeof entry.is_official, 'boolean');
    assert.match(entry.add_time, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.deepEqual(JSON.parse(entry.metadata), { name: 'one' });

    const got = await call('GET', `/v2/keymap/${a.json.keymap_id}`);
    assert.deepEqual(JSON.parse(got.json.keymap), { k: 1 });
    assert.deepEqual(JSON.parse(got.json.metadata), { name: 'one' });
    assert.equal(got.json.isOfficial, false);
    assert.equal(got.json.bundleId, NS);

    const upd = await post(call, `/v2/keymap/update/${a.json.keymap_id}`, { keymap: { k: 10 }, metadata: { name: 'uno' } });
    assert.equal(upd.json.success, true);
    const got2 = await call('GET', `/v2/keymap/${a.json.keymap_id}`);
    assert.deepEqual(JSON.parse(got2.json.keymap), { k: 10 });

    const sel = await post(call, `/v2/keymap/select/${a.json.keymap_id}`);
    assert.equal(sel.json.success, true);
    assert.equal(sel.json.keymap_bundle_id, NS);
    list = await call('GET', `/v2/keymap_list/${NS}`);
    assert.equal(list.json.selected_keymap_id, a.json.keymap_id);

    const del = await call('DELETE', `/v2/keymap/${a.json.keymap_id}`);
    assert.equal(del.json.success, true);
    list = await call('GET', `/v2/keymap_list/${NS}`);
    assert.deepEqual(list.json.keymaps.map((k) => k.id), [b.json.keymap_id]);
    assert.equal(list.json.selected_keymap_id, b.json.keymap_id);

    const missing = await call('GET', `/v2/keymap/${a.json.keymap_id}`);
    assert.equal(missing.status, 404);
  });
});

test('share code round trip across accounts, with use limit', async () => {
  await withServer({}, async ({ call }) => {
    const created = await post(call, `/v2/keymap/${NS}`, { keymap: { secret: true }, metadata: { name: 'shared' } });
    const id = created.json.keymap_id;

    const sh = await call('GET', `/v2/keymap/share/${id}?prefix=yqa3_&valid_count=1`);
    assert.match(sh.json.share_code, /^yqa3_ft[a-f0-9]{24}$/);

    // Editing the source afterwards must not change what the code returns.
    await post(call, `/v2/keymap/update/${id}`, { keymap: { secret: false }, metadata: {} });

    const imp = await call('GET', `/v2.1/keymap/share/${sh.json.share_code}`, { client: CLIENT_B });
    assert.equal(imp.json.success, true);
    assert.deepEqual(JSON.parse(imp.json.keymap), { secret: true });
    assert.deepEqual(JSON.parse(imp.json.metadata), { name: 'shared' });

    const again = await call('GET', `/v2.1/keymap/share/${sh.json.share_code}`, { client: CLIENT_B });
    assert.equal(again.status, 410);

    const bad = await call('GET', `/v2/keymap/share/${id}?prefix=evil`);
    assert.equal(bad.status, 400);
  });
});

test('clone from a share code via create + share_code', async () => {
  await withServer({}, async ({ call }) => {
    const created = await post(call, `/v2/keymap/${NS}`, { keymap: { v: 7 }, metadata: { name: 'src' } });
    const sh = await call('GET', `/v2/keymap/share/${created.json.keymap_id}?prefix=ankm2`);
    assert.match(sh.json.share_code, /^ankm2ft[a-f0-9]{24}$/);

    const clone = await post(call, `/v2/keymap/${NS}?share_code=${sh.json.share_code}`, { keymap: {} }, { client: CLIENT_B });
    assert.equal(clone.json.success, true);
    const got = await call('GET', `/v2/keymap/${clone.json.keymap_id}`, { client: CLIENT_B });
    assert.deepEqual(JSON.parse(got.json.keymap), { v: 7 });

    const none = await post(call, `/v2/keymap/${NS}?share_code=ankm2ft${'0'.repeat(24)}`, { keymap: {} });
    assert.equal(none.status, 404);
  });
});

test('migration import keeps ids and verify checks hashes and count', async () => {
  await withServer({}, async ({ call }) => {
    const docs = [1, 2, 3].map((n) => ({ id: `legacy${n}`, add_time: `2024-01-0${n} 10:00:00`, metadata: { name: `m${n}` }, keymap: { n } }));
    const page1 = await post(call, '/ft/v1/migration/import', {
      namespace: NS, expected_count: 3, selected_keymap_id: 'legacy2', reset: true, documents: docs.slice(0, 2),
    });
    const page2 = await post(call, '/ft/v1/migration/import', {
      namespace: NS, expected_count: 3, selected_keymap_id: 'legacy2', reset: false, documents: docs.slice(2),
    });
    assert.equal(page1.json.success, true);
    const manifest = [...page1.json.copied, ...page2.json.copied];
    assert.equal(manifest.length, 3);

    const list = await call('GET', `/v2/keymap_list/${NS}`);
    assert.deepEqual(list.json.keymaps.map((k) => k.id), ['legacy1', 'legacy2', 'legacy3']);
    assert.equal(list.json.keymaps[0].add_time, '2024-01-01 10:00:00');
    assert.equal(list.json.selected_keymap_id, 'legacy2');

    const ver = await post(call, '/ft/v1/migration/verify', { namespace: NS, manifest });
    assert.equal(ver.json.success, true);
    assert.equal(ver.json.state, 'VERIFIED');

    const tampered = manifest.map((m, i) => (i === 0 ? { ...m, sha256: 'f'.repeat(64) } : m));
    const bad = await post(call, '/ft/v1/migration/verify', { namespace: NS, manifest: tampered });
    assert.equal(bad.json.success, false);
    assert.equal(bad.json.state, 'MISMATCH');

    const short = await post(call, '/ft/v1/migration/verify', { namespace: NS, manifest: manifest.slice(0, 2) });
    assert.equal(short.json.state, 'MISMATCH');

    // An empty account migrates cleanly and verifies.
    const empty = await post(call, '/ft/v1/migration/import', { namespace: NS, expected_count: 0, reset: true, documents: [] }, { client: CLIENT_B });
    assert.equal(empty.json.success, true);
    const emptyVer = await post(call, '/ft/v1/migration/verify', { namespace: NS, manifest: [] }, { client: CLIENT_B });
    assert.equal(emptyVer.json.state, 'VERIFIED');
  });
});

test('accounts are isolated by ft_client', async () => {
  await withServer({}, async ({ call }) => {
    const a = await post(call, `/v2/keymap/${NS}`, { keymap: { a: 1 }, metadata: {} });
    const asB = await call('GET', `/v2/keymap/${a.json.keymap_id}`, { client: CLIENT_B });
    assert.equal(asB.status, 404);
    const listB = await call('GET', `/v2/keymap_list/${NS}`, { client: CLIENT_B });
    assert.deepEqual(listB.json.keymaps, []);
  });
});

test('idempotency-key replays the first response instead of creating twice', async () => {
  await withServer({}, async ({ call }) => {
    const h = { 'Idempotency-Key': 'android-1' };
    const one = await post(call, `/v2/keymap/${NS}`, { keymap: { x: 1 }, metadata: {} }, { headers: h });
    const two = await post(call, `/v2/keymap/${NS}`, { keymap: { x: 1 }, metadata: {} }, { headers: h });
    assert.equal(one.json.keymap_id, two.json.keymap_id);
    const list = await call('GET', `/v2/keymap_list/${NS}`);
    assert.equal(list.json.keymaps.length, 1);
  });
});

test('auth, allowlist, validation and persistence', async () => {
  await withServer({}, async ({ call }) => {
    assert.equal((await call('GET', `/v2/keymap_list/${NS}`, { token: '' })).status, 401);
    assert.equal((await call('GET', `/v2/keymap_list/${NS}`, { token: 'short' })).status, 401);
    assert.equal((await call('GET', '/v2/keymap_list/not-a-namespace')).status, 400);
    assert.equal((await post(call, `/v2/keymap/${NS}`, { keymap: 'nope' })).status, 400);
    assert.equal((await call('GET', '/v2/keymap/..%2Fetc')).status, 400);
    assert.equal((await call('GET', '/nowhere')).status, 404);
  });

  await withServer({ FT_ALLOWED_CLIENTS: CLIENT_A }, async ({ call }) => {
    assert.equal((await call('GET', `/v2/keymap_list/${NS}`, { client: CLIENT_A })).status, 200);
    assert.equal((await call('GET', `/v2/keymap_list/${NS}`, { client: CLIENT_B })).status, 403);
    assert.equal((await call('GET', `/v2/keymap_list/${NS}`, { client: null })).status, 403);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftks-persist-'));
  try {
    for (const phase of ['write', 'read']) {
      const server = createServer(loadConfig({ DATA_DIR: dir }));
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${server.address().port}`;
      const headers = { 'Login-Token': TOKEN, 'Content-Type': 'application/json' };
      if (phase === 'write') {
        await fetch(`${base}/v2/keymap/${NS}?ft_client=${CLIENT_A}`, { method: 'POST', headers, body: JSON.stringify({ keymap: { p: 1 }, metadata: { name: 'kept' } }) });
      } else {
        const r = await (await fetch(`${base}/v2/keymap_list/${NS}?ft_client=${CLIENT_A}`, { headers })).json();
        assert.equal(r.keymaps.length, 1);
        assert.deepEqual(JSON.parse(r.keymaps[0].metadata), { name: 'kept' });
      }
      await new Promise((r) => server.close(r));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
