'use strict';
// Editing a stored document from the admin: optimistic concurrency (etag), history snapshots, restore.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withServer, raw, CLIENT_A } = require('./harness');

const NS = 'com.zjx.pubg.rcConfig2';
const ACC = `c_${CLIENT_A}`;
const W = { 'X-Admin-Request': '1' };
const post = (call, p, body) => call('POST', p, { body });

const docUrl = (id) => `/admin/api/accounts/${ACC}/docs/${id}`;
const getDoc = async (port, id) => (await raw(port, 'GET', docUrl(id))).json;
const put = (port, id, body) => raw(port, 'PUT', docUrl(id), { headers: W, body });
async function seed(call) {
  return (await post(call, `/v2/keymap/${NS}`, { keymap: { a: 1, list: [1, 2, 3] }, metadata: { name: 'Gốc' } })).json.keymap_id;
}

test('GET returns an etag that changes with the content', async () => {
  await withServer({}, async ({ call, port }) => {
    const id = await seed(call);
    const d1 = await getDoc(port, id);
    assert.match(d1.etag, /^[a-f0-9]{64}$/);
    assert.equal((await getDoc(port, id)).etag, d1.etag, 'stable while nothing changes');
    const r = await put(port, id, { etag: d1.etag, keymap: { a: 2 } });
    assert.notEqual(r.json.etag, d1.etag);
    assert.equal((await getDoc(port, id)).etag, r.json.etag);
  });
});

test('PUT replaces keymap and/or metadata and the app API sees it', async () => {
  await withServer({}, async ({ call, port }) => {
    const id = await seed(call);
    let d = await getDoc(port, id);
    const r1 = await put(port, id, { etag: d.etag, keymap: { a: 99, list: [9] } });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.ok, true);
    const got = await call('GET', `/v2/keymap/${id}`);
    assert.deepEqual(JSON.parse(got.json.keymap), { a: 99, list: [9] });
    assert.deepEqual(JSON.parse(got.json.metadata), { name: 'Gốc' }, 'metadata untouched when not sent');

    const r2 = await put(port, id, { etag: r1.json.etag, metadata: { name: 'Đã đổi tên' } });
    assert.equal(r2.status, 200);
    const list = await call('GET', `/v2/keymap_list/${NS}`);
    assert.equal(JSON.parse(list.json.keymaps[0].metadata).name, 'Đã đổi tên');
    d = await getDoc(port, id);
    assert.deepEqual(d.keymap, { a: 99, list: [9] });
  });
});

test('a stale etag is a 409 and nothing changes (e.g. the app synced in the meantime)', async () => {
  await withServer({}, async ({ call, port }) => {
    const id = await seed(call);
    const opened = await getDoc(port, id);
    // the phone updates the same document through the normal API
    await post(call, `/v2/keymap/update/${id}`, { keymap: { fromApp: true }, metadata: { name: 'App' } });
    const r = await put(port, id, { etag: opened.etag, keymap: { mine: true } });
    assert.equal(r.status, 409);
    assert.match(r.json.etag, /^[a-f0-9]{64}$/, 'the current etag is returned so the UI can reload');
    assert.deepEqual((await getDoc(port, id)).keymap, { fromApp: true });
    assert.equal((await raw(port, 'GET', `${docUrl(id)}/history`)).json.versions.length, 0, 'a rejected save leaves no snapshot');
  });
});

test('PUT validates its input', async () => {
  await withServer({}, async ({ call, port }) => {
    const id = await seed(call);
    const { etag } = await getDoc(port, id);
    assert.equal((await put(port, id, { keymap: { a: 1 } })).status, 400, 'etag required');
    assert.equal((await put(port, id, { etag })).status, 400, 'nothing to change');
    assert.equal((await put(port, id, { etag, keymap: [1, 2] })).status, 400, 'keymap must be an object');
    assert.equal((await put(port, id, { etag, keymap: 'text' })).status, 400);
    assert.equal((await put(port, id, { etag, metadata: [] })).status, 400, 'metadata must be an object');
    assert.equal((await put(port, 'no_such_doc', { etag, keymap: {} })).status, 404);
    assert.equal((await put(port, '__proto__', { etag, keymap: {} })).status, 404);
    assert.equal((await raw(port, 'PUT', docUrl(id), { body: { etag, keymap: {} } })).status, 403, 'needs X-Admin-Request');
    assert.equal((await raw(port, 'PUT', docUrl(id), { headers: W, body: '{not json' })).status, 400);
    assert.deepEqual((await getDoc(port, id)).keymap, { a: 1, list: [1, 2, 3] }, 'nothing changed');
    assert.equal({}.keymap, undefined);
  });
});

