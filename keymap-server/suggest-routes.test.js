'use strict';
// The two calls the page makes in parallel for a recoil combination: the server's own suggestion and the AI's.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const C = require('./admin/cachexml');
const R = require('./admin/recoil');
const { withServer, raw } = require('./harness');

const W = { 'X-Admin-Request': '1' };
const A = { 'X-Device-Id': 'tablet-0001', 'X-Device-Name': 'Tab' };
const CACHE = 'gamwing_keymap_cache.xml';
const RC = 'com.zjx.pubg.rcConfig2';
const KEY = 'freellmapi-routes-secret-0123456789';
const wi = (n) => R.WEAPONS.indexOf(n);
const SC = R.SCOPES.indexOf('X1');
const MUZ = R.MUZZLES.indexOf('COMPENSATOR');
const COEF = { compensatorMuzzle: 0.9, flashHidderMuzzle: 0.8, suppressorMuzzle: 0.95, verticalGrip: 0.85, horizontalGrip: 0.97, halfGrip: 0.93, lightGrip: 0.98, thumbGrip: 0.8, laserGrip: 0.99, generalStock: 0.9, crouch: 0.8, prone: 0.6, stand: 1 };
const BASE = [[0, 100], [100, 80], [200, 60]];
const ID = 'a'.repeat(32);
const E = (grip, muzzle, stock, gesture, recoilValue) => ({ scope: SC, grip, muzzle, stock, gesture, recoilValue });
const times = (c, k) => c.map(([t, v]) => [t, v * k]);

function groups(guns) {
  const g = Array.from({ length: 70 }, () => ({ v: [], coefficients: Array.from({ length: 13 }, () => ({ ...COEF })) }));
  for (const [name, entries] of Object.entries(guns)) g[wi(name)].v.push(...entries);
  return g;
}
function cacheXml(doc) {
  const str = (name, value) => `<string name="${C.escapeXml(name)}">${C.escapeXml(value)}</string>`;
  const item = { id: ID, name: '2026-01-01 00:00:00', game: RC, public: false, meta: JSON.stringify({ name: 'Recoil A' }) };
  return `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    ${str(`list|${RC}`, JSON.stringify({ selected: ID, items: [item] }))}\n    ${str(`map|${ID}`, JSON.stringify(doc))}\n</map>\n`;
}
// the real entries are base x 0.72 for the compensator, i.e. 0.8 of the coefficient curve (base x 0.9)
const real = (k) => E(0, MUZ, 0, 0, times(BASE, k * 0.72));
const DOC = () => {
  const data = groups({
    AUG: [E(0, 0, 0, 0, BASE)],
    M416: [E(0, 0, 0, 0, times(BASE, 1.05)), real(1.05)],
    Scar: [E(0, 0, 0, 0, times(BASE, 0.95)), real(0.95)],
  });
  return { name: 'Recoil A', recoil_data: data, ft_recoil_mode_profiles: { normal_touch_recoil_data: data, gyro_recoil_data: data } };
};
const combo = (o = {}) => ({ weapon: wi('AUG'), scope: SC, gesture: 0, grip: 0, muzzle: MUZ, stock: 0, ...o });

const push = (port, text) => raw(port, 'POST', '/admin/api/sync/databases/push', { headers: { ...W, ...A }, body: { files: [{ name: CACHE, text }] } });
const post = (port, path, body, headers = W) => raw(port, 'POST', path, { headers, body });
const near = (a, b, eps = 1e-2) => Math.abs(a - b) < eps;

function fakeAi(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') });
      const out = handler(seen[seen.length - 1]);
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) })));
}
const answering = (points, reasoning = 'giống M416') => () => ({ body: { choices: [{ message: { content: JSON.stringify({ points, reasoning }) } }], model: 'fake-model-1' } });
const GOOD = [[0, 65], [100, 52], [200, 39]];

