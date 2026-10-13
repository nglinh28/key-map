'use strict';
// Web admin and sync API for the preference files (Documents/jya2/databases/*.xml): browse, edit, compare, download.
//
// There is deliberately no login: the server is meant for a trusted LAN. What it does guard against is a
// web page in your browser talking to it on your behalf (CSRF / DNS rebinding):
//   * the Host header must be an IP, localhost, a bare name, *.local / *.lan / *.home.arpa, or listed in ADMIN_ALLOWED_HOSTS;
//   * every write must carry `X-Admin-Request: 1` (a custom header forces a CORS preflight, which is never granted)
//     and, if the browser sends Origin / Sec-Fetch-Site, they must be same-origin.
// Do not expose this port to the internet.

const fs = require('node:fs');
const path = require('node:path');
const PKG_VERSION = require('./package.json').version;
const { DAY_RE } = require('./backup');
const { DEVICE_ID_RE } = require('./devices');
const CacheXml = require('./admin/cachexml');
const { manifestOf, serverCheck } = require('./verify');

const CACHE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_DELETE_IDS = 200;

const MAX_ADMIN_BODY = 64 * 1024 * 1024; // a 24 MB file can grow to about twice that once it is escaped into JSON
const PAGE_DIR = path.join(__dirname, 'admin');
const PAGES = {
  '/admin': ['index.html', 'text/html; charset=utf-8'],
  '/admin/': ['index.html', 'text/html; charset=utf-8'],
  '/admin/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/admin/recoil.js': ['recoil.js', 'text/javascript; charset=utf-8'],
  '/admin/edit.js': ['edit.js', 'text/javascript; charset=utf-8'],
  '/admin/layout.js': ['layout.js', 'text/javascript; charset=utf-8'],
  '/admin/cachexml.js': ['cachexml.js', 'text/javascript; charset=utf-8'],
  '/admin/ui.js': ['ui.js', 'text/javascript; charset=utf-8'],
  '/admin/analysis.js': ['analysis.js', 'text/javascript; charset=utf-8'],
  '/admin/palette.js': ['palette.js', 'text/javascript; charset=utf-8'],
  '/admin/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/admin/app.css': ['app.css', 'text/css; charset=utf-8'],
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function hostAllowed(hostHeader, extra = []) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  if (/^\[[0-9a-f:.]+\](:\d+)?$/.test(host)) return true; // IPv6 literal
  const name = host.replace(/:\d+$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true; // IPv4 literal
  if (name === 'localhost' || !name.includes('.')) return true;
  if (/\.(local|lan)$/.test(name) || name.endsWith('.home.arpa')) return true;
  return extra.includes(name);
}

function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch {
    return false;
  }
}

const safeDecode = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

