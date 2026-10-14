'use strict';
// The AI endpoints the server may ask, in the order they are tried. The first one is the endpoint of the environment (AI_BASE_URL / AI_API_KEY /
// AI_MODEL, normally FreeLLMAPI): it cannot be edited or removed from the page, only moved or switched off. The page may add more OpenAI-compatible
// endpoints with their own address, key and model; they are kept in DATA_DIR/ai-providers.json (mode 0600).
//
// What the page gets back never contains a key, nor the address of the environment endpoint (the README promises that): a key shows as
// "••••abcd" (its last 4 characters) and an empty key on save means "keep the one already stored".

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ENV_ID = 'env';
const MAX_PROVIDERS = 8;
const ID_RE = /^[a-z0-9-]{1,40}$/;

const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
const maskKey = (k) => (k ? `••••${k.slice(-4)}` : '');

function checkUrl(u) {
  let url;
  try { url = new URL(u); } catch { return 'Địa chỉ không hợp lệ (ví dụ http://192.168.4.6:3001/v1).'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Địa chỉ phải bắt đầu bằng http:// hoặc https://.';
  if (url.username || url.password) return 'Không ghi tài khoản/mật khẩu vào địa chỉ: dùng ô khóa API.';
  return '';
}

class AiProviders {
  // env: the endpoint of the environment ({ baseUrl, apiKey, model } from loadAiConfig); file: where the page's list is kept
  constructor({ env = {}, file = '' } = {}) {
    this.env = { baseUrl: trimUrl(env.baseUrl), apiKey: String(env.apiKey || ''), model: String(env.model || '') || 'auto' };
    this.file = file;
    this.list = this.load();
  }

  load() {
    let saved = null;
    if (this.file) { try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { saved = null; } }
    const out = [];
    for (const p of (saved && Array.isArray(saved.providers) ? saved.providers : [])) {
      if (!p || typeof p.id !== 'string') continue;
      if (p.id === ENV_ID) { if (!out.some((x) => x.id === ENV_ID)) out.push({ id: ENV_ID, enabled: p.enabled !== false }); continue; }
      if (!ID_RE.test(p.id) || out.some((x) => x.id === p.id) || checkUrl(trimUrl(p.baseUrl))) continue;
      out.push({ id: p.id, name: String(p.name || '').slice(0, 60) || 'AI', baseUrl: trimUrl(p.baseUrl), apiKey: String(p.apiKey || ''), model: String(p.model || '').trim().slice(0, 120) || 'auto', enabled: p.enabled !== false });
      if (out.length >= MAX_PROVIDERS + 1) break;
    }
    if (!out.some((x) => x.id === ENV_ID)) out.unshift({ id: ENV_ID, enabled: true }); // the default: FreeLLMAPI first
    return out;
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ providers: this.list }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* not every file system keeps modes */ }
  }

  // full entries (with key and address), in order: for the server only
  resolved() {
    return this.list.map((p) => (p.id === ENV_ID
      ? { id: ENV_ID, name: 'FreeLLMAPI (mặc định, cấu hình trên server)', baseUrl: this.env.baseUrl, apiKey: this.env.apiKey, model: this.env.model, enabled: p.enabled, builtin: true }
      : { ...p, builtin: false }));
  }

  // the ones a question may go to, in order: switched on and complete
  usable() { return this.resolved().filter((p) => p.enabled && p.baseUrl && p.apiKey); }

  // what the page may see
  publicList() {
    return this.resolved().map((p) => ({
      id: p.id, name: p.name, model: p.model, enabled: p.enabled, builtin: p.builtin,
      baseUrl: p.builtin ? '' : p.baseUrl, // the address of the environment endpoint stays on the server
      hasKey: Boolean(p.apiKey), keyHint: p.builtin ? '' : maskKey(p.apiKey),
      ready: Boolean(p.baseUrl && p.apiKey),
    }));
  }

  get(id) { return this.resolved().find((p) => p.id === id) || null; }

  // body: [{ id?, name, baseUrl, apiKey?, model, enabled }] in priority order, the environment endpoint as { id: 'env', enabled }.
  // -> { ok: true } or { ok: false, error }. Nothing is changed when anything is wrong.
  replace(items) {
    if (!Array.isArray(items)) return { ok: false, error: 'Danh sách không hợp lệ.' };
    const custom = items.filter((x) => x && x.id !== ENV_ID);
    if (custom.length > MAX_PROVIDERS) return { ok: false, error: `Tối đa ${MAX_PROVIDERS} nguồn AI thêm.` };
    const old = new Map(this.list.map((p) => [p.id, p]));
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const x = items[i];
      if (!x || typeof x !== 'object') return { ok: false, error: `Dòng ${i + 1} không hợp lệ.` };
      if (x.id === ENV_ID) {
        if (out.some((p) => p.id === ENV_ID)) return { ok: false, error: 'FreeLLMAPI xuất hiện hai lần.' };
        out.push({ id: ENV_ID, enabled: x.enabled !== false });
        continue;
      }
      const name = String(x.name || '').trim().slice(0, 60);
      const baseUrl = trimUrl(x.baseUrl);
      const model = String(x.model || '').trim().slice(0, 120) || 'auto';
      if (!name) return { ok: false, error: `Dòng ${i + 1}: cần tên.` };
      const bad = checkUrl(baseUrl);
      if (bad) return { ok: false, error: `${name}: ${bad}` };
      let id = typeof x.id === 'string' && ID_RE.test(x.id) && old.has(x.id) ? x.id : '';
      if (!id) id = `ai-${crypto.randomBytes(4).toString('hex')}`;
      if (out.some((p) => p.id === id)) return { ok: false, error: `${name}: trùng mã.` };
      const typed = typeof x.apiKey === 'string' ? x.apiKey.trim() : '';
      if (typed.length > 400) return { ok: false, error: `${name}: khóa API quá dài.` };
      // empty = keep the stored key, but only for the same server: otherwise anyone on the LAN could point the entry at their own host and
      // have the stored key sent there
      const prev = old.get(id);
      const sameOrigin = prev && new URL(prev.baseUrl).origin === new URL(baseUrl).origin;
      if (!typed && prev && !sameOrigin) return { ok: false, error: `${name}: đổi địa chỉ máy chủ thì phải nhập lại khóa API.` };
      const apiKey = typed || (prev && prev.apiKey) || '';
      if (!apiKey) return { ok: false, error: `${name}: cần khóa API.` };
      out.push({ id, name, baseUrl, apiKey, model, enabled: x.enabled !== false });
    }
    if (!out.some((p) => p.id === ENV_ID)) out.unshift({ id: ENV_ID, enabled: true }); // cannot be removed
    this.list = out;
    this.save();
    return { ok: true };
  }
}

module.exports = { AiProviders, ENV_ID, MAX_PROVIDERS, maskKey, checkUrl };
