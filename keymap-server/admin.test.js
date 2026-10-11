'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer, raw, CLIENT_A } = require('./harness');

const NS = 'com.zjx.pubg.rcConfig2';
const ACC = `c_${CLIENT_A}`;
const post = (call, p, body) => call('POST', p, { body });

const W = { 'X-Admin-Request': '1' };

async function seed(call) {
  const a = await post(call, `/v2/keymap/${NS}`, { keymap: { components: [{ 'base:componentIdentifier': 'com.zjx.app:joystick' }, { 'base:componentIdentifier': 'com.zjx.app:ntp' }, { 'base:componentIdentifier': 'com.zjx.app:ntp' }] }, metadata: { name: 'Keymap A' } });
  const b = await post(call, `/v2/keymap/${NS}`, { keymap: { k: 2 }, metadata: { name: 'Keymap B' } });
  return [a.json.keymap_id, b.json.keymap_id];
}

test('admin page is served with a strict CSP and without any login', async () => {
  await withServer({}, async ({ port }) => {
    const r = await raw(port, 'GET', '/admin');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.headers['content-security-policy'], /default-src 'none'/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    for (const f of ['app.js', 'app.css', 'recoil.js', 'edit.js', 'layout.js']) assert.equal((await raw(port, 'GET', `/admin/${f}`)).status, 200, f);
    // Path traversal: the URL normalises to /server.js, which is not an admin route; it must never serve the source.
    for (const p of ['/admin/../server.js', '/admin/%2e%2e/server.js', '/admin/..%2fserver.js', '/admin/admin/app.js']) {
      const r = await raw(port, 'GET', p);
      assert.notEqual(r.status, 200, p);
      assert.ok(!r.text.includes('createServer'), p);
    }
  });
});

test('admin can be switched off', async () => {
  await withServer({ ADMIN_ENABLED: '0' }, async ({ port }) => {
    assert.equal((await raw(port, 'GET', '/admin')).status, 404);
    assert.equal((await raw(port, 'GET', '/admin/api/overview')).status, 404);
  });
});

test('requests whose Host is not an IP, localhost or a bare/.local/.lan name are refused (DNS rebinding)', async () => {
  await withServer({}, async ({ port }) => {
    const bad = await raw(port, 'GET', '/admin/api/overview', { headers: { Host: 'evil.example.com' } });
    assert.equal(bad.status, 403);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `nas:${port}`, `box.local:${port}`, `192.168.1.5:${port}`, `[::1]:${port}`]) {
      assert.equal((await raw(port, 'GET', '/admin/api/overview', { headers: { Host: host } })).status, 200, host);
    }
  });
  await withServer({ ADMIN_ALLOWED_HOSTS: 'keymap.home.example' }, async ({ port }) => {
    assert.equal((await raw(port, 'GET', '/admin/api/overview', { headers: { Host: 'keymap.home.example' } })).status, 200);
  });
});

test('writes need the X-Admin-Request header and a same-origin Origin', async () => {
  await withServer({}, async ({ call, port }) => {
    const [id] = await seed(call);
    const url = `/admin/api/accounts/${ACC}/docs/${id}`;
    assert.equal((await raw(port, 'DELETE', url)).status, 403, 'no header');
    assert.equal((await raw(port, 'DELETE', url, { headers: { ...W, Origin: 'http://evil.example.com' } })).status, 403, 'foreign origin');
    assert.equal((await raw(port, 'GET', `/admin/api/accounts/${ACC}/docs/${id}`)).status, 200, 'still there');
    assert.equal((await raw(port, 'DELETE', url, { headers: { ...W, Origin: `http://127.0.0.1:${port}` } })).status, 200);
    assert.equal((await raw(port, 'GET', url)).status, 404);
  });
});

