'use strict';
// The "server" half of the points suggestion for a recoil combination that has no entry of its own (the AI is the other half, ai.js).
//
// Idea: the app computes such a combination as  base curve x coefficients  (RecoilLib.computedFor). The real entries of OTHER guns show how
// much real data deviates from that estimate for this very combination (accessories, posture, scope). So:
//   1. pick the guns whose base curve (same scope, standing, no accessories) is closest to this gun's, and that have an own entry for the combination;
//   2. for each, the correction is  (its own entry) / (its coefficient curve), compared on a time axis normalised by duration;
//   3. the candidate is this gun's coefficient curve times the weighted mean correction, with the time axis stretched by the mean duration ratio.
// Pure functions over RecoilLib.indexData(groups); no I/O.

const R = require('./admin/recoil');

const SAMPLES = 8;
const EPS = 1e-6;
const keyOf = (w, s, g, m, st, ge) => `${w}|${s}|${g}|${m}|${st}|${ge}`; // same layout as RecoilLib's index
const round4 = (x) => Math.round(x * 10000) / 10000;
const duration = (curve) => (curve.length ? curve[curve.length - 1][0] : 0);
const lastCurve = (list) => (list && list.length ? list[list.length - 1].recoilValue : null);

// value of a curve at time t: linear between points, flat before the first and after the last
function interp(curve, t) {
  if (!curve.length) return 0;
  if (t <= curve[0][0]) return curve[0][1];
  const last = curve[curve.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i][0]) {
      const [t0, v0] = curve[i - 1];
      const [t1, v1] = curve[i];
      return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return last[1];
}

// How different two base curves are: mean |ln value ratio| at equally spaced fractions of their durations, plus half the |ln duration ratio|.
function distance(a, b) {
  const da = Math.max(duration(a), 1);
  const db = Math.max(duration(b), 1);
  let sum = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const u = i / (SAMPLES - 1);
    sum += Math.abs(Math.log((Math.abs(interp(a, u * da)) + EPS) / (Math.abs(interp(b, u * db)) + EPS)));
  }
  return sum / SAMPLES + 0.5 * Math.abs(Math.log(da / db));
}

// 1/(distance + 0.05), normalised to add up to 1: the nearer the gun, the more it counts
function weigh(list) {
  const raw = list.map((s) => 1 / (s.distance + 0.05));
  const total = raw.reduce((n, x) => n + x, 0) || 1;
  return list.map((s, i) => ({ ...s, weight: raw[i] / total }));
}

// Every other gun (not zero ones) that has a base curve at the target's scope, nearest base first. null when the target has none itself.
function rankedByBase(idx, target) {
  const tBase = lastCurve(idx.map.get(keyOf(target.weapon, target.scope, 0, 0, 0, 0)));
  if (!tBase) return null;
  const found = [];
  for (let w = 0; w < idx.groups.length; w++) {
    if (w === target.weapon || R.isZeroWeapon(w)) continue;
    const base = lastCurve(idx.map.get(keyOf(w, target.scope, 0, 0, 0, 0)));
    if (base) found.push({ weapon: w, name: R.WEAPONS[w] || `nhóm ${w}`, distance: distance(tBase, base), base });
  }
  found.sort((x, y) => x.distance - y.distance || x.weapon - y.weapon);
  return found;
}

// target: { weapon, scope, gesture, grip, muzzle, stock }. Guns that have a base curve and an own entry for the target combination, nearest first.
function similarGuns(idx, target, { limit = 5 } = {}) {
  const ranked = rankedByBase(idx, target) || [];
  const withCombo = [];
  for (const s of ranked) {
    const combo = lastCurve(idx.map.get(keyOf(s.weapon, target.scope, target.grip, target.muzzle, target.stock, target.gesture)));
    if (combo) withCombo.push({ ...s, combo });
  }
  return weigh(withCombo.slice(0, Math.max(1, limit)));
}

// the nearest guns by base curve alone (used to see what combinations exist around this gun)
function similarByBase(idx, target, { limit = 5 } = {}) {
  const ranked = rankedByBase(idx, target);
  return ranked ? weigh(ranked.slice(0, Math.max(1, limit))) : [];
}

