'use strict';
// The AI half of the points suggestion: asks an OpenAI-compatible endpoint (POST {AI_BASE_URL}/chat/completions) for the curve of a
// recoil combination, from the data of the gun and of similar guns. The key lives only on the server (env AI_API_KEY); nothing
// that is returned to the page contains it or the address. Free routers are slow and sometimes wrong, so:
//   * one request at a time;
//   * the answer is parsed strictly and checked against the coefficient curve (validatePoints); a bad answer is a reason, not an exception.
// The data sent is recoil numbers only (gun names, scope, accessories, curves): no keymaps, no device information.

const R = require('./admin/recoil');
const S = require('./suggest');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_CONCURRENCY = 3; // measured on a free-model gateway: more than 3-4 at once only moves requests to slower fallback models
const MAX_CONCURRENCY = 8;
const MAX_POINTS = 60;
const r2 = (x) => Math.round(x * 100) / 100;
const curve2 = (c) => c.map(([t, v]) => [Math.round(t), r2(v)]);

function loadAiConfig(env = process.env) {
  const t = Number(env.AI_TIMEOUT_MS);
  const c = Number(env.AI_CONCURRENCY);
  return {
    baseUrl: String(env.AI_BASE_URL || '').trim().replace(/\/+$/, ''),
    apiKey: String(env.AI_API_KEY || '').trim(),
    model: String(env.AI_MODEL || '').trim() || 'auto',
    timeoutMs: Number.isFinite(t) && t > 0 ? Math.max(1000, Math.floor(t)) : DEFAULT_TIMEOUT_MS,
    // how many points-requests may be out at the same time (the page asks for as many as this at once when it makes many combinations)
    concurrency: Number.isFinite(c) && c >= 1 ? Math.min(MAX_CONCURRENCY, Math.floor(c)) : DEFAULT_CONCURRENCY,
  };
}

// ---------------------------------------------------------------- what is asked
const SYSTEM = `You help tune the recoil curves in the controller config of a mobile shooter game.
A curve is a list of points [time_ms, value]: time starts at 0 and strictly increases, the value is the vertical pull strength at that time.
Task: propose the curve for the TARGET gun and combination (scope, posture, accessories) that has no entry of its own yet.
Evidence you get: (1) coefficient_estimate = the gun's base curve times the accessory/posture coefficients, which is what the app uses when there is no own entry; (2) similar_guns = for guns whose base curve resembles the target's, their REAL own entry for this very combination next to their own coefficient curve, so you can see how real data differs from the coefficient estimate (value ratio and duration change); (3) same_gun_entries = other real entries of the target gun.
target.accessory_rules says what this gun can physically take (anything not listed cannot be fitted); target.combination_problems is empty when the combination fits the gun, otherwise it says what does not. Never rely on an accessory the gun cannot take.
Keep the number of points close to the coefficient estimate (between 3 and ${MAX_POINTS}). Do not invent a wildly different scale.
If target.time_axis is not null, the times are FIXED by it: the points are spread evenly from 0 to duration_ms, so decide only the VALUES and answer exactly point_count points (your times are replaced by that grid anyway).
Answer with ONE JSON object only, no markdown: {"points": [[time_ms, value], ...], "reasoning": "at most 3 sentences in Vietnamese: which evidence you used and the main change against the coefficient estimate"}`;

const label = (list, i) => list[i] || String(i);
// said last in every question, as a message of its own (the data message stays plain JSON): "thinking" models otherwise write their analysis
// into the answer and run out of tokens before the JSON
const JSON_ONLY = { role: 'user', content: 'Reply with the JSON object ONLY: no analysis, no text before or after it. The first character of your reply must be {.' };

// What a gun can take (RecoilLib.attachmentsFor, from the official table): sent with every question so the model never relies on or proposes an accessory
// the gun cannot carry. A gun the table does not cover gets an explicit "no rule" note instead of a guess.
function accessoryRules(weapon) {
  const a = R.attachmentsFor(weapon);
  if (!a) return { known: false, note: 'No accessory rule is known for this gun: do not assume any restriction.' };
  const names = (set, list) => [...set].map((i) => list[i]);
  return { known: true, source: a.sourceLabel, grips: names(a.grips, R.GRIPS), muzzles: names(a.muzzles, R.MUZZLES), stocks: names(a.stocks, R.STOCKS), max_scope_zoom: a.maxZoom, note: 'Anything not listed cannot be fitted on this gun.' };
}

