'use strict';
// Helpers for the web page: JSON paths and a change summary (diff) between two JSON values.
// Works in the browser (window.EditLib) and in Node (tests).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EditLib = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/; // a whole key is an identifier

  // ---------------------------------------------------------------- paths: $.a.b[3]["odd key"]
  function formatKey(key) {
    if (typeof key === 'number') return `[${key}]`;
    return IDENT.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  }
  const formatPath = (segs) => `$${segs.map(formatKey).join('')}`;
  const childPath = (path, key) => `${path}${formatKey(key)}`;

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

  return { formatPath, childPath, diff };
});
