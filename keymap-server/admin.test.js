'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer, raw } = require('./harness');

const W = { 'X-Admin-Request': '1' };
const xml = (v) => `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <int name="x" value="${v}" />\n</map>\n`;

test('admin page is served with a strict CSP and without any login', async () => {
  await withServer({}, async ({ port }) => {
    const r = await raw(port, 'GET', '/admin');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.headers['content-security-policy'], /default-src 'none'/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    for (const f of ['app.js', 'app.css', 'recoil.js', 'edit.js', 'layout.js', 'cachexml.js', 'ui.js', 'analysis.js', 'ai-settings.js', 'palette.js', 'theme.js']) assert.equal((await raw(port, 'GET', `/admin/${f}`)).status, 200, f);
    // Path traversal: the URL normalises to /server.js, which is not an admin route; it must never serve the source.
    for (const p of ['/admin/../server.js', '/admin/%2e%2e/server.js', '/admin/..%2fserver.js', '/admin/admin/app.js']) {
      const r2 = await raw(port, 'GET', p);
      assert.notEqual(r2.status, 200, p);
      assert.ok(!r2.text.includes('createServer'), p);
    }
  });
});

test('/health answers and nothing of the old keymap API is left', async () => {
  await withServer({}, async ({ port }) => {
    assert.deepEqual((await raw(port, 'GET', '/health')).json, { ok: true });
    for (const [method, p] of [['GET', '/v2/keymap_list/com.a.b'], ['POST', '/v2/keymap/com.a.b'], ['POST', '/ft/v1/migration/import'],
      ['GET', '/admin/api/overview'], ['GET', '/admin/api/shares'], ['GET', '/admin/api/sync/pull'], ['POST', '/admin/api/sync/push'],
      ['POST', `/admin/api/accounts/c_${'0'.repeat(32)}/import-cache`]]) {
      const r = await raw(port, method, p, { headers: { ...W, 'Login-Token': 'login-token-1234' }, body: method === 'POST' ? {} : undefined });
      assert.equal(r.status, 404, `${method} ${p}`);
    }
  });
});

test('admin can be switched off', async () => {
  await withServer({ ADMIN_ENABLED: '0' }, async ({ port }) => {
    assert.equal((await raw(port, 'GET', '/admin')).status, 404);
    assert.equal((await raw(port, 'GET', '/admin/api/sync/info')).status, 404);
  });
});

test('requests whose Host is not an IP, localhost or a bare/.local/.lan name are refused (DNS rebinding)', async () => {
  await withServer({}, async ({ port }) => {
    const bad = await raw(port, 'GET', '/admin/api/sync/info', { headers: { Host: 'evil.example.com' } });
    assert.equal(bad.status, 403);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `nas:${port}`, `box.local:${port}`, `192.168.1.5:${port}`, `[::1]:${port}`]) {
      assert.equal((await raw(port, 'GET', '/admin/api/sync/info', { headers: { Host: host } })).status, 200, host);
    }
  });
  await withServer({ ADMIN_ALLOWED_HOSTS: 'keymap.home.example' }, async ({ port }) => {
    assert.equal((await raw(port, 'GET', '/admin/api/sync/info', { headers: { Host: 'keymap.home.example' } })).status, 200);
  });
});

test('writes need the X-Admin-Request header and a same-origin Origin', async () => {
  await withServer({}, async ({ port }) => {
    const body = { files: [{ name: 'a.xml', text: xml(1) }] };
    const url = '/admin/api/sync/databases/push';
    assert.equal((await raw(port, 'POST', url, { body })).status, 403, 'no header');
    assert.equal((await raw(port, 'POST', url, { headers: { ...W, Origin: 'http://evil.example.com' }, body })).status, 403, 'foreign origin');
    assert.equal((await raw(port, 'POST', url, { headers: { ...W, 'Sec-Fetch-Site': 'cross-site' }, body })).status, 403, 'cross-site fetch');
    assert.deepEqual((await raw(port, 'GET', '/admin/api/sync/databases')).json.files, [], 'nothing was written by the refused calls');
    assert.equal((await raw(port, 'POST', url, { headers: { ...W, Origin: `http://127.0.0.1:${port}` }, body })).status, 200);
    assert.equal((await raw(port, 'GET', '/admin/api/sync/databases')).json.files.length, 1);
  });
});

test('info reports the server, the version and the number of stored files', async () => {
  await withServer({}, async ({ port }) => {
    let r = (await raw(port, 'GET', '/admin/api/sync/info')).json;
    assert.deepEqual([r.ok, r.server, r.files, r.docs, r.backup_days], [true, 'ft-keymap-server', 0, 0, 0]);
    assert.match(r.version, /^\d+\.\d+\.\d+$/);
    await raw(port, 'POST', '/admin/api/sync/databases/push', { headers: W, body: { files: [{ name: 'a.xml', text: xml(1) }, { name: 'b.xml', text: xml(2) }] } });
    r = (await raw(port, 'GET', '/admin/api/sync/info')).json;
    assert.deepEqual([r.files, r.docs], [2, 2]);
  });
});

test('a large (7 MB) file is accepted and read back whole', async () => {
  await withServer({}, async ({ port }) => {
    const big = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n<string name="map|x">${'a'.repeat(7 * 1024 * 1024)}</string>\n</map>\n`;
    const r = await raw(port, 'POST', '/admin/api/sync/databases/push', { headers: W, body: { files: [{ name: 'gamwing_keymap_cache.xml', text: big }] } });
    assert.deepEqual([r.status, r.json.saved], [200, 1]);
    const got = await raw(port, 'GET', '/admin/api/sync/databases/gamwing_keymap_cache.xml');
    assert.equal(got.json.text.length, big.length);
  });
});

test('POST /admin/api/ai/providers/models: returns error when missing baseUrl, handles model loading', async () => {
  await withServer({}, async ({ port }) => {
    const r1 = await raw(port, 'POST', '/admin/api/ai/providers/models', { headers: W, body: {} });
    assert.equal(r1.status, 404);
    assert.match(r1.json.error, /Base URL/);

    const r2 = await raw(port, 'POST', '/admin/api/ai/providers/models', { headers: W, body: { provider: { baseUrl: 'http://127.0.0.1:9/v1' } } });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.ok, false);
    assert.match(r2.json.reason, /kết nối/);
  });
});