test('status: AI is off without url + key; on with them; the key is never shown', async () => {
  await withServer({}, async ({ port }) => {
    const r = await raw(port, 'GET', '/admin/api/ai/status');
    assert.deepEqual(r.json, { enabled: false, model: 'auto', concurrency: 3 });
  });
  await withServer({ AI_BASE_URL: 'http://127.0.0.1:9/v1', AI_API_KEY: KEY, AI_MODEL: 'glm-5.3' }, async ({ port }) => {
    const r = await raw(port, 'GET', '/admin/api/ai/status');
    assert.deepEqual(r.json, { enabled: true, model: 'glm-5.3', concurrency: 3 });
    assert.ok(!r.text.includes(KEY) && !r.text.includes('127.0.0.1'));
  });
});

test('server suggestion: learns from similar guns, answers with the coefficient curve and the similar guns', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, cacheXml(DOC()));
    const r = await post(port, '/admin/api/recoil/suggest', { id: ID, mode: 'touch', combo: combo() });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true, r.json.reason);
    r.json.curve.forEach(([, v], i) => assert.ok(near(v, BASE[i][1] * 0.72), `${v}`));
    assert.deepEqual(r.json.computed.map(([t, v]) => [t, Math.round(v)]), [[0, 90], [100, 72], [200, 54]]);
    assert.deepEqual(r.json.similar.map((s) => s.name).sort(), ['M416', 'Scar']);
    assert.ok(typeof r.json.ms === 'number');
    // a gun without data to learn from: still 200, with the reason and the coefficient curve
    const lonely = await post(port, '/admin/api/recoil/suggest', { id: ID, mode: 'touch', combo: combo({ weapon: wi('AKM') }) });
    assert.equal(lonely.status, 200);
    assert.equal(lonely.json.ok, false);
    assert.match(lonely.json.reason, /đường cong nền/);
  });
});

test('both suggestions can be asked at the same time; the AI one carries the key to the AI and nothing of it back', async () => {
  const ai = await fakeAi(answering(GOOD));
  try {
    await withServer({ AI_BASE_URL: ai.url, AI_API_KEY: KEY, AI_MODEL: 'auto' }, async ({ port }) => {
      await push(port, cacheXml(DOC()));
      const body = { id: ID, mode: 'touch', combo: combo() };
      const [s, a] = await Promise.all([post(port, '/admin/api/recoil/suggest', body), post(port, '/admin/api/ai/suggest-curve', body)]);
      assert.equal(s.json.ok, true);
      assert.equal(a.status, 200, a.text);
      assert.equal(a.json.ok, true, a.json.reason);
      assert.deepEqual(a.json.curve, GOOD);
      assert.equal(a.json.reasoning, 'giống M416');
      assert.equal(a.json.model, 'fake-model-1');
      assert.equal(ai.seen.length, 1);
      assert.equal(ai.seen[0].auth, `Bearer ${KEY}`);
      assert.ok(ai.seen[0].body.messages[1].content.includes('M416'));
      for (const x of [s, a]) assert.ok(!x.text.includes(KEY) && !x.text.includes('127.0.0.1:'), 'no key or address in any answer');
    });
  } finally { await ai.close(); }
});

test('AI failures come back as ok:false with a reason, status 200, so the page can still offer the server result', async () => {
  const ai = await fakeAi(() => ({ status: 500, body: { error: `down ${KEY}` } }));
  try {
    await withServer({ AI_BASE_URL: ai.url, AI_API_KEY: KEY }, async ({ port }) => {
      await push(port, cacheXml(DOC()));
      const a = await post(port, '/admin/api/ai/suggest-curve', { id: ID, mode: 'touch', combo: combo() });
      assert.equal(a.status, 200);
      assert.equal(a.json.ok, false);
      assert.match(a.json.reason, /HTTP 500/);
      assert.ok(!a.text.includes(KEY));
    });
  } finally { await ai.close(); }
  await withServer({}, async ({ port }) => {
    await push(port, cacheXml(DOC()));
    const off = await post(port, '/admin/api/ai/suggest-curve', { id: ID, mode: 'touch', combo: combo() });
    assert.equal(off.status, 200);
    assert.equal(off.json.ok, false);
    assert.match(off.json.reason, /chưa được cấu hình/);
  });
});