// Combinations worth ADDING for target { weapon, scope, gesture }: those that the nearest guns have an own entry for (same scope and posture)
// and this gun has not. support = share of the compared guns (weighted by closeness) that have it; n of `of` guns.
// -> { ok:true, candidates:[{ grip, muzzle, stock, n, of, support, names }], similar } or { ok:false, reason, candidates:[] }
function comboGaps(idx, target, { similar = 8, minSupport = 2, limit = 10, allowed } = {}) {
  const fits = allowed || rulesAllowed(target);
  if (R.isZeroWeapon(target.weapon)) return { ok: false, reason: 'Súng này luôn dùng đường cong 0 trong app: không có tổ hợp nào để thêm.', candidates: [] };
  if (!idx.map.get(keyOf(target.weapon, target.scope, 0, 0, 0, 0))) return { ok: false, reason: 'Súng này chưa có đường cong nền (không phụ kiện, đứng) ở ống ngắm này, nên chưa có gì để so sánh.', candidates: [] };
  const sims = similarByBase(idx, target, { limit: similar });
  if (!sims.length) return { ok: false, reason: 'Không có súng nào để so sánh với súng này.', candidates: [] };
  const bySim = new Map(sims.map((s) => [s.weapon, s]));
  const found = new Map(); // "g|m|st" -> { grip, muzzle, stock, support, names: [] } (sims are visited nearest first through the map below)
  const owned = new Set();
  for (const key of idx.map.keys()) {
    const [w, s, g, m, st, ge] = key.split('|').map(Number);
    if (s !== target.scope || ge !== target.gesture || (!g && !m && !st)) continue;
    if (w === target.weapon) { owned.add(`${g}|${m}|${st}`); continue; }
    const sim = bySim.get(w);
    if (!sim) continue;
    const k = `${g}|${m}|${st}`;
    if (!found.has(k)) found.set(k, { grip: g, muzzle: m, stock: st, support: 0, hits: [] });
    const f = found.get(k);
    f.support += sim.weight;
    f.hits.push(sim);
  }
  const need = Math.min(minSupport, sims.length);
  const candidates = [...found.entries()]
    .filter(([k, f]) => !owned.has(k) && f.hits.length >= need && fits({ grip: f.grip, muzzle: f.muzzle, stock: f.stock }))
    .map(([, f]) => ({
      grip: f.grip, muzzle: f.muzzle, stock: f.stock, n: f.hits.length, of: sims.length, support: Math.min(1, f.support),
      names: f.hits.sort((x, y) => x.distance - y.distance).slice(0, 5).map((h) => h.name),
    }))
    .sort((x, y) => y.support - x.support || ((x.grip ? 1 : 0) + (x.muzzle ? 1 : 0) + (x.stock ? 1 : 0)) - ((y.grip ? 1 : 0) + (y.muzzle ? 1 : 0) + (y.stock ? 1 : 0))
      || x.grip - y.grip || x.muzzle - y.muzzle || x.stock - y.stock)
    .slice(0, limit);
  return { ok: true, candidates, similar: sims.map(({ weapon, name, distance: d, weight }) => ({ weapon, name, distance: d, weight })) };
}

// Accessories the gun does not take (RecoilLib.comboProblems, from the accessory table) are never suggested. allowed({ grip, muzzle, stock }) can replace the rule.
const rulesAllowed = (target) => (c) => R.comboProblems(target.weapon, target.scope, c).length === 0;

// ---------------------------------------------------------------- where an own entry would help most
// Kind of a combination: posture + which of grip / muzzle / stock are fitted ("0|110" = standing, grip and muzzle).
const kindOf = (g, m, st, ge) => `${ge}|${g ? 1 : 0}${m ? 1 : 0}${st ? 1 : 0}`;

// mean |prediction / truth - 1| over equally spaced fractions of the duration
function curveError(pred, truth) {
  const dp = Math.max(duration(pred), 1);
  const dt = Math.max(duration(truth), 1);
  let sum = 0;
  const N = 12;
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    const t = interp(truth, u * dt);
    sum += Math.abs(interp(pred, u * dp) - t) / (Math.abs(t) + 1e-6);
  }
  return sum / N;
}

