'use strict';
// Self-hosted keymap storage server that speaks the same HTTP contract the app's
// FtMapRouter / C8870a client expects from the FT keymap server. Zero dependencies.

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAdmin } = require('./admin');
const { DailyBackups, buildCacheFiles } = require('./backup');
const { DatabasesStore } = require('./databases');
const { Devices } = require('./devices');

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
// Ids are used as keys of plain objects. Lookups go through own() so names such as "constructor"
// are just unknown ids, and "__proto__" is refused outright because assigning it rewrites the prototype.
const validId = (s) => typeof s === 'string' && ID_RE.test(s) && s !== '__proto__';
const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);
const NS_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const CLIENT_RE = /^[a-f0-9]{32}$/;
const SHARE_PREFIXES = new Set(['ankm2', 'yqa3_', 'yqg3_']);
const MAX_DOCS_PER_ACCOUNT = 2000;
const MAX_IMPORT_PAGE = 100;
const MAX_IDEMPOTENCY_KEYS = 200;

function loadConfig(env = process.env) {
  const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  return {
    port: Number(env.PORT || 8787),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, 'data')),
    maxBody: Number(env.MAX_BODY_BYTES || 8 * 1024 * 1024),
    allowedClients: new Set(list(env.FT_ALLOWED_CLIENTS)),
    tlsKey: env.TLS_KEY || '',
    tlsCert: env.TLS_CERT || '',
    adminEnabled: !['0', 'false', 'off'].includes(String(env.ADMIN_ENABLED || '1').toLowerCase()),
    adminAllowedHosts: list(env.ADMIN_ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    // the account the phone companion app syncs with (no account code needed on the phone)
    syncAccount: /^[ct]_[a-f0-9]{32}$/.test(env.SYNC_ACCOUNT || '') ? env.SYNC_ACCOUNT : `c_${'0'.repeat(32)}`,
    // daily backups of that account: the day changes at midnight in this time zone; 0 = keep every day
    backupTz: env.BACKUP_TZ || 'Asia/Ho_Chi_Minh',
    backupKeepDays: Math.max(0, Math.floor(Number(env.BACKUP_KEEP_DAYS || 0)) || 0),
  };
}

// ---------------------------------------------------------------- storage

class Store {
  constructor(dir) {
    this.dir = dir;
    this.accountDir = path.join(dir, 'accounts');
    fs.mkdirSync(this.accountDir, { recursive: true });
    this.accounts = new Map();
    this.sharesFile = path.join(dir, 'shares.json');
    this.shares = this.readJson(this.sharesFile, {});
  }

  readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return fallback;
      throw e;
    }
  }

  writeJson(file, value) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  }

  account(id) {
    let acc = this.accounts.get(id);
    if (!acc) {
      acc = this.readJson(path.join(this.accountDir, `${id}.json`), null) || {
        seq: 0, docs: {}, selected: {}, expected: {}, idem: {}, idemOrder: [],
      };
      this.accounts.set(id, acc);
    }
    return acc;
  }

  listAccountIds() {
    return fs.readdirSync(this.accountDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  }

  saveAccount(id) {
    this.writeJson(path.join(this.accountDir, `${id}.json`), this.account(id));
    if (this.onSave) {
      try { this.onSave(id); } catch (e) { console.error('backup failed:', e.message); } // a failed backup must never fail the save
    }
  }

  saveShares() {
    this.writeJson(this.sharesFile, this.shares);
  }
}

// ---------------------------------------------------------------- helpers

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const docHash = (doc) => crypto.createHash('sha256').update(stable({ keymap: doc.keymap, metadata: doc.metadata })).digest('hex');
const newId = () => `ft_${crypto.randomBytes(12).toString('hex')}`;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function nowStamp() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function asObject(v) {
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return isObj(v) ? v : null;
}

const ok = (extra = {}) => ({ status: 200, body: { success: true, ft_server: true, ft_verified: true, ...extra } });
const fail = (status, reason, extra = {}) => ({ status, body: { success: false, ft_server: true, ft_verified: false, reason, ...extra } });

function accountKey(url, token) {
  const client = url.searchParams.get('ft_client');
  if (client && CLIENT_RE.test(client)) return { key: `c_${client}`, client };
  return { key: `t_${crypto.createHash('sha256').update(token).digest('hex').slice(0, 32)}`, client: null };
}

function docsIn(acc, ns) {
  return Object.values(acc.docs).filter((d) => d.ns === ns).sort((a, b) => a.seq - b.seq);
}

function fixSelection(acc, ns) {
  const sel = own(acc.selected, ns);
  const selDoc = sel && own(acc.docs, sel);
  if (selDoc && selDoc.ns === ns) return;
  const first = docsIn(acc, ns)[0];
  if (first) acc.selected[ns] = first.id; else delete acc.selected[ns];
}