test('input is checked: bad ids, modes and combinations are 400; unknown item or no cache is 404; writes need the admin header', async () => {
  await withServer({}, async ({ port }) => {
    const ask = (body, headers) => post(port, '/admin/api/recoil/suggest', body, headers);
    assert.equal((await ask({ id: ID, mode: 'touch', combo: combo() })).status, 404, 'no cache file yet');
    await push(port, cacheXml(DOC()));
    assert.equal((await ask({ id: 'b'.repeat(32), mode: 'touch', combo: combo() })).status, 404, 'unknown item');
    for (const bad of [
      { id: '../x', mode: 'touch', combo: combo() },
      { id: ID, mode: 'nope', combo: combo() },
      { id: ID, mode: 'touch' },
      { id: ID, mode: 'touch', combo: combo({ weapon: 999 }) },
      { id: ID, mode: 'touch', combo: combo({ scope: -1 }) },
      { id: ID, mode: 'touch', combo: combo({ gesture: 3 }) },
      { id: ID, mode: 'touch', combo: combo({ grip: 1.5 }) },
      { id: ID, mode: 'touch', combo: combo({ muzzle: '1' }) },
      { id: ID, mode: 'touch', combo: combo({ stock: 99 }) },
    ]) assert.equal((await ask(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await ask({ id: ID, mode: 'touch', combo: combo() }, {})).status, 403, 'no X-Admin-Request');
    assert.equal((await post(port, '/admin/api/ai/suggest-curve', { id: ID, mode: 'touch', combo: combo({ weapon: 999 }) })).status, 400);
    // an item that has no recoil data at all
    await push(port, cacheXml({ name: 'keymap', components: [] }));
    assert.equal((await ask({ id: ID, mode: 'touch', combo: combo() })).status, 400);
  });
});

test('after the cache changes the suggestion uses the new data (the parsed file is cached by its etag only)', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, cacheXml(DOC()));
    const body = { id: ID, mode: 'touch', combo: combo() };
    const one = (await post(port, '/admin/api/recoil/suggest', body)).json;
    const doc = DOC();
    doc.recoil_data = groups({ AUG: [E(0, 0, 0, 0, BASE)], M416: [E(0, 0, 0, 0, BASE), E(0, MUZ, 0, 0, times(BASE, 0.5))] });
    doc.ft_recoil_mode_profiles.normal_touch_recoil_data = doc.recoil_data;
    await push(port, cacheXml(doc));
    const two = (await post(port, '/admin/api/recoil/suggest', body)).json;
    assert.ok(near(one.curve[0][1], 72) && near(two.curve[0][1], 50), `${one.curve[0][1]} -> ${two.curve[0][1]}`);
  });
});

// ---- combinations worth adding: the server finds them, the AI orders and explains them
const where = (o = {}) => ({ weapon: wi('AUG'), scope: SC, gesture: 0, ...o });
const answeringAny = (curvePoints) => (rec) => {
  const user = rec.body.messages[1].content;
  if (user.includes('"candidates"')) {
    const data = JSON.parse(user.slice(user.indexOf('{')));
    return { body: { model: 'fake-model-1', choices: [{ message: { content: JSON.stringify({ ranking: [{ i: data.candidates.length - 1, reason: 'phổ biến nhất' }, { i: 0, reason: 'hay đi cùng nhau' }] }) } }] } };
  }
  return { body: { choices: [{ message: { content: JSON.stringify({ points: curvePoints, reasoning: 'ok' }) } }] } };
};

