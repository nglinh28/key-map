'use strict';
// Web admin for the keymap store: browse, download, delete and import (phone cache backup) keymaps.
//
// There is deliberately no login: the server is meant for a trusted LAN. What it does guard against is a
// web page in your browser talking to it on your behalf (CSRF / DNS rebinding):
//   * the Host header must be an IP, localhost, a bare name, *.local / *.lan / *.home.arpa, or listed in ADMIN_ALLOWED_HOSTS;
//   * every write must carry `X-Admin-Request: 1` (a custom header forces a CORS preflight, which is never granted)
//     and, if the browser sends Origin / Sec-Fetch-Site, they must be same-origin.
// Do not expose this port to the internet.

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const PKG_VERSION = require('./package.json').version;
const { buildCacheFiles, DAY_RE } = require('./backup');
const { DEVICE_ID_RE } = require('./devices');

const ACCOUNT_RE = /^[ct]_[a-f0-9]{32}$/;
const DATE_RE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
const VERSION_RE = /^\d{8}T\d{9}Z-[a-f0-9]{4}$/;
const MAX_HISTORY = 20; // snapshots kept per document
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const PAGE_DIR = path.join(__dirname, 'admin');
const PAGES = {
  '/admin': ['index.html', 'text/html; charset=utf-8'],
  '/admin/': ['index.html', 'text/html; charset=utf-8'],
  '/admin/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/admin/recoil.js': ['recoil.js', 'text/javascript; charset=utf-8'],
  '/admin/edit.js': ['edit.js', 'text/javascript; charset=utf-8'],
  '/admin/layout.js': ['layout.js', 'text/javascript; charset=utf-8'],
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

// What a stored document is, from its namespace. The UI shows these as separate sections.
//   recoil       -> recoil/config data: per-weapon compensation curves + sensitivity
//   recognition  -> AI recognition maps: where the weapon/scope/vehicle icons are on screen
//   keymap       -> everything else: keyboard/mouse layouts (per game, or the general remote-control one)
const RECOIL_NS = 'com.zjx.pubg.rcConfig2';
const RECOGNITION_PREFIX = 'com.zjx.pubg.recognition.';
function kindOf(ns) {
  if (ns === RECOIL_NS) return 'recoil';
  if (typeof ns === 'string' && ns.startsWith(RECOGNITION_PREFIX)) return 'recognition';
  return 'keymap';
}

const safeDecode = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

function createAdmin({ store, cfg, deps, devices, backups, databases }) {
  const { readBody, own, validId, putDoc, docsIn, fixSelection, asObject, nowStamp, docHash, NS_RE, MAX_DOCS } = deps;
  const pageCache = new Map();

  function json(res, status, body, extra = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...SECURITY_HEADERS, ...extra });
    res.end(data);
  }
  const err = (res, status, message) => json(res, status, { error: message });

  function download(res, text, filename) {
    const ascii = filename.replace(/[^A-Za-z0-9._-]/g, '_');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      ...SECURITY_HEADERS,
    });
    res.end(text);
  }

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

  const nameOf = (d) => (d.metadata && typeof d.metadata.name === 'string' ? d.metadata.name : '');
  const sizeOf = (d) => Buffer.byteLength(JSON.stringify(d.keymap)) + Buffer.byteLength(JSON.stringify(d.metadata));

  function accountFileBytes(id) {
    try { return fs.statSync(path.join(store.accountDir, `${id}.json`)).size; } catch { return 0; }
  }

  function overview() {
    const accounts = store.listAccountIds().map((id) => {
      const acc = store.account(id);
      const byNs = new Map();
      for (const d of Object.values(acc.docs)) {
        if (!byNs.has(d.ns)) byNs.set(d.ns, 0);
        byNs.set(d.ns, byNs.get(d.ns) + 1);
      }
      const namespaces = [...byNs].sort(([a], [b]) => a.localeCompare(b)).map(([ns, count]) => {
        const sel = own(acc.selected, ns);
        const selDoc = sel && own(acc.docs, sel);
        return { ns, kind: kindOf(ns), count, selected: selDoc ? sel : '', selected_name: selDoc ? nameOf(selDoc) : '' };
      });
      let mtime = 0;
      try { mtime = fs.statSync(path.join(store.accountDir, `${id}.json`)).mtimeMs; } catch { /* unsaved */ }
      return { id, kind: id[0] === 'c' ? 'ft_client' : 'token', docs: Object.keys(acc.docs).length, namespaces, bytes: accountFileBytes(id), mtime };
    }).sort((a, b) => b.mtime - a.mtime);
    return { accounts, shares: Object.keys(store.shares).length, dataDir: store.dir, limits: { maxDocsPerAccount: MAX_DOCS } };
  }

  function docList(acc) {
    return Object.values(acc.docs).sort((a, b) => a.seq - b.seq).map((d) => ({
      id: d.id, ns: d.ns, kind: kindOf(d.ns), name: nameOf(d), add_time: d.add_time, bytes: sizeOf(d), selected: own(acc.selected, d.ns) === d.id,
    }));
  }

  function exportAccount(accId) {
    const acc = store.account(accId);
    return {
      format: 'ft-keymap-server/export@1',
      exported: new Date().toISOString(),
      account: accId,
      docs: Object.values(acc.docs).sort((a, b) => a.seq - b.seq).map((d) => ({
        id: d.id, ns: d.ns, add_time: d.add_time, metadata: d.metadata, keymap: d.keymap, selected: own(acc.selected, d.ns) === d.id,
      })),
    };
  }

  function removeDoc(accId, docId) {
    const acc = store.account(accId);
    const d = own(acc.docs, docId);
    if (!d) return false;
    delete acc.docs[docId];
    fixSelection(acc, d.ns);
    store.saveAccount(accId);
    return true;
  }

  // Imports files copied from the phone's Documents/Gamwing/keymap_cache/ ("list|<ns>.json" + "map|<id>.json").
  // New documents are created; documents that already exist are UPDATED when their content differs, and the previous
  // version is copied to the history first (so nothing is ever lost by a re-import / sync). Identical content is left alone.
  // A "map" file may come without its list (the document must then already exist); a list may come without maps (rename, selection).
  // Nothing is ever deleted.
  function importCache(accId, files) {
    const acc = store.account(accId);
    const imported = [];
    const updated = [];
    const skipped = [];
    let unchanged = 0;
    let snapshots = 0;
    let dirty = false;
    const maps = new Map();
    const lists = [];
    for (const f of files) {
      const name = safeDecode(String(f.name)).replace(/^.*[\\/]/, '');
      let m = /^map\|([^|]+)\.json$/.exec(name);
      if (m) {
        try { maps.set(m[1], { value: JSON.parse(f.text) }); } catch { maps.set(m[1], { bad: true }); }
        continue;
      }
      m = /^list\|(.+)\.json$/.exec(name);
      if (m) {
        let parsed;
        try { parsed = JSON.parse(f.text); } catch { skipped.push({ file: name, reason: 'invalid JSON' }); continue; }
        if (!NS_RE.test(m[1])) { skipped.push({ file: name, reason: 'invalid namespace' }); continue; }
        lists.push({ ns: m[1], list: parsed });
        continue;
      }
      skipped.push({ file: name, reason: 'not a list|… or map|… file' });
    }

    const touched = new Set();
    const seen = new Set();
    const nameOf2 = (metadata) => (typeof metadata.name === 'string' ? metadata.name : '');
    // create or update one document; returns nothing, records the outcome
    function upsert({ id, ns, keymap, metadata, add_time, pub }) {
      const existing = own(acc.docs, id);
      if (!existing) {
        putDoc(acc, { id, ns, keymap, metadata, add_time, public: pub });
        imported.push({ id, ns, name: nameOf2(metadata) });
        dirty = true;
        touched.add(ns);
        return;
      }
      const same = isDeepStrictEqual(existing.keymap, keymap) && isDeepStrictEqual(existing.metadata, metadata)
        && existing.add_time === add_time && Boolean(existing.public) === pub;
      if (same) { unchanged++; return; }
      snapshot(accId, existing); // keep the version we are about to replace
      snapshots++;
      existing.keymap = keymap;
      existing.metadata = metadata;
      existing.add_time = add_time;
      existing.public = pub;
      updated.push({ id, ns, name: nameOf2(metadata) });
      dirty = true;
      touched.add(ns);
    }

    for (const { ns, list } of lists) {
      const items = Array.isArray(list && list.items) ? list.items : [];
      for (const item of items) {
        const id = item && item.id;
        if (!validId(id)) { skipped.push({ id: String(id), reason: 'invalid id' }); continue; }
        seen.add(id);
        const existing = own(acc.docs, id);
        const mp = maps.get(id);
        if (!mp && !existing) { skipped.push({ id, reason: 'missing map file' }); continue; }
        let keymap;
        if (mp) {
          keymap = mp.bad ? null : asObject(mp.value);
          if (!keymap) { skipped.push({ id, reason: mp.bad ? 'invalid JSON' : 'keymap is not an object' }); continue; }
        } else keymap = existing.keymap;
        if (existing && existing.ns !== ns) { skipped.push({ id, reason: 'id used by another namespace' }); continue; }
        if (!existing && Object.keys(acc.docs).length >= MAX_DOCS) { skipped.push({ id, reason: 'document limit reached' }); continue; }
        const metadata = asObject(item.meta) || {};
        const add_time = typeof item.name === 'string' && DATE_RE.test(item.name) ? item.name : (existing ? existing.add_time : nowStamp());
        upsert({ id, ns, keymap, metadata, add_time, pub: item.public === true });
      }
      const sel = list && list.selected;
      const selDoc = typeof sel === 'string' ? own(acc.docs, sel) : undefined;
      if (selDoc && selDoc.ns === ns && own(acc.selected, ns) !== sel) { acc.selected[ns] = sel; dirty = true; }
    }

    // map files that came without a list entry: update the content of a document we already have
    for (const [id, mp] of maps) {
      if (seen.has(id)) continue;
      if (!validId(id)) { skipped.push({ id, reason: 'invalid id' }); continue; }
      const existing = own(acc.docs, id);
      if (!existing) { skipped.push({ id, reason: 'no list entry for this map' }); continue; }
      const keymap = mp.bad ? null : asObject(mp.value);
      if (!keymap) { skipped.push({ id, reason: mp.bad ? 'invalid JSON' : 'keymap is not an object' }); continue; }
      upsert({ id, ns: existing.ns, keymap, metadata: existing.metadata, add_time: existing.add_time, pub: Boolean(existing.public) });
    }

    for (const ns of touched) fixSelection(acc, ns);
    if (dirty) store.saveAccount(accId);
    return { imported, updated, unchanged, skipped, snapshots };
  }

  // ---- history: every save/restore first copies the current document to <data>/history/<account>/d_<id>/
  let lastStamp = 0;
  function nextStamp() {
    lastStamp = Math.max(Date.now(), lastStamp + 1); // strictly increasing, so names sort in save order
    const iso = new Date(lastStamp).toISOString(); // 2026-10-10T08:41:03.123Z
    return `${iso.replace(/[-:]/g, '').replace('.', '')}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`;
  }
  const versionTime = (v) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}.${v.slice(15, 18)}Z`;
  // the "d_" prefix keeps ids such as ".." from ever naming a parent folder
  const historyDir = (accId, docId) => path.join(store.dir, 'history', accId, `d_${docId}`);

  function snapshot(accId, d) {
    const dir = historyDir(accId, d.id);
    fs.mkdirSync(dir, { recursive: true });
    const version = nextStamp();
    store.writeJson(path.join(dir, `${version}.json`), {
      id: d.id, ns: d.ns, add_time: d.add_time, metadata: d.metadata, keymap: d.keymap, etag: docHash(d), saved_at: versionTime(version),
    });
    const names = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && VERSION_RE.test(f.slice(0, -5))).sort().reverse();
    for (const old of names.slice(MAX_HISTORY)) fs.rmSync(path.join(dir, old), { force: true });
    return version;
  }

  function historyList(accId, docId) {
    const dir = historyDir(accId, docId);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* no history yet */ }
    return names.filter((f) => f.endsWith('.json') && VERSION_RE.test(f.slice(0, -5))).sort().reverse().map((f) => {
      const version = f.slice(0, -5);
      return { version, saved_at: versionTime(version), bytes: fs.statSync(path.join(dir, f)).size };
    });
  }

  function readSnapshot(accId, docId, version) {
    if (!VERSION_RE.test(version)) return null;
    try { return { version, ...JSON.parse(fs.readFileSync(path.join(historyDir(accId, docId), `${version}.json`), 'utf8')) }; } catch { return null; }
  }

  // Replaces keymap/metadata after checking the caller still sees the current content (etag).
  // Returns { status, body }.
  function applyEdit(accId, d, { etag, keymap, metadata }) {
    if (typeof etag !== 'string' || !etag) return { status: 400, body: { error: 'etag is required' } };
    if (keymap === undefined && metadata === undefined) return { status: 400, body: { error: 'Nothing to change' } };
    if (keymap !== undefined && !isPlainObject(keymap)) return { status: 400, body: { error: 'keymap must be an object' } };
    if (metadata !== undefined && !isPlainObject(metadata)) return { status: 400, body: { error: 'metadata must be an object' } };
    const current = docHash(d);
    if (etag !== current) return { status: 409, body: { error: 'Conflict', etag: current } };
    snapshot(accId, d);
    if (keymap !== undefined) d.keymap = keymap;
    if (metadata !== undefined) d.metadata = metadata;
    store.saveAccount(accId);
    return { status: 200, body: { ok: true, etag: docHash(d), history: historyList(accId, d.id).length } };
  }

  async function jsonBody(req) {
    const text = await readBody(req, Math.max(cfg.maxBody, 32 * 1024 * 1024));
    if (!text.trim()) return {};
    try { return JSON.parse(text); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }

  function shareList() {
    return Object.entries(store.shares).map(([code, s]) => ({
      code, ns: s.ns, uses: s.uses, max_uses: s.max_uses, created: s.created, name: nameOf(s),
    })).sort((a, b) => String(a.created).localeCompare(String(b.created)));
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

  async function api(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    let m;
    const who = p.startsWith('/admin/api/sync/') ? identityOf(req) : null;
    if (who) devices.touch(who.id, who.name, remoteOf(req)); // any sync request is a sign of life

    if (p === '/admin/api/overview' && method === 'GET') return json(res, 200, overview());
    // ---- phone sync (used by the Android companion app); always works on cfg.syncAccount
    if (p === '/admin/api/sync/info' && method === 'GET') {
      backups.ensureToday();
      return json(res, 200, {
        ok: true, server: 'ft-keymap-server', version: PKG_VERSION, account: cfg.syncAccount,
        accounts: store.listAccountIds().length, docs: Object.keys(store.account(cfg.syncAccount).docs).length,
        web: { sessions: devices.webSessions() }, devices_online: devices.onlineCount(), backup_days: backups.list().length,
      });
    }
    if (p === '/admin/api/sync/pull' && method === 'GET') {
      const files = buildCacheFiles(store.account(cfg.syncAccount));
      if (who) devices.recordPull(who.id, files.length);
      return json(res, 200, { account: cfg.syncAccount, generated: new Date().toISOString(), files });
    }
    // ---- who is connected
    if (p === '/admin/api/sync/hello' && method === 'POST') {
      const body = await jsonBody(req);
      const id = body && body.id;
      if (typeof id !== 'string' || !DEVICE_ID_RE.test(id)) return err(res, 400, 'Invalid device id');
      const device = devices.hello(id, body, remoteOf(req));
      backups.ensureToday();
      return json(res, 200, { ok: true, now: new Date().toISOString(), online: devices.onlineCount(), web: { sessions: devices.webSessions() }, device });
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
    // ---- daily backups
    if (p === '/admin/api/sync/backups' && method === 'GET') {
      backups.ensureToday();
      return json(res, 200, { days: backups.list() });
    }
    if ((m = /^\/admin\/api\/sync\/backups\/([^/]+)\/databases$/.exec(p)) && method === 'GET') {
      const day = safeDecode(m[1]);
      if (!DAY_RE.test(day)) return err(res, 400, 'Invalid date');
      if (!backups.read(day)) return err(res, 404, 'Backup not found');
      return json(res, 200, { date: day, files: backups.readDatabases(day) });
    }
    if ((m = /^\/admin\/api\/sync\/backups\/([^/]+)$/.exec(p)) && method === 'GET') {
      const day = safeDecode(m[1]);
      if (!DAY_RE.test(day)) return err(res, 400, 'Invalid date');
      const found = backups.read(day);
      return found ? json(res, 200, found) : err(res, 404, 'Backup not found');
    }
    if (p === '/admin/api/sync/push' && method === 'POST') {
      const body = await jsonBody(req);
      const files = body && body.files;
      if (!Array.isArray(files) || files.some((f) => !f || typeof f.name !== 'string' || typeof f.text !== 'string')) {
        return err(res, 400, 'Body must be {"files":[{"name":"…","text":"…"}]}');
      }
      backups.actor = who ? (who.name || who.id) : 'Ứng dụng đồng bộ'; // recorded in the manifest of today's backup
      const result = importCache(cfg.syncAccount, files);
      backups.ensureToday();
      if (who) devices.recordPush(who.id, result);
      return json(res, 200, result);
    }
    // ---- the app's own preference files (Documents/jya2/databases/*.xml): stored as they are, never edited here
    if (p === '/admin/api/sync/databases' && method === 'GET') return json(res, 200, { files: databases.list() });
    if (p === '/admin/api/sync/databases/push' && method === 'POST') {
      const body = await jsonBody(req);
      const files = body && body.files;
      if (!Array.isArray(files) || files.some((f) => !f || typeof f.name !== 'string' || typeof f.text !== 'string')) {
        return err(res, 400, 'Body must be {"files":[{"name":"…","text":"…"}]}');
      }
      backups.actor = who ? (who.name || who.id) : 'Ứng dụng đồng bộ';
      const result = databases.put(files);
      if (result.saved > 0) {
        try { backups.snapshot(); } catch (e) { console.error('backup failed:', e.message); }
      } else {
        backups.ensureToday();
      }
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
      if (r.saved > 0) { try { backups.snapshot(); } catch (e) { console.error('backup failed:', e.message); } }
      return json(res, 200, { ok: true, saved: r.saved, etag: r.etag, history: r.history });
    }
    // ---- delete everything the server keeps (keymaps, history, daily backups, preference files, share codes).
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
      for (const n of ['accounts', 'history', 'backups', 'databases', 'shares.json']) {
        const from = path.join(cfg.dataDir, n);
        if (fs.existsSync(from)) { fs.renameSync(from, path.join(dest, n)); moved.push(n); }
      }
      store.accounts.clear();
      store.shares = {};
      fs.mkdirSync(store.accountDir, { recursive: true });
      return json(res, 200, { ok: true, moved, kept_in: `_wiped/${stamp}` });
    }
    if (p === '/admin/api/shares' && method === 'GET') return json(res, 200, { shares: shareList() });
    if ((m = /^\/admin\/api\/shares\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      const code = safeDecode(m[1]);
      if (!validId(code) || !own(store.shares, code)) return err(res, 404, 'Share code not found');
      delete store.shares[code];
      store.saveShares();
      return json(res, 200, { ok: true });
    }

    if ((m = /^\/admin\/api\/accounts\/([^/]+)\/docs\/([^/]+)\/history(?:\/([^/]+)(\/restore)?)?$/.exec(p))) {
      const accId = safeDecode(m[1]);
      const docId = safeDecode(m[2]);
      if (!ACCOUNT_RE.test(accId)) return err(res, 400, 'Invalid account id');
      const d = validId(docId) ? own(store.account(accId).docs, docId) : undefined;
      if (!d) return err(res, 404, 'Keymap not found');
      const version = m[3] && safeDecode(m[3]);
      if (!version && method === 'GET') return json(res, 200, { versions: historyList(accId, docId) });
      const snap = version ? readSnapshot(accId, docId, version) : null;
      if (version && !VERSION_RE.test(version)) return err(res, 400, 'Invalid version');
      if (version && !m[4] && method === 'GET') return snap ? json(res, 200, snap) : err(res, 404, 'Version not found');
      if (version && m[4] && method === 'POST') {
        const body = await jsonBody(req);
        if (!snap) return err(res, 404, 'Version not found');
        if (!isPlainObject(snap.keymap) || !isPlainObject(snap.metadata)) return err(res, 409, 'Snapshot is damaged');
        const out = applyEdit(accId, d, { etag: body.etag, keymap: snap.keymap, metadata: snap.metadata });
        return json(res, out.status, out.body);
      }
    }

    if ((m = /^\/admin\/api\/accounts\/([^/]+)\/(docs|export|import-cache)(?:\/([^/]+))?$/.exec(p))) {
      const accId = safeDecode(m[1]);
      if (!ACCOUNT_RE.test(accId)) return err(res, 400, 'Invalid account id');
      const [, , what, docId] = m;
      if (what === 'docs' && !docId && method === 'GET') return json(res, 200, { docs: docList(store.account(accId)) });
      if (what === 'docs' && docId) {
        const id = safeDecode(docId);
        const d = validId(id) ? own(store.account(accId).docs, id) : undefined;
        if (method === 'GET') {
          if (!d) return err(res, 404, 'Keymap not found');
          if (url.searchParams.get('download')) return download(res, JSON.stringify(d.keymap, null, 1), `${nameOf(d) || 'keymap'}-${d.id}.json`);
          return json(res, 200, { id: d.id, ns: d.ns, add_time: d.add_time, etag: docHash(d), metadata: d.metadata, keymap: d.keymap });
        }
        if (method === 'PUT') {
          if (!d) return err(res, 404, 'Keymap not found');
          const body = await jsonBody(req);
          const out = applyEdit(accId, d, { etag: body.etag, keymap: body.keymap, metadata: body.metadata });
          return json(res, out.status, out.body);
        }
        if (method === 'DELETE') {
          if (!d || !removeDoc(accId, id)) return err(res, 404, 'Keymap not found');
          return json(res, 200, { ok: true });
        }
      }
      if (what === 'export' && method === 'GET') return download(res, JSON.stringify(exportAccount(accId), null, 1), `export-${accId}.json`);
      if (what === 'import-cache' && method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req, Math.max(cfg.maxBody, 32 * 1024 * 1024)) || 'null'); } catch (e) {
          if (e.status) throw e;
          return err(res, 400, 'Invalid JSON');
        }
        const files = body && body.files;
        if (!Array.isArray(files) || !files.length || files.some((f) => !f || typeof f.name !== 'string' || typeof f.text !== 'string')) {
          return err(res, 400, 'Body must be {"files":[{"name":"…","text":"…"}]}');
        }
        return json(res, 200, importCache(accId, files));
      }
    }
    return err(res, 404, 'Not found');
  }

  // Returns true when the request was handled here.
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

module.exports = { createAdmin, hostAllowed, sameOrigin, kindOf };