test('every successful save keeps the previous version; history is newest first and capped at 20', async () => {
  await withServer({}, async ({ call, port, dir }) => {
    const id = await seed(call);
    let etag = (await getDoc(port, id)).etag;
    for (let i = 1; i <= 22; i++) {
      const r = await put(port, id, { etag, keymap: { rev: i } });
      assert.equal(r.status, 200, `save ${i}`);
      etag = r.json.etag;
    }
    const h = (await raw(port, 'GET', `${docUrl(id)}/history`)).json.versions;
    assert.equal(h.length, 20);
    assert.ok(h.every((v) => /^\d{8}T\d{9}Z-[a-f0-9]{4}$/.test(v.version) && v.bytes > 0 && v.saved_at));
    const newest = (await raw(port, 'GET', `${docUrl(id)}/history/${h[0].version}`)).json;
    assert.deepEqual(newest.keymap, { rev: 21 }, 'the newest snapshot is the version before the last save');
    const oldest = (await raw(port, 'GET', `${docUrl(id)}/history/${h[19].version}`)).json;
    assert.deepEqual(oldest.keymap, { rev: 2 }, 'rev 0 (the original) and rev 1 were dropped by the cap');
    const files = fs.readdirSync(path.join(dir, 'history', ACC, `d_${id}`));
    assert.equal(files.length, 20, 'older snapshots are deleted from disk too');
  });
});

test('restore puts an old version back and is itself undoable', async () => {
  await withServer({}, async ({ call, port }) => {
    const id = await seed(call);
    let etag = (await getDoc(port, id)).etag;
    etag = (await put(port, id, { etag, keymap: { rev: 1 }, metadata: { name: 'v1' } })).json.etag;
    etag = (await put(port, id, { etag, keymap: { rev: 2 } })).json.etag;
    const versions = (await raw(port, 'GET', `${docUrl(id)}/history`)).json.versions;
    assert.equal(versions.length, 2);
    const original = versions[1]; // oldest snapshot = the document as first stored
    assert.equal((await raw(port, 'POST', `${docUrl(id)}/history/${original.version}/restore`, { headers: W, body: {} })).status, 400, 'etag required');
    const r = await raw(port, 'POST', `${docUrl(id)}/history/${original.version}/restore`, { headers: W, body: { etag } });
    assert.equal(r.status, 200);
    const d = await getDoc(port, id);
    assert.deepEqual(d.keymap, { a: 1, list: [1, 2, 3] });
    assert.deepEqual(d.metadata, { name: 'Gốc' });
    assert.equal((await raw(port, 'GET', `${docUrl(id)}/history`)).json.versions.length, 3, 'the state before the restore was snapshotted');
    const stale = await raw(port, 'POST', `${docUrl(id)}/history/${original.version}/restore`, { headers: W, body: { etag } });
    assert.equal(stale.status, 409, 'old etag after the restore');
  });
});

test('history version ids cannot escape the history folder', async () => {
  await withServer({}, async ({ call, port }) => {
    const id = await seed(call);
    for (const v of ['..', '../../accounts/x', '%2e%2e%2f%2e%2e', 'abc', '20260101T000000000Z-zzzz']) {
      const r = await raw(port, 'GET', `${docUrl(id)}/history/${v}`);
      assert.ok([400, 404].includes(r.status), `${v} -> ${r.status}`);
      assert.ok(!r.text.includes('"keymap"'));
    }
    assert.equal((await raw(port, 'GET', `${docUrl(id)}/history/20260101T000000000Z-abcd`)).status, 404);
  });
});

test('deleting a document does not break reading its history', async () => {
  await withServer({}, async ({ call, port }) => {
    const id = await seed(call);
    const etag = (await getDoc(port, id)).etag;
    await put(port, id, { etag, keymap: { x: 1 } });
    await raw(port, 'DELETE', docUrl(id), { headers: W });
    assert.equal((await raw(port, 'GET', `${docUrl(id)}/history`)).status, 404, 'history is tied to a document that still exists');
  });
});