test('combo suggestions: the server lists what similar guns have and this gun has not (no AI needed)', async () => {
  await withServer({}, async ({ port }) => {
    await push(port, cacheXml(DOC()));
    const r = await post(port, '/admin/api/recoil/combo-suggestions', { id: ID, mode: 'touch', combo: where() });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true, r.json.reason);
    assert.equal(r.json.candidates.length, 1);
    const c = r.json.candidates[0];
    assert.deepEqual([c.grip, c.muzzle, c.stock], [0, MUZ, 0]);
    assert.equal(c.gap.n, 2);
    assert.ok(r.json.total > 10 && r.json.total < 40 && typeof r.json.ms === 'number', 'the pool is what AUG can take: 5 grips x 3 muzzles, no stock (r.json.total=' + r.json.total + ')');
    assert.deepEqual(r.json.similar.map((s) => s.name).sort(), ['M416', 'Scar']);
    // the best few are the candidates; `missing` is every combination AUG can still take (the page can list and add them all)
    assert.equal(r.json.missing.length, r.json.total);
    assert.ok(r.json.missing.length > r.json.candidates.length);
    assert.ok(r.json.missing.some((m) => m.grip === c.grip && m.muzzle === c.muzzle && m.stock === c.stock));
    // only weapon, scope and posture are needed; a full combination is tolerated; bad values are refused
    assert.equal((await post(port, '/admin/api/recoil/combo-suggestions', { id: ID, mode: 'touch', combo: combo() })).status, 200);
    for (const bad of [{ weapon: 999 }, { gesture: 3 }, { scope: -1 }, { weapon: 'AUG' }]) assert.equal((await post(port, '/admin/api/recoil/combo-suggestions', { id: ID, mode: 'touch', combo: where(bad) })).status, 400, JSON.stringify(bad));
    assert.equal((await post(port, '/admin/api/recoil/combo-suggestions', { id: ID, mode: 'touch' })).status, 400);
    assert.equal((await post(port, '/admin/api/recoil/combo-suggestions', { id: ID, mode: 'touch', combo: where() }, {})).status, 403);
    const none = await post(port, '/admin/api/recoil/combo-suggestions', { id: ID, mode: 'touch', combo: where({ weapon: wi('AKM') }) });
    assert.equal(none.json.ok, false);
    assert.match(none.json.reason, /đường cong nền/);
  });
});

test('combo suggestions and ranking follow the table filter; bad filters are refused; "AI tạo lại" is passed on', async () => {
  const seen = [];
  const ai = await fakeAi((rec) => { seen.push(rec.body); return answeringAny(GOOD)(rec); });
  try {
    await withServer({ AI_BASE_URL: ai.url, AI_API_KEY: KEY }, async ({ port }) => {
      await push(port, cacheXml(DOC()));
      const free = (await post(port, '/admin/api/recoil/combo-suggestions', { id: ID, mode: 'touch', combo: where() })).json;
      assert.equal(free.candidates.length, 1);
      // a filter that leaves the candidate out: the pool shrinks and the candidate is gone
      const other = [0, 1, 2, 3, 4].filter((g) => g !== free.candidates[0].grip);
      const narrowed = await post(port, '/admin/api/recoil/combo-suggestions', { id: ID, mode: 'touch', combo: where(), filter: { grips: other.slice(0, 1) } });
      assert.equal(narrowed.status, 200, narrowed.text);
      assert.ok(narrowed.json.total < free.total, `${narrowed.json.total} < ${free.total}`);
      assert.ok(narrowed.json.candidates.every((c) => c.grip === other[0]));
      // a filter that keeps it: still there, with the numbers of its curve
      const kept = (await post(port, '/admin/api/recoil/combo-suggestions', { id: ID, mode: 'touch', combo: where(), filter: { muzzles: [MUZ] } })).json;
      assert.equal(kept.candidates.length, 1);
      assert.equal(typeof kept.candidates[0].stats.v0, 'number');
      for (const bad of [{ grips: 'x' }, { grips: [999] }, { muzzles: [-1] }, { stocks: [1.5] }, [1], 'a']) {
        assert.equal((await post(port, '/admin/api/recoil/combo-suggestions', { id: ID, mode: 'touch', combo: where(), filter: bad })).status, 400, JSON.stringify(bad));
        assert.equal((await post(port, '/admin/api/ai/rank-combos', { id: ID, mode: 'touch', combo: where(), filter: bad })).status, 400, JSON.stringify(bad));
      }
      // the AI hears about the filter, and about regenerating; without them nothing extra is said
      const data = () => JSON.parse(seen.at(-1).messages[1].content.split('\n').slice(1).join('\n'));
      assert.equal((await post(port, '/admin/api/ai/rank-combos', { id: ID, mode: 'touch', combo: where() })).json.ok, true);
      assert.equal(data().user_filter, undefined);
      assert.equal(data().regenerate, undefined);
      assert.equal(seen.at(-1).temperature, 0.2);
      const r = await post(port, '/admin/api/ai/rank-combos', { id: ID, mode: 'touch', combo: where(), filter: { muzzles: [MUZ] }, regenerate: true });
      assert.equal(r.json.ok, true, r.json.reason);
      assert.deepEqual(data().user_filter, { muzzles: [require('./admin/recoil').MUZZLES[MUZ]] });
      assert.equal(data().regenerate, true);
      assert.equal(seen.at(-1).temperature, 0.7);
      // nothing inside the filter: a reason, no call to the AI
      const calls = seen.length;
      const empty = await post(port, '/admin/api/ai/rank-combos', { id: ID, mode: 'touch', combo: where(), filter: { grips: [] } });
      assert.equal(empty.json.ok, false);
      assert.equal(seen.length, calls);
    });
  } finally { await ai.close(); }
});

