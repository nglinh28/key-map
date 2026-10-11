'use strict';
// Helpers for the JSON editor: node paths, change summary and structure checks.
// Works in the browser (window.EditLib) and in Node (tests).
//
// validate() only ever produces *warnings for the user to read before saving*; it never blocks a save.
//   level "error": the app very probably breaks on this (it reads that field directly)
//   level "warn" : suspicious, the app probably copes
// The recoil rules come from how com.zjx.jyandroid.Extensions.pubg.C8727g reads recoil_data.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EditLib = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/; // a whole key is an identifier (formatting)
  const IDENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/; // an identifier at the start of the rest of a path (parsing)

  // ---------------------------------------------------------------- paths: $.a.b[3]["odd key"]
  function formatKey(key) {
    if (typeof key === 'number') return `[${key}]`;
    return IDENT.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  }
  const formatPath = (segs) => `$${segs.map(formatKey).join('')}`;
  const childPath = (path, key) => `${path}${formatKey(key)}`;

  function parsePath(p) {
    const bad = () => new Error(`Sai cú pháp đường dẫn: "${p}"`);
    if (typeof p !== 'string' || p[0] !== '$') throw bad();
    const segs = [];
    let i = 1;
    while (i < p.length) {
      const rest = p.slice(i + 1);
      if (p[i] === '.') {
        const m = IDENT_PREFIX.exec(rest);
        if (!m) throw bad();
        segs.push(m[0]);
        i += 1 + m[0].length;
      } else if (p[i] === '[' && p[i + 1] === '"') {
        const m = /^"(?:[^"\\]|\\.)*"/.exec(rest);
        if (!m || p[i + 1 + m[0].length] !== ']') throw bad();
        segs.push(JSON.parse(m[0]));
        i += m[0].length + 2;
      } else if (p[i] === '[') {
        const m = /^(\d+)\]/.exec(rest);
        if (!m) throw bad();
        segs.push(Number(m[1]));
        i += m[0].length + 1;
      } else throw bad();
    }
    return segs;
  }

  function getAt(root, segs) {
    let cur = root;
    for (const s of segs) {
      if (cur === null || typeof cur !== 'object') return undefined;
      if (Array.isArray(cur)) { if (typeof s !== 'number' || s >= cur.length) return undefined; } else if (typeof s !== 'string' || !hasOwn(cur, s)) return undefined;
      cur = cur[s];
    }
    return cur;
  }

  // Replaces the node at segs inside root (in place) and returns root; an empty path returns value itself.
  function setAt(root, segs, value) {
    if (!segs.length) return value;
    const missing = () => new Error(`Đường dẫn không tồn tại: ${formatPath(segs)}`);
    if (segs.includes('__proto__')) throw new Error('Khóa không hợp lệ: __proto__');
    const parent = getAt(root, segs.slice(0, -1));
    if (parent === null || typeof parent !== 'object') throw missing();
    const last = segs[segs.length - 1];
    if (Array.isArray(parent)) {
      if (typeof last !== 'number' || last >= parent.length) throw missing();
    } else if (typeof last !== 'string') throw missing();
    parent[last] = value;
    return root;
  }

  // ---------------------------------------------------------------- diff
  function diff(a, b, { limit = 200 } = {}) {
    const out = { total: 0, changes: [], truncated: false };
    const stack = [];
    const push = (kind, before, after) => {
      out.total++;
      if (out.changes.length < limit) out.changes.push({ path: formatPath(stack), kind, before, after });
      else out.truncated = true;
    };
    const walk = (x, y) => {
      if (x === y) return;
      const xo = x !== null && typeof x === 'object';
      const yo = y !== null && typeof y === 'object';
      if (xo && yo && Array.isArray(x) === Array.isArray(y)) {
        if (Array.isArray(x)) {
          const n = Math.max(x.length, y.length);
          for (let i = 0; i < n; i++) {
            stack.push(i);
            if (i >= x.length) push('added', undefined, y[i]);
            else if (i >= y.length) push('removed', x[i], undefined);
            else walk(x[i], y[i]);
            stack.pop();
          }
        } else {
          for (const k of Object.keys(x)) {
            stack.push(k);
            if (!hasOwn(y, k)) push('removed', x[k], undefined);
            else walk(x[k], y[k]);
            stack.pop();
          }
          for (const k of Object.keys(y)) {
            if (hasOwn(x, k)) continue;
            stack.push(k);
            push('added', undefined, y[k]);
            stack.pop();
          }
        }
        return;
      }
      push('changed', x, y);
    };
    walk(a, b);
    return out;
  }

  // ---------------------------------------------------------------- structure checks
  const MAX_ISSUES = 60;
  const ENUM_MAX = { scope: 12, grip: 7, muzzle: 6, stock: 2, gesture: 2 };
  // coefficient names the app reads straight from the map (a missing one throws inside the app)
  const REQUIRED_COEF = ['compensatorMuzzle', 'flashHidderMuzzle', 'suppressorMuzzle', 'verticalGrip', 'horizontalGrip', 'halfGrip',
    'lightGrip', 'thumbGrip', 'laserGrip', 'generalStock', 'crouch', 'prone'];

  function collector() {
    const issues = [];
    let total = 0;
    return {
      add(level, segs, message) { total++; if (issues.length < MAX_ISSUES) issues.push({ level, path: formatPath(segs), message }); },
      done() {
        if (total > issues.length) issues.push({ level: 'warn', path: '$', message: `… và ${total - issues.length} vấn đề nữa (chỉ hiện ${MAX_ISSUES} đầu tiên).` });
        return issues;
      },
    };
  }

  function checkGroups(c, groups, base) {
    if (!Array.isArray(groups)) { c.add('error', base, 'Phải là một mảng các nhóm (mỗi nhóm một loại súng).'); return; }
    groups.forEach((g, gi) => {
      const gp = [...base, gi];
      if (!isObj(g)) { c.add('error', gp, 'Nhóm phải là một đối tượng có "v" và "coefficients".'); return; }
      if (!Array.isArray(g.v)) c.add('error', [...gp, 'v'], 'Phải là mảng các mục recoil.');
      else {
        g.v.forEach((e, ei) => {
          const ep = [...gp, 'v', ei];
          if (!isObj(e)) { c.add('error', ep, 'Mục phải là một đối tượng.'); return; }
          for (const [field, max] of Object.entries(ENUM_MAX)) {
            if (!isInt(e[field], 0, max)) c.add('error', [...ep, field], `"${field}" phải là số nguyên từ 0 đến ${max}.`);
          }
          const rv = e.recoilValue;
          if (!Array.isArray(rv) || !rv.length) { c.add('error', [...ep, 'recoilValue'], 'Phải là mảng có ít nhất một mốc [thời gian, giá trị].'); return; }
          let lastT = -Infinity;
          rv.forEach((p, pi) => {
            const pp = [...ep, 'recoilValue', pi];
            if (!Array.isArray(p) || p.length < 2 || !isNum(p[0]) || !isNum(p[1])) { c.add('error', pp, 'Mốc phải là [thời gian, giá trị] với hai số hợp lệ.'); if (Array.isArray(p) && isNum(p[0])) lastT = p[0]; return; }
            if (p[0] <= lastT) c.add('warn', pp, `Thời gian ${p[0]} không lớn hơn mốc trước (${lastT}); đường cong nên tăng dần theo thời gian.`);
            lastT = p[0];
          });
        });
      }
      if (!Array.isArray(g.coefficients)) c.add('error', [...gp, 'coefficients'], 'Phải là mảng các bảng hệ số (mỗi ống ngắm một bảng).');
      else {
        g.coefficients.forEach((co, ci) => {
          const cp = [...gp, 'coefficients', ci];
          if (!isObj(co)) { c.add('error', cp, 'Bảng hệ số phải là một đối tượng.'); return; }
          for (const k of REQUIRED_COEF) {
            if (!isNum(co[k])) c.add('error', [...cp, k], `Thiếu hệ số "${k}" hoặc không phải số (app đọc trực tiếp, thiếu sẽ gây lỗi).`);
          }
        });
      }
    });
  }

  function checkRecoil(c, k) {
    checkGroups(c, k.recoil_data, ['recoil_data']);
    if (hasOwn(k, 'sensitivity') && !(Array.isArray(k.sensitivity) && k.sensitivity.length === 7 && k.sensitivity.every((v) => isNum(v) && v > 0))) {
      c.add('warn', ['sensitivity'], 'Nên là mảng 7 số dương (hippie, 1x, 2x, 3x, 4x, 6x, 8x).');
    }
    if (hasOwn(k, 'recoil_value_coefficient') && !isNum(k.recoil_value_coefficient)) c.add('warn', ['recoil_value_coefficient'], 'Phải là một số.');
    if (hasOwn(k, 'ft_recoil_mode_profiles')) {
      const b = k.ft_recoil_mode_profiles;
      if (!isObj(b)) c.add('error', ['ft_recoil_mode_profiles'], 'Phải là một đối tượng.');
      else {
        for (const name of ['gyro_recoil_data', 'normal_touch_recoil_data']) {
          if (hasOwn(b, name)) checkGroups(c, b[name], ['ft_recoil_mode_profiles', name]);
        }
      }
    }
  }

  const BASE_NUM = ['base:x', 'base:y', 'base:width', 'base:height'];

  function checkComponents(c, k, { needId }) {
    if (!Array.isArray(k.components)) { c.add('error', ['components'], 'Phải là một mảng các thành phần.'); return; }
    k.components.forEach((comp, i) => {
      const p = ['components', i];
      if (!isObj(comp)) { c.add('warn', p, 'Thành phần phải là một đối tượng.'); return; }
      if (needId && typeof comp['base:componentIdentifier'] !== 'string') c.add('warn', [...p, 'base:componentIdentifier'], 'Thiếu mã loại thành phần (chuỗi).');
      if (!needId && !isNum(comp.type)) c.add('warn', [...p, 'type'], '"type" phải là số.');
      for (const f of BASE_NUM) if (!isNum(comp[f])) c.add('warn', [...p, f], `"${f}" phải là số.`);
    });
  }

  // kind: 'recoil' | 'recognition' | 'keymap'
  function validate(kind, keymap) {
    const c = collector();
    if (!isObj(keymap)) { c.add('error', [], 'Nội dung phải là một đối tượng JSON.'); return c.done(); }
    if (kind === 'recoil') checkRecoil(c, keymap);
    else if (kind === 'recognition') {
      for (const f of ['weaponSize', 'scopeSize', 'vehicleSize', 'vehicleCarSize', 'vehicleCarRectLeft', 'vehicleCarRectTop', 'vehicleCarRectRight', 'vehicleCarRectBottom']) {
        if (hasOwn(keymap, f) && !isNum(keymap[f])) c.add('warn', [f], `"${f}" phải là số.`);
      }
      checkComponents(c, keymap, { needId: false });
    } else {
      if (hasOwn(keymap, 'version') && typeof keymap.version !== 'string') c.add('warn', ['version'], '"version" nên là chuỗi.');
      checkComponents(c, keymap, { needId: true });
    }
    return c.done();
  }

  // issues in `after` that were not already in `before` (what this edit introduced)
  function newIssues(before, after) {
    const key = (i) => `${i.level}|${i.path}|${i.message}`;
    const seen = new Set(before.map(key));
    return after.filter((i) => !seen.has(key(i)));
  }

  return { parsePath, formatPath, childPath, getAt, setAt, diff, validate, newIssues };
});
