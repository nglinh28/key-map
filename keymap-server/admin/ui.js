'use strict';
// Shared helpers of the admin page (window.Ui): DOM builders, toast, modal dialog, API calls.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k.startsWith('aria-')) { n.setAttribute(k, String(v)); continue; } // aria-* booleans must be "true"/"false", never empty
      if (v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };
  const svgEl = (tag, attrs = {}, ...kids) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };
  const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);
  const short = (id) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
  const textBytes = (s) => new TextEncoder().encode(s).length;
  const clockTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('vi-VN') : '—');
  const clockDateTime = (iso) => (iso ? new Date(iso).toLocaleString('vi-VN') : '—');

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `show${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, isError ? 6000 : 2500);
  }

  const ERRORS_VI = {
    'Not found': 'Không tìm thấy.',
    'Internal error': 'Lỗi nội bộ của server.',
    'Invalid JSON': 'Dữ liệu gửi lên không phải JSON hợp lệ.',
    'Cross-site or missing X-Admin-Request': 'Yêu cầu bị chặn vì không đến từ chính trang quản trị này.',
    'Method not allowed': 'Phương thức không được phép.',
    Conflict: 'File đã bị thay đổi từ lúc bạn mở (có thể app vừa đồng bộ).',
    'Version not found': 'Không tìm thấy phiên bản lịch sử này.',
    'File not found': 'Không tìm thấy file này trên server.',
    'Backup not found': 'Không có bản sao lưu của ngày này.',
    'Invalid date': 'Ngày không hợp lệ.',
    'Device not found': 'Không tìm thấy thiết bị.',
    'text must be a string': 'Nội dung phải là văn bản.',
  };
  const viError = (msg) => ERRORS_VI[msg] || (msg.startsWith('Host not allowed') ? 'Địa chỉ truy cập này không được phép (xem ADMIN_ALLOWED_HOSTS).' : msg.startsWith('Body must be') ? 'Dữ liệu gửi lên sai định dạng.' : msg);

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (method !== 'GET') opts.headers['X-Admin-Request'] = '1';
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(`/admin/api${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(viError(data.error || `HTTP ${res.status}`));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  // Dialog with buttons; resolves with the id of the pressed action (null on Escape). The first action is the safe one and has the focus.
  function showModal({ title, tone = 'warn', body, actions }) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const done = (id) => { overlay.remove(); document.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus(); resolve(id); };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      const buttons = actions.map((a) => el('button', { class: `btn${a.primary ? ' primary' : ''}${a.danger ? ' danger-fill' : ''}`, onclick: () => done(a.id) }, a.label));
      const dialog = el('div', { class: `modal-card ${tone}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' },
        el('h2', { id: 'modal-title' }, title), el('div', { class: 'modal-body' }, body), el('div', { class: 'modal-actions' }, buttons));
      const overlay = el('div', { class: 'modal' }, dialog);
      document.body.append(overlay);
      document.addEventListener('keydown', onKey);
      buttons[0].focus();
    });
  }

  const brief = (v) => { if (v === undefined) return '—'; const t = JSON.stringify(v); return t.length > 70 ? `${t.slice(0, 70)}…` : t; };
  const KIND_VN = { added: 'Thêm', removed: 'Xóa', changed: 'Sửa' };
  // c: result of EditLib.diff
  function changesList(c) {
    return el('div', { class: 'changes mono' },
      c.changes.map((x) => el('div', {}, el('span', { class: `chg ${x.kind}` }, KIND_VN[x.kind]), ' ', el('span', { class: 'k' }, x.path), ': ',
        x.kind === 'added' ? el('span', { class: 's' }, brief(x.after)) : x.kind === 'removed' ? el('span', { class: 'n' }, brief(x.before))
          : [el('span', { class: 'n' }, brief(x.before)), ' → ', el('span', { class: 's' }, brief(x.after))])),
      c.truncated ? el('div', { class: 'muted' }, `… và ${c.total - c.changes.length} thay đổi nữa.`) : null);
  }

  function downloadText(name, text, type = 'application/xml;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.Ui = { $, el, svgEl, fmtBytes, short, textBytes, clockTime, clockDateTime, toast, api, guard, showModal, brief, changesList, downloadText };
})();