test('rank combos: the AI orders the server\'s candidates by accessories (not by index) and explains; failures are reasons', async () => {
  const ai = await fakeAi(answeringAny(GOOD));
  try {
    await withServer({ AI_BASE_URL: ai.url, AI_API_KEY: KEY }, async ({ port }) => {
      await push(port, cacheXml(DOC()));
      const r = await post(port, '/admin/api/ai/rank-combos', { id: ID, mode: 'touch', combo: where() });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.ok, true, r.json.reason);
      assert.deepEqual(r.json.ranking.map((x) => [x.grip, x.muzzle, x.stock, x.rank, x.reason]), [[0, MUZ, 0, 1, 'phổ biến nhất']], 'the one candidate, ranked first (the repeat of index 0 is dropped)');
      assert.equal(r.json.model, 'fake-model-1');
      assert.ok(!r.text.includes(KEY) && !r.text.includes('127.0.0.1:'));
      // a curve request and a ranking at the same time do not block each other
      const body = { id: ID, mode: 'touch', combo: combo() };
      const [a, b] = await Promise.all([post(port, '/admin/api/ai/suggest-curve', body), post(port, '/admin/api/ai/rank-combos', { id: ID, mode: 'touch', combo: where() })]);
      assert.equal(a.json.ok, true, a.json.reason);
      assert.equal(b.json.ok, true, b.json.reason);
    });
  } finally { await ai.close(); }
  await withServer({}, async ({ port }) => {
    await push(port, cacheXml(DOC()));
    const off = await post(port, '/admin/api/ai/rank-combos', { id: ID, mode: 'touch', combo: where() });
    assert.equal(off.status, 200);
    assert.equal(off.json.ok, false);
    assert.match(off.json.reason, /chưa được cấu hình/);
    const none = await post(port, '/admin/api/ai/rank-combos', { id: ID, mode: 'touch', combo: where({ weapon: wi('AKM') }) });
    assert.equal(none.json.ok, false);
  });
  const down = await fakeAi(() => ({ status: 500, body: {} }));
  try {
    await withServer({ AI_BASE_URL: down.url, AI_API_KEY: KEY }, async ({ port }) => {
      await push(port, cacheXml(DOC()));
      const r = await post(port, '/admin/api/ai/rank-combos', { id: ID, mode: 'touch', combo: where() });
      assert.equal(r.json.ok, false);
      assert.match(r.json.reason, /HTTP 500/);
    });
  } finally { await down.close(); }
});
