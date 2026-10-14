'use strict';
// "Cài đặt AI" (several endpoints, tried in order) and "Quét tất cả" (the server's pre-scan, the AI review of an existing entry).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('./admin/recoil');
const { AiProviders, ENV_ID } = require('./ai-providers');
const { createAi, reviewScan, validateReview, curveChange } = require('./ai');

const W = (n) => R.WEAPONS.indexOf(n);
const SC = R.SCOPES.indexOf('X1');
const MUZ = R.MUZZLES.indexOf('COMPENSATOR');
const COEF = { compensatorMuzzle: 0.9, flashHidderMuzzle: 0.8, suppressorMuzzle: 0.95, verticalGrip: 0.85, horizontalGrip: 0.97, halfGrip: 0.93, lightGrip: 0.98, thumbGrip: 0.8, laserGrip: 0.99, generalStock: 0.9, crouch: 0.8, prone: 0.6, stand: 1 };
const BASE = [[0, 100], [100, 80], [200, 60]];
const E = (grip, muzzle, stock, gesture, recoilValue) => ({ scope: SC, grip, muzzle, stock, gesture, recoilValue });
function build(guns) {
  const groups = Array.from({ length: 70 }, () => ({ v: [], coefficients: Array.from({ length: 13 }, () => ({ ...COEF })) }));
  for (const [name, entries] of Object.entries(guns)) groups[W(name)].v.push(...entries);
  return R.indexData(groups);
}
const ENV = { baseUrl: 'http://192.168.4.6:3001/v1', apiKey: 'env-secret-key-0000', model: 'auto' };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aip-')), 'ai-providers.json');

test('providers: FreeLLMAPI first by default; the page never sees a key nor the address of the environment endpoint', () => {
  const s = new AiProviders({ env: ENV, file: tmpFile() });
  assert.deepEqual(s.usable().map((p) => p.id), [ENV_ID]);
  const pub = JSON.stringify(s.publicList());
  assert.ok(!pub.includes('env-secret') && !pub.includes('192.168.4.6'));
  assert.equal(s.publicList()[0].builtin, true);
});

test('providers: added, ordered, kept on disk, key masked; empty key keeps it on the same server only', () => {
  const file = tmpFile();
  const s = new AiProviders({ env: ENV, file });
  let r = s.replace([{ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1/', apiKey: 'sk-or-123456789', model: 'x/y' }, { id: ENV_ID, enabled: true }]);
  assert.equal(r.ok, true);
  assert.deepEqual(s.usable().map((p) => p.name), ['OpenRouter', 'FreeLLMAPI (mặc định, cấu hình trên server)'], 'the order given is the order tried');
  const added = s.publicList()[0];
  assert.equal(added.keyHint, '••••6789');
  assert.ok(!JSON.stringify(s.publicList()).includes('sk-or-123456789'));
  assert.equal((fs.statSync(file).mode & 0o777).toString(8).length > 0, true);
  // reload from disk
  const again = new AiProviders({ env: ENV, file });
  assert.equal(again.usable()[0].apiKey, 'sk-or-123456789');
  // same server, empty key: kept
  r = again.replace([{ id: added.id, name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'z' }, { id: ENV_ID }]);
  assert.equal(r.ok, true);
  assert.equal(again.usable()[0].apiKey, 'sk-or-123456789');
  // another server, empty key: refused (the stored key would be sent to whoever owns the new address)
  r = again.replace([{ id: added.id, name: 'OpenRouter', baseUrl: 'http://10.0.0.9:9/v1', apiKey: '', model: 'z' }, { id: ENV_ID }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /nhập lại khóa/);
  // the environment endpoint cannot be removed: it comes back first, and can be switched off
  r = again.replace([{ id: added.id, name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'z' }]);
  assert.equal(r.ok, true);
  assert.equal(again.resolved()[0].id, ENV_ID);
  r = again.replace([{ id: ENV_ID, enabled: false }, { id: added.id, name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'z' }]);
  assert.deepEqual(again.usable().map((p) => p.name), ['OpenRouter']);
  // bad input changes nothing
  assert.equal(again.replace([{ name: 'X', baseUrl: 'ftp://a', apiKey: 'k' }]).ok, false);
  assert.equal(again.replace([{ name: 'X', baseUrl: 'http://u:p@a/v1', apiKey: 'k' }]).ok, false);
  assert.equal(again.replace([{ name: '', baseUrl: 'http://a/v1', apiKey: 'k' }]).ok, false);
  assert.deepEqual(again.usable().map((p) => p.name), ['OpenRouter']);
});

// a fetch that answers per host
function fakeFetch(byHost) {
  const calls = [];
  const fn = async (url, init) => {
    const host = new URL(url).host;
    calls.push(host);
    const h = byHost[host];
    if (!h) throw new TypeError('fetch failed');
    const out = await h(JSON.parse(init.body), init);
    return { ok: out.status === undefined || out.status < 400, status: out.status || 200, text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)) };
  };
  fn.calls = calls;
  return fn;
}
const reply = (points, reasoning = 'ok') => ({ body: { choices: [{ message: { content: JSON.stringify({ points, reasoning }) } }], model: 'm' } });

test('fallback: an endpoint that fails (HTTP, no connection, bad answer) passes the question to the next one', async () => {
  const idx = build({ AUG: [E(0, 0, 0, 0, BASE)] });
  const target = { weapon: W('AUG'), scope: SC, gesture: 0, grip: 0, muzzle: MUZ, stock: 0 };
  const list = [
    { id: 'a', name: 'A', baseUrl: 'http://a/v1', apiKey: 'ka', model: 'm1' },
    { id: 'b', name: 'B', baseUrl: 'http://gone/v1', apiKey: 'kb', model: 'm2' },
    { id: 'c', name: 'C', baseUrl: 'http://c/v1', apiKey: 'kc', model: 'm3' },
    { id: 'd', name: 'D', baseUrl: 'http://d/v1', apiKey: 'kd', model: 'm4' },
  ];
  const f = fakeFetch({
    a: () => ({ status: 500, body: 'oops ka' }),
    c: () => reply([[0, 1]]), // invalid (far from the coefficient curve): next
    d: () => reply([[0, 90], [100, 72], [200, 54]]),
  });
  const ai = createAi({ concurrency: 2 }, { fetchImpl: f, providers: () => list });
  const r = await ai.suggest(idx, target);
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'D');
  assert.deepEqual(f.calls, ['a', 'gone', 'c', 'd']);
  // all fail: the reason names every endpoint and never contains a key or an address
  const g = createAi({}, { fetchImpl: fakeFetch({ a: () => ({ status: 429, body: 'slow ka http://a/v1' }) }), providers: () => list.slice(0, 2) });
  const bad = await g.suggest(idx, target);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /A: .*HTTP 429/);
  assert.match(bad.reason, /B: /);
  assert.ok(!bad.reason.includes('ka') || !/\bka\b/.test(bad.reason));
  assert.ok(!bad.reason.includes('http://a/v1'));
  // no endpoint at all
  assert.equal((await createAi({}, { providers: () => [] }).suggest(idx, target)).ok, false);
});

