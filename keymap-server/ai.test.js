'use strict';
// The AI half of the suggestion: a client for an OpenAI-compatible endpoint, checked against a fake one.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const R = require('./admin/recoil');
const { createAi, parseAnswer, validatePoints, buildMessages, loadAiConfig } = require('./ai');

const W = (n) => R.WEAPONS.indexOf(n);
const SC = R.SCOPES.indexOf('X1');
const MUZ = R.MUZZLES.indexOf('COMPENSATOR');
const KEY = 'freellmapi-secret-0123456789abcdef';
const COEF = { compensatorMuzzle: 0.9, flashHidderMuzzle: 0.8, suppressorMuzzle: 0.95, verticalGrip: 0.85, horizontalGrip: 0.97, halfGrip: 0.93, lightGrip: 0.98, thumbGrip: 0.8, laserGrip: 0.99, generalStock: 0.9, crouch: 0.8, prone: 0.6, stand: 1 };
const BASE = [[0, 100], [100, 80], [200, 60]];
const E = (grip, muzzle, stock, gesture, recoilValue) => ({ scope: SC, grip, muzzle, stock, gesture, recoilValue });
function build(guns) {
  const groups = Array.from({ length: 70 }, () => ({ v: [], coefficients: Array.from({ length: 13 }, () => ({ ...COEF })) }));
  for (const [name, entries] of Object.entries(guns)) groups[W(name)].v.push(...entries);
  return R.indexData(groups);
}
const idx = build({
  AUG: [E(0, 0, 0, 0, BASE), E(1, 0, 0, 0, [[0, 85], [100, 68], [200, 51]])],
  M416: [E(0, 0, 0, 0, BASE), E(0, MUZ, 0, 0, [[0, 81], [100, 64.8], [200, 48.6]])],
  Scar: [E(0, 0, 0, 0, BASE), E(0, MUZ, 0, 0, [[0, 80], [100, 64], [200, 48]])],
});
const target = { weapon: W('AUG'), scope: SC, gesture: 0, grip: 0, muzzle: MUZ, stock: 0 };

// a fake OpenAI-compatible server; handler(req, body) -> { status, body } or undefined to hang
function fake(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const out = await handler(req, body);
      if (!out) return; // never answers
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) })));
}
const reply = (content) => ({ body: { choices: [{ message: { role: 'assistant', content } }] } });
const answer = (points, reasoning = 'vì súng tương tự') => reply(JSON.stringify({ points, reasoning }));
const GOOD = [[0, 80], [100, 64], [200, 48]]; // about the computed curve x 0.89

test('config: all of url + key needed; a trailing slash and odd numbers are tolerated', () => {
  assert.deepEqual(loadAiConfig({}), { baseUrl: '', apiKey: '', model: 'auto', timeoutMs: 120000, concurrency: 3 });
  const c = loadAiConfig({ AI_BASE_URL: ' http://x:1/v1/ ', AI_API_KEY: ' k ', AI_MODEL: 'glm-5.3', AI_TIMEOUT_MS: '5000' });
  assert.deepEqual(c, { baseUrl: 'http://x:1/v1', apiKey: 'k', model: 'glm-5.3', timeoutMs: 5000, concurrency: 3 });
  assert.equal(loadAiConfig({ AI_TIMEOUT_MS: 'abc' }).timeoutMs, 120000);
  assert.equal(loadAiConfig({ AI_TIMEOUT_MS: '5' }).timeoutMs, 1000, 'not below one second');
  assert.equal(createAi(loadAiConfig({ AI_BASE_URL: 'http://x/v1' })).status().enabled, false, 'no key: off');
  assert.equal(createAi(loadAiConfig({ AI_API_KEY: 'k' })).status().enabled, false, 'no url: off');
  assert.deepEqual(createAi(loadAiConfig({ AI_BASE_URL: 'http://x/v1', AI_API_KEY: 'k' })).status(), { enabled: true, model: 'auto', concurrency: 3 });
});

test('parseAnswer: plain JSON, fenced JSON and JSON inside prose; anything else is refused with a reason', () => {
  const j = { points: [[0, 1], [10, 2]], reasoning: 'ok' };
  assert.deepEqual(parseAnswer(JSON.stringify(j)), { ok: true, points: j.points, reasoning: 'ok' });
  assert.equal(parseAnswer('```json\n' + JSON.stringify(j) + '\n```').ok, true);
  assert.equal(parseAnswer('Đây là kết quả:\n' + JSON.stringify(j) + '\nHy vọng giúp ích.').ok, true);
  assert.deepEqual(parseAnswer(JSON.stringify({ points: [{ t: 0, v: 1 }, { t: 5, v: 2 }] })).points, [[0, 1], [5, 2]], 'objects with t and v are accepted');
  for (const bad of ['', 'không có json', '{"points": "no"}', '{"points": []}', '{"nothing": 1}', '{"points": [[0, "x"]]}', '{"points": [[0, null]]}', null, 42]) {
    const r = parseAnswer(bad);
    assert.equal(r.ok, false, String(bad));
    assert.ok(r.reason.length > 0);
  }
});