// How wrong is the coefficient curve for each kind of combination? Measured on every own entry of every gun (the base curves are not
// combinations). -> Map kind -> { n, mean }. Where the mean is high, an own entry of that kind is worth having.
function kindErrors(idx) {
  const acc = new Map();
  for (const [key, list] of idx.map) {
    const [w, s, g, m, st, ge] = key.split('|').map(Number);
    if (R.isZeroWeapon(w) || (!g && !m && !st && !ge)) continue;
    const comp = R.computedFor(idx, { weapon: w, scope: s, gesture: ge, grip: g, muzzle: m, stock: st });
    if (comp.baseMissing) continue;
    const e = curveError(comp.curve, list[list.length - 1].recoilValue);
    const k = kindOf(g, m, st, ge);
    const a = acc.get(k) || { n: 0, sum: 0 };
    a.n++; a.sum += e;
    acc.set(k, a);
  }
  return new Map([...acc].map(([k, a]) => [k, { n: a.n, mean: a.sum / a.n }]));
}

// Combinations worth adding for target { weapon, scope, gesture } (each one not yet an own entry of this gun):
//   gap    = the nearest guns have an own entry for it (comboGaps), best supported first;
//   impact = no similar gun has it, but the coefficient curve is usually wrong for this KIND of combination (kindErrors >= minError).
// -> { ok:true, candidates:[{ grip, muzzle, stock, kind, expectedError, multiplier, stats, gap:{n,of,support,names}|null }], missing, similar, total } or { ok:false, reason }
//    missing = EVERY combination the gun can take (its attachment rules, and the table filter) that has no own entry yet, best first: the
//    candidates are only the best few of them (the ones worth looking at first); total = missing.length.
function comboCandidates(idx, target, { limit = 8, minError = 0.06, minKindSamples = 30, perKind = 3, allowed, constraints = null } = {}) {
  // constraints: { grips, muzzles, stocks } = the enum indexes the user's table filter lets through (a missing slot = any). They narrow the candidates
  // BEFORE the best ones are chosen, so a filter gets a full list of its own best candidates, not what is left of the overall best.
  const rules = allowed || rulesAllowed(target);
  const lim = constraints ? { grip: constraints.grips ? new Set(constraints.grips) : null, muzzle: constraints.muzzles ? new Set(constraints.muzzles) : null, stock: constraints.stocks ? new Set(constraints.stocks) : null } : {};
  const fits = (c) => rules(c) && (!lim.grip || lim.grip.has(c.grip)) && (!lim.muzzle || lim.muzzle.has(c.muzzle)) && (!lim.stock || lim.stock.has(c.stock));
  const gaps = comboGaps(idx, target, { minSupport: 2, allowed: fits });
  if (!gaps.ok) return gaps;
  const kinds = kindErrors(idx);
  const gapOf = new Map(gaps.candidates.map((c) => [`${c.grip}|${c.muzzle}|${c.stock}`, c]));
  const owned = new Set();
  const seenIn = new Map(); // combination -> how many of the compared guns own it (also when fewer than a gap needs)
  const pop = { grip: new Map(), muzzle: new Map(), stock: new Map() }; // how often each option is fitted in owned entries around this gun
  const around = new Set([target.weapon, ...gaps.similar.map((s) => s.weapon)]);
  for (const key of idx.map.keys()) {
    const [w, s, g, m, st, ge] = key.split('|').map(Number);
    if (s !== target.scope || !around.has(w)) continue;
    if (w === target.weapon && ge === target.gesture) owned.add(`${g}|${m}|${st}`);
    else if (ge === target.gesture && (g || m || st)) seenIn.set(`${g}|${m}|${st}`, (seenIn.get(`${g}|${m}|${st}`) || 0) + 1);
    for (const [slot, v] of [['grip', g], ['muzzle', m], ['stock', st]]) if (v) pop[slot].set(v, (pop[slot].get(v) || 0) + 1);
  }
  const out = [];
  let total = 0;
  for (let g = 0; g < R.GRIPS.length; g++) {
    for (let m = 0; m < R.MUZZLES.length; m++) {
      for (let st = 0; st < R.STOCKS.length; st++) {
        if (!g && !m && !st && target.gesture === 0) continue; // the base curve
        const k = `${g}|${m}|${st}`;
        if (owned.has(k) || !fits({ grip: g, muzzle: m, stock: st })) continue;
        total++;
        const gap = gapOf.get(k) || null;
        const ke = kinds.get(kindOf(g, m, st, target.gesture));
        const expected = ke && ke.n >= minKindSamples ? ke.mean : null;
        const strong = Boolean(gap) || (expected != null && expected >= minError); // worth looking at first; the others are still missing combinations
        const popularity = (pop.grip.get(g) || 0) + (pop.muzzle.get(m) || 0) + (pop.stock.get(st) || 0);
        const seen = seenIn.get(k) || 0;
        const score = (gap ? 1000 + gap.support * 100 : 0) + (expected || 0) * 100 + seen * 0.5 + popularity * 0.001;
        const comp = R.computedFor(idx, { ...target, grip: g, muzzle: m, stock: st });
        out.push({ score, strong, c: { grip: g, muzzle: m, stock: st, kind: kindOf(g, m, st, target.gesture), expectedError: expected, seenIn: seen, multiplier: comp.multiplier, stats: R.curveStats(comp.curve), gap: gap ? { n: gap.n, of: gap.of, support: gap.support, names: gap.names } : null } });
      }
    }
  }
  out.sort((x, y) => y.score - x.score || x.c.grip - y.c.grip || x.c.muzzle - y.c.muzzle || x.c.stock - y.c.stock);
  // not all of one kind: at most `perKind` impact candidates per kind (gap candidates are not capped)
  const taken = new Map();
  const picked = [];
  for (const x of out) {
    if (picked.length >= limit) break;
    if (!x.strong) continue;
    if (!x.c.gap) {
      const n = taken.get(x.c.kind) || 0;
      if (n >= perKind) continue;
      taken.set(x.c.kind, n + 1);
    }
    picked.push(x.c);
  }
  return { ok: true, candidates: picked, missing: out.map((x) => x.c), similar: gaps.similar, total };
}

