'use strict';
// Commands the web page leaves for the phone app: delete items of gamwing_keymap_cache.xml, and check that the files on the tablet match the server.
// The app picks them up in the answer to its heartbeat, does the work on the tablet and reports the result back.
//   * a command is for the devices the server knew when it was made; it stays pending until each of them has reported;
//   * a pending command is also applied by the server to what a targeted device pushes (so an old copy cannot bring the items back);
//   * commands older than 14 days are not handed out any more; the newest 50 are kept.

const crypto = require('node:crypto');
const fs = require('node:fs');

const EXPIRES_MS = 14 * 24 * 3600 * 1000;
const KEEP = 50;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const cleanIds = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, 200) : []);
const cleanNames = (v) => (Array.isArray(v) ? v.map((x) => cleanText(x, 120)).filter(Boolean).slice(0, 100) : []);
const count = (v) => (Number.isInteger(v) && v >= 0 && v < 1e6 ? v : 0);
const TYPES = new Set(['delete_cache_items', 'verify_sync']);

// what the tablet found when it compared its files with the server
function cleanVerify(v) {
  if (!v || typeof v !== 'object') return null;
  return {
    day: cleanText(v.day, 10), checked: count(v.checked), same: count(v.same),
    different: cleanNames(v.different), only_tablet: cleanNames(v.only_tablet), only_server: cleanNames(v.only_server), day_different: cleanNames(v.day_different),
    error: cleanText(v.error, 300),
  };
}
const verifyProblem = (v) => Boolean(v && (v.error || v.different.length || v.only_tablet.length || v.only_server.length || v.day_different.length));

class Commands {
  constructor({ file, clock = Date.now }) {
    this.file = file;
    this.clock = clock;
    this.items = [];
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved.commands)) this.items = saved.commands;
    } catch { /* first run, or an unreadable file: start empty */ }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ commands: this.items }));
    fs.renameSync(tmp, this.file);
  }

  expired(c) { return this.clock() - Date.parse(c.created_at) > EXPIRES_MS; }

  // targets: [{ id, name }]; labels: names to show for the ids
  create({ type, file, ids, labels = [], targets = [], by = 'Giao diện web' }) {
    if (!TYPES.has(type)) throw new Error(`Unknown command type: ${type}`);
    const c = {
      id: `cmd_${crypto.randomBytes(8).toString('hex')}`, type, file, ids: cleanIds(ids), labels: labels.map((l) => cleanText(l, 120)).slice(0, 200),
      created_at: new Date(this.clock()).toISOString(), created_by: cleanText(by, 60), targets: targets.map((t) => ({ id: t.id, name: cleanText(t.name, 60) })), results: {},
    };
    this.items.unshift(c);
    this.items.length = Math.min(this.items.length, KEEP);
    this.save();
    return c;
  }

  // what the device still has to do
  pendingFor(deviceId) {
    return this.items.filter((c) => !this.expired(c) && c.targets.some((t) => t.id === deviceId) && !Object.hasOwn(c.results, deviceId));
  }

  // A device that is forgotten will not report any more: take it out of the commands that still wait for it.
  // A device that already answered stays (its answer is history). Returns how many commands it was taken out of.
  dropTarget(deviceId) {
    let n = 0;
    for (const c of this.items) {
      if (Object.hasOwn(c.results, deviceId) || !c.targets.some((t) => t.id === deviceId)) continue;
      c.targets = c.targets.filter((t) => t.id !== deviceId);
      n++;
    }
    if (n) this.save();
    return n;
  }

  // The result of one device. Returns the command, or null when the command or the device is unknown.
  report(id, deviceId, result = {}) {
    const c = this.items.find((x) => x.id === id);
    if (!c || !c.targets.some((t) => t.id === deviceId)) return null;
    const r = result && typeof result === 'object' ? result : {};
    c.results[deviceId] = {
      at: new Date(this.clock()).toISOString(),
      removed: cleanIds(r.removed), missing: cleanIds(r.missing), reappeared: cleanIds(r.reappeared),
      skipped: (Array.isArray(r.skipped) ? r.skipped : []).filter((s) => s && typeof s === 'object' && typeof s.id === 'string' && ID_RE.test(s.id))
        .map((s) => ({ id: s.id, reason: cleanText(s.reason, 200) })).slice(0, 200),
      error: cleanText(r.error, 300), backup: cleanText(r.backup, 300),
      verify: cleanVerify(r.verify),
    };
    this.save();
    return c;
  }

  status(c) {
    if (!c.targets.length) return 'server_only';
    const answered = c.targets.filter((t) => Object.hasOwn(c.results, t.id));
    if (answered.some((t) => { const r = c.results[t.id]; return r.error || r.reappeared.length || r.skipped.length || verifyProblem(r.verify); })) return 'attention';
    if (answered.length === c.targets.length) return 'done';
    return this.expired(c) ? 'expired' : 'pending';
  }

  list() {
    return this.items.map((c) => ({ ...c, status: this.status(c) }));
  }
}

module.exports = { Commands };