test('validatePoints: finite, ascending in time, and not wildly different from the coefficient curve', () => {
  const computed = [[0, 90], [100, 72], [200, 54]];
  assert.equal(validatePoints(GOOD, computed).ok, true);
  assert.equal(validatePoints([[0, 80], [100, 64], [200, 48]].map(([t, v]) => [t * 1.5, v]), computed).ok, true, 'a longer curve is fine');
  assert.match(validatePoints([[0, 80], [100, 64], [50, 48]], computed).reason, /tăng dần/);
  assert.match(validatePoints([[0, 80], [100, Infinity]], computed).reason, /hữu hạn/);
  assert.match(validatePoints([[0, 900], [100, 700], [200, 500]], computed).reason, /lệch/, 'ten times too big');
  assert.match(validatePoints([[0, 8], [100, 6], [200, 4]], computed).reason, /lệch/, 'ten times too small');
  assert.match(validatePoints([[0, 90], [1000000, 54]], computed).reason, /thời lượng/i);
  assert.match(validatePoints(Array.from({ length: 200 }, (_, i) => [i, 70]), computed).reason, /quá nhiều/);
  assert.equal(validatePoints([[0, 5], [10, 6]], [[0, 0]]).ok, true, 'no reference to compare with: only the basic checks');
});

test('buildMessages: carries the gun, the combination, the similar guns and the coefficient curve; never the key', () => {
  const m = buildMessages(idx, target, { limit: 2 });
  assert.equal(m[0].role, 'system');
  assert.equal(m[1].role, 'user');
  const user = m[1].content;
  for (const s of ['AUG', 'M416', 'Scar', 'COMPENSATOR', 'X1', 'points']) assert.ok(user.includes(s) || m[0].content.includes(s), s);
  const data = JSON.parse(user.slice(user.indexOf('{')));
  assert.equal(data.target.gun, 'AUG');
  assert.deepEqual(data.target.base_curve, BASE);
  assert.deepEqual(data.coefficient_estimate.curve.map((p) => p[0]), [0, 100, 200]);
  assert.equal(data.similar_guns.length, 2);
  assert.ok(data.similar_guns[0].combo_curve.length >= 2 && data.similar_guns[0].base_curve.length >= 2);
  assert.ok(data.same_gun_entries.some((e) => e.accessories.grip === 'VERTICAL'), 'the gun\'s own other entries are given');
  assert.ok(!JSON.stringify(m).includes(KEY));
  // no similar gun: the message says so instead of failing
  const lonely = build({ AUG: [E(0, 0, 0, 0, BASE)] });
  assert.equal(JSON.parse(buildMessages(lonely, target)[1].content.slice(buildMessages(lonely, target)[1].content.indexOf('{'))).similar_guns.length, 0);
});

test('suggest: sends the key and the model, returns the points; the key is not in the answer', async () => {
  const f = await fake(() => answer(GOOD, 'M416 và Scar giảm 11% so với hệ số'));
  try {
    const ai = createAi({ baseUrl: f.url + '/', apiKey: KEY, model: 'glm-5.3', timeoutMs: 5000 });
    const r = await ai.suggest(idx, target);
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.curve, GOOD);
    assert.match(r.reasoning, /M416/);
    assert.equal(r.model, 'glm-5.3');
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].method, 'POST');
    assert.equal(f.seen[0].url, '/v1/chat/completions');
    assert.equal(f.seen[0].auth, `Bearer ${KEY}`);
    assert.equal(f.seen[0].body.model, 'glm-5.3');
    assert.ok(f.seen[0].body.messages.length >= 2);
    assert.ok(!JSON.stringify(r).includes(KEY));
  } finally { await f.close(); }
});

test('suggest: bad answers become a reason, never an exception, and never expose the key or the address', async () => {
  const cases = [
    [() => ({ status: 500, body: { error: { message: `boom ${KEY}` } } }), /HTTP 500/],
    [() => ({ status: 401, body: 'unauthorized' }), /HTTP 401/],
    [() => reply('xin lỗi, tôi không thể'), /JSON/],
    [() => answer([[0, 900], [100, 800]]), /lệch/],
    [() => ({ body: { choices: [] } }), /trống|không có/],
    [() => ({ body: 'not json at all' }), /không đọc được/],
  ];
  for (const [handler, re] of cases) {
    const f = await fake(handler);
    try {
      const r = await createAi({ baseUrl: f.url, apiKey: KEY, timeoutMs: 5000 }).suggest(idx, target);
      assert.equal(r.ok, false);
      assert.match(r.reason, re);
      assert.ok(!r.reason.includes(KEY), r.reason);
      assert.ok(!r.reason.includes('127.0.0.1'), r.reason);
    } finally { await f.close(); }
  }
});