function putDoc(acc, doc) {
  const existing = own(acc.docs, doc.id);
  acc.docs[doc.id] ={ ...doc, seq: existing ? existing.seq : ++acc.seq, add_time: existing ? existing.add_time : doc.add_time };
  return acc.docs[doc.id];
}

// ---------------------------------------------------------------- handlers

function listKeymaps(acc, ns) {
  const keymaps = docsIn(acc, ns).map((d) => ({
    id: d.id,
    add_time: d.add_time,
    is_official: false,
    metadata: JSON.stringify(d.metadata),
  }));
  return ok({ selected_keymap_id: own(acc.selected, ns) || '', keymaps });
}

function getKeymap(acc, id) {
  const d = own(acc.docs, id);
  if (!d) return fail(404, 'Keymap not found');
  return ok({ keymap: JSON.stringify(d.keymap), metadata: JSON.stringify(d.metadata), isOfficial: false, bundleId: d.ns });
}

function createKeymap(store, accId, ns, body, url) {
  const acc = store.account(accId);
  if (Object.keys(acc.docs).length >= MAX_DOCS_PER_ACCOUNT) return fail(409, 'Document limit reached');
  let keymap;
  let metadata;
  const code = url.searchParams.get('share_code');
  if (code) {
    const share = own(store.shares, code);
    if (!share) return fail(404, 'Share code not found');
    if (share.max_uses > 0 && share.uses >= share.max_uses) return fail(410, 'Share code exhausted');
    share.uses += 1;
    store.saveShares();
    ({ keymap, metadata } = share);
  } else {
    keymap = asObject(body.keymap);
    if (!keymap) return fail(400, 'keymap must be an object');
    metadata = body.metadata == null ? {} : asObject(body.metadata);
    if (!metadata) return fail(400, 'metadata must be an object');
  }
  const doc = putDoc(acc, { id: newId(), ns, keymap, metadata, add_time: nowStamp() });
  acc.selected[ns] = doc.id;
  store.saveAccount(accId);
  return ok({ keymap_id: doc.id });
}

function updateKeymap(store, accId, id, body) {
  const acc = store.account(accId);
  const d = own(acc.docs, id);
  if (!d) return fail(404, 'Keymap not found');
  const keymap = asObject(body.keymap);
  if (!keymap) return fail(400, 'keymap must be an object');
  const metadata = body.metadata == null ? {} : asObject(body.metadata);
  if (!metadata) return fail(400, 'metadata must be an object');
  d.keymap = keymap;
  d.metadata = metadata;
  store.saveAccount(accId);
  return ok({ keymap_id: id });
}

function selectKeymap(store, accId, id) {
  const acc = store.account(accId);
  const d = own(acc.docs, id);
  if (!d) return fail(404, 'Keymap not found');
  acc.selected[d.ns] = id;
  store.saveAccount(accId);
  return ok({ keymap_bundle_id: d.ns });
}

function deleteKeymap(store, accId, id) {
  const acc = store.account(accId);
  const d = own(acc.docs, id);
  // 404 (not 200) for an unknown id: the 2.9.46.6 client only fails over to the original server on a non-2xx.
  if (!d) return fail(404, 'Keymap not found');
  delete acc.docs[id];
  fixSelection(acc, d.ns);
  store.saveAccount(accId);
  return ok();
}

function createShare(store, accId, id, url) {
  const acc = store.account(accId);
  const d = own(acc.docs, id);
  if (!d) return fail(404, 'Keymap not found');
  const prefix = url.searchParams.get('prefix') || 'ankm2';
  if (!SHARE_PREFIXES.has(prefix)) return fail(400, 'Unsupported share prefix');
  // valid_count is treated as the maximum number of imports; absent or -1 means unlimited.
  const vc = Number(url.searchParams.get('valid_count'));
  const code = `${prefix}ft${crypto.randomBytes(12).toString('hex')}`;
  store.shares[code] = {
    ns: d.ns, keymap: d.keymap, metadata: d.metadata, created: nowStamp(),
    max_uses: Number.isInteger(vc) && vc > 0 ? vc : 0, uses: 0,
  };
  store.saveShares();
  return ok({ share_code: code });
}

function readShare(store, code) {
  const share = own(store.shares, code);
  if (!share) return fail(404, 'Share code not found');
  if (share.max_uses > 0 && share.uses >= share.max_uses) return fail(410, 'Share code exhausted');
  share.uses += 1;
  store.saveShares();
  return ok({ keymap: JSON.stringify(share.keymap), metadata: JSON.stringify(share.metadata) });
}

