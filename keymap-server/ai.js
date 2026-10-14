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
Answer with ONE JSON object only, no markdown: {"points": [[time_ms, value], ...], "reasoning": "at most 3 sentences in Vietnamese: which evidence you used and the main change against the coefficient estimate"}`;

const label = (list, i) => list[i] || String(i);

// What a gun can take (RecoilLib.attachmentsFor, from the official table): sent with every question so the model never relies on or proposes an accessory
// the gun cannot carry. A gun the table does not cover gets an explicit "no rule" note instead of a guess.
function accessoryRules(weapon) {
  const a = R.attachmentsFor(weapon);
  if (!a) return { known: false, note: 'No accessory rule is known for this gun: do not assume any restriction.' };
  const names = (set, list) => [...set].map((i) => list[i]);
  return { known: true, source: a.sourceLabel, grips: names(a.grips, R.GRIPS), muzzles: names(a.muzzles, R.MUZZLES), stocks: names(a.stocks, R.STOCKS), max_scope_zoom: a.maxZoom, note: 'Anything not listed cannot be fitted on this gun.' };
}

// idx: RecoilLib.indexData(groups); target: { weapon, scope, gesture, grip, muzzle, stock } (enum indexes)
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
  ];
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
function validatePoints(points, computed) {
  const checked = R.checkCurve(points);
  if (!checked.ok) return { ok: false, reason: checked.error };
  if (points.length > MAX_POINTS) return { ok: false, reason: `AI trả quá nhiều mốc (${points.length}; tối đa ${MAX_POINTS}).` };
  for (let i = 1; i < points.length; i++) if (points[i][0] <= points[i - 1][0]) return { ok: false, reason: `Thời gian phải tăng dần (mốc #${i + 1}).` };
  const durC = S.duration(computed);
  const hasRef = durC > 0 && computed.some(([, v]) => Math.abs(v) > 1e-6);
  if (hasRef) {
    const dur = S.duration(points);
    if (dur / durC < 0.25 || dur / durC > 4) return { ok: false, reason: `Thời lượng AI đưa ra (${Math.round(dur)} ms) lệch quá xa đường cong theo hệ số (${Math.round(durC)} ms).` };
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
  return [{ role: 'system', content: SYSTEM_RANK }, { role: 'user', content: `Data for the request (JSON follows):\n${JSON.stringify(data)}` }];
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
function createAi(cfg = {}, { fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const enabled = Boolean(baseUrl && cfg.apiKey);
  const model = cfg.model || 'auto';
  const timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
  const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(Number(cfg.concurrency)) || 1)); // asking this class directly: one at a time unless told
  const limit = { curve: concurrency, rank: 1 }; // the ranking of combinations stays one at a time
  const busy = { curve: 0, rank: 0 }; // requests out now, per kind of work
  const clean = (s) => String(s).split(cfg.apiKey).join('***').replace(/\s+/g, ' ').slice(0, 160);

  // One chat completion. -> { ok:true, content, model, ms } or { ok:false, reason, busy? }. opts.signal: aborted when the page gives up.
  async function ask(lane, messages, opts = {}) {
    if (!enabled) return { ok: false, reason: 'AI chưa được cấu hình (cần AI_BASE_URL và AI_API_KEY trên server).' };
    if (busy[lane] >= limit[lane]) return { ok: false, busy: true, reason: 'AI đang bận với một yêu cầu khác, thử lại sau ít giây.' };
    busy[lane]++;
    const started = Date.now();
    const aborted = () => opts.signal && opts.signal.aborted;
    const late = () => ({ ok: false, reason: `AI không trả lời kịp (quá ${Math.round(timeoutMs / 1000)} giây).` });
    try {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({ model, temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens || 3000, messages }),
          signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (aborted()) return { ok: false, reason: 'Đã hủy yêu cầu AI.' };
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return late();
        return { ok: false, reason: 'Không kết nối được tới AI (kiểm tra AI_BASE_URL và mạng).' };
      }
      let text = '';
      try { text = await res.text(); } catch (e) {
        if (aborted()) return { ok: false, reason: 'Đã hủy yêu cầu AI.' };
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return late();
        return { ok: false, reason: 'Kết nối tới AI bị ngắt giữa chừng.' };
      }
      if (!res.ok) return { ok: false, reason: `AI trả lỗi HTTP ${res.status}${text ? `: ${clean(text)}` : ''}` };
      let data;
      try { data = JSON.parse(text); } catch { return { ok: false, reason: 'Nội dung AI trả về không đọc được (không phải JSON).' }; }
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return { ok: true, content, model: typeof data.model === 'string' && data.model ? data.model : model, ms: Date.now() - started };
    } finally {
      busy[lane]--;
    }
  }

  // The points of one combination.
  async function suggest(idx, target, opts = {}) {
    const r = await ask('curve', buildMessages(idx, target, opts), opts);
    if (!r.ok) return r;
    const parsed = parseAnswer(r.content);
    if (!parsed.ok) return parsed;
    const valid = validatePoints(parsed.points, R.computedFor(idx, target).curve);
    if (!valid.ok) return { ok: false, reason: valid.reason };
    return { ok: true, curve: valid.curve, reasoning: parsed.reasoning, model: r.model, ms: r.ms };
  }

  // Which of the candidates (suggest.comboCandidates) deserve an own entry most. The AI only orders and explains: it cannot add a combination.
  async function rankCombos(idx, target, candidates, opts = {}) {
    if (!Array.isArray(candidates) || !candidates.length) return { ok: false, reason: 'Không có tổ hợp ứng viên nào để xếp hạng.' };
    // "AI tạo lại" (regenerate) asks for a fresh opinion: a higher temperature, and the message says so
    const r = await ask('rank', buildRankMessages(idx, target, candidates, { userFilter: opts.userFilter, regenerate: opts.regenerate }), { ...opts, maxTokens: 1500, temperature: opts.regenerate ? 0.7 : undefined });
    if (!r.ok) return r;
    const parsed = parseRanking(r.content, candidates.length);
    return parsed.ok ? { ok: true, ranking: parsed.ranking, model: r.model, ms: r.ms } : parsed;
  }

  return { status: () => ({ enabled, model, concurrency }), suggest, rankCombos };
}

module.exports = { createAi, loadAiConfig, parseAnswer, parseRanking, validatePoints, buildMessages, buildRankMessages, MAX_POINTS };