test('suggest: a server that never answers times out; one that is not there is reported; the next request is not stuck', async () => {
  const hang = await fake(() => undefined);
  try {
    const ai = createAi({ baseUrl: hang.url, apiKey: KEY, timeoutMs: 1000 });
    const r = await ai.suggest(idx, target);
    assert.equal(r.ok, false);
    assert.match(r.reason, /kịp/);
    const again = await ai.suggest(idx, target);
    assert.match(again.reason, /kịp/, 'busy flag was released');
  } finally { await hang.close(); }
  const gone = await createAi({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: KEY, timeoutMs: 3000 }).suggest(idx, target);
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /kết nối/);
  assert.equal((await createAi({}).suggest(idx, target)).reason, 'AI chưa được cấu hình (cần AI_BASE_URL và AI_API_KEY trên server).');
});

test('suggest: one request at a time, so a free endpoint is not hammered', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = await fake(async () => { await gate; return answer(GOOD); });
  try {
    const ai = createAi({ baseUrl: f.url, apiKey: KEY, timeoutMs: 5000 });
    const first = ai.suggest(idx, target);
    await new Promise((r) => setTimeout(r, 100));
    const second = await ai.suggest(idx, target);
    assert.equal(second.ok, false);
    assert.equal(second.busy, true);
    assert.match(second.reason, /bận/);
    release();
    assert.equal((await first).ok, true);
    assert.equal((await ai.suggest(idx, target)).ok, true, 'free again');
  } finally { release(); await f.close(); }
});

test('suggest: a cancelled request stops at once and frees the AI for the next one', async () => {
  let n = 0;
  const f = await fake(() => { n++; return n === 1 ? undefined : answer(GOOD); }); // the first request never gets an answer
  try {
    const ai = createAi({ baseUrl: f.url, apiKey: KEY, timeoutMs: 20000 });
    const ac = new AbortController();
    const started = Date.now();
    const first = ai.suggest(idx, target, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    const r = await first;
    assert.equal(r.ok, false);
    assert.match(r.reason, /hủy/);
    assert.ok(Date.now() - started < 3000, 'did not wait for the timeout');
    assert.equal((await ai.suggest(idx, target)).ok, true, 'free again right away');
    assert.equal((await ai.suggest(idx, target, { signal: AbortSignal.abort() })).ok, false, 'already cancelled before it starts');
  } finally { await f.close(); }
});

// ---- ranking the combinations that are worth adding
const { parseRanking, buildRankMessages } = require('./ai');
const cands = [
  { grip: R.GRIPS.indexOf('VERTICAL'), muzzle: MUZ, stock: 0, kind: '0|110', expectedError: 0.11, multiplier: 0.765, seenIn: 0, gap: null },
  { grip: R.GRIPS.indexOf('THUMB'), muzzle: 0, stock: R.STOCKS.indexOf('GENERAL'), kind: '0|101', expectedError: 0.17, multiplier: 0.72, seenIn: 1, gap: { n: 2, of: 5, support: 0.4, names: ['M416', 'Scar'] } },
  { grip: 0, muzzle: R.MUZZLES.indexOf('FLASH_HIDER'), stock: 0, kind: '0|010', expectedError: 0.01, multiplier: 0.8, seenIn: 0, gap: null },
];
const rank = (list) => reply(JSON.stringify({ ranking: list }));

test('parseRanking: only indexes of the list, no repeats, reasons trimmed; anything else is refused with a reason', () => {
  const ok = parseRanking(JSON.stringify({ ranking: [{ i: 1, reason: '  hay dùng cùng nhau ' }, { i: 0, reason: 'x'.repeat(400) }, { i: 1, reason: 'lặp' }, { i: 9, reason: 'ngoài danh sách' }, { i: 'a' }, { reason: 'thiếu i' }] }), 3);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ranking.map((r) => r.i), [1, 0], 'repeats and unknown indexes are dropped');
  assert.equal(ok.ranking[0].reason, 'hay dùng cùng nhau');
  assert.ok(ok.ranking[1].reason.length <= 160);
  assert.equal(parseRanking('```json\n{"ranking":[{"i":2,"reason":"ok"}]}\n```', 3).ok, true);
  for (const bad of ['', 'không có json', '{"ranking": "no"}', '{"ranking": []}', '{"ranking":[{"i":7,"reason":"x"}]}', null]) assert.equal(parseRanking(bad, 3).ok, false, String(bad));
});

