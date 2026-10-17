'use strict';
// The window that compares the two suggestions for the points of a recoil combination: what the server worked out from similar guns
// and what the AI answered. Both are asked at the same time; the user picks exactly ONE of them (or cancels). Nothing is saved here:
// the caller puts the chosen points into the editor, where they are an ordinary unsaved change.
(() => {
  const { el, svgEl, icon, api, badge, alert, showModal } = window.Ui;
  const RL = window.RecoilLib;

  const vn = (n, d = 2) => Number(n).toFixed(d).replace('.', ',');
  const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1).replace('.', ',')}%`;
  const failure = (e) => ({ ok: false, reason: e && e.message ? e.message : 'Không gọi được server.' });

  // how far a curve is from the coefficient curve, as a mean relative difference on a time axis normalised by duration
  function meanDiff(curve, ref) {
    if (!ref || !ref.length) return null;
    const dc = curve[curve.length - 1][0] || 1;
    const dr = ref[ref.length - 1][0] || 1;
    const at = (c, t) => {
      if (t <= c[0][0]) return c[0][1];
      for (let i = 1; i < c.length; i++) if (t <= c[i][0]) { const [t0, v0] = c[i - 1]; const [t1, v1] = c[i]; return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0); }
      return c[c.length - 1][1];
    };
    let sum = 0; let n = 0;
    for (let i = 0; i < 20; i++) {
      const u = i / 19;
      const r = at(ref, u * dr);
      if (Math.abs(r) < 1e-9) continue;
      sum += at(curve, u * dc) / r - 1; n++;
    }
    return n ? sum / n : null;
  }

  // series: [{ label, curve, cls, mark: 'circle'|'square'|null }]
  function compareChart(series) {
    const all = series.filter((s) => s.curve && s.curve.length);
    const W = 900; const H = 260; const L = 56; const R = 14; const T = 14; const B = 30;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart compare-chart', role: 'img', 'aria-label': `So sánh đường cong: ${all.map((s) => s.label).join(', ')}` });
    if (!all.length) return svg;
    const tMax = Math.max(1, ...all.map((s) => s.curve[s.curve.length - 1][0]));
    const vs = all.flatMap((s) => s.curve.map((p) => p[1]));
    const vMin = Math.min(0, ...vs);
    let vMax = Math.max(...vs);
    if (vMax === vMin) vMax = vMin + 1;
    vMax += (vMax - vMin) * 0.08;
    const x = (t) => L + (t / tMax) * (W - L - R);
    const y = (v) => T + (1 - (v - vMin) / (vMax - vMin)) * (H - T - B);
    for (let i = 0; i <= 4; i++) {
      const v = vMin + ((vMax - vMin) * i) / 4;
      svg.append(svgEl('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }), svgEl('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, v.toFixed(0)));
      const t = (tMax * i) / 4;
      svg.append(svgEl('text', { x: x(t), y: H - 10, 'text-anchor': i === 4 ? 'end' : 'middle' }, `${Math.round(t)} ms`));
    }
    for (const s of all) {
      svg.append(svgEl('polyline', { class: `series ${s.cls}`, fill: 'none', points: s.curve.map(([t, v]) => `${x(t)},${y(v)}`).join(' ') }));
      if (s.mark) {
        for (const [t, v] of s.curve) {
          svg.append(s.mark === 'square'
            ? svgEl('rect', { class: `mark ${s.cls}`, x: x(t) - 3.5, y: y(v) - 3.5, width: 7, height: 7 }, svgEl('title', {}, `${s.label}: t=${t} ms, giá trị=${vn(v)}`))
            : svgEl('circle', { class: `mark ${s.cls}`, cx: x(t), cy: y(v), r: 3.5 }, svgEl('title', {}, `${s.label}: t=${t} ms, giá trị=${vn(v)}`)));
        }
      }
    }
    return svg;
  }

  function legend(series) {
    return el('div', { class: 'compare-legend' }, series.filter((s) => s.curve && s.curve.length).map((s) =>
      el('span', { class: 'legend-item' }, svgEl('svg', { viewBox: '0 0 28 10', width: 28, height: 10, 'aria-hidden': 'true' }, svgEl('line', { class: `series ${s.cls}`, x1: 1, x2: 27, y1: 5, y2: 5 })), s.label)));
  }

  function pointsList(curve) {
    return el('details', { class: 'disclosure' }, el('summary', {}, `Xem ${curve.length} mốc`),
      el('div', { class: 'disclosure-body' }, el('div', { class: 'mono text-xs points-list' }, curve.map(([t, v], i) => el('div', {}, `#${i + 1}  ${t} ms  →  ${vn(v)}`)))));
  }

  // body: { id, mode, combo } as the two routes expect it. ai: { enabled, model } from /ai/status.
  // Resolves { source: 'server' | 'ai', curve } or null (cancelled / nothing chosen).
  async function compare({ title, label, body, ai, current }) {
    let open = true;
    const picked = { source: '' };
    const state = { server: { status: 'loading' }, ai: { status: ai.enabled ? 'loading' : 'off' } };

    // started before the window opens: the two run side by side
    const serverP = api('POST', '/recoil/suggest', body).catch(failure);
    const stopAi = new AbortController(); // closing the window drops the AI request, so the AI is free for the next question
    const aiP = ai.enabled ? api('POST', '/ai/suggest-curve', body, { signal: stopAi.signal }).catch(failure) : Promise.resolve(null);

    const radios = {};
    const slots = { server: el('div', { class: 'pick-body' }), ai: el('div', { class: 'pick-body' }) };
    const chartSlot = el('div', { class: 'compare-chart-slot' });
    const liveNote = el('div', { class: 'muted text-xs', role: 'status', 'aria-live': 'polite' });
    let modalApi = null;

    const result = (k) => (state[k].status === 'ok' ? state[k].data : null);
    const refDiff = (k) => { const d = result(k); const ref = state.server.data && state.server.data.computed; return d && ref ? meanDiff(d.curve, ref) : null; };

    function pickCard(k, heading, hint) {
      const input = el('input', { type: 'radio', name: 'suggest-pick', value: k, disabled: true, onchange: () => { picked.source = k; sync(); } });
      radios[k] = input;
      return el('label', { class: 'pick-card', 'data-source': k }, el('div', { class: 'pick-head' }, input, el('span', { class: 'pick-title' }, heading), hint), slots[k]);
    }

    function drawBody(k) {
      const s = state[k];
      const slot = slots[k];
      if (s.status === 'loading') { slot.replaceChildren(el('p', { class: 'muted' }, k === 'ai' ? 'Đang hỏi AI… (có thể mất vài chục giây, bạn vẫn chọn được kết quả của server)' : 'Đang tính…')); return; }
      if (s.status === 'off') { slot.replaceChildren(el('p', { class: 'muted' }, 'AI chưa được cấu hình trên server (đặt AI_BASE_URL và AI_API_KEY, xem README).')); return; }
      if (s.status === 'fail') { slot.replaceChildren(alert('warn', el('span', {}, s.reason))); return; }
      const d = s.data;
      const st = RL.curveStats(d.curve);
      const diff = refDiff(k);
      const lines = [
        el('div', {}, `${st.points} mốc · ${Math.round(st.duration)} ms · giá trị ${vn(st.v0)} → ${vn(st.vEnd)}`),
        diff == null ? null : el('div', { class: 'muted' }, `So với đường cong theo hệ số: ${pct(diff)} (trung bình)`),
      ];
      if (k === 'server') {
        lines.push(el('div', { class: 'muted' }, `Học từ ${d.similar.length} súng tương tự: ${d.similar.map((x) => x.name).join(', ')}`));
        lines.push(el('div', { class: 'muted' }, `Hiệu chỉnh so với hệ số: ×${vn(d.factor.mean)} (từ ×${vn(d.factor.min)} đến ×${vn(d.factor.max)}), thời gian ×${vn(d.stretch)}`));
      } else {
        lines.push(el('div', { class: 'muted' }, `Model: ${d.model || ai.model}${d.ms ? ` · ${(d.ms / 1000).toFixed(1).replace('.', ',')} giây` : ''}`));
        if (d.reasoning) lines.push(el('p', { class: 'ai-reason' }, d.reasoning));
      }
      lines.push(pointsList(d.curve));
      slot.replaceChildren(...lines.filter(Boolean));
    }

    function series() {
      const s = state.server.data; const a = state.ai.data;
      return [
        { label: 'Theo hệ số (app dùng nếu không có mục riêng)', curve: s && s.computed, cls: 'series-coef', mark: null },
        { label: 'Server (từ súng tương tự)', curve: result('server') && result('server').curve, cls: 'series-server', mark: 'circle' },
        { label: 'AI', curve: a && state.ai.status === 'ok' ? a.curve : null, cls: 'series-ai', mark: 'square' },
        { label: 'Đang có trong ô sửa', curve: current, cls: 'series-now', mark: null },
      ];
    }
    function drawChart() { const sr = series(); chartSlot.replaceChildren(compareChart(sr), legend(sr)); }

    // one radio can be chosen, only when its result exists; the button follows
    function sync() {
      for (const k of ['server', 'ai']) {
        radios[k].disabled = state[k].status !== 'ok';
        radios[k].checked = picked.source === k && state[k].status === 'ok';
        radios[k].closest('.pick-card').classList.toggle('chosen', radios[k].checked);
        radios[k].closest('.pick-card').classList.toggle('unavailable', state[k].status !== 'ok' && state[k].status !== 'loading');
      }
      if (modalApi) modalApi.setDisabled('apply', !(picked.source && state[picked.source].status === 'ok'));
      const waiting = Object.values(state).some((s) => s.status === 'loading');
      liveNote.textContent = picked.source ? `Đã chọn kết quả của ${picked.source === 'ai' ? 'AI' : 'server'}.` : waiting ? 'Đang chờ kết quả…' : 'Chọn một trong hai kết quả để dùng.';
    }

    function settle(k, r) {
      if (!open) return;
      if (r == null) return; // AI not configured: already shown as off
      state[k] = r.ok ? { status: 'ok', data: r } : { status: 'fail', reason: r.reason || 'Không có kết quả.', data: r };
      drawBody(k); drawChart();
      if (k === 'server') drawBody('ai'); // the "so với hệ số" line of the AI card needs the coefficient curve
      sync();
    }

    const grid = el('div', { class: 'pick-grid' },
      pickCard('server', 'Kết quả của server', badge('tính từ dữ liệu', 'info')),
      pickCard('ai', 'Kết quả của AI', badge(ai.enabled ? ai.model : 'chưa bật', ai.enabled ? 'accent' : 'neutral')));
    drawBody('server'); drawBody('ai'); drawChart(); sync();

    const choice = showModal({
      title: title || 'So sánh kết quả: server và AI',
      tone: 'info',
      className: 'suggest-modal',
      body: [
        el('p', { class: 'mono font-semibold' }, label),
        el('p', { class: 'muted text-xs' }, 'Server và AI chạy cùng lúc. Chọn đúng một kết quả: các mốc của nó sẽ được điền vào ô sửa (chưa lưu), bạn xem và chỉnh tiếp rồi mới bấm Lưu.'),
        chartSlot,
        grid,
        liveNote,
      ],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'apply', label: 'Dùng kết quả đã chọn', primary: true, disabled: true }],
      onOpen: (m) => { modalApi = m; sync(); },
    });

    serverP.then((r) => settle('server', r));
    aiP.then((r) => settle('ai', r));

    const ok = await choice;
    open = false;
    stopAi.abort();
    if (ok !== 'apply' || !picked.source || state[picked.source].status !== 'ok') return null;
    return { source: picked.source, curve: state[picked.source].data.curve.map(([t, v]) => [t, v]) };
  }

  // How different the results of many combinations are, one row each: server and AI against the coefficient curve, and the AI against the server.
  // The user chooses per row (AI / server / skip) and applies them all at once. Nothing is saved here.
  // items: [{ key, label, coef: [[t,v]...], server: { ok, curve }|null, ai: { ok, curve }|null }]. -> [{ key, source, curve }] or null (cancelled).
  const WARN = 0.25; // a mean difference above this (25%) is shown as a warning
  async function reviewBatch({ items, aiOn }) {
    const rows = items.map((it) => {
      const s = it.server && it.server.ok ? it.server.curve : null;
      const a = it.ai && it.ai.ok ? it.ai.curve : null;
      const dS = s ? meanDiff(s, it.coef) : null;
      const dA = a ? meanDiff(a, it.coef) : null;
      const dAS = s && a ? meanDiff(a, s) : null;
      // default: the AI when it is within the warning margin of the coefficient curve, else the server, else (only the AI answered) skip
      const choice = a && (dA == null || Math.abs(dA) <= WARN) ? 'ai' : s ? 'server' : 'skip';
      return { it, s, a, dS, dA, dAS, choice, why: it.ai && !it.ai.ok ? it.ai.reason : '', whyServer: it.server && !it.server.ok ? it.server.reason : '' };
    });
    const worst = (r) => Math.max(...[r.dS, r.dA].filter((x) => x != null).map(Math.abs), 0);
    let onlyBig = false;
    let modalApi = null;
    const list = el('div', { class: 'batch-list' });
    const summary = el('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
    const diffTag = (d) => (d == null ? el('span', { class: 'muted' }, '—') : el('span', { class: Math.abs(d) > WARN ? 'tag warn' : 'tag' }, pct(d)));
    const paintSummary = () => {
      const n = (c) => rows.filter((r) => r.choice === c).length;
      const use = n('ai') + n('server');
      summary.textContent = `Sẽ điền ${use}/${rows.length} tổ hợp: AI ${n('ai')}, server ${n('server')} · bỏ qua ${n('skip')} (bản nháp, chưa lưu).`;
      if (modalApi) modalApi.setDisabled('apply', use === 0);
    };
    function rowNode(r) {
      const select = el('select', { 'aria-label': `Chọn kết quả cho ${r.it.label}`, onchange: (e) => { r.choice = e.target.value; paintSummary(); } },
        el('option', { value: 'ai', disabled: !r.a, selected: r.choice === 'ai' }, 'AI'),
        el('option', { value: 'server', disabled: !r.s, selected: r.choice === 'server' }, 'Server'),
        el('option', { value: 'skip', selected: r.choice === 'skip' }, 'Bỏ qua'));
      select.onclick = (e) => e.stopPropagation();
      const chart = el('div', { class: 'compare-chart-slot' });
      const det = el('details', { class: 'batch-row' },
        el('summary', {},
          el('span', { class: 'batch-name' }, r.it.label),
          el('span', { class: 'batch-cell', 'data-label': 'Server so với hệ số' }, diffTag(r.dS)),
          el('span', { class: 'batch-cell', 'data-label': 'AI so với hệ số' }, diffTag(r.dA)),
          el('span', { class: 'batch-cell', 'data-label': 'AI so với server' }, diffTag(r.dAS)),
          select),
        chart,
        r.why ? el('p', { class: 'muted text-xs' }, `AI: ${r.why}`) : null,
        r.whyServer ? el('p', { class: 'muted text-xs' }, `Server: ${r.whyServer}`) : null);
      det.addEventListener('toggle', () => {
        if (!det.open || chart.childElementCount) return;
        const sr = [
          { label: 'Theo hệ số (app dùng nếu không có mục riêng)', curve: r.it.coef, cls: 'series-coef', mark: null },
          { label: 'Server (từ súng tương tự)', curve: r.s, cls: 'series-server', mark: 'circle' },
          { label: 'AI', curve: r.a, cls: 'series-ai', mark: 'square' },
        ];
        chart.replaceChildren(compareChart(sr), legend(sr));
      });
      r.node = det;
      r.select = select;
      return det;
    }
    function paintList() {
      const shown = rows.filter((r) => !onlyBig || worst(r) > WARN || (r.dAS != null && Math.abs(r.dAS) > WARN));
      list.replaceChildren(...(shown.length ? shown.map((r) => r.node || rowNode(r)) : [el('p', { class: 'muted' }, 'Không có dòng nào lệch nhiều.')]));
    }
    const setAll = (fn) => { for (const r of rows) { r.choice = fn(r); if (r.select) r.select.value = r.choice; } paintSummary(); };
    const quick = (label, fn) => el('button', { type: 'button', class: 'btn small ghost', onclick: () => { setAll(fn); paintList(); } }, label);
    const bigBox = el('input', { type: 'checkbox', onchange: (e) => { onlyBig = e.target.checked; paintList(); } });
    const bigCount = rows.filter((r) => worst(r) > WARN || (r.dAS != null && Math.abs(r.dAS) > WARN)).length;
    for (const r of rows) rowNode(r);
    paintList(); paintSummary();
    const choice = await showModal({
      title: `So sánh kết quả của ${rows.length} tổ hợp`, tone: 'info', className: 'wide',
      body: [
        el('p', { class: 'muted' }, `Mỗi dòng: độ khác nhau trung bình giữa các đường cong (so sánh trên trục thời gian chuẩn hóa) · màu cảnh báo khi lệch hơn ${Math.round(WARN * 100)}%. Bấm một dòng để xem biểu đồ chồng ba đường cong. Chọn AI, server hoặc bỏ qua cho từng dòng.`),
        el('div', { class: 'row batch-tools' },
          quick('Mặc định', (r) => r.a && (r.dA == null || Math.abs(r.dA) <= WARN) ? 'ai' : r.s ? 'server' : 'skip'),
          aiOn ? quick('Tất cả dùng AI (nếu có)', (r) => (r.a ? 'ai' : r.s ? 'server' : 'skip')) : null,
          quick('Tất cả dùng server (nếu có)', (r) => (r.s ? 'server' : 'skip')),
          quick('Bỏ qua tất cả', () => 'skip'),
          el('label', { class: 'check' }, bigBox, ` Chỉ dòng lệch nhiều (${bigCount})`)),
        summary,
        el('div', { class: 'batch-head', 'aria-hidden': 'true' }, el('span', {}, 'Tổ hợp'), el('span', { class: 'batch-cell' }, 'Server / hệ số'), el('span', { class: 'batch-cell' }, 'AI / hệ số'), el('span', { class: 'batch-cell' }, 'AI / server'), el('span', {}, 'Dùng')),
        list,
      ],
      actions: [{ id: 'cancel', label: 'Hủy' }, { id: 'apply', label: 'Điền vào bảng (chưa lưu)', primary: true }],
      onOpen: (m) => { modalApi = m; paintSummary(); },
    });
    if (choice !== 'apply') return null;
    return rows.filter((r) => r.choice !== 'skip').map((r) => ({ key: r.it.key, source: r.choice, curve: (r.choice === 'ai' ? r.a : r.s).map(([t, v]) => [t, v]) }));
  }

  window.SuggestUi = { compare, compareChart, meanDiff, reviewBatch };
})();