function createAdmin({ cfg, devices, backups, databases, commands, readBody }) {
  const pageCache = new Map();

  function json(res, status, body, extra = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...SECURITY_HEADERS, ...extra });
    res.end(data);
  }
  const err = (res, status, message) => json(res, status, { error: message });

  function servePage(res, pathname) {
    const [file, type] = PAGES[pathname];
    let body = pageCache.get(file);
    if (!body) {
      body = fs.readFileSync(path.join(PAGE_DIR, file));
      pageCache.set(file, body);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, ...SECURITY_HEADERS });
    res.end(body);
  }

  async function jsonBody(req) {
    const text = await readBody(req, Math.max(cfg.maxBody, MAX_ADMIN_BODY));
    if (!text.trim()) return {};
    try { return JSON.parse(text); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }

  const remoteOf = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  // identity the Android app puts on every sync request (name is percent-encoded UTF-8)
  function identityOf(req) {
    const id = req.headers['x-device-id'];
    if (typeof id !== 'string' || !DEVICE_ID_RE.test(id)) return null;
    let name = '';
    try { name = decodeURIComponent(String(req.headers['x-device-name'] || '')); } catch { /* keep empty */ }
    return { id, name };
  }

  const validFiles = (files) => Array.isArray(files) && files.every((f) => f && typeof f.name === 'string' && typeof f.text === 'string');
  const snapshotNow = () => { try { backups.snapshot(); } catch (e) { console.error('backup failed:', e.message); } };

  // What a device pushes is stored as it is, except that items the web page deleted (and the device has not yet confirmed) stay deleted.
  function withoutDeleted(files, deviceId) {
    const pending = commands.pendingFor(deviceId).filter((c) => c.type === 'delete_cache_items');
    if (!pending.length) return files;
    return files.map((f) => {
      const ids = pending.filter((c) => c.file === f.name).flatMap((c) => c.ids);
      if (!ids.length) return f;
      try { return { ...f, text: CacheXml.removeItems(f.text, ids).text }; } catch { return f; }
    });
  }

  // POST /admin/api/cache/delete { file, ids, etag }: cuts items out of the keymap cache on the server now and leaves a command for the tablets.
  async function deleteCacheItems(req, res) {
    const body = await jsonBody(req);
    const name = typeof body.file === 'string' ? body.file : 'gamwing_keymap_cache.xml';
    const ids = body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_DELETE_IDS || ids.some((x) => typeof x !== 'string' || !CACHE_ID_RE.test(x))) return err(res, 400, 'Invalid ids');
    const current = databases.read(name);
    if (!current) return err(res, 404, 'File not found');
    if (typeof body.etag !== 'string' || body.etag !== current.etag) return json(res, 409, { error: 'Conflict', etag: current.etag });
    let cut;
    try { cut = CacheXml.removeItems(current.text, ids); } catch (e) { return err(res, 400, e.message); }
    if (!cut.removedMaps.length && !cut.lists.length) return err(res, 404, 'Item not found');
    backups.actor = 'Giao diện web';
    const saved = databases.update(name, cut.text, current.etag);
    if (saved.status !== 200) return json(res, saved.status, { error: saved.error, ...(saved.etag ? { etag: saved.etag } : {}) });
    snapshotNow();
    const targets = devices.list().map((d) => ({ id: d.id, name: d.name }));
    // names for the tablet: from items [{id,label}], or labels in the order of the request
    const names = new Map();
    if (Array.isArray(body.items)) for (const it of body.items) if (it && typeof it.id === 'string' && typeof it.label === 'string') names.set(it.id, it.label);
    else if (Array.isArray(body.labels)) ids.forEach((x, i) => { if (typeof body.labels[i] === 'string') names.set(x, body.labels[i]); });
    if (!names.size && Array.isArray(body.labels)) ids.forEach((x, i) => { if (typeof body.labels[i] === 'string') names.set(x, body.labels[i]); });
    const done = [...new Set([...cut.removedMaps, ...cut.lists.flatMap((l) => l.removed)])];
    const command = commands.create({ type: 'delete_cache_items', file: name, ids: done, labels: done.map((x) => names.get(x) || ''), targets });
    return json(res, 200, {
      ok: true, etag: saved.etag, removedMaps: cut.removedMaps, lists: cut.lists, missing: cut.missing, warnings: cut.warnings,
      command: { id: command.id, targets: command.targets.length },
    });
  }

  async function api(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    let m;
    const who = p.startsWith('/admin/api/sync/') ? identityOf(req) : null;
    if (who) devices.touch(who.id, who.name, remoteOf(req)); // any sync request is a sign of life

    if (p === '/admin/api/sync/info' && method === 'GET') {
      backups.ensureToday();
      const files = databases.names().length;
      return json(res, 200, {
        ok: true, server: 'ft-keymap-server', version: PKG_VERSION, files, docs: files,
        web: { sessions: devices.webSessions() }, devices_online: devices.onlineCount(), backup_days: backups.list().length,
      });
    }
    // ---- who is connected
    if (p === '/admin/api/sync/hello' && method === 'POST') {
      const body = await jsonBody(req);
      const id = body && body.id;
      if (typeof id !== 'string' || !DEVICE_ID_RE.test(id)) return err(res, 400, 'Invalid device id');
      const device = devices.hello(id, body, remoteOf(req));
      backups.ensureToday();
      const pending = commands.pendingFor(id).map((c) => ({ id: c.id, type: c.type, file: c.file, ids: c.ids, labels: c.labels }));
      return json(res, 200, { ok: true, now: new Date().toISOString(), online: devices.onlineCount(), web: { sessions: devices.webSessions() }, device, commands: pending });
    }
    if (p === '/admin/api/sync/devices' && method === 'GET') {
      return json(res, 200, { now: new Date().toISOString(), web: { sessions: devices.webSessions() }, devices: devices.list() });
    }
    if ((m = /^\/admin\/api\/sync\/devices\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      return devices.forget(safeDecode(m[1])) ? json(res, 200, { ok: true }) : err(res, 404, 'Device not found');
    }
    if (p === '/admin/api/presence' && method === 'POST') {
      const body = await jsonBody(req);
      const session = body && body.session;
      if (typeof session !== 'string' || !DEVICE_ID_RE.test(session)) return err(res, 400, 'Invalid session');
      return json(res, 200, { ok: true, sessions: devices.presence(session) });
    }
    // ---- deleting items of the keymap cache (the web page asks, the tablet app does the same on its side)
    if (p === '/admin/api/cache/delete' && method === 'POST') return deleteCacheItems(req, res);
    if (p === '/admin/api/cache/commands' && method === 'GET') return json(res, 200, { commands: commands.list() });
    if ((m = /^\/admin\/api\/sync\/commands\/([^/]+)\/result$/.exec(p)) && method === 'POST') {
      if (!who) return err(res, 400, 'Invalid device id');
      const body = await jsonBody(req);
      return commands.report(safeDecode(m[1]), who.id, body) ? json(res, 200, { ok: true }) : err(res, 404, 'Command not found');
    }
    // ---- "kiểm tra đồng bộ": what the server holds against its newest backup day; fingerprints for the app; ask the tablet to check itself
    if (p === '/admin/api/sync/verify' && method === 'GET') {
      backups.ensureToday();
      return json(res, 200, serverCheck({ databases, backups }));
    }
    if (p === '/admin/api/sync/manifest' && method === 'GET') {
      backups.ensureToday();
      const days = backups.list();
      return json(res, 200, { at: new Date().toISOString(), latest: manifestOf(databases.all()), day: days.length ? { date: days[0].date, files: manifestOf(backups.readDatabases(days[0].date)) } : null });
    }
    if (p === '/admin/api/sync/verify-request' && method === 'POST') {
      const targets = devices.list().map((d) => ({ id: d.id, name: d.name }));
      const command = commands.create({ type: 'verify_sync', file: '', ids: [], targets });
      return json(res, 200, { ok: true, command: { id: command.id, targets: command.targets.length } });
    }
    // ---- daily backups
    if (p === '/admin/api/sync/backups' && method === 'GET') {
      backups.ensureToday();
      return json(res, 200, { days: backups.list() });
    }
    if ((m = /^\/admin\/api\/sync\/backups\/([^/]+)\/databases\/([^/]+)$/.exec(p)) && method === 'GET') {
      const day = safeDecode(m[1]);
      if (!DAY_RE.test(day)) return err(res, 400, 'Invalid date');
      const found = backups.readDatabase(day, safeDecode(m[2]));
      return found ? json(res, 200, found) : err(res, 404, 'File not found');
    }
    if ((m = /^\/admin\/api\/sync\/backups\/([^/]+)\/databases$/.exec(p)) && method === 'GET') {
      const day = safeDecode(m[1]);
      if (!DAY_RE.test(day)) return err(res, 400, 'Invalid date');
      if (!backups.read(day)) return err(res, 404, 'Backup not found');
      const files = backups.readDatabases(day);
      if (who) devices.recordPull(who.id, files.length);
      return json(res, 200, { date: day, files });
    }
    // ---- the app's own preference files (Documents/jya2/databases/*.xml)
    if (p === '/admin/api/sync/databases' && method === 'GET') return json(res, 200, { files: databases.list() });
    if (p === '/admin/api/sync/databases/push' && method === 'POST') {
      const body = await jsonBody(req);
      const files = body && body.files;
      if (!validFiles(files)) return err(res, 400, 'Body must be {"files":[{"name":"…","text":"…"}]}');
      backups.actor = who ? (who.name || who.id) : 'Ứng dụng đồng bộ'; // recorded in the manifest of today's backup
      const result = databases.put(who ? withoutDeleted(files, who.id) : files, { folder: body.folder, device: backups.actor });
      if (who) devices.recordPush(who.id, result);
      if (result.saved > 0) snapshotNow(); else backups.ensureToday();
      return json(res, 200, { saved: result.saved, unchanged: result.unchanged, skipped: result.skipped, changed: result.changed });
    }
    if ((m = /^\/admin\/api\/sync\/databases\/([^/]+)\/history(?:\/([^/]+))?$/.exec(p)) && method === 'GET') {
      const name = safeDecode(m[1]);
      if (!databases.read(name)) return err(res, 404, 'File not found');
      if (!m[2]) return json(res, 200, { versions: databases.versions(name) });
      const v = databases.readVersion(name, safeDecode(m[2]));
      return v ? json(res, 200, v) : err(res, 404, 'Version not found');
    }
    if ((m = /^\/admin\/api\/sync\/databases\/([^/]+)$/.exec(p)) && method === 'GET') {
      const found = databases.read(safeDecode(m[1]));
      return found ? json(res, 200, found) : err(res, 404, 'File not found');
    }
    if ((m = /^\/admin\/api\/sync\/databases\/([^/]+)$/.exec(p)) && method === 'PUT') {
      const body = await jsonBody(req);
      backups.actor = 'Giao diện web';
      const r = databases.update(safeDecode(m[1]), body && body.text, body && body.etag);
      if (r.status !== 200) return json(res, r.status, { error: r.error, ...(r.etag ? { etag: r.etag } : {}) });
      if (r.saved > 0) snapshotNow();
      return json(res, 200, { ok: true, saved: r.saved, etag: r.etag, history: r.history });
    }
    // ---- delete everything the server keeps (preference files with their history, daily backups).
    // Deliberate and noisy on purpose: a typed confirmation, and the last wipe is kept in <data>/_wiped/ so one mistake can be undone by hand.
    if (p === '/admin/api/sync/wipe' && method === 'POST') {
      const body = await jsonBody(req);
      if (!body || body.confirm !== 'XOA TAT CA') return err(res, 400, 'Confirmation required: {"confirm":"XOA TAT CA"}');
      const root = path.join(cfg.dataDir, '_wiped');
      fs.rmSync(root, { recursive: true, force: true }); // only the most recent wipe is kept
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(root, stamp);
      fs.mkdirSync(dest, { recursive: true });
      const moved = [];
      for (const n of ['backups', 'databases']) {
        const from = path.join(cfg.dataDir, n);
        if (fs.existsSync(from)) { fs.renameSync(from, path.join(dest, n)); moved.push(n); }
      }
      return json(res, 200, { ok: true, moved, kept_in: `_wiped/${stamp}` });
    }
    return err(res, 404, 'Not found');
  }

  // Handles every request under /admin.
  return async function handle(req, res, url) {
    try {
      if (!hostAllowed(req.headers.host, cfg.adminAllowedHosts)) return err(res, 403, 'Host not allowed (set ADMIN_ALLOWED_HOSTS)');
      const method = req.method;
      if (method !== 'GET' && method !== 'HEAD') {
        if (req.headers['x-admin-request'] !== '1' || !sameOrigin(req)) return err(res, 403, 'Cross-site or missing X-Admin-Request');
      }
      if (Object.hasOwn(PAGES, url.pathname)) return method === 'GET' ? servePage(res, url.pathname) : err(res, 405, 'Method not allowed');
      if (url.pathname.startsWith('/admin/api/')) return await api(req, res, url);
      return err(res, 404, 'Not found');
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return err(res, status, status === 500 ? 'Internal error' : e.message);
    }
  };
}

module.exports = { createAdmin, hostAllowed, sameOrigin };