test('review: an existing entry is checked against itself, an unchanged answer always passes, change is measured', () => {
  const cur = [[0, 100], [100, 80], [200, 60]];
  assert.equal(validateReview(cur, cur).ok, true);
  assert.equal(validateReview([[0, 104], [100, 81], [200, 59]], cur).ok, true);
  assert.equal(validateReview([[0, 200], [100, 160], [200, 120]], cur).ok, false, 'twice the pull is refused');
  assert.equal(validateReview([[0, 100], [500, 60]], cur).ok, false, 'duration x2.5 is refused');
  assert.equal(curveChange(cur, cur), 0);
  assert.ok(Math.abs(curveChange(cur, [[0, 110], [100, 88], [200, 66]]) - 0.1) < 1e-9);
});

test('review via AI: the endpoint gets the current curve and the answer is checked against it', async () => {
  const own = [[0, 120], [100, 96], [200, 72]]; // far from the coefficient curve on purpose
  const idx = build({ AUG: [E(0, 0, 0, 0, BASE), E(0, MUZ, 0, 0, own)] });
  const target = { weapon: W('AUG'), scope: SC, gesture: 0, grip: 0, muzzle: MUZ, stock: 0 };
  let sent = null;
  const f = fakeFetch({ a: (body) => { sent = body; return reply(own, 'giữ nguyên'); } });
  const ai = createAi({}, { fetchImpl: f, providers: () => [{ id: 'a', name: 'A', baseUrl: 'http://a/v1', apiKey: 'k', model: 'm' }] });
  const r = await ai.review(idx, target);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.change, 0);
  assert.match(sent.messages[1].content, /"current_curve":\[\[0,120\]/);
  // a combination without an own entry is not reviewed
  const none = await ai.review(idx, { ...target, muzzle: 0, grip: 1 });
  assert.equal(none.ok, false);
});

test('pre-scan: own entries far from similar guns, crouch above standing and extra accessories pulling harder are flagged', () => {
  const idx = build({
    AUG: [E(0, 0, 0, 0, BASE), E(0, MUZ, 0, 0, [[0, 120], [100, 96], [200, 72]]), E(0, 0, 0, 1, [[0, 110], [100, 88], [200, 66]])],
    M416: [E(0, 0, 0, 0, BASE), E(0, MUZ, 0, 0, [[0, 81], [100, 64.8], [200, 48.6]])],
    Scar: [E(0, 0, 0, 0, BASE), E(0, MUZ, 0, 0, [[0, 80], [100, 64], [200, 48]])],
  });
  const r = reviewScan(idx, W('AUG'));
  assert.equal(r.total, 2, 'the bare base curve is not reviewed');
  assert.equal(r.flagged.length, 2);
  const muz = r.flagged.find((f) => f.muzzle === MUZ);
  assert.ok(muz.reasons.some((x) => /súng tương tự/.test(x)));
  assert.ok(muz.reasons.some((x) => /đầu nòng/.test(x)), 'compensator pulling harder than none');
  const crouch = r.flagged.find((f) => f.gesture === 1);
  assert.ok(crouch.reasons.some((x) => /ngồi kéo mạnh hơn đứng/.test(x)));
  // guns whose entries agree with each other: nothing flagged
  const fine = build({
    M416: [E(0, 0, 0, 0, BASE), E(0, MUZ, 0, 0, [[0, 81], [100, 64.8], [200, 48.6]])],
    Scar: [E(0, 0, 0, 0, BASE), E(0, MUZ, 0, 0, [[0, 80], [100, 64], [200, 48]])],
  });
  const clean = reviewScan(fine, W('M416'));
  assert.equal(clean.flagged.length, 0);
});
