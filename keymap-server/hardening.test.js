'use strict';
// Regression tests for bugs found while reviewing the server against the 2.9.46.6 client contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withServer, CLIENT_A } = require('./harness');

const NS_A = 'com.example.a';
const NS_B = 'com.example.b';
const post = (call, p, body) => call('POST', p, { body });

test('DELETE of an unknown id is a 404 so the 2.9.46.6 client fails over to the original server', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('DELETE', '/v2/keymap/khong_ton_tai');
    assert.equal(r.status, 404);
    assert.equal(r.json.success, false);
    assert.equal(r.json.ft_server, true);
  });
});

test('ids that collide with Object.prototype members are plain unknown ids', async () => {
  await withServer({}, async ({ call }) => {
    // "__proto__" is rejected as an invalid id (400); the others are simply unknown (404).
    // Either way the status is non-2xx, which is all the client needs to fail over.
    for (const [id, status] of [['constructor', 404], ['toString', 404], ['hasOwnProperty', 404], ['__proto__', 400]]) {
      const got = await call('GET', `/v2/keymap/${id}`);
      assert.equal(got.status, status, `GET ${id}`);
      const sel = await post(call, `/v2/keymap/select/${id}`);
      assert.equal(sel.status, status, `select ${id}`);
      const shr = await call('GET', `/v2.1/keymap/share/${id}`);
      assert.equal(shr.status, status, `share ${id}`);
    }
    const upd = await post(call, '/v2/keymap/update/__proto__', { keymap: { x: 1 }, metadata: { y: 2 } });
    assert.equal(upd.status, 400);
    assert.equal({}.keymap, undefined, 'Object.prototype must not be polluted');
    assert.equal({}.metadata, undefined);
  });
});

test('migration import refuses reserved ids', async () => {
  await withServer({}, async ({ call }) => {
    const r = await post(call, '/ft/v1/migration/import', {
      namespace: NS_A, reset: true, documents: [{ id: '__proto__', keymap: { a: 1 }, metadata: {} }],
    });
    assert.equal(r.status, 400);
    assert.equal(Object.getPrototypeOf((await call('GET', `/v2/keymap_list/${NS_A}`)).json), Object.prototype);
  });
});

test('a rejected reset import leaves the namespace untouched, in memory and on disk', async () => {
  await withServer({}, async ({ call, dir }) => {
    await post(call, '/ft/v1/migration/import', {
      namespace: NS_A, reset: true, documents: [{ id: 'a1', keymap: { k: 1 }, metadata: {} }],
    });
    // fill the account up to the 2000 document limit using another namespace
    for (let p = 0; p < 20; p++) {
      const documents = [];
      for (let i = 0; i < 100 && p * 100 + i < 1999; i++) documents.push({ id: `b${p * 100 + i}`, keymap: { k: i }, metadata: {} });
      if (documents.length) {
        const r = await post(call, '/ft/v1/migration/import', { namespace: NS_B, reset: p === 0, documents });
        assert.equal(r.status, 200);
      }
    }
    const rejected = await post(call, '/ft/v1/migration/import', {
      namespace: NS_A, reset: true,
      documents: [{ id: 'a2', keymap: {}, metadata: {} }, { id: 'a3', keymap: {}, metadata: {} }],
    });
    assert.equal(rejected.status, 409);

    const list = await call('GET', `/v2/keymap_list/${NS_A}`);
    assert.deepEqual(list.json.keymaps.map((k) => k.id), ['a1'], 'in-memory state must be unchanged');
    await post(call, `/v2/keymap/${NS_B}`, { keymap: {}, metadata: {} }).catch(() => {}); // forces another save attempt
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'accounts', `c_${CLIENT_A}.json`), 'utf8'));
    assert.ok(onDisk.docs.a1, 'a1 must still be on disk');
  });
});