function migrationImport(store, accId, body) {
  const ns = body.namespace;
  if (typeof ns !== 'string' || !NS_RE.test(ns)) return fail(400, 'Invalid namespace');
  if (!Array.isArray(body.documents) || body.documents.length > MAX_IMPORT_PAGE) return fail(400, 'Invalid documents page');
  const acc = store.account(accId);
  const staged = [];
  for (const raw of body.documents) {
    const keymap = asObject(raw && raw.keymap);
    const metadata = raw && raw.metadata == null ? {} : asObject(raw && raw.metadata);
    if (!raw || !validId(raw.id) || !keymap || !metadata) return fail(400, 'Invalid document');
    const owner = own(acc.docs, raw.id);
    if (owner && owner.ns !== ns) return fail(409, 'Document id already used by another namespace');
    staged.push({ id: raw.id, ns, keymap, metadata, add_time: typeof raw.add_time === 'string' ? raw.add_time : nowStamp() });
  }
  // Check the limit against what the account will hold after the optional reset, BEFORE touching anything,
  // so a rejected request cannot leave the in-memory account out of step with the file on disk.
  const reset = body.reset === true;
  const dropped = reset ? docsIn(acc, ns).length : 0;
  const kept = Object.keys(acc.docs).length - dropped;
  const newIds = new Set(staged.filter((d) => !own(acc.docs, d.id) || (reset && acc.docs[d.id].ns === ns)).map((d) => d.id));
  if (kept + newIds.size > MAX_DOCS_PER_ACCOUNT) return fail(409, 'Document limit reached');
  if (reset) {
    for (const d of docsIn(acc, ns)) delete acc.docs[d.id];
    delete acc.selected[ns];
  }
  if (Number.isInteger(body.expected_count)) acc.expected[ns] = body.expected_count;
  const copied = staged.map((doc) => {
    const saved = putDoc(acc, doc);
    return { id: saved.id, sha256: docHash(saved) };
  });
  const sel = body.selected_keymap_id;
  const selDoc = typeof sel === 'string' ? own(acc.docs, sel) : undefined;
  if (selDoc && selDoc.ns === ns) acc.selected[ns] = sel;
  fixSelection(acc, ns);
  store.saveAccount(accId);
  return ok({ copied });
}

function migrationVerify(store, accId, body) {
  const ns = body.namespace;
  if (typeof ns !== 'string' || !NS_RE.test(ns) || !Array.isArray(body.manifest)) return fail(400, 'Invalid verify request');
  const acc = store.account(accId);
  const have = new Map(docsIn(acc, ns).map((d) => [d.id, docHash(d)]));
  const want = new Map();
  for (const m of body.manifest) {
    if (!m || typeof m.id !== 'string' || typeof m.sha256 !== 'string') return fail(400, 'Invalid manifest entry');
    want.set(m.id, m.sha256);
  }
  const missing = [...want.keys()].filter((id) => have.get(id) !== want.get(id));
  const extra = [...have.keys()].filter((id) => !want.has(id));
  const expected = acc.expected[ns];
  const countOk = expected === undefined || expected === have.size;
  if (missing.length || extra.length || !countOk) {
    return { status: 200, body: { success: false, ft_server: true, ft_verified: false, state: 'MISMATCH', missing, extra } };
  }
  return ok({ state: 'VERIFIED', count: have.size });
}

// ---------------------------------------------------------------- routing

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

function route(store, method, url, body, accId) {
  const p = url.pathname;
  let m;

  if ((m = /^\/v2\/keymap_list\/([^/]+)$/.exec(p)) && method === 'GET') {
    const ns = safeDecode(m[1]);
    if (!ns || !NS_RE.test(ns)) return fail(400, 'Invalid namespace');
    return listKeymaps(store.account(accId), ns);
  }
  if ((m = /^\/v2\/keymap\/update\/([^/]+)$/.exec(p)) && method === 'POST') {
    const id = safeDecode(m[1]);
    return validId(id) ? updateKeymap(store, accId, id, body) : fail(400, 'Invalid id');
  }
  if ((m = /^\/v2\/keymap\/select\/([^/]+)$/.exec(p)) && method === 'POST') {
    const id = safeDecode(m[1]);
    return validId(id) ? selectKeymap(store, accId, id) : fail(400, 'Invalid id');
  }
  if ((m = /^\/v2\/keymap\/share\/([^/]+)$/.exec(p)) && method === 'GET') {
    const id = safeDecode(m[1]);
    return validId(id) ? createShare(store, accId, id, url) : fail(400, 'Invalid id');
  }
  if ((m = /^\/v2\.1\/keymap\/share\/([^/]+)$/.exec(p)) && method === 'GET') {
    const code = safeDecode(m[1]);
    return validId(code) ? readShare(store, code) : fail(400, 'Invalid share code');
  }
  if ((m = /^\/v2\/keymap\/([^/]+)$/.exec(p))) {
    const seg = safeDecode(m[1]);
    if (method === 'GET') return validId(seg) ? getKeymap(store.account(accId), seg) : fail(400, 'Invalid id');
    if (method === 'DELETE') return validId(seg) ? deleteKeymap(store, accId, seg) : fail(400, 'Invalid id');
    if (method === 'POST') {
      if (!seg || !NS_RE.test(seg)) return fail(400, 'Invalid namespace');
      return createKeymap(store, accId, seg, body, url);
    }
  }
  if (p === '/ft/v1/migration/import' && method === 'POST') return migrationImport(store, accId, body);
  if (p === '/ft/v1/migration/verify' && method === 'POST') return migrationVerify(store, accId, body);
  return fail(404, 'Not found');
}