test('overview, document list, document detail and downloads', async () => {
  await withServer({}, async ({ call, port }) => {
    const [a, b] = await seed(call);
    const ov = (await raw(port, 'GET', '/admin/api/overview')).json;
    assert.equal(ov.accounts.length, 1);
    assert.equal(ov.accounts[0].id, ACC);
    assert.equal(ov.accounts[0].docs, 2);
    assert.deepEqual(ov.accounts[0].namespaces.map((n) => [n.ns, n.count, n.selected]), [[NS, 2, b]]);

    const list = (await raw(port, 'GET', `/admin/api/accounts/${ACC}/docs`)).json.docs;
    assert.deepEqual(list.map((d) => [d.id, d.name, d.ns, d.selected]), [[a, 'Keymap A', NS, false], [b, 'Keymap B', NS, true]]);
    assert.ok(list.every((d) => d.bytes > 0 && /^\d{4}-\d\d-\d\d/.test(d.add_time)));

    const one = (await raw(port, 'GET', `/admin/api/accounts/${ACC}/docs/${a}`)).json;
    assert.equal(one.metadata.name, 'Keymap A');
    assert.equal(one.keymap.components.length, 3);

    const dl = await raw(port, 'GET', `/admin/api/accounts/${ACC}/docs/${a}?download=1`);
    assert.match(dl.headers['content-disposition'], /attachment; filename\*?=/);
    assert.deepEqual(JSON.parse(dl.text), one.keymap, 'download is the bare keymap, same shape as the app cache');

    const ex = await raw(port, 'GET', `/admin/api/accounts/${ACC}/export`);
    assert.match(ex.headers['content-disposition'], /attachment/);
    assert.equal(JSON.parse(ex.text).docs.length, 2);

    assert.equal((await raw(port, 'GET', '/admin/api/accounts/not-an-account/docs')).status, 400);
    assert.equal((await raw(port, 'GET', `/admin/api/accounts/c_${'f'.repeat(32)}/docs`)).json.docs.length, 0);
  });
});

test('documents are classified: keyboard keymap, recoil/config and AI recognition are told apart', async () => {
  await withServer({}, async ({ call, port }) => {
    const mk = async (ns, name) => (await post(call, `/v2/keymap/${ns}`, { keymap: { k: 1 }, metadata: { name } })).json.keymap_id;
    const ids = {
      keyboard: await mk('com.vng.pubgmobile', 'Bàn phím'),
      general: await mk('com.zjx.generalrc.rcConfig2', 'General'),
      recoil: await mk('com.zjx.pubg.rcConfig2', 'Recoil'),
      recog: await mk('com.zjx.pubg.recognition.com.vng.pubgmobile', 'Nhận diện'),
    };
    const list = (await raw(port, 'GET', `/admin/api/accounts/${ACC}/docs`)).json.docs;
    const kindOf = (id) => list.find((d) => d.id === id).kind;
    assert.equal(kindOf(ids.keyboard), 'keymap');
    assert.equal(kindOf(ids.general), 'keymap');
    assert.equal(kindOf(ids.recoil), 'recoil');
    assert.equal(kindOf(ids.recog), 'recognition');
    const ns = (await raw(port, 'GET', '/admin/api/overview')).json.accounts[0].namespaces;
    assert.deepEqual(Object.fromEntries(ns.map((n) => [n.ns, n.kind])), {
      'com.vng.pubgmobile': 'keymap', 'com.zjx.generalrc.rcConfig2': 'keymap',
      'com.zjx.pubg.rcConfig2': 'recoil', 'com.zjx.pubg.recognition.com.vng.pubgmobile': 'recognition',
    });
  });
});

test('deleting the selected keymap in the admin falls back to another one', async () => {
  await withServer({}, async ({ call, port }) => {
    const [a, b] = await seed(call);
    assert.equal((await raw(port, 'DELETE', `/admin/api/accounts/${ACC}/docs/${b}`, { headers: W })).status, 200);
    const list = await call('GET', `/v2/keymap_list/${NS}`);
    assert.equal(list.json.selected_keymap_id, a);
  });
});

