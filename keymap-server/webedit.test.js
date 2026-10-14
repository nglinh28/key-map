'use strict';
// An edit made on the web page must not be wiped by the tablet pushing its older copy, and a file that is not a preferences file is refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer, raw } = require('./harness');

const W = { 'X-Admin-Request': '1' };
const A = { 'X-Device-Id': 'tablet-0001', 'X-Device-Name': 'Galaxy Tab' };
const NAME = 'gamwing_keymap_cache.xml';
const prefs = (n) => `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <int name="x" value="${n}" />\n</map>\n`;

const push = (port, files) => raw(port, 'POST', '/admin/api/sync/databases/push', { headers: { ...W, ...A }, body: { folder: '/sdcard/Documents/jya2/databases', files } });
const get = async (port, name = NAME) => (await raw(port, 'GET', `/admin/api/sync/databases/${encodeURIComponent(name)}`)).json;
const put = (port, name, text, etag) => raw(port, 'PUT', `/admin/api/sync/databases/${encodeURIComponent(name)}`, { headers: W, body: { text, etag } });
const listed = async (port) => (await raw(port, 'GET', '/admin/api/sync/databases')).json.files;
const accept = (port, name = NAME) => raw(port, 'DELETE', `/admin/api/sync/databases/${encodeURIComponent(name)}/web-edit`, { headers: W });

test('a web edit is remembered until the tablet has the same text; the tablet cannot overwrite it before that', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, [{ name: NAME, text: prefs(1) }, { name: 'other.xml', text: prefs(1) }]);
    assert.equal((await listed(port)).find((f) => f.name === NAME).web_edit, null, 'nothing edited yet');

    const saved = await put(port, NAME, prefs(2), (await get(port)).etag);
    assert.equal(saved.status, 200);
    const mark = (await listed(port)).find((f) => f.name === NAME).web_edit;
    assert.match(mark.at, /^\d{4}-\d\d-\d\dT/);
    assert.equal((await get(port)).web_edit.etag, saved.json.etag);

    // the tablet still holds the old text and pushes it (and a changed other file in the same request)
    const stale = await push(port, [{ name: NAME, text: prefs(1) }, { name: 'other.xml', text: prefs(5) }]);
    assert.equal(stale.status, 200);
    assert.equal(stale.json.saved, 1, 'the other file is saved');
    assert.deepEqual(stale.json.skipped.map((s) => s.name), [NAME]);
    assert.match(stale.json.skipped[0].reason, /web/);
    assert.equal((await get(port)).text, prefs(2), 'the web edit is still there');
    assert.ok((await get(port)).web_edit, 'and still waiting for the tablet');

    // after "Khôi phục theo ngày" the tablet has the web text; its next push is "unchanged" and clears the mark
    const same = await push(port, [{ name: NAME, text: prefs(2) }]);
    assert.deepEqual([same.json.saved, same.json.unchanged, same.json.skipped.length], [0, 1, 0]);
    assert.equal((await get(port)).web_edit, null);

    // from now on the tablet may change the file again
    const later = await push(port, [{ name: NAME, text: prefs(3) }]);
    assert.equal(later.json.saved, 1);
    assert.equal((await get(port)).text, prefs(3));
  });
});

test('the page can accept the tablet copy instead: the mark is removed and the next push goes through', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, [{ name: NAME, text: prefs(1) }]);
    await put(port, NAME, prefs(2), (await get(port)).etag);
    assert.equal((await push(port, [{ name: NAME, text: prefs(1) }])).json.saved, 0);
    assert.equal((await accept(port)).status, 200);
    assert.equal((await get(port)).web_edit, null);
    assert.equal((await push(port, [{ name: NAME, text: prefs(1) }])).json.saved, 1);
    assert.equal((await get(port)).text, prefs(1));
    assert.equal((await accept(port, 'nope.xml')).status, 404);
    assert.equal((await accept(port)).status, 200, 'accepting twice is harmless');
  });
});

test('a web save that changes nothing leaves no mark; a file that is not a preferences file is refused', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, [{ name: NAME, text: prefs(1) }]);
    const same = await put(port, NAME, prefs(1), (await get(port)).etag);
    assert.equal(same.json.saved, 0);
    assert.equal((await get(port)).web_edit, null);
    for (const bad of ['', 'hello', '<html></html>', JSON.stringify({ a: 1 })]) {
      const r = await put(port, NAME, bad, (await get(port)).etag);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.match(r.json.error, /XML/);
    }
    assert.equal((await get(port)).text, prefs(1));
    assert.equal((await get(port)).web_edit, null);
  });
});

test('a conflicting save does not leave a mark either', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, [{ name: NAME, text: prefs(1) }]);
    const old = (await get(port)).etag;
    await push(port, [{ name: NAME, text: prefs(2) }]);
    assert.equal((await put(port, NAME, prefs(9), old)).status, 409);
    assert.equal((await get(port)).web_edit, null);
  });
});

test('deleting items on the page is NOT a web edit: the tablet cuts them itself, so its own changes still go through', async () => {
  const { id, cacheXml } = require('./webedit.helpers');
  await withServer({}, async ({ port }) => {
    await push(port, [{ name: NAME, text: cacheXml() }]);
    await raw(port, 'POST', '/admin/api/sync/hello', { headers: { ...W, ...A }, body: { id: A['X-Device-Id'], name: 'x', state: 'idle' } });
    const etag = (await get(port)).etag;
    const del = await raw(port, 'POST', '/admin/api/cache/delete', { headers: W, body: { file: NAME, ids: [id('b')], etag } });
    assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.equal((await get(port)).web_edit, null, 'no mark after a delete');
    // the tablet pushes its copy with something else changed: the server keeps the deletion but accepts the change
    const changed = cacheXml().replace('Recoil D', 'Recoil D changed');
    const r = await push(port, [{ name: NAME, text: changed }]);
    assert.equal(r.json.saved, 1);
    assert.deepEqual(r.json.skipped, []);
    assert.equal((await get(port)).text.includes('Recoil D changed'), true);
    assert.equal((await get(port)).text.includes(`map|${id('b')}`), false, 'the deleted item stays deleted');
  });
});