// ---------------------------------------------------------------- http

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function createServer(cfg = loadConfig()) {
  const store = new Store(cfg.dataDir);
  const clock = cfg.clock || Date.now; // tests can pass a fake clock
  const devices = new Devices({ file: path.join(cfg.dataDir, 'devices.json'), clock });
  const databases = new DatabasesStore({ dir: path.join(cfg.dataDir, 'databases'), clock });
  const backups = new DailyBackups({
    dir: path.join(cfg.dataDir, 'backups'), tz: cfg.backupTz, keepDays: cfg.backupKeepDays, clock,
    build: () => buildCacheFiles(store.account(cfg.syncAccount)),
    buildExtra: () => databases.all(),
  });
  store.onSave = (id) => { if (id === cfg.syncAccount) backups.snapshot(); };
  const admin = createAdmin({
    store,
    cfg,
    devices,
    backups,
    databases,
    deps: { readBody, own, validId, putDoc, docsIn, fixSelection, asObject, nowStamp, docHash, NS_RE, MAX_DOCS: MAX_DOCS_PER_ACCOUNT },
  });

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health') return send(res, 200, { ok: true });
      backups.actor = url.pathname.startsWith('/admin') ? 'Giao diện web' : 'API keymap';
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        if (!cfg.adminEnabled) return send(res, 404, fail(404, 'Not found').body);
        return await admin(req, res, url);
      }

      const token = String(req.headers['login-token'] || '');
      if (token.length < 8) return send(res, 401, { success: false, ft_server: true, ft_verified: false, reason: 'LoginRequired' });
      const { key, client } = accountKey(url, token);
      if (cfg.allowedClients.size && !(client && cfg.allowedClients.has(client))) {
        return send(res, 403, { success: false, ft_server: true, ft_verified: false, reason: 'Client not allowed' });
      }

      let body = {};
      if (req.method === 'POST' || req.method === 'PUT') {
        const raw = await readBody(req, cfg.maxBody);
        if (raw.trim()) {
          try { body = JSON.parse(raw); } catch { return send(res, 400, fail(400, 'Invalid JSON').body); }
          if (!isObj(body)) return send(res, 400, fail(400, 'JSON body must be an object').body);
        }
      }

      const idemKey = req.method === 'POST' ? req.headers['idempotency-key'] : undefined;
      const acc = store.account(key);
      const idemId = idemKey ? `${req.method} ${url.pathname}${url.search} ${idemKey}` : null;
      if (idemId && acc.idem[idemId]) {
        const prev = acc.idem[idemId];
        return send(res, prev.status, prev.body);
      }

      const out = route(store, req.method, url, body, key);

      if (idemId && out.status < 500) {
        acc.idem[idemId] = out;
        acc.idemOrder.push(idemId);
        while (acc.idemOrder.length > MAX_IDEMPOTENCY_KEYS) delete acc.idem[acc.idemOrder.shift()];
        store.saveAccount(key);
      }
      return send(res, out.status, out.body);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return send(res, status, { success: false, ft_server: true, ft_verified: false, reason: status === 500 ? 'Internal error' : e.message });
    }
  };

  const server = cfg.tlsKey && cfg.tlsCert
    ? https.createServer({ key: fs.readFileSync(cfg.tlsKey), cert: fs.readFileSync(cfg.tlsCert) }, handler)
    : http.createServer(handler);
  // a new day must get its folder even when nobody is using the server; and the device list is saved when the server stops
  const timer = setInterval(() => { try { backups.ensureToday(); } catch (e) { console.error('backup failed:', e.message); } }, 30 * 60 * 1000);
  timer.unref();
  server.on('close', () => { clearInterval(timer); devices.flush(); });
  return server;
}

if (require.main === module) {
  const cfg = loadConfig();
  createServer(cfg).listen(cfg.port, cfg.host, () => {
    const scheme = cfg.tlsKey && cfg.tlsCert ? 'https' : 'http';
    console.log(`ft-keymap-server listening on ${scheme}://${cfg.host}:${cfg.port}  data=${cfg.dataDir}`);
    if (scheme === 'http') console.log('Warning: plain HTTP. Put it behind a TLS reverse proxy before exposing it.');
  });
}

module.exports = { createServer, loadConfig };