test('buildRankMessages: gun, posture, what the gun already owns and the numbered candidates; never the key', () => {
  const m = buildRankMessages(idx, { weapon: W('AUG'), scope: SC, gesture: 0 }, cands);
  const data = JSON.parse(m[1].content.slice(m[1].content.indexOf('{')));
  assert.equal(data.gun, 'AUG');
  assert.equal(data.posture, 'STAND');
  assert.equal(data.candidates.length, 3);
  assert.deepEqual(data.candidates.map((c) => c.i), [0, 1, 2]);
  assert.equal(data.candidates[1].accessories.grip, 'THUMB');
  assert.equal(data.candidates[1].similar_guns_having, '2/5');
  assert.ok(Array.isArray(data.owned_combinations));
  assert.match(m[0].content, /ranking/);
  assert.ok(!JSON.stringify(m).includes(KEY));
});

test('rankCombos: sends the candidates, returns the ranking with the model; bad answers are reasons; has its own lane next to suggest', async () => {
  const f = await fake((req, body) => (body.messages[1].content.includes('"candidates"') ? rank([{ i: 1, reason: 'tay cầm ngón cái + báng hay đi cùng' }, { i: 0, reason: 'phổ biến' }]) : answer(GOOD)));
  try {
    const ai = createAi({ baseUrl: f.url, apiKey: KEY, model: 'm1', timeoutMs: 5000 });
    const r = await ai.rankCombos(idx, { weapon: W('AUG'), scope: SC, gesture: 0 }, cands);
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.ranking, [{ i: 1, reason: 'tay cầm ngón cái + báng hay đi cùng' }, { i: 0, reason: 'phổ biến' }]);
    assert.equal(r.model, 'm1');
    assert.equal(f.seen[0].auth, `Bearer ${KEY}`);
    assert.ok(!JSON.stringify(r).includes(KEY));
    assert.equal((await ai.rankCombos(idx, { weapon: W('AUG'), scope: SC, gesture: 0 }, [])).ok, false, 'nothing to rank');
  } finally { await f.close(); }
  const bad = await fake(() => rank([{ i: 99, reason: 'x' }]));
  try {
    const r = await createAi({ baseUrl: bad.url, apiKey: KEY, timeoutMs: 5000 }).rankCombos(idx, { weapon: W('AUG'), scope: SC, gesture: 0 }, cands);
    assert.equal(r.ok, false);
    assert.ok(r.reason.length > 0 && !r.reason.includes(KEY));
  } finally { await bad.close(); }
  // while a curve request is waiting, ranking is not told the AI is busy (and the other way round)
  let release;
  const gate = new Promise((res) => { release = res; });
  const slow = await fake(async (req, body) => { if (!body.messages[1].content.includes('"candidates"')) await gate; return body.messages[1].content.includes('"candidates"') ? rank([{ i: 0, reason: 'ok' }]) : answer(GOOD); });
  try {
    const ai = createAi({ baseUrl: slow.url, apiKey: KEY, timeoutMs: 5000 });
    const curve = ai.suggest(idx, target);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal((await ai.rankCombos(idx, { weapon: W('AUG'), scope: SC, gesture: 0 }, cands)).ok, true, 'own lane');
    assert.equal((await ai.rankCombos(idx, { weapon: W('AUG'), scope: SC, gesture: 0 }, cands)).ok, true, 'and free again');
    release();
    assert.equal((await curve).ok, true);
  } finally { release(); await slow.close(); }
});

test('concurrency: AI_CONCURRENCY decides how many points-requests may be out at once (1 to 8, default 3); asking directly stays at one', async () => {
  const conc = (v) => loadAiConfig({ AI_BASE_URL: 'http://x/v1', AI_API_KEY: 'k', ...(v === undefined ? {} : { AI_CONCURRENCY: v }) }).concurrency;
  assert.deepEqual([conc(), conc('5'), conc('0'), conc('-2'), conc('abc'), conc('99'), conc('2.7')], [3, 5, 3, 3, 3, 8, 2]);
  assert.equal(createAi({ baseUrl: 'http://x/v1', apiKey: 'k' }).status().concurrency, 1);
  assert.equal(createAi({ baseUrl: 'http://x/v1', apiKey: 'k', concurrency: 4 }).status().concurrency, 4);

  let release;
  const gate = new Promise((r) => { release = r; });
  let seen = 0;
  const f = await fake(async () => { seen++; await gate; return answer(GOOD); });
  try {
    const ai = createAi({ baseUrl: f.url, apiKey: KEY, timeoutMs: 5000, concurrency: 2 });
    const a = ai.suggest(idx, target);
    const b = ai.suggest(idx, target);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen, 2, 'two requests are out at the same time');
    const third = await ai.suggest(idx, target);
    assert.equal(third.busy, true, 'the third waits: the limit is 2');
    release();
    assert.deepEqual([(await a).ok, (await b).ok], [true, true]);
    assert.equal((await ai.suggest(idx, target)).ok, true, 'free again');
  } finally { release(); await f.close(); }
});