const ratio = (a, b) => (Math.abs(b) < 1e-9 ? 1 : a / b);

// -> { ok:true, curve, computed, factor:{min,max,mean}, stretch, similar:[{weapon,name,distance,weight}], method:'analog' }
//    or { ok:false, reason, computed } when there is nothing to learn from (the coefficient curve is still returned)
function analogCurve(idx, target, opts = {}) {
  if (R.isZeroWeapon(target.weapon)) return { ok: false, reason: 'Súng này luôn dùng đường cong 0 trong app: không có gì để tính.', computed: [[0, 0]] };
  const comp = R.computedFor(idx, target);
  const computed = comp.curve;
  if (comp.baseMissing) return { ok: false, reason: 'Súng này chưa có đường cong nền (không phụ kiện, đứng) ở ống ngắm này, nên không có gì để hiệu chỉnh.', computed };
  const sims = similarGuns(idx, target, opts);
  if (!sims.length) return { ok: false, reason: 'Không có súng tương tự nào có mục riêng cho đúng tổ hợp này.', computed };

  const durT = duration(computed);
  const pieces = sims.map((s) => {
    const own = R.computedFor(idx, { ...target, weapon: s.weapon }).curve;
    const durE = duration(s.combo);
    const durC = duration(own);
    return { w: s.weight, own, e: s.combo, durE, durC, rho: durC > 0 ? durE / durC : 1 };
  });
  const stretch = pieces.reduce((n, p) => n + p.w * p.rho, 0);
  const factors = computed.map(([t]) => {
    const u = durT > 0 ? t / durT : 0;
    return pieces.reduce((n, p) => n + p.w * ratio(interp(p.e, u * p.durE), interp(p.own, u * p.durC)), 0);
  });

  const curve = [];
  computed.forEach(([t, v], i) => {
    let nt = Math.round(t * stretch);
    if (i > 0 && nt <= curve[i - 1][0]) nt = curve[i - 1][0] + 1; // time must keep increasing
    curve.push([nt, round4(v * factors[i])]);
  });
  return {
    ok: true, curve, computed,
    factor: { min: Math.min(...factors), max: Math.max(...factors), mean: factors.reduce((n, x) => n + x, 0) / factors.length },
    stretch,
    similar: sims.map(({ weapon, name, distance: d, weight }) => ({ weapon, name, distance: d, weight })),
    method: 'analog',
  };
}

module.exports = { interp, distance, similarGuns, similarByBase, comboGaps, kindErrors, comboCandidates, analogCurve, keyOf, duration };
