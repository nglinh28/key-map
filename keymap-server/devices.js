'use strict';
// Who is connected: the phone app sends a heartbeat every ~15 s (and every sync request carries its identity),
// the web page sends a presence ping every ~10 s. Each side can then show the other as connected or not.
// "Connected" is judged by the time since the last sign of life, not by an open socket.

const fs = require('node:fs');

const DEVICE_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const STATES = new Set(['idle', 'watching', 'syncing', 'error']);
const MAX_DEVICES = 50;

const clean = (v, max = 60) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const cleanIp = (v) => (typeof v === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(v) ? v : '');

class Devices {
  constructor({ file, clock = Date.now, onlineMs = 40_000, webMs = 30_000 }) {
    this.file = file;
    this.clock = clock;
    this.onlineMs = onlineMs;
    this.webMs = webMs;
    this.devices = new Map();
    this.web = new Map(); // page session -> last ping (ms)
    this.dirty = false;
    this.lastWrite = 0;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [id, d] of Object.entries(saved.devices || {})) if (DEVICE_ID_RE.test(id)) this.devices.set(id, d);
    } catch { /* first run, or an unreadable file: start empty */ }
  }

  iso() { return new Date(this.clock()).toISOString(); }

  ensure(id) {
    let d = this.devices.get(id);
    if (!d) {
      d = { id, name: '', model: '', android: '', app_version: '', ip: '', remote: '', first_seen: this.iso(), last_seen: this.iso(), auto_push: false, folder: '', state: 'idle', error: '', last_push: null, last_pull: null };
      this.devices.set(id, d);
      this.trim();
      this.save(true);
    }
    return d;
  }

  // full heartbeat from the app
  hello(id, info, remote) {
    const d = this.ensure(id);
    const before = JSON.stringify(d);
    d.name = clean(info.name) || d.name || `Thiết bị ${id.slice(0, 6)}`;
    d.model = clean(info.model);
    d.android = clean(info.android, 20);
    d.app_version = clean(info.app_version, 20);
    d.ip = cleanIp(info.ip);
    d.remote = cleanIp(remote);
    d.auto_push = info.auto_push === true;
    d.folder = clean(info.folder, 200);
    d.state = STATES.has(info.state) ? info.state : 'idle';
    d.error = clean(info.error, 200);
    d.last_seen = this.iso();
    this.save(JSON.stringify({ ...d, last_seen: '' }) !== JSON.stringify({ ...JSON.parse(before), last_seen: '' }));
    return d;
  }

  // a sync request that carried the identity headers
  touch(id, name, remote) {
    const d = this.ensure(id);
    const n = clean(name);
    if (n && d.name !== n) { d.name = n; this.save(true); }
    if (!d.name) d.name = `Thiết bị ${id.slice(0, 6)}`;
    d.remote = cleanIp(remote) || d.remote;
    d.last_seen = this.iso();
    this.save(false);
    return d;
  }

  recordPush(id, summary) {
    const d = this.devices.get(id);
    if (!d) return;
    d.last_push = { at: this.iso(), saved: summary.saved, unchanged: summary.unchanged, skipped: summary.skipped.length };
    this.save(true);
  }

  recordPull(id, files) {
    const d = this.devices.get(id);
    if (!d) return;
    d.last_pull = { at: this.iso(), files };
    this.save(true);
  }

  isOnline(d) { return this.clock() - Date.parse(d.last_seen) <= this.onlineMs; }

  list() {
    return [...this.devices.values()].map((d) => ({ ...d, online: this.isOnline(d) })).sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen));
  }

  onlineCount() { return [...this.devices.values()].filter((d) => this.isOnline(d)).length; }

  forget(id) {
    const had = this.devices.delete(id);
    if (had) this.save(true);
    return had;
  }

  // the web page: returns how many pages are open (each page pings with its own random session id)
  presence(session) {
    this.web.set(session, this.clock());
    return this.webSessions();
  }

  webSessions() {
    const now = this.clock();
    for (const [s, t] of this.web) if (now - t > this.webMs) this.web.delete(s);
    return this.web.size;
  }

  trim() {
    while (this.devices.size > MAX_DEVICES) {
      const oldest = [...this.devices.values()].sort((a, b) => Date.parse(a.last_seen) - Date.parse(b.last_seen))[0];
      this.devices.delete(oldest.id);
    }
  }

  // important changes are written at once; plain "seen again" updates at most every 5 s
  save(important) {
    this.dirty = true;
    if (important || this.clock() - this.lastWrite >= 5_000) this.flush();
  }

  flush() {
    if (!this.dirty) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ devices: Object.fromEntries(this.devices) }));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      this.lastWrite = this.clock();
    } catch (e) {
      console.error('devices: cannot save', e.message);
    }
  }
}

module.exports = { Devices, DEVICE_ID_RE };