test('shares can be listed and deleted', async () => {
  await withServer({}, async ({ call, port }) => {
    const [a] = await seed(call);
    const sh = await call('GET', `/v2/keymap/share/${a}?prefix=yqa3_&valid_count=2`);
    const code = sh.json.share_code;
    const list = (await raw(port, 'GET', '/admin/api/shares')).json.shares;
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].code, list[0].ns, list[0].max_uses, list[0].uses, list[0].name], [code, NS, 2, 0, 'Keymap A']);
    assert.equal((await raw(port, 'DELETE', `/admin/api/shares/${code}`, { headers: W })).status, 200);
    assert.equal((await call('GET', `/v2.1/keymap/share/${code}`)).status, 404);
  });
});

const LIST = (ns, selected, items) => ({ name: `list|${ns}.json`, text: JSON.stringify({ selected, items }) });
const MAP = (id, body) => ({ name: `map|${id}.json`, text: JSON.stringify(body) });

test('import-cache loads the phone backup files, keeps ids and is visible through the app API', async () => {
  await withServer({}, async ({ call, port }) => {
    const ns = 'com.vng.pubgmobile';
    const files = [
      // the files as they were pulled onto a Windows PC: "|" is URL-encoded in the name
      { ...LIST(ns, 'b'.repeat(32), [
        { id: 'a'.repeat(32), name: '2025-07-30 08:18:23', game: ns, public: true, meta: JSON.stringify({ componentCount: 3, name: 'Official' }) },
        { id: 'b'.repeat(32), name: '2026-10-03 13:49:27', game: ns, public: false, meta: JSON.stringify({ componentCount: 1, name: 'Mine' }) },
        { id: 'c'.repeat(32), name: '2026-10-04 00:00:00', game: ns, public: false },
      ]), name: `list%7C${ns}.json` },
      { ...MAP('a'.repeat(32), { components: [1, 2, 3], version: '1.0.0' }), name: `map%7C${'a'.repeat(32)}.json` },
      MAP('b'.repeat(32), { components: [1], version: '1.0.0' }),
    ];
    const r = await raw(port, 'POST', `/admin/api/accounts/${ACC}/import-cache`, { headers: W, body: { files } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.imported.map((d) => d.id), ['a'.repeat(32), 'b'.repeat(32)]);
    assert.deepEqual(r.json.skipped.map((s) => [s.id, s.reason]), [['c'.repeat(32), 'missing map file']]);

    const list = await call('GET', `/v2/keymap_list/${ns}`);
    assert.equal(list.json.selected_keymap_id, 'b'.repeat(32));
    assert.deepEqual(list.json.keymaps.map((k) => [k.id, k.add_time, JSON.parse(k.metadata).name]), [
      ['a'.repeat(32), '2025-07-30 08:18:23', 'Official'], ['b'.repeat(32), '2026-10-03 13:49:27', 'Mine'],
    ]);
    const got = await call('GET', `/v2/keymap/${'a'.repeat(32)}`);
    assert.deepEqual(JSON.parse(got.json.keymap), { components: [1, 2, 3], version: '1.0.0' });
  });
});

test('import-cache rejects bad input without changing anything', async () => {
  await withServer({}, async ({ call, port }) => {
    const bad = (body) => raw(port, 'POST', `/admin/api/accounts/${ACC}/import-cache`, { headers: W, body });
    assert.equal((await bad({})).status, 400);
    assert.equal((await bad({ files: [{ name: 'list|nsnodot.json', text: '{"items":[]}' }] })).json.skipped.length, 1);
    assert.equal((await bad({ files: [{ name: 'list|com.a.b.json', text: 'not json' }] })).json.skipped[0].reason, 'invalid JSON');
    const clash = await bad({ files: [LIST('com.a.b', null, [{ id: '__proto__', name: 'x' }]), MAP('__proto__', {})] });
    assert.equal(clash.json.imported.length, 0);
    assert.equal({}.keymap, undefined);
    assert.deepEqual((await call('GET', '/v2/keymap_list/com.a.b')).json.keymaps, []);
  });
});
