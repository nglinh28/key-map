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

  // Weapon classification categories (Assault Rifles, Snipers, DMRs, SMGs, LMGs, Shotguns, Others)
  const GUN_CLASS_MAP = {
    // Súng trường tấn công (AR)
    AKM: 'ar', M16: 'ar', M416: 'ar', Scar: 'ar', Groza: 'ar', AUG: 'ar', QBZ: 'ar', M762: 'ar',
    MK47: 'ar', G36C: 'ar', ASM: 'ar', ACVAL: 'ar', HB: 'ar', FAMAS: 'ar', ACE32: 'ar', ARX: 'ar', ABAKAN: 'ar',

    // Súng bắn tỉa (SR)
    AWM: 'sr', Kar98K: 'sr', M24: 'sr', Mosin: 'sr', Win94: 'sr', AMR: 'sr', M200: 'sr', M338: 'sr', AS50: 'sr', M1: 'sr',

    // Súng trường thiện xạ (DMR)
    MK14: 'dmr', SKS: 'dmr', SLR: 'dmr', QBU: 'dmr', MK12: 'dmr', VSS: 'dmr', Mini14: 'dmr', M417: 'dmr', MK20H: 'dmr', SVD: 'dmr',

    // Súng tiểu liên (SMG)
    UZI: 'smg', Thomson: 'smg', UMP45: 'smg', Vector: 'smg', Bison: 'smg', MP5K: 'smg', P90: 'smg', AKS: 'smg', JS9: 'smg', MP7: 'smg',

    // Súng máy (LMG)
    M249: 'lmg', DP28: 'lmg', MG3: 'lmg', PKM: 'lmg', MG36: 'lmg', MG97: 'lmg',

    // Shotgun (SG)
    S12K: 'sg', S1897: 'sg', S686: 'sg', DBS: 'sg', M1014: 'sg', SPAS12: 'sg', AA12G: 'sg',

    // Khác
    CrossBow: 'other', Bow: 'other', TacticsBow: 'other', FireCompositeBow: 'other', SHIELD: 'other', MORTAR: 'other', ChiXiao: 'other', Empty: 'other',
  };

  const GUN_CLASSES = [
    { id: 'ar', name: 'Súng trường tấn công (AR)' },
    { id: 'sr', name: 'Súng bắn tỉa (SR)' },
    { id: 'dmr', name: 'Súng trường thiện xạ (DMR)' },
    { id: 'smg', name: 'Súng tiểu liên (SMG)' },
    { id: 'lmg', name: 'Súng máy (LMG)' },
    { id: 'sg', name: 'Súng Shotgun' },
    { id: 'other', name: 'Vũ khí khác' },
  ];

  const gunClass = (weapon) => {
    const code = typeof weapon === 'number' ? WEAPONS[weapon] : typeof weapon === 'string' ? weapon : null;
    return (code && GUN_CLASS_MAP[code]) || 'other';
  };

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
    return { source: 'computed', ...computedFor(idx, o), copies: 0, distinct: 0 };
  }

  // What the app computes WITHOUT an own entry: the bare standing curve of the gun + scope times the coefficients of the accessories
  // and the posture. Ignores an own entry of this combination, so it is also the reference to compare an own entry against.
  function computedFor(idx, o) {
    const { weapon, scope } = o;
    if (ZERO_WEAPONS.has(weapon)) return { curve: zeroCurve(), multiplier: null, parts: [], baseMissing: false, notes: ['Súng này luôn dùng đường cong 0 trong app.'] };
    const base = idx.map.get(keyOf(weapon, scope, 0, 0, 0, 0));
    const baseCurve = base ? base[base.length - 1].recoilValue : null;
    const f = factors(coefficientsFor(idx, weapon, scope), o);
    const notes = ['Hệ số ghép theo ý định của code (JADX làm rối nhánh tay cầm ngón cái/laser và tư thế): suy ra.'];
    if (!baseCurve) notes.push('Không có đường cong nền (không phụ kiện, đứng) cho súng + scope này: app dùng 0.');
    return { curve: baseCurve ? scale(baseCurve, f.total) : zeroCurve(), multiplier: f.total, parts: f.parts, baseMissing: !baseCurve, notes };
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

  // ---------------------------------------------------------------- editing (the web page changes ONE dataset of ONE item)
  const isZeroWeapon = (weapon) => ZERO_WEAPONS.has(weapon);

  // ---------------------------------------------------------------- which accessories a gun takes
  // Source: the official Tencent data of 和平精英 (kho vũ khí: every accessory with the guns it fits, and each gun's own list), checked against the
  // table the user supplied; docs/PhuKien_Sung_PUBG_Mobile.xlsx has the comparison. The REAL DATA of the app cannot tell: 62 of the 70 guns carry the
  // very same template of combinations, whatever the gun. Guns that no source covers have no rule (nothing is refused for them).
  // Names differ from the app's lists, so some of it has no counterpart and is treated as "not taken":
  //   Angled grip = HORIZONTAL; Tactical Stock and the plain stock of the UZI = GENERAL; Cheek Pad, Bullet Loops, Quiver, Choke, Duckbill: no entry in the app;
  //   ERGONOMIC grip, BRAKE, EXTENDER, BRAKE_NEW muzzles and GENERAL_NEW stock are in no source.
  // On hold: Mosin, M1014, MP5K, P90, AMR (one secondary source each): see the workbook.
  // M249 follows the official data (scopes only, like the DP28 and MG3): no grip, muzzle or stock.
  // To change a rule, edit ATTACHMENT_RULES (the tests check every name against the enums).
  const ZOOM = { hippie: 0, X1: 1, X2: 2, X3: 3, X4: 4, X6: 6, X8: 8, X63: 6, X84: 8, tactic: 8, tactic_84: 8, LPVO: 6, LPVO_61: 6 }; // the highest magnification of each scope entry
  const MZ3 = ['COMPENSATOR', 'FLASH_HIDER', 'SUPPRESSOR'];
  const SUPP = ['SUPPRESSOR'];
  const GR5 = ['VERTICAL', 'HORIZONTAL', 'THUMB', 'HALF', 'LIGHT'];
  const GR6 = ['VERTICAL', 'HORIZONTAL', 'THUMB', 'HALF', 'LIGHT', 'LASER']; // Tencent puts the laser sight in the grip slot
  const GR4 = ['VERTICAL', 'HALF', 'LIGHT', 'LASER'];
  const GRV = ['VERTICAL'];
  const TACTICAL = ['GENERAL'];
  const SOURCES = { official: 'chính thức 和平精英 (Tencent)', appmedia: 'AppMedia, PUBG Mobile toàn cầu 2022', user: 'bảng do người dùng cung cấp' };
  const rule = (muzzles, grips, stocks, maxZoom, source, note) => ({ muzzles, grips, stocks, maxZoom, source, note });
  const ATTACHMENT_RULES = {
    // assault rifles (Tencent)
    AKM: rule(MZ3, [], [], 6, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: không; báng: không; ống ngắm đến 6x'),
    M16: rule(MZ3, [], TACTICAL, 6, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: không; báng: có; ống ngắm đến 6x'),
    M416: rule(MZ3, GR6, TACTICAL, 6, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: tam giác, đứng, ngón cái, nhẹ, half, laser; báng: có; ống ngắm đến 6x'),
    Scar: rule(MZ3, GR6, [], 6, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: tam giác, đứng, ngón cái, nhẹ, half, laser; báng: không; ống ngắm đến 6x'),
    Groza: rule(SUPP, [], [], 6, 'official', 'nòng: giảm thanh; tay cầm: không; báng: không; ống ngắm đến 6x'),
    AUG: rule(MZ3, GR6, [], 6, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: tam giác, đứng, ngón cái, nhẹ, half, laser; báng: không; ống ngắm đến 6x'),
    QBZ: rule(MZ3, GR6, [], 6, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: tam giác, đứng, ngón cái, nhẹ, half, laser; báng: không; ống ngắm đến 6x'),
    M762: rule(MZ3, GR6, [], 6, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: tam giác, đứng, ngón cái, nhẹ, half, laser; báng: không; ống ngắm đến 6x'),
    MK47: rule(MZ3, GR6, TACTICAL, 6, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: tam giác, đứng, ngón cái, nhẹ, half, laser; báng: có; ống ngắm đến 6x'),
    G36C: rule(MZ3, GR6, [], 6, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: tam giác, đứng, ngón cái, nhẹ, half, laser; báng: không; ống ngắm đến 6x'),
    // submachine guns (Tencent)
    UZI: rule(MZ3, [], TACTICAL, 1, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: không; báng: có; ống ngắm chỉ Red Dot/Holo'),
    Thomson: rule(SUPP, GRV, [], 1, 'official', 'nòng: giảm thanh; tay cầm: đứng; báng: không; ống ngắm chỉ Red Dot/Holo'),
    UMP45: rule(MZ3, GR6, [], 6, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: tam giác, đứng, ngón cái, nhẹ, half, laser; báng: không; ống ngắm đến 6x'),
    Vector: rule(MZ3, GR4, TACTICAL, 6, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: đứng, nhẹ, half, laser; báng: có; ống ngắm đến 6x'),
    Bison: rule(MZ3, [], [], 6, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: không; báng: không; ống ngắm đến 6x'),
    // designated marksman rifles (Tencent)
    VSS: rule([], [], [], 0, 'official', 'nòng: không; tay cầm: không; báng: không; ống ngắm không lắp được; ngoài danh sách của app: cheek pad'),
    SKS: rule(MZ3, GR6, [], 8, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: tam giác, đứng, ngón cái, nhẹ, half, laser; báng: không; ống ngắm đến 8x; ngoài danh sách của app: cheek pad'),
    MK14: rule(MZ3, [], [], 8, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: không; báng: không; ống ngắm đến 8x; ngoài danh sách của app: cheek pad'),
    Mini14: rule(MZ3, [], [], 8, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: không; báng: không; ống ngắm đến 8x'),
    SLR: rule(MZ3, [], [], 8, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: không; báng: không; ống ngắm đến 8x; ngoài danh sách của app: cheek pad'),
    QBU: rule(MZ3, [], [], 8, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: không; báng: không; ống ngắm đến 8x'),
    // sniper rifles (Tencent)
    AWM: rule(MZ3, [], [], 8, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: không; báng: không; ống ngắm đến 8x; ngoài danh sách của app: cheek pad'),
    Kar98K: rule(MZ3, [], [], 8, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: không; báng: không; ống ngắm đến 8x; ngoài danh sách của app: bullet loops, cheek pad'),
    M24: rule(MZ3, [], [], 8, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: không; báng: không; ống ngắm đến 8x; ngoài danh sách của app: cheek pad'),
    Win94: rule([], [], [], 0, 'official', 'nòng: không; tay cầm: không; báng: không; ống ngắm không lắp được; ngoài danh sách của app: bullet loops'),
    // shotguns (Tencent)
    S12K: rule(MZ3, [], [], 6, 'official', 'nòng: hãm giật, ẩn tia lửa, giảm thanh; tay cầm: không; báng: không; ống ngắm đến 6x; ngoài danh sách của app: duckbill'),
    S1897: rule([], [], [], 0, 'official', 'nòng: không; tay cầm: không; báng: không; ống ngắm không lắp được; ngoài danh sách của app: bullet loops, choke, duckbill'),
    S686: rule([], [], [], 0, 'official', 'nòng: không; tay cầm: không; báng: không; ống ngắm không lắp được; ngoài danh sách của app: bullet loops, choke'),
    DBS: rule([], [], [], 6, 'official', 'nòng: không; tay cầm: không; báng: không; ống ngắm đến 6x'),
    // light machine guns (Tencent)
    M249: rule([], [], [], 6, 'official', 'nòng: không; tay cầm: không; báng: không; ống ngắm đến 6x (bản toàn cầu có báng chiến thuật, 和平精英 thì không)'),
    DP28: rule([], [], [], 6, 'official', 'nòng: không; tay cầm: không; báng: không; ống ngắm đến 6x'),
    MG3: rule([], [], [], 6, 'official', 'nòng: không; tay cầm: không; báng: không; ống ngắm đến 6x'),
    // other (Tencent)
    CrossBow: rule([], [], [], 6, 'official', 'nòng: không; tay cầm: không; báng: không; ống ngắm đến 6x; ngoài danh sách của app: quiver'),
    // not in the Tencent data
    ACE32: rule(MZ3, GR5, [], 6, 'user', 'như M416 nhưng không có báng, ống ngắm đến 6x (bảng người dùng; chưa có nguồn đối chiếu)'),
    FAMAS: rule(MZ3, [], [], 6, 'appmedia', 'nòng, ống ngắm đến 6x; không tay cầm, không báng'),
    MK12: rule(MZ3, [], [], 8, 'appmedia', 'nòng, ống ngắm đến 8x; không tay cầm, không báng'),
  };

  const attachCache = new Map();
  const toSet = (list, names) => new Set(names.map((n) => { const i = list.indexOf(n); if (i < 0) throw new Error(`Unknown accessory ${n}`); return i; }));
  // ---- the user's corrections ("Tiêu chuẩn súng" → "Sửa tiêu chuẩn"), kept by the server in DATA_DIR/gun-standards.json and loaded by the server
  // and by the page: gun code -> a rule like those above (source 'edited'), or null = "no rule for this gun" (nothing refused). They win over
  // ATTACHMENT_RULES everywhere: the checks, the combinations offered, the scans and what the AI is told.
  SOURCES.edited = 'người dùng sửa trên trang Tiêu chuẩn súng';
  const MAX_ZOOMS = [null, 0, 1, 2, 3, 4, 6, 8]; // null = no limit
  let ruleOverrides = {};
  const hasOverride = (name) => Object.prototype.hasOwnProperty.call(ruleOverrides, name);
  let disabledGuns = new Set();
  function setDisabledGuns(list) {
    const next = new Set();
    for (const item of Array.isArray(list) ? list : []) {
      const code = typeof item === 'number' ? WEAPONS[item] : typeof item === 'string' ? item : null;
      if (code && WEAPONS.includes(code) && code !== WEAPONS[0]) next.add(code);
    }
    disabledGuns = next;
    attachCache.clear();
    return getDisabledGuns();
  }
  const getDisabledGuns = () => [...disabledGuns];
  function isGunDisabled(weapon) {
    const code = typeof weapon === 'number' ? WEAPONS[weapon] : typeof weapon === 'string' ? weapon : null;
    return Boolean(code && disabledGuns.has(code));
  }
  // a rule from the page -> { ok, rule } with the names checked against the app's lists, or { ok:false, error }
  function checkRule(r) {
    if (!r || typeof r !== 'object') return { ok: false, error: 'Tiêu chuẩn không hợp lệ.' };
    const names = (list, v, what) => {
      if (!Array.isArray(v)) return { error: `${what}: cần một danh sách.` };
      const out = [...new Set(v)];
      const bad = out.find((n) => typeof n !== 'string' || n === 'None' || !list.includes(n));
      return bad === undefined ? { out } : { error: `${what}: "${bad}" không có trong danh sách của app.` };
    };
    const m = names(MUZZLES, r.muzzles, 'Đầu nòng');
    const g = names(GRIPS, r.grips, 'Tay cầm');
    const s = names(STOCKS, r.stocks, 'Báng');
    const err = m.error || g.error || s.error;
    if (err) return { ok: false, error: err };
    const maxZoom = r.maxZoom === undefined ? null : r.maxZoom;
    if (!MAX_ZOOMS.includes(maxZoom)) return { ok: false, error: 'Ống ngắm tối đa phải là không giới hạn, không lắp được, 1x, 2x, 3x, 4x, 6x hoặc 8x.' };
    const note = typeof r.note === 'string' ? r.note.trim().slice(0, 300) : '';
    return { ok: true, rule: { muzzles: m.out, grips: g.out, stocks: s.out, maxZoom, source: 'edited', note } };
  }
  function setRuleOverrides(map) {
    const next = {};
    for (const [name, r] of Object.entries(map && typeof map === 'object' ? map : {})) {
      if (!WEAPONS.includes(name)) continue;
      if (r === null) { next[name] = null; continue; }
      const c = checkRule(r);
      if (c.ok) next[name] = c.rule;
    }
    ruleOverrides = next;
    attachCache.clear();
    return getRuleOverrides();
  }
  const getRuleOverrides = () => ({ ...ruleOverrides });
  // the rule in force for a gun code: the user's correction if any, else the table above (null = none)
  const ruleOf = (name) => (hasOverride(name) ? ruleOverrides[name] : ATTACHMENT_RULES[name] || null);

  // -> { name, grips:Set, muzzles:Set, stocks:Set (enum indexes), maxZoom, source, sourceLabel, note, edited, disabled } or null when no rule covers the gun
  function attachmentsFor(weapon) {
    const name = WEAPONS[weapon];
    const r = name && ruleOf(name);
    if (!r) return null;
    if (!attachCache.has(name)) attachCache.set(name, { name, grips: toSet(GRIPS, r.grips), muzzles: toSet(MUZZLES, r.muzzles), stocks: toSet(STOCKS, r.stocks), maxZoom: r.maxZoom, source: r.source, sourceLabel: SOURCES[r.source] || r.source, note: r.note, edited: hasOverride(name), disabled: isGunDisabled(name) });
    return attachCache.get(name);
  }

  // Problems with fitting these accessories on this gun at this scope: [{ slot: 'grip'|'muzzle'|'stock'|'scope', reason }] (empty = fine, or no rule)
  function comboProblems(weapon, scope, { grip = 0, muzzle = 0, stock = 0 } = {}) {
    const a = attachmentsFor(weapon);
    if (!a) return [];
    const gun = weaponLabel(weapon);
    const out = [];
    const check = (slot, set, value, labels, slotVn) => {
      if (!value || set.has(value)) return;
      if (!set.size) out.push({ slot, reason: `${gun} không hỗ trợ ${slotVn} (theo tài liệu phụ kiện).` });
      else out.push({ slot, reason: `${slotVn} "${labels[value]}" không nằm trong các ${slotVn} ${gun} hỗ trợ (${[...set].map((i) => labels[i]).join(', ')}).` });
    };
    check('grip', a.grips, grip, LABELS.GRIPS, 'tay cầm');
    check('muzzle', a.muzzles, muzzle, LABELS.MUZZLES, 'đầu nòng');
    check('stock', a.stocks, stock, LABELS.STOCKS, 'báng');
    const zoom = ZOOM[SCOPES[scope]];
    if (a.maxZoom != null && zoom != null && zoom > a.maxZoom) out.push({ slot: 'scope', reason: `${gun} chỉ lắp được ống ngắm tối đa ${a.maxZoom}x; "${LABELS.SCOPES[scope]}" lớn hơn.` });
    return out;
  }

  // One line telling what the gun takes (null = the table does not mention it).
  function describeAttachments(weapon) {
    const a = attachmentsFor(weapon);
    if (!a) return null;
    const list = (set, labels) => (set.size ? [...set].map((i) => labels[i]).join(', ') : 'không hỗ trợ');
    return `Đầu nòng: ${list(a.muzzles, LABELS.MUZZLES)} · Tay cầm: ${list(a.grips, LABELS.GRIPS)} · Báng: ${list(a.stocks, LABELS.STOCKS)} · Ống ngắm: ${a.maxZoom == null ? 'không giới hạn trong tài liệu' : `tối đa ${a.maxZoom}x`}`;
  }

  // ---------------------------------------------------------------- how fast a gun empties one (normal) magazine
  // T = (magazine - 1) x interval: the first shot leaves at once. It is the length of a recoil curve: the points are spread evenly over it.
  // Seconds between shots: Liquipedia PUBG Mobile (a snapshot of about mid 2025); magazine: BitTopup, except MG3, DP28 and M249 (wiki of the PC game).
  // Single-shot guns (DMR, sniper, shotgun) are given by their shortest cycle. Not verified in the game: the user can correct every gun on the
  // page "Tiêu chuẩn súng"; guns that are not here have no value (the old random step of the points is used for them).
  SOURCES.fire = 'Liquipedia PUBG Mobile (giây/phát) và BitTopup (băng); chưa kiểm chứng';
  const F = (magazine, interval, note = '') => Object.freeze({ magazine, interval, note });
  const FIRE_DEFAULTS = Object.freeze({
    M416: F(30, 0.085), AUG: F(30, 0.085), M762: F(30, 0.086), G36C: F(30, 0.086), Groza: F(30, 0.08), AKM: F(30, 0.1), QBZ: F(30, 0.092), ACE32: F(30, 0.092),
    Scar: F(30, 0.096), M16: F(30, 0.075, 'bắn theo loạt, thực tế chậm hơn'), MK47: F(20, 0.1, 'bắn theo loạt; trang nguồn lẫn số liệu'),
    FAMAS: F(30, 0.15, 'nghi vấn: nhiều khả năng bắn nhanh hơn nhiều'),
    UZI: F(25, 0.048), Vector: F(19, 0.054), MP5K: F(30, 0.067), Thomson: F(30, 0.086), UMP45: F(25, 0.092),
    VSS: F(10, 0.086), MK14: F(10, 0.09), SKS: F(10, 0.09), SLR: F(10, 0.1), QBU: F(10, 0.1), Mini14: F(20, 0.13, 'wiki PC ghi 0,1'), MK12: F(20, 0.13, 'wiki PC ghi 0,1'),
    MG3: F(75, 0.066, 'băng theo wiki PC; chế độ bắn nhanh'), DP28: F(47, 0.109, 'băng theo wiki PC'), M249: F(100, 0.075, 'băng theo wiki PC'),
    S686: F(2, 0.2, 'có thể bắn cả hai nòng cùng lúc'), S12K: F(5, 0.25), M1014: F(7, 0.25, 'wiki PC ghi 8 viên'), S1897: F(5, 0.75),
    M24: F(5, 1.8, 'chu kỳ nạp đạn bolt'), AWM: F(5, 1.85), Kar98K: F(5, 1.9), Mosin: F(5, 1.9), AMR: F(5, 1.9),
  });
  const MAGAZINE = Object.freeze([2, 200]);
  const INTERVAL = Object.freeze([0.02, 3]);
  const emptyMsOf = (f) => Math.round((f.magazine - 1) * f.interval * 1000);
  // { magazine, interval } typed on the page -> { ok, fire } with the interval to 4 decimals, or { ok:false, error }
  function checkFire(f) {
    if (!f || typeof f !== 'object') return { ok: false, error: 'Thông số bắn không hợp lệ.' };
    if (!Number.isInteger(f.magazine) || f.magazine < MAGAZINE[0] || f.magazine > MAGAZINE[1]) return { ok: false, error: `Số viên một băng phải là số nguyên từ ${MAGAZINE[0]} đến ${MAGAZINE[1]}.` };
    if (typeof f.interval !== 'number' || !Number.isFinite(f.interval) || f.interval < INTERVAL[0] || f.interval > INTERVAL[1]) return { ok: false, error: `Số giây giữa hai phát phải từ ${INTERVAL[0]} đến ${INTERVAL[1]}.` };
    return { ok: true, fire: { magazine: f.magazine, interval: Math.round(f.interval * 10000) / 10000 } };
  }
  // the user's corrections: gun code -> { magazine, interval }, or null = "this gun has no fire data". They win over FIRE_DEFAULTS.
  let fireOverrides = {};
  function setFireOverrides(map) {
    const next = {};
    for (const [name, f] of Object.entries(map && typeof map === 'object' ? map : {})) {
      if (!WEAPONS.includes(name) || name === WEAPONS[0]) continue;
      if (f === null) { next[name] = null; continue; }
      const c = checkFire(f);
      if (c.ok) next[name] = c.fire;
    }
    fireOverrides = next;
    return getFireOverrides();
  }
  const getFireOverrides = () => ({ ...fireOverrides });
  // -> { magazine, interval, emptyMs, source: 'default' | 'edited', sourceLabel, note, edited } or null (a zero gun, a disabled gun unless ignoreDisabled,
  // a gun the user cleared, a gun without default or edit)
  function fireOf(weapon, { ignoreDisabled = false } = {}) {
    const code = typeof weapon === 'number' ? WEAPONS[weapon] : typeof weapon === 'string' ? weapon : null;
    if (!code || !WEAPONS.includes(code) || ZERO_WEAPONS.has(WEAPONS.indexOf(code))) return null;
    if (!ignoreDisabled && isGunDisabled(code)) return null;
    const edited = Object.prototype.hasOwnProperty.call(fireOverrides, code);
    const f = edited ? fireOverrides[code] : FIRE_DEFAULTS[code];
    if (!f) return null;
    return { magazine: f.magazine, interval: f.interval, emptyMs: emptyMsOf(f), source: edited ? 'edited' : 'default', sourceLabel: edited ? SOURCES.edited : SOURCES.fire, note: edited ? '' : f.note || '', edited };
  }

  const MAX_POINTS = 10000;

  // A curve typed on the page -> { ok, curve } with numbers sorted by time, or { ok:false, error }.
  // Only finite numbers are accepted: Infinity/NaN would be written as null by JSON.stringify and break the app.
  function checkCurve(curve) {
    if (!Array.isArray(curve) || !curve.length) return { ok: false, error: 'Đường cong phải có ít nhất 1 mốc.' };
    if (curve.length > MAX_POINTS) return { ok: false, error: `Đường cong có quá nhiều mốc (tối đa ${MAX_POINTS}).` };
    const out = [];
    for (let i = 0; i < curve.length; i++) {
      const p = curve[i];
      if (!Array.isArray(p) || p.length !== 2) return { ok: false, error: `Mốc #${i + 1}: cần đúng 2 giá trị (thời gian, giá trị).` };
      const [t, v] = p.map((x) => (typeof x === 'string' && x.trim() === '' ? NaN : Number(x))); // Number(null) and Number('') are 0: not a number the user typed
      if (p[0] === null || p[1] === null) return { ok: false, error: `Mốc #${i + 1}: thiếu giá trị.` };
      if (!Number.isFinite(t) || t < 0) return { ok: false, error: `Mốc #${i + 1}: thời gian phải là số hữu hạn, không âm.` };
      if (!Number.isFinite(v)) return { ok: false, error: `Mốc #${i + 1}: giá trị phải là số hữu hạn.` };
      out.push([t, v]);
    }
    return { ok: true, curve: out.sort((a, b) => a[0] - b[0]) };
  }

  const sameKey = (e, o) => Boolean(e) && e.scope === o.scope && e.grip === o.grip && e.muzzle === o.muzzle && e.stock === o.stock && e.gesture === o.gesture;
  const clone = (doc) => JSON.parse(JSON.stringify(doc));

  // Sets the curve of one combination in the dataset that pickDataset(doc, mode) shows (a copy is returned, doc is not changed).
  // The app keeps the LAST entry of a key, so that one is changed; a combination without an entry gets a new one.
  function applyCurveEdit(doc, mode, o, curve, opts) {
    const ed = curveEditor(doc, mode);
    const r = ed.apply(o, curve, opts);
    return { doc: ed.doc, key: ed.key, created: r.created, copies: r.copies };
  }

  // The same for MANY combinations: the document is copied once, then each apply(o, curve) changes the copy (the copy of a big document is
  // the slow part, so a few hundred combinations must not copy it a few hundred times). apply throws like applyCurveEdit does.
  // -> { doc (the copy, changed as the edits go), key, apply(o, curve, { allowUnsupported }) -> { created, copies } }
  function curveEditor(doc, mode) {
    const next = clone(doc);
    const ds = pickDataset(next, mode);
    if (!ds) throw new Error('Mục này không có recoil_data.');
    return {
      doc: next,
      key: ds.key,
      apply(o, curve, { allowUnsupported = false } = {}) {
        const checked = checkCurve(curve);
        if (!checked.ok) throw new Error(checked.error);
        if (isZeroWeapon(o.weapon)) throw new Error('Súng này luôn dùng đường cong 0 trong app: sửa ở đây không có tác dụng.');
        const group = ds.data[o.weapon];
        if (!group || typeof group !== 'object') throw new Error(`Bộ dữ liệu ${ds.key} chưa có nhóm dữ liệu cho súng này (nhóm ${o.weapon}); không tự tạo nhóm trống.`);
        if (!Array.isArray(group.v)) group.v = [];
        const matches = group.v.filter((e) => sameKey(e, o));
        if (matches.length) matches[matches.length - 1].recoilValue = checked.curve;
        else if (!allowUnsupported && comboProblems(o.weapon, o.scope, o).length) throw new Error(comboProblems(o.weapon, o.scope, o).map((p) => p.reason).join(' '));
        else group.v.push({ scope: o.scope, grip: o.grip, muzzle: o.muzzle, stock: o.stock, gesture: o.gesture, recoilValue: checked.curve });
        return { created: !matches.length, copies: matches.length };
      },
    };
  }

  // Deletes the own entries (all copies) of one combination: the app then computes the curve from the coefficients again.
  function removeEntry(doc, mode, o) {
    const next = clone(doc);
    const ds = pickDataset(next, mode);
    if (!ds) throw new Error('Mục này không có recoil_data.');
    const group = ds.data[o.weapon];
    let removed = 0;
    if (group && Array.isArray(group.v)) {
      const kept = group.v.filter((e) => !sameKey(e, o));
      removed = group.v.length - kept.length;
      group.v = kept;
    }
    return { doc: next, key: ds.key, removed };
  }

  // ---------------------------------------------------------------- checking the entries against the table of accessories
  // The own entries (keys) of a dataset that the table says cannot exist: a grip on the M249, a muzzle on a gun that has none, a 16x scope on a
  // gun that stops at 6x. Guns the table does not mention have no rule, so none of their entries is reported.
  // -> [{ weapon, scope, grip, muzzle, stock, gesture, copies, problems }] in gun, scope, posture order
  function auditEntries(idx) {
    const out = [];
    for (const [key, list] of idx.map) {
      const [weapon, scope, grip, muzzle, stock, gesture] = key.split('|').map(Number);
      const problems = comboProblems(weapon, scope, { grip, muzzle, stock });
      if (problems.length) out.push({ weapon, scope, grip, muzzle, stock, gesture, copies: list.length, problems });
    }
    return out.sort((a, b) => a.weapon - b.weapon || a.scope - b.scope || a.gesture - b.gesture || a.grip - b.grip || a.muzzle - b.muzzle || a.stock - b.stock);
  }

  // Deletes the own entries (every copy of each key) of many combinations in one go: the copy is made once, not once per combination.
  // list: [{ weapon, scope, grip, muzzle, stock, gesture }]. -> { doc, key, removed (entries), keys (combinations that had one) }
  function removeEntries(doc, mode, list) {
    const next = clone(doc);
    const ds = pickDataset(next, mode);
    if (!ds) throw new Error('Mục này không có recoil_data.');
    const byGun = new Map();
    for (const o of list) {
      if (!byGun.has(o.weapon)) byGun.set(o.weapon, new Set());
      byGun.get(o.weapon).add(`${o.scope}|${o.grip}|${o.muzzle}|${o.stock}|${o.gesture}`);
    }
    let removed = 0;
    const hit = new Set();
    for (const [weapon, keys] of byGun) {
      const group = ds.data[weapon];
      if (!group || !Array.isArray(group.v)) continue;
      group.v = group.v.filter((e) => {
        const k = `${e.scope}|${e.grip}|${e.muzzle}|${e.stock}|${e.gesture}`;
        if (!keys.has(k)) return true;
        removed++;
        hit.add(`${weapon}|${k}`);
        return false;
      });
    }
    return { doc: next, key: ds.key, removed, keys: hit.size };
  }

  // ---------------------------------------------------------------- points the page adds or recomputes
  // A new point, and every point after an edited one, continues from the point before it (cumulative: each from the previous):
  //   time  + 450..678 ms (whole milliseconds);
  //   value + 1.02..1.35 ("up"), or - 1.02..1.35 ("down"), or one of the two at random ("random"); the step has two decimals.
  // rnd() is Math.random by default; tests pass their own.
  const STEP = Object.freeze({ time: Object.freeze([450, 678]), value: Object.freeze([1.02, 1.35]) });
  const DIRECTIONS = ['up', 'down', 'random'];
  const stepTime = (t, rnd = Math.random) => t + STEP.time[0] + Math.floor(rnd() * (STEP.time[1] - STEP.time[0] + 1));
  const stepDelta = (rnd = Math.random) => Math.round((STEP.value[0] + rnd() * (STEP.value[1] - STEP.value[0])) * 100) / 100;
  const stepValue = (v, rnd = Math.random, dir = 'up') => {
    const delta = stepDelta(rnd);
    const down = dir === 'down' || (dir === 'random' && rnd() < 0.5);
    return Number((down ? v - delta : v + delta).toFixed(6)); // only float noise is removed
  };
  const nextPoint = (curve, rnd = Math.random, dir = 'up') => {
    const last = Array.isArray(curve) && curve.length ? curve[curve.length - 1] : null;
    return last ? [stepTime(last[0], rnd), stepValue(last[1], rnd, dir)] : [0, 0];
  };
  // After the point at `index` was edited: recompute that column (0 = time, 1 = value) of every later point, each from the one before.
  // The other column is left alone. Changes the array; returns how many points changed.
  function cascadeFrom(curve, index, col, rnd = Math.random, dir = 'up') {
    if (!Array.isArray(curve) || !Number.isInteger(index) || index < 0 || (col !== 0 && col !== 1)) return 0;
    let n = 0;
    for (let i = index + 1; i < curve.length; i++) {
      curve[i][col] = col === 0 ? stepTime(curve[i - 1][0], rnd) : stepValue(curve[i - 1][1], rnd, dir);
      n++;
    }
    return n;
  }

  // Extends a curve by adding `count` points continuing from previous points.
  // method: 'trend' (extrapolates from the last 2 points' delta t and delta v, fallback to step)
  //         'step'  (uses nextPoint: time +450..678 ms, value +1.02..1.35 per dir)
  function extendCurve(curve, count = 1, { method = 'trend', rnd = Math.random, dir = 'up' } = {}) {
    if (!Array.isArray(curve)) return [];
    const n = Math.max(0, Math.floor(Number(count) || 0));
    const out = curve.map(([t, v]) => [Number(t), Number(v)]);
    for (let k = 0; k < n; k++) {
      if (out.length === 0) {
        out.push([0, 0]);
        continue;
      }
      if (out.length === 1 || method === 'step') {
        out.push(nextPoint(out, rnd, dir));
        continue;
      }
      const last = out[out.length - 1];
      const prev = out[out.length - 2];
      let dt = last[0] - prev[0];
      let dv = last[1] - prev[1];
      if (dt <= 0) dt = stepTime(0, rnd);
      const nextT = Math.round(last[0] + dt);
      const nextV = Number((last[1] + dv).toFixed(6));
      out.push([nextT, nextV]);
    }
    return out;
  }

  // ---------------------------------------------------------------- combinations
  const comboKey = (o) => `${o.weapon}|${o.scope}|${o.gesture}|${o.grip}|${o.muzzle}|${o.stock}`;
  // Is this combination already in the list? { kind: 'exact' (has its own entry in the file) | 'custom' (added on the page, not saved yet)
  // | 'default' (the none/none/none row is always listed), copies } or null when it is new. customKeys: Set of comboKey strings.
  function findDuplicateCombo(idx, customKeys, o) {
    const own = idx.map.get(keyOf(o.weapon, o.scope, o.grip, o.muzzle, o.stock, o.gesture));
    if (own) return { kind: 'exact', copies: own.length };
    if (customKeys && customKeys.has(comboKey(o))) return { kind: 'custom', copies: 0 };
    if (!o.grip && !o.muzzle && !o.stock) return { kind: 'default', copies: 0 };
    return null;
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

  // The combinations of one gun that "Thêm mốc cho súng" can extend. customKeys: Set of comboKey strings (added on the page, not saved yet);
  // scopes: the scope indexes the gun can take (from its attachment rules).
  // own = every own entry of the gun (any scope, even one the rules no longer allow) and every custom combination, once each;
  // all = the own ones in the allowed scopes plus the bare combination of each allowed scope and posture; scopeList = allowed scopes + the scopes
  // the own entries use that the rules do not allow (extra), in index order.
  function batchCombos(idx, customKeys, weapon, scopes) {
    const own = [];
    const seen = new Set();
    const add = (list, o) => {
      const k = `${o.scope}|${o.gesture}|${o.grip}|${o.muzzle}|${o.stock}`;
      if (list === own) { if (seen.has(k)) return; seen.add(k); }
      list.push({ weapon, ...o });
    };
    for (const key of idx.map.keys()) {
      const [w, scope, grip, muzzle, stock, gesture] = key.split('|').map(Number);
      if (w === weapon) add(own, { scope, gesture, grip, muzzle, stock });
    }
    for (const key of customKeys || []) {
      const [w, scope, gesture, grip, muzzle, stock] = key.split('|').map(Number);
      if (w === weapon) add(own, { scope, gesture, grip, muzzle, stock });
    }
    const all = [];
    const seenAll = new Set();
    for (const scope of scopes) {
      for (const gesture of [0, 1, 2]) {
        const here = exactCombos(idx, weapon, scope, gesture);
        if (!here.some((c) => !c.grip && !c.muzzle && !c.stock)) here.unshift({ grip: 0, muzzle: 0, stock: 0 });
        for (const c of here) {
          const k = `${scope}|${gesture}|${c.grip}|${c.muzzle}|${c.stock}`;
          if (!seenAll.has(k)) { seenAll.add(k); all.push({ weapon, scope, gesture, grip: c.grip, muzzle: c.muzzle, stock: c.stock }); }
        }
      }
    }
    const extra = new Set(own.map((o) => o.scope).filter((sc) => !scopes.includes(sc)));
    const scopeList = [...new Set([...scopes, ...extra])].sort((a, b) => a - b);
    return { own, all, scopeList, extra };
  }

  // Keeps the combinations whose scope is in `scopes` and whose posture is in `gestures` (a Set of enum indexes; null = any).
  const filterCombos = (list, { scopes = null, gestures = null } = {}) => list.filter((c) => (!scopes || scopes.has(c.scope)) && (!gestures || gestures.has(c.gesture)));

  // Combos that have their own entry for (weapon, scope, gesture), sorted by grip, muzzle, stock.
  function exactCombos(idx, weapon, scope, gesture) {
    const out = [];
    for (const k of idx.map.keys()) {
      const [w, s, g, m, st, ge] = k.split('|').map(Number);
      if (w === weapon && s === scope && ge === gesture) out.push({ grip: g, muzzle: m, stock: st });
    }
    return out.sort((a, b) => a.grip - b.grip || a.muzzle - b.muzzle || a.stock - b.stock);
  }

  return { WEAPONS, SCOPES, GRIPS, MUZZLES, STOCKS, POSTURES, LABELS, COEF_LABELS, MUZZLE_COEF, GRIP_COEF, STOCK_COEF, POSTURE_COEF, weaponLabel, coefLabel, indexData, resolve, computedFor, curveStats, pickDataset, weaponSummary, exactCombos, batchCombos, filterCombos, coefficientsFor, isZeroWeapon, ATTACHMENT_RULES, attachmentsFor, comboProblems, setRuleOverrides, getRuleOverrides, checkRule, ruleOf, MAX_ZOOMS, SOURCES, describeAttachments, checkCurve, applyCurveEdit, curveEditor, removeEntry, auditEntries, removeEntries, STEP, DIRECTIONS, stepTime, stepDelta, stepValue, nextPoint, cascadeFrom, extendCurve, comboKey, findDuplicateCombo, setDisabledGuns, getDisabledGuns, isGunDisabled, FIRE_DEFAULTS, checkFire, emptyMsOf, setFireOverrides, getFireOverrides, fireOf, GUN_CLASS_MAP, GUN_CLASSES, gunClass };
});
