'use strict';
// Backup server for the preference files of the Gamwing app (Documents/jya2/databases/*.xml) sent by the phone app,
// with a web page (/admin) to browse, edit, compare and analyse them. Zero dependencies.

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { createAdmin } = require('./admin');
const { DailyBackups } = require('./backup');
const { DatabasesStore } = require('./databases');
const { Devices } = require('./devices');
const { Commands } = require('./commands');

function loadConfig(env = process.env) {
  const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  return {
    port: Number(env.PORT || 8787),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, 'data')),
    maxBody: Number(env.MAX_BODY_BYTES || 8 * 1024 * 1024),
    tlsKey: env.TLS_KEY || '',
    tlsCert: env.TLS_CERT || '',
    adminEnabled: !['0', 'false', 'off'].includes(String(env.ADMIN_ENABLED || '1').toLowerCase()),
    adminAllowedHosts: list(env.ADMIN_ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    // daily backups: the day changes at midnight in this time zone; 0 = keep every day
    backupTz: env.BACKUP_TZ || 'Asia/Ho_Chi_Minh',
    backupKeepDays: Math.max(0, Math.floor(Number(env.BACKUP_KEEP_DAYS || 0)) || 0),
  };
}

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
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const clock = cfg.clock || Date.now; // tests can pass a fake clock
  const devices = new Devices({ file: path.join(cfg.dataDir, 'devices.json'), clock });
  const databases = new DatabasesStore({ dir: path.join(cfg.dataDir, 'databases'), clock });
  const commands = new Commands({ file: path.join(cfg.dataDir, 'commands.json'), clock });
  const backups = new DailyBackups({
    dir: path.join(cfg.dataDir, 'backups'), tz: cfg.backupTz, keepDays: cfg.backupKeepDays, clock,
    buildExtra: () => databases.all(),
  });
  const admin = createAdmin({ cfg, devices, backups, databases, commands, readBody });

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health') return send(res, 200, { ok: true });
      if (cfg.adminEnabled && (url.pathname === '/admin' || url.pathname.startsWith('/admin/'))) return await admin(req, res, url);
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return send(res, status, { error: status === 500 ? 'Internal error' : e.message });
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
    if (scheme === 'http') console.log('Warning: plain HTTP, no login. Use it only on a trusted network.');
  });
}

module.exports = { createServer, loadConfig };
