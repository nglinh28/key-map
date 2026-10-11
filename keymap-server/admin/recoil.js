'use strict';
// Logic for the recoil analysis tab. Works in the browser (window.RecoilLib) and in Node (tests).
//
// It mirrors how the app (com.zjx.jyandroid.Extensions.pubg.C8727g + ModeRecoilProfiles) turns the stored
// "recoil_data" into the curve it uses for one (weapon, scope, grip, muzzle, stock, posture) combination:
//   1. which dataset is loaded depends on the gyro mode (touch -> normal_touch_recoil_data, gyro -> gyro_recoil_data);
//   2. groups are indexed by weapon (the order of enum C8712c.l); entries are keyed by
//      (scope, grip, muzzle, stock, gesture) and, when a key repeats, the LAST entry wins (HashMap.put);
//   3. without an exact entry the curve is the bare standing curve of that weapon+scope times the product of
//      the muzzle / grip / stock / posture coefficients (times untouched). No bare curve -> all zeros;
//   4. weapon "Empty" and "MORTAR" always use a zero curve.
// Parts of the app code are garbled by the decompiler (coefficient branches for THUMB/LASER and posture);
// the factors below follow the evident intent, and results of that kind are flagged as inferred.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecoilLib = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  // Generated from C8712c.java (enums l, g, c, d, h, b); a test keeps them in sync.
  const WEAPONS = ['Empty', 'AWM', 'CrossBow', 'M24', 'Mosin', 'Kar98K', 'MG3', 'DP28', 'MK14', 'SKS', 'SLR', 'Groza', 'MK47', 'M762', 'AKM', 'MK12', 'M249', 'QBU', 'AUG', 'G36C', 'QBZ', 'PKM', 'M416', 'Scar', 'M16', 'ASM', 'DBS', 'S12K', 'M1014', 'S1897', 'S686', 'VSS', 'Vector', 'MP5K', 'Bison', 'UZI', 'P90', 'Win94', 'Thomson', 'UMP45', 'AMR', 'ACVAL', 'Mini14', 'Bow', 'SPAS12', 'M417', 'HB', 'TacticsBow', 'MK20H', 'M200', 'SHIELD', 'AA12G', 'FAMAS', 'AKS', 'FireCompositeBow', 'SVD', 'MG36', 'MORTAR', 'ACE32', 'JS9', 'M1', 'ARX', 'ABAKAN', 'M338', 'MP7', 'AS50', 'MG97', 'ChiXiao'];
  const SCOPES = ['hippie', 'X1', 'X2', 'X3', 'X4', 'X6', 'X8', 'X63', 'X84', 'tactic', 'tactic_84', 'LPVO', 'LPVO_61'];
  const GRIPS = ['None', 'VERTICAL', 'HORIZONTAL', 'HALF', 'LIGHT', 'THUMB', 'LASER', 'ERGONOMIC'];
  const MUZZLES = ['None', 'COMPENSATOR', 'FLASH_HIDER', 'SUPPRESSOR', 'BRAKE', 'EXTENDER', 'BRAKE_NEW'];
  const STOCKS = ['None', 'GENERAL', 'GENERAL_NEW'];
  const POSTURES = ['STAND', 'CROUCH', 'PRONE'];

  // Vietnamese display names, same order as the enums above. The raw enum name stays available for tooltips.
  // Names marked (*) are not in the glossary the user supplied and were inferred from the enum / app code.
  const LABELS = {
    SCOPES: ['Bắn hông (không ngắm)', '1x (Red Dot, Holo)', '2x', '3x', '4x', '6x', '8x',
      '3–6x (đang ở 6x)', '4–8x (đang ở 8x)', 'Chiến thuật 8x', 'Chiến thuật 4–8x', 'LPVO', 'LPVO 1–6x'], // X63, X84, tactic, tactic_84, LPVO, LPVO_61 (*)
    GRIPS: ['Không', 'Tay cầm đứng', 'Tay cầm tam giác', 'Tay cầm Half', 'Tay cầm nhẹ', 'Tay cầm ngón cái', 'Tay cầm laser', 'Tay cầm công thái học'], // HORIZONTAL, LASER, ERGONOMIC (*)
    MUZZLES: ['Không', 'Nòng hãm giật', 'Nòng ẩn tia lửa', 'Nòng giảm thanh', 'Nòng hãm giật kiểu Brake', 'Nòng nối dài', 'Nòng Brake (bản mới)'], // BRAKE, EXTENDER, BRAKE_NEW (*)
    STOCKS: ['Không', 'Báng súng (Tactical Stock)', 'Báng súng (bản mới)'], // GENERAL, GENERAL_NEW (*)
    POSTURES: ['Đứng', 'Ngồi', 'Nằm'],
  };
  // Gun names are proper nouns and stay as they are; only the odd entries are translated.
  const WEAPON_VI = { Empty: '(Không súng)', CrossBow: 'Nỏ', Bow: 'Cung', TacticsBow: 'Cung chiến thuật', SHIELD: 'Khiên', MORTAR: 'Cối' };
  const COEF_LABELS = {
    compensatorMuzzle: 'Nòng hãm giật', flashHidderMuzzle: 'Nòng ẩn tia lửa', suppressorMuzzle: 'Nòng giảm thanh',
    verticalGrip: 'Tay cầm đứng', horizontalGrip: 'Tay cầm tam giác', halfGrip: 'Tay cầm Half', lightGrip: 'Tay cầm nhẹ',
    thumbGrip: 'Tay cầm ngón cái', laserGrip: 'Tay cầm laser', generalStock: 'Báng súng',
    stand: 'Tư thế đứng', crouch: 'Tư thế ngồi', prone: 'Tư thế nằm',
  };
  const weaponLabel = (i) => (i >= WEAPONS.length ? `(nhóm ${i})` : WEAPON_VI[WEAPONS[i]] || WEAPONS[i]);
  const coefLabel = (key) => COEF_LABELS[key] || key;

  // coefficient name per option; options absent here (None, BRAKE, EXTENDER, ERGONOMIC, GENERAL_NEW) mean factor 1
  const MUZZLE_COEF = { COMPENSATOR: 'compensatorMuzzle', FLASH_HIDER: 'flashHidderMuzzle', SUPPRESSOR: 'suppressorMuzzle' };
  const GRIP_COEF = { VERTICAL: 'verticalGrip', HORIZONTAL: 'horizontalGrip', HALF: 'halfGrip', LIGHT: 'lightGrip', THUMB: 'thumbGrip', LASER: 'laserGrip' };
  const STOCK_COEF = { GENERAL: 'generalStock' };
  const POSTURE_COEF = { CROUCH: 'crouch', PRONE: 'prone' };
  const ZERO_WEAPONS = new Set([WEAPONS.indexOf('Empty'), WEAPONS.indexOf('MORTAR')]);

  const keyOf = (w, s, g, m, st, ge) => `${w}|${s}|${g}|${m}|${st}|${ge}`;
  const zeroCurve = () => [[0, 0]];

  // map: key -> every entry with that key, in file order (the app keeps the last one)
  function indexData(groups) {
    const map = new Map();
    groups.forEach((group, w) => {
      for (const e of (group && group.v) || []) {
        const k = keyOf(w, e.scope, e.grip, e.muzzle, e.stock, e.gesture);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(e);
      }
    });
    return { groups, map };
  }

  function coefficientsFor(idx, weapon, scope) {
    const list = idx.groups[weapon] && idx.groups[weapon].coefficients;
    if (!Array.isArray(list) || !list.length) return null;
    return list[scope] || list[0]; // the app appends a copy of list[0] when the scope index is beyond the list
  }

  function factors(coef, { grip, muzzle, stock, gesture }) {
    const parts = [];
    const add = (label, name) => {
      if (!name) return;
      const value = coef && typeof coef[name] === 'number' ? coef[name] : 1;
      parts.push({ label, key: name, value });
    };
    add(`Nòng: ${LABELS.MUZZLES[muzzle]}`, MUZZLE_COEF[MUZZLES[muzzle]]);
    add(`Tay cầm: ${LABELS.GRIPS[grip]}`, GRIP_COEF[GRIPS[grip]]);
    add(`Báng: ${LABELS.STOCKS[stock]}`, STOCK_COEF[STOCKS[stock]]);
    add(`Tư thế: ${LABELS.POSTURES[gesture]}`, POSTURE_COEF[POSTURES[gesture]]);
    return { parts, total: parts.reduce((m, p) => m * p.value, 1) };
  }

  const scale = (curve, m) => curve.map(([t, v]) => [t, v * m]);

  // opts: { weapon, scope, grip, muzzle, stock, gesture } as enum indexes
  function resolve(idx, o) {
    const { weapon, scope, grip, muzzle, stock, gesture } = o;
    if (ZERO_WEAPONS.has(weapon)) {
      return { source: 'zero', curve: zeroCurve(), multiplier: null, parts: [], copies: 0, distinct: 0, baseMissing: false, notes: ['Súng này luôn dùng đường cong 0 trong app.'] };
    }
    const copies = idx.map.get(keyOf(weapon, scope, grip, muzzle, stock, gesture));
    if (copies) {
      const last = copies[copies.length - 1];
      return {
        source: 'exact', curve: last.recoilValue, multiplier: null, parts: [], copies: copies.length,
        distinct: new Set(copies.map((e) => JSON.stringify(e.recoilValue))).size, baseMissing: false, notes: [],
      };
    }
    const base = idx.map.get(keyOf(weapon, scope, 0, 0, 0, 0));
    const baseCurve = base ? base[base.length - 1].recoilValue : null;
    const f = factors(coefficientsFor(idx, weapon, scope), o);
    const notes = ['Hệ số ghép theo ý định của code (JADX làm rối nhánh tay cầm ngón cái/laser và tư thế): suy ra.'];
    if (!baseCurve) notes.push('Không có đường cong nền (không phụ kiện, đứng) cho súng + scope này: app dùng 0.');
    return {
      source: 'computed', curve: baseCurve ? scale(baseCurve, f.total) : zeroCurve(), multiplier: f.total, parts: f.parts,
      copies: 0, distinct: 0, baseMissing: !baseCurve, notes,
    };
  }

  function curveStats(curve) {
    const vs = curve.map((p) => p[1]);
    return { v0: vs[0], vEnd: vs[vs.length - 1], min: Math.min(...vs), max: Math.max(...vs), duration: curve[curve.length - 1][0], points: curve.length };
  }

  // mode: 'touch' | 'gyro' | 'raw'. Returns { key, data } or null when the document has no recoil data.
  function pickDataset(doc, mode) {
    if (!doc || !Array.isArray(doc.recoil_data)) return null;
    const block = doc.ft_recoil_mode_profiles;
    if (mode !== 'raw' && block && typeof block === 'object') {
      const key = mode === 'gyro' ? 'gyro_recoil_data' : 'normal_touch_recoil_data';
      if (Array.isArray(block[key])) return { key, data: block[key] };
    }
    return { key: 'recoil_data', data: doc.recoil_data };
  }

  // How much data a weapon has: entries total, per posture and per scope (distinct keys, not copies).
  function weaponSummary(idx, weapon) {
    const byGesture = [0, 0, 0];
    const byScope = SCOPES.map(() => 0);
    let keys = 0;
    let entries = 0;
    for (const [k, list] of idx.map) {
      const [w, s, , , , ge] = k.split('|').map(Number);
      if (w !== weapon) continue;
      keys++;
      entries += list.length;
      byGesture[ge] = (byGesture[ge] || 0) + 1;
      byScope[s] = (byScope[s] || 0) + 1;
    }
    return { keys, entries, byGesture, byScope };
  }

  // Combos that have their own entry for (weapon, scope, gesture), sorted by grip, muzzle, stock.
  function exactCombos(idx, weapon, scope, gesture) {
    const out = [];
    for (const k of idx.map.keys()) {
      const [w, s, g, m, st, ge] = k.split('|').map(Number);
      if (w === weapon && s === scope && ge === gesture) out.push({ grip: g, muzzle: m, stock: st });
    }
    return out.sort((a, b) => a.grip - b.grip || a.muzzle - b.muzzle || a.stock - b.stock);
  }

  return { WEAPONS, SCOPES, GRIPS, MUZZLES, STOCKS, POSTURES, LABELS, COEF_LABELS, weaponLabel, coefLabel, indexData, resolve, curveStats, pickDataset, weaponSummary, exactCombos, coefficientsFor };
});