// idx: RecoilLib.indexData(groups); target: { weapon, scope, gesture, grip, muzzle, stock } (enum indexes)
// what fixes the times of the points of a gun that has fire data: null when it has none
function timeAxis(weapon, pointCount) {
  const fire = R.fireOf(weapon);
  return fire ? { duration_ms: fire.emptyMs, point_count: pointCount, rule: 'points are evenly spaced: time_i = round(i * duration_ms / (point_count - 1)); the first is at 0 and the last at duration_ms' } : null;
}

function buildMessages(idx, target, { limit = 5 } = {}) {
  const comp = R.computedFor(idx, target);
  const baseList = idx.map.get(S.keyOf(target.weapon, target.scope, 0, 0, 0, 0));
  const sims = S.similarGuns(idx, target, { limit });
  const sameGun = [];
  for (const [key, list] of idx.map) {
    const [w, s, g, m, st, ge] = key.split('|').map(Number);
    if (w !== target.weapon || s !== target.scope) continue;
    if (g === target.grip && m === target.muzzle && st === target.stock && ge === target.gesture) continue;
    if (!g && !m && !st && !ge) continue; // the base curve is given on its own
    sameGun.push({ ge, n: (g ? 1 : 0) + (m ? 1 : 0) + (st ? 1 : 0), e: { posture: label(R.POSTURES, ge), accessories: { grip: label(R.GRIPS, g), muzzle: label(R.MUZZLES, m), stock: label(R.STOCKS, st) }, curve: curve2(list[list.length - 1].recoilValue) } });
  }
  sameGun.sort((a, b) => (a.ge === target.gesture ? 0 : 1) - (b.ge === target.gesture ? 0 : 1) || a.n - b.n);
  const data = {
    target: {
      gun: label(R.WEAPONS, target.weapon),
      scope: label(R.SCOPES, target.scope),
      posture: label(R.POSTURES, target.gesture),
      accessories: { grip: label(R.GRIPS, target.grip), muzzle: label(R.MUZZLES, target.muzzle), stock: label(R.STOCKS, target.stock) },
      base_curve: baseList ? curve2(baseList[baseList.length - 1].recoilValue) : null,
      accessory_rules: accessoryRules(target.weapon),
      combination_problems: R.comboProblems(target.weapon, target.scope, target).map((p) => p.reason),
      time_axis: timeAxis(target.weapon, comp.curve.length),
    },
    coefficient_estimate: { curve: curve2(comp.curve), multiplier: comp.multiplier == null ? null : Math.round(comp.multiplier * 10000) / 10000, parts: comp.parts.map((p) => ({ name: p.label, value: Math.round(p.value * 10000) / 10000 })) },
    same_gun_entries: sameGun.slice(0, 14).map((x) => x.e),
    similar_guns: sims.map((s) => ({
      gun: s.name, distance: r2(s.distance), base_curve: curve2(s.base), coefficient_curve: curve2(R.computedFor(idx, { ...target, weapon: s.weapon }).curve), combo_curve: curve2(s.combo),
    })),
  };
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Data for the request (JSON follows):\n${JSON.stringify(data)}` },
    JSON_ONLY,
  ];
}

// ---------------------------------------------------------------- reviewing an entry that already exists ("Quét tất cả")
const SYSTEM_REVIEW = `You help tune the recoil curves in the controller config of a mobile shooter game.
A curve is a list of points [time_ms, value]: time starts at 0 and strictly increases, the value is the vertical pull strength at that time.
Task: the TARGET gun and combination (scope, posture, accessories) ALREADY has its own entry: current_curve. Review it against the evidence and propose the curve it should have.
Evidence you get: (1) coefficient_estimate = the gun's base curve times the accessory/posture coefficients (what the app would use without an own entry); (2) similar_guns = for guns whose base curve resembles the target's, their REAL own entry for this very combination next to their own coefficient curve, so you can see how real data differs from the coefficient estimate; (3) same_gun_entries = other real entries of the target gun (keep the target consistent with them: e.g. more recoil-reducing accessories should not give a stronger pull than fewer, crouch/prone are usually lower than standing).
target.accessory_rules says what this gun can physically take; target.combination_problems is empty when the combination fits the gun.
If current_curve is already consistent with the evidence, return it unchanged (same points). Change only what the evidence supports; keep the shape and the number of points close to current_curve (between 3 and ${MAX_POINTS}). Do not invent a wildly different scale.
If target.time_axis is not null, the times are FIXED by it (points spread evenly from 0 to duration_ms): decide only the VALUES and answer exactly point_count points; to keep the curve as it is, return its current values.
Answer with ONE JSON object only, no markdown: {"points": [[time_ms, value], ...], "reasoning": "at most 3 sentences in Vietnamese: is the current curve fine, what evidence you used and what you changed"}`;

// the same evidence as buildMessages plus the entry being reviewed
function buildReviewMessages(idx, target, opts = {}) {
  const msgs = buildMessages(idx, target, opts);
  const body = msgs[1].content;
  const data = JSON.parse(body.slice(body.indexOf('{')));
  const own = idx.map.get(S.keyOf(target.weapon, target.scope, target.grip, target.muzzle, target.stock, target.gesture));
  data.target.current_curve = own ? curve2(own[own.length - 1].recoilValue) : null;
  if (data.target.time_axis && data.target.current_curve) data.target.time_axis.point_count = data.target.current_curve.length;
  return [{ role: 'system', content: SYSTEM_REVIEW }, { role: 'user', content: `Data for the request (JSON follows):\n${JSON.stringify(data)}` }, JSON_ONLY];
}

// how far a new curve is from the current one: mean of |new/old - 1| over the old curve's points, time scaled to the new duration (0.05 = 5%)
function curveChange(current, next, { ignoreDuration = false } = {}) {
  const dc = S.duration(current);
  const dn = S.duration(next);
  let sum = 0;
  let n = 0;
  for (const [t, v] of current) {
    if (Math.abs(v) < 1e-6) continue;
    const w = S.interp(next, dc > 0 && dn > 0 ? (t / dc) * dn : t);
    sum += Math.abs(w / v - 1);
    n++;
  }
  const value = n ? sum / n : 0;
  const duration = dc > 0 && !ignoreDuration ? Math.abs(dn / dc - 1) : 0; // a gun with fire data has the length of its magazine, not of the saved curve
  return Math.round(Math.max(value, duration) * 10000) / 10000;
}

// A reviewed curve is checked against the CURRENT entry, not the coefficient curve (real entries often sit far from the coefficients, and an
// unchanged answer must always pass): same rules for points, duration 0.5-2x and every value 0.6-1.6x of the current curve.
const sameCurve = (a, b) => a.length === b.length && a.every(([t, v], i) => Math.abs(t - b[i][0]) < 1e-6 && Math.abs(v - b[i][1]) < 1e-4);
// fire: R.fireOf(gun) or null. With it the times of a changed answer are put on the even grid first (values kept) and the length is not judged.
function validateReview(points, current, fire = null) {
  const checked = R.checkCurve(points);
  if (!checked.ok) return { ok: false, reason: checked.error };
  if (sameCurve(points, current)) return { ok: true, curve: points.map(([t, v]) => [t, v]) };
  if (points.length > MAX_POINTS) return { ok: false, reason: `AI trả quá nhiều mốc (${points.length}; tối đa ${MAX_POINTS}).` };
  if (fire) points = R.withEvenTimes(checked.curve, fire.emptyMs); // checked.curve is sorted by time: a list in the wrong order is not read upside down
  else for (let i = 1; i < points.length; i++) if (points[i][0] <= points[i - 1][0]) return { ok: false, reason: `Thời gian phải tăng dần (mốc #${i + 1}).` };
  const durC = S.duration(current);
  if (durC > 0 && current.some(([, v]) => Math.abs(v) > 1e-6)) {
    const dur = S.duration(points);
    if (!fire && (dur / durC < 0.5 || dur / durC > 2)) return { ok: false, reason: `Thời lượng AI đưa ra (${Math.round(dur)} ms) lệch quá xa mục hiện tại (${Math.round(durC)} ms).` };
    for (let i = 0; i < points.length; i++) {
      const ref = S.interp(current, (points[i][0] / dur) * durC);
      if (Math.abs(ref) < 1e-6) continue;
      const k = points[i][1] / ref;
      if (k < 0.6 || k > 1.6) return { ok: false, reason: `Giá trị mốc #${i + 1} (${r2(points[i][1])}) lệch quá xa mục hiện tại (${r2(ref)}).` };
    }
  }
  return { ok: true, curve: points.map(([t, v]) => [t, v]) };
}

// ---------------------------------------------------------------- which existing entries are worth reviewing (no AI: the server's own logic)
// Every own entry of the gun (not the bare base curves, not the ones against the table of accessories), with what the server finds odd:
//   * far from what similar guns say for the same combination (analogCurve), by REVIEW_ANALOG or more;
//   * crouch/prone pulling harder than standing with the same accessories;
//   * more accessories pulling harder than a subset of them (same scope and posture).
// -> { ok, total, flagged: [{ scope, gesture, grip, muzzle, stock, score, reasons }] most suspicious first, clean, entries: every own entry reviewed }
const REVIEW_ANALOG = 0.08;
const meanValue = (c) => (c.length ? c.reduce((n, [, v]) => n + Math.abs(v), 0) / c.length : 0);
function reviewScan(idx, weapon) {
  if (R.isGunDisabled(weapon)) return { ok: false, reason: 'Súng này đã bị tắt không sử dụng trong Tiêu chuẩn súng.', total: 0, flagged: [], clean: 0, entries: [] };
  const own = [];
  for (const [key, list] of idx.map) {
    const [w, s, g, m, st, ge] = key.split('|').map(Number);
    if (w !== weapon || (!g && !m && !st && !ge)) continue;
    const o = { weapon: w, scope: s, gesture: ge, grip: g, muzzle: m, stock: st };
    if (R.comboProblems(w, s, o).length) continue; // against the table: "Kiểm tra theo chuẩn" deletes those, nothing to tune
    own.push({ o, curve: list[list.length - 1].recoilValue.map(([t, v]) => [Number(t), Number(v)]) });
  }
  const meanOf = (o) => {
    const list = idx.map.get(S.keyOf(o.weapon, o.scope, o.grip, o.muzzle, o.stock, o.gesture));
    return list ? meanValue(list[list.length - 1].recoilValue.map(([t, v]) => [Number(t), Number(v)])) : null;
  };
  const flagged = [];
  for (const e of own) {
    const reasons = [];
    let score = 0;
    const a = S.analogCurve(idx, e.o);
    if (a.ok) {
      const d = curveChange(e.curve, a.curve, { ignoreDuration: Boolean(R.fireOf(weapon)) });
      if (d >= REVIEW_ANALOG) { reasons.push(`lệch ${Math.round(d * 100)}% so với các súng tương tự`); score = Math.max(score, d); }
    }
    const mine = meanValue(e.curve);
    if (e.o.gesture) {
      const stand = meanOf({ ...e.o, gesture: 0 });
      if (stand && mine > stand * 1.02) { reasons.push(`${e.o.gesture === 1 ? 'ngồi' : 'nằm'} kéo mạnh hơn đứng ${Math.round((mine / stand - 1) * 100)}%`); score = Math.max(score, mine / stand - 1 + 0.1); }
    }
    for (const slot of ['grip', 'muzzle', 'stock']) {
      if (!e.o[slot]) continue;
      const fewer = meanOf({ ...e.o, [slot]: 0 });
      if (fewer && mine > fewer * 1.1) {
        reasons.push(`thêm ${slot === 'grip' ? 'tay cầm' : slot === 'muzzle' ? 'đầu nòng' : 'báng'} mà kéo mạnh hơn ${Math.round((mine / fewer - 1) * 100)}%`);
        score = Math.max(score, mine / fewer - 1);
      }
    }
    if (reasons.length) flagged.push({ ...e.o, score: Math.round(score * 10000) / 10000, reasons });
  }
  flagged.sort((x, y) => y.score - x.score);
  return { ok: true, total: own.length, flagged, clean: own.length - flagged.length, entries: own.map((e) => e.o) };
}

// ---------------------------------------------------------------- what comes back
function parseAnswer(content) {
  if (typeof content !== 'string' || !content.trim()) return { ok: false, reason: 'AI trả về câu trả lời trống.' };
  const text = content.replace(/```(?:json)?/gi, '');
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  let obj = null;
  if (a >= 0 && b > a) { try { obj = JSON.parse(text.slice(a, b + 1)); } catch { obj = null; } }
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'Không tìm thấy JSON hợp lệ trong câu trả lời của AI.' };
  if (!Array.isArray(obj.points) || !obj.points.length) return { ok: false, reason: 'Câu trả lời của AI không có danh sách "points" (hoặc rỗng).' };
  const points = [];
  for (let i = 0; i < obj.points.length; i++) {
    const p = obj.points[i];
    const pair = Array.isArray(p) ? p : p && typeof p === 'object' ? [p.t, p.v] : null;
    if (!pair || pair.length !== 2 || typeof pair[0] !== 'number' || typeof pair[1] !== 'number') return { ok: false, reason: `Mốc #${i + 1} của AI không phải cặp số [thời gian, giá trị].` };
    points.push([pair[0], pair[1]]);
  }
  return { ok: true, points, reasoning: typeof obj.reasoning === 'string' ? obj.reasoning.trim().slice(0, 600) : '' };
}

// computed: the coefficient curve of the same combination (the sanity reference)
// fire: R.fireOf(gun) or null. With it the times are put on the even grid first (the values stay) and neither the order nor the length of the times is judged.
function validatePoints(points, computed, fire = null) {
  const checked = R.checkCurve(points);
  if (!checked.ok) return { ok: false, reason: checked.error };
  if (points.length > MAX_POINTS) return { ok: false, reason: `AI trả quá nhiều mốc (${points.length}; tối đa ${MAX_POINTS}).` };
  if (fire) points = R.withEvenTimes(checked.curve, fire.emptyMs); // checked.curve is sorted by time: a list in the wrong order is not read upside down
  else for (let i = 1; i < points.length; i++) if (points[i][0] <= points[i - 1][0]) return { ok: false, reason: `Thời gian phải tăng dần (mốc #${i + 1}).` };
  const durC = S.duration(computed);
  const hasRef = durC > 0 && computed.some(([, v]) => Math.abs(v) > 1e-6);
  if (hasRef) {
    const dur = S.duration(points);
    if (!fire && (dur / durC < 0.25 || dur / durC > 4)) return { ok: false, reason: `Thời lượng AI đưa ra (${Math.round(dur)} ms) lệch quá xa đường cong theo hệ số (${Math.round(durC)} ms).` };
    for (let i = 0; i < points.length; i++) {
      const ref = S.interp(computed, (points[i][0] / dur) * durC);
      if (Math.abs(ref) < 1e-6) continue;
      const k = points[i][1] / ref;
      if (k < 0.4 || k > 2.5) return { ok: false, reason: `Giá trị mốc #${i + 1} (${r2(points[i][1])}) lệch quá xa đường cong theo hệ số (${r2(ref)}).` };
    }
  }
  return { ok: true, curve: points.map(([t, v]) => [t, v]) };
}

// ---------------------------------------------------------------- which combinations are worth adding
const SYSTEM_RANK = `You help decide which accessory combinations of a gun deserve their own recoil entry in the controller config of a mobile shooter game.
When a combination has no own entry the app computes it as base curve x accessory coefficients; "expected_error" says how far off that estimate usually is for this KIND of combination (0.17 = 17%). "similar_guns_having" is how many of the compared similar guns already own that combination.
You get numbered CANDIDATES. Choose at most 6 of them, most worth adding first: prefer combinations that players really fit together in the game and where the estimate is likely to be off; skip odd or unrealistic ones. accessory_rules lists what this gun can physically take; the candidates already fit it, so never argue for an accessory outside that list. When user_filter is present the user has filtered the table to those accessories: the candidates already respect it, so rank and explain inside it only. When regenerate is true the user asked for a fresh opinion: reconsider the candidates independently instead of repeating the most obvious order. Use only the given indexes.
Answer with ONE JSON object only, no markdown: {"ranking": [{"i": <candidate index>, "reason": "at most 15 words in Vietnamese"}]}`;

function buildRankMessages(idx, target, candidates, { userFilter = null, regenerate = false } = {}) {
  const owned = [];
  for (const [key] of idx.map) {
    const [w, s, g, m, st, ge] = key.split('|').map(Number);
    if (w !== target.weapon || s !== target.scope || ge !== target.gesture || (!g && !m && !st)) continue;
    owned.push(`${label(R.GRIPS, g)}/${label(R.MUZZLES, m)}/${label(R.STOCKS, st)}`);
  }
  const data = {
    gun: label(R.WEAPONS, target.weapon),
    scope: label(R.SCOPES, target.scope),
    posture: label(R.POSTURES, target.gesture),
    accessory_rules: accessoryRules(target.weapon),
    ...(userFilter ? { user_filter: userFilter } : {}),
    ...(regenerate ? { regenerate: true } : {}),
    owned_combinations: owned.slice(0, 24),
    candidates: candidates.map((c, i) => ({
      i,
      accessories: { grip: label(R.GRIPS, c.grip), muzzle: label(R.MUZZLES, c.muzzle), stock: label(R.STOCKS, c.stock) },
      expected_error: c.expectedError == null ? null : Math.round(c.expectedError * 1000) / 1000,
      coefficient_multiplier: c.multiplier == null ? null : Math.round(c.multiplier * 1000) / 1000,
      similar_guns_having: c.gap ? `${c.gap.n}/${c.gap.of}` : `${c.seenIn || 0}/?`,
    })),
  };
  return [{ role: 'system', content: SYSTEM_RANK }, { role: 'user', content: `Data for the request (JSON follows):\n${JSON.stringify(data)}` }, JSON_ONLY];
}

// -> { ok:true, ranking:[{ i, reason }] } with indexes inside [0, count), no repeats, at most 8; else { ok:false, reason }
function parseRanking(content, count) {
  if (typeof content !== 'string' || !content.trim()) return { ok: false, reason: 'AI trả về câu trả lời trống.' };
  const text = content.replace(/```(?:json)?/gi, '');
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  let obj = null;
  if (a >= 0 && b > a) { try { obj = JSON.parse(text.slice(a, b + 1)); } catch { obj = null; } }
  if (!obj || !Array.isArray(obj.ranking)) return { ok: false, reason: 'Câu trả lời của AI không có danh sách "ranking".' };
  const seen = new Set();
  const ranking = [];
  for (const r of obj.ranking) {
    if (!r || !Number.isInteger(r.i) || r.i < 0 || r.i >= count || seen.has(r.i)) continue;
    seen.add(r.i);
    ranking.push({ i: r.i, reason: typeof r.reason === 'string' ? r.reason.replace(/\s+/g, ' ').trim().slice(0, 160) : '' });
    if (ranking.length >= 8) break;
  }
  return ranking.length ? { ok: true, ranking } : { ok: false, reason: 'AI không chọn được tổ hợp nào hợp lệ trong danh sách.' };
}

// ---------------------------------------------------------------- the client
// cfg: { baseUrl, apiKey, model, timeoutMs, concurrency } (loadAiConfig). providers (optional): () => [{ id, name, baseUrl, apiKey, model }] the
// endpoints to try, in order (AiProviders.usable). Without it the one endpoint of cfg is used, as before.
// A question goes to the first endpoint; when that one fails (no connection, HTTP error, timeout, empty or invalid answer) it goes to the next,
// until one gives a usable answer. The page aborting stops the chain at once.
function createAi(cfg = {}, { fetchImpl = globalThis.fetch, providers = null } = {}) {
  const single = { id: 'env', name: 'AI', baseUrl: String(cfg.baseUrl || '').replace(/\/+$/, ''), apiKey: cfg.apiKey || '', model: cfg.model || 'auto' };
  const listOf = () => (providers ? providers() : single.baseUrl && single.apiKey ? [single] : []);
  const timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
  const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(Number(cfg.concurrency)) || 1)); // asking this class directly: one at a time unless told
  const limit = { curve: concurrency, rank: 1 }; // the ranking of combinations stays one at a time
  const busy = { curve: 0, rank: 0 }; // requests out now, per kind of work (one slot for the whole chain of endpoints)

  // One chat completion to one endpoint. -> { ok:true, content, model, ms } or { ok:false, reason, aborted? }
  async function askOne(p, messages, opts = {}) {
    const clean = (s) => String(s).split(p.apiKey).join('***').split(p.baseUrl).join('…').replace(/\s+/g, ' ').slice(0, 160);
    const started = Date.now();
    const aborted = () => opts.signal && opts.signal.aborted;
    const late = () => ({ ok: false, reason: `không trả lời kịp (quá ${Math.round(timeoutMs / 1000)} giây)` });
    let res;
    try {
      res = await fetchImpl(`${p.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({ model: p.model || 'auto', temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens || 6000, messages }),
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (aborted()) return { ok: false, aborted: true, reason: 'Đã hủy yêu cầu AI.' };
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return late();
      return { ok: false, reason: 'không kết nối được (kiểm tra địa chỉ và mạng)' };
    }
    let text = '';
    try { text = await res.text(); } catch (e) {
      if (aborted()) return { ok: false, aborted: true, reason: 'Đã hủy yêu cầu AI.' };
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return late();
      return { ok: false, reason: 'kết nối bị ngắt giữa chừng' };
    }
    if (!res.ok) return { ok: false, reason: `trả lỗi HTTP ${res.status}${text ? `: ${clean(text)}` : ''}` };
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false, reason: 'nội dung trả về không đọc được (không phải JSON)' }; }
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const finish = data && data.choices && data.choices[0] && data.choices[0].finish_reason;
    return { ok: true, content, finish, model: typeof data.model === 'string' && data.model ? data.model : p.model, ms: Date.now() - started };
  }

  // The chain: endpoints in order; take(r) turns an answer into a result ({ ok:true, ... } or { ok:false, reason }) and a bad answer also
  // moves on to the next endpoint. -> the first good result + { model, ms, provider }, or { ok:false, reason, busy? } saying what each one did.
  async function ask(lane, messages, opts, take) {
    const list = listOf();
    if (!list.length) return { ok: false, reason: providers ? 'AI chưa được cấu hình (thêm nguồn AI trong "Cài đặt AI", hoặc AI_BASE_URL và AI_API_KEY trên server).' : 'AI chưa được cấu hình (cần AI_BASE_URL và AI_API_KEY trên server).' };
    if (busy[lane] >= limit[lane]) return { ok: false, busy: true, reason: 'AI đang bận với một yêu cầu khác, thử lại sau ít giây.' };
    busy[lane]++;
    const started = Date.now();
    const failures = [];
    let slowDown = false; // every endpoint asked us to slow down: the page waits and tries again
    const deadline = started + timeoutMs * 2; // the whole chain, so one question never holds its slot for endpoints x timeout
    try {
      for (const p of list) {
        if (failures.length && Date.now() > deadline) { failures.push(`${p.name}: bỏ qua (đã quá thời gian cho cả chuỗi)`); break; }
        const r = await askOne(p, messages, opts);
        if (r.aborted) return { ok: false, reason: r.reason };
        if (!r.ok) {
          if (/HTTP (429|5\d\d)/.test(r.reason)) slowDown = true;
          failures.push(`${p.name}: ${r.reason}`);
          continue;
        }
        const t = take(r);
        if (t.ok) return { ...t, model: r.model, ms: Date.now() - started, provider: p.name, tried: failures.length + 1 };
        failures.push(`${p.name}: ${t.reason}${r.finish === 'length' ? ' (câu trả lời bị cắt: model viết quá dài)' : ''}`);
      }
    } finally {
      busy[lane]--;
    }
    const head = failures.length > 1 ? `Đã thử ${failures.length} nguồn AI, không nguồn nào dùng được. ` : 'AI ';
    // a single failure keeps the wording the page knows ("AI trả lỗi HTTP 429") so its wait-and-retry still works
    const reason = failures.length === 1 ? `AI ${failures[0].slice(failures[0].indexOf(': ') + 2)}` : `${head}${failures.join(' · ')}`;
    return { ok: false, reason: slowDown && failures.length > 1 ? `${reason} (HTTP 429)` : reason };
  }

  const curveTaker = (idx, target) => (r) => {
    const parsed = parseAnswer(r.content);
    if (!parsed.ok) return parsed;
    const valid = validatePoints(parsed.points, R.computedFor(idx, target).curve, R.fireOf(target.weapon));
    return valid.ok ? { ok: true, curve: valid.curve, reasoning: parsed.reasoning } : { ok: false, reason: valid.reason };
  };

  // The points of one combination.
  async function suggest(idx, target, opts = {}) {
    return ask('curve', buildMessages(idx, target, opts), opts, curveTaker(idx, target));
  }

  // "Quét tất cả": a combination that has its own entry, reviewed. -> { ok, curve, reasoning, change } (change: see curveChange)
  async function review(idx, target, opts = {}) {
    const own = idx.map.get(S.keyOf(target.weapon, target.scope, target.grip, target.muzzle, target.stock, target.gesture));
    if (!own) return { ok: false, reason: 'Tổ hợp này chưa có mục riêng: dùng "AI tạo mốc" thay vì rà soát.' };
    const current = own[own.length - 1].recoilValue.map(([t, v]) => [Number(t), Number(v)]);
    const r = await ask('curve', buildReviewMessages(idx, target, opts), opts, (a) => {
      const parsed = parseAnswer(a.content);
      if (!parsed.ok) return parsed;
      const valid = validateReview(parsed.points, current, R.fireOf(target.weapon));
      return valid.ok ? { ok: true, curve: valid.curve, reasoning: parsed.reasoning } : { ok: false, reason: valid.reason };
    });
    return r.ok ? { ...r, current, change: curveChange(current, r.curve, { ignoreDuration: Boolean(R.fireOf(target.weapon)) }) } : r;
  }

  // Which of the candidates (suggest.comboCandidates) deserve an own entry most. The AI only orders and explains: it cannot add a combination.
  async function rankCombos(idx, target, candidates, opts = {}) {
    if (!Array.isArray(candidates) || !candidates.length) return { ok: false, reason: 'Không có tổ hợp ứng viên nào để xếp hạng.' };
    // "AI tạo lại" (regenerate) asks for a fresh opinion: a higher temperature, and the message says so
    return ask('rank', buildRankMessages(idx, target, candidates, { userFilter: opts.userFilter, regenerate: opts.regenerate }),
      { ...opts, maxTokens: 1500, temperature: opts.regenerate ? 0.7 : undefined }, (r) => parseRanking(r.content, candidates.length));
  }

  // "Thử" in the settings: one tiny question to one endpoint, outside the queue
  async function test(p, opts = {}) {
    if (!p || !p.baseUrl || !p.apiKey) return { ok: false, reason: 'Nguồn này chưa có địa chỉ hoặc khóa API.' };
    const r = await askOne(p, [{ role: 'user', content: 'Reply with the single word OK.' }], { ...opts, maxTokens: 20, temperature: 0 });
    if (!r.ok) return { ok: false, reason: `${p.name}: ${r.reason}` };
    return typeof r.content === 'string' && r.content.trim() ? { ok: true, model: r.model, ms: r.ms } : { ok: false, reason: `${p.name}: trả lời trống` };
  }

  // Query available models from endpoint (OpenAI /models or Ollama /api/tags)
  async function listModels(p, opts = {}) {
    if (!p || !p.baseUrl) return { ok: false, reason: 'Chưa có địa chỉ Base URL.' };
    const base = String(p.baseUrl).trim().replace(/\/+$/, '');
    const clean = (s) => String(s).split(p.apiKey || '').join('***').split(base).join('…').replace(/\s+/g, ' ').slice(0, 160);
    const headers = { Accept: 'application/json' };
    if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;

    const tryFetch = async (url) => {
      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers,
          signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        });
        const text = await res.text();
        return { status: res.status, ok: res.ok, text };
      } catch (e) {
        if (opts.signal && opts.signal.aborted) return { error: 'Đã hủy yêu cầu tải model.' };
        return { error: e.name === 'TimeoutError' ? 'Quá thời gian chờ phản hồi (15s)' : 'Không kết nối được tới endpoint' };
      }
    };

    let res = await tryFetch(`${base}/models`);
    if (res.error) return { ok: false, reason: res.error };

    if (res.status === 404) {
      if (!/\/v1$/i.test(base)) {
        const f1 = await tryFetch(`${base}/v1/models`);
        if (!f1.error) res = f1;
      }
      if (res.status === 404) {
        const f2 = await tryFetch(`${base}/api/tags`);
        if (!f2.error) res = f2;
      }
    }

    if (!res.ok) {
      return { ok: false, reason: `Endpoint trả lỗi HTTP ${res.status}${res.text ? `: ${clean(res.text)}` : ''}` };
    }

    let data;
    try { data = JSON.parse(res.text); } catch {
      return { ok: false, reason: 'Nội dung trả về từ endpoint không phải JSON hợp lệ.' };
    }

    let rawList = [];
    if (Array.isArray(data)) rawList = data;
    else if (Array.isArray(data.data)) rawList = data.data;
    else if (Array.isArray(data.models)) rawList = data.models;
    else {
      return { ok: false, reason: 'Dữ liệu trả về không chứa danh sách model (thiếu mảng data hoặc models).' };
    }

    const ids = [];
    for (const item of rawList) {
      const id = typeof item === 'string' ? item.trim() : (item && (item.id || item.name || item.model));
      if (typeof id === 'string' && id.trim()) ids.push(id.trim());
    }

    const unique = Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    return { ok: true, models: unique };
  }

  // the model of the first endpoint that will be asked (the page shows it); which endpoints exist is GET /ai/providers
  function status() {
    const list = listOf();
    return { enabled: list.length > 0, model: list.length ? list[0].model || 'auto' : cfg.model || 'auto', concurrency };
  }

  return { status, suggest, review, rankCombos, test, listModels };
}

module.exports = { createAi, loadAiConfig, parseAnswer, parseRanking, validatePoints, validateReview, reviewScan, buildMessages, buildRankMessages, buildReviewMessages, curveChange, MAX_POINTS, REVIEW_ANALOG };
