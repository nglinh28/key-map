'use strict';
// Daily backups of the app's preference files (Documents/jya2/databases/*.xml): one folder per day,
// e.g. data/backups/2026-10-11/, holding a "databases" sub-folder (names percent-encoded) plus a manifest.
//   * during a day the folder is overwritten with the latest state;
//   * on a new day a new folder is created and the old one is left untouched;
//   * a folder is written to a temporary place first and swapped in, so a crash never leaves a half-written day;
//   * an empty set never replaces anything (the last non-empty state of the day stays).
// Days written by earlier versions may also hold keymap cache files (list%7C…, map%7C…); they are ignored.

const fs = require('node:fs');
const path = require('node:path');

const { encode, decode, nameProblem } = require('./databases');

const DB_DIR = 'databases';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MANIFEST = '_manifest.json';

// "2026-10-11" for the instant `ms` in the time zone `tz` (the container itself usually runs in UTC)
function dayString(ms, tz = 'Asia/Ho_Chi_Minh') {
  const format = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  try { return format(tz); } catch { return format('UTC'); }
}

class DailyBackups {
  // buildExtra(): the files [{name,text}] to back up. clock(): current time in ms.
  constructor({ dir, tz = 'Asia/Ho_Chi_Minh', keepDays = 0, clock = Date.now, buildExtra = () => [] }) {
    this.dir = dir;
    this.tz = tz;
    this.keepDays = keepDays;
    this.clock = clock;
    this.buildExtra = buildExtra;
    this.actor = null; // who caused the change being backed up (a device name, the web page…), informational
  }

  today() { return dayString(this.clock(), this.tz); }

  folder(day) { return path.join(this.dir, day); }

  // Backs up the current files into today's folder. Returns { day, databases } or null when there is nothing to back up.
  snapshot() {
    const day = this.today();
    const files = this.buildExtra().filter((f) => nameProblem(f.name) === null);
    if (!files.length) return null;
    const manifest = {
      date: day,
      updated_at: new Date(this.clock()).toISOString(),
      databases: files.length,
      bytes: files.reduce((n, f) => n + Buffer.byteLength(f.text), 0),
      last_actor: this.actor || null,
    };
    const sources = Object.fromEntries(files.filter((f) => f.folder).map((f) => [f.name.normalize('NFC'), { folder: f.folder, device: f.device || '' }]));
    if (Object.keys(sources).length) manifest.sources = sources;
    this.write(day, files, manifest);
    this.prune();
    return { day, databases: files };
  }

  // the folder (on the phone) of a file of a day, from the manifest; '' for days written before folders were recorded
  folderOf(day, name) {
    const m = this.readManifest(day);
    const s = m && m.sources && Object.hasOwn(m.sources, name.normalize('NFC')) ? m.sources[name.normalize('NFC')] : null;
    return (s && s.folder) || '';
  }

  // the preference files of a day, with their real (decoded) names
  readDatabases(day) {
    const dir = path.join(this.folder(day), DB_DIR);
    let stored = [];
    try { stored = fs.readdirSync(dir); } catch { return []; }
    return stored.map((n) => ({ name: decode(n), stored: n })).filter((f) => f.name && nameProblem(f.name) === null)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ name: f.name, text: fs.readFileSync(path.join(dir, f.stored), 'utf8'), folder: this.folderOf(day, f.name) }));
  }

  // one file of a day, or null (unknown day, unknown file, unsafe name)
  readDatabase(day, name) {
    if (!DAY_RE.test(day) || nameProblem(name) !== null) return null;
    try { return { name, text: fs.readFileSync(path.join(this.folder(day), DB_DIR, encode(name)), 'utf8'), folder: this.folderOf(day, name) }; } catch { return null; }
  }

  // The first activity of a new day creates that day's folder (a copy of the current state) even when nothing changed.
  ensureToday() {
    if (fs.existsSync(this.folder(this.today()))) return;
    const previous = this.list()[0];
    const keep = this.actor;
    this.actor = previous ? previous.last_actor : null;
    try { this.snapshot(); } finally { this.actor = keep; }
  }

  write(day, files, manifest) {
    fs.mkdirSync(this.dir, { recursive: true });
    const salt = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = path.join(this.dir, `.tmp-${day}-${salt}`);
    fs.mkdirSync(path.join(tmp, DB_DIR), { recursive: true });
    try {
      for (const f of files) fs.writeFileSync(path.join(tmp, DB_DIR, encode(f.name)), f.text);
      fs.writeFileSync(path.join(tmp, MANIFEST), JSON.stringify(manifest));
      const target = this.folder(day);
      const old = path.join(this.dir, `.old-${day}-${salt}`);
      const had = fs.existsSync(target);
      if (had) fs.renameSync(target, old);
      fs.renameSync(tmp, target);
      if (had) fs.rmSync(old, { recursive: true, force: true });
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  readManifest(day) {
    try { return JSON.parse(fs.readFileSync(path.join(this.folder(day), MANIFEST), 'utf8')); } catch { return null; }
  }

  // newest first
  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names.filter((n) => DAY_RE.test(n) && fs.statSync(this.folder(n)).isDirectory()).sort().reverse().map((date) => {
      const m = this.readManifest(date) || {};
      return {
        date,
        databases: m.databases ?? this.readDatabases(date).length,
        bytes: m.bytes ?? 0,
        updated_at: m.updated_at ?? null,
        last_actor: m.last_actor ?? null,
      };
    });
  }

  read(day) {
    if (!DAY_RE.test(day) || !fs.existsSync(this.folder(day))) return null;
    return { date: day, manifest: this.readManifest(day) };
  }

  // size of a day's folder on disk
  sizeOf(day) {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? walk(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
    try { return walk(this.folder(day)); } catch { return 0; }
  }

  // Removes whole days (existing ones only). Returns { deleted: [days], freed: bytes, missing: [days] }.
  remove(days) {
    const out = { deleted: [], freed: 0, missing: [] };
    for (const day of [...new Set(days)]) {
      if (!DAY_RE.test(day) || !fs.existsSync(this.folder(day))) { out.missing.push(day); continue; }
      out.freed += this.sizeOf(day);
      fs.rmSync(this.folder(day), { recursive: true, force: true });
      out.deleted.push(day);
    }
    return out;
  }

  prune() {
    if (!(this.keepDays > 0)) return;
    const days = this.list().map((d) => d.date); // newest first
    for (const old of days.slice(this.keepDays)) fs.rmSync(this.folder(old), { recursive: true, force: true });
  }
}

module.exports = { DailyBackups, dayString, DAY_RE };
