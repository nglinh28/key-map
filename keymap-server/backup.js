'use strict';
// Daily backups of the sync account: one folder per day, e.g. data/backups/2026-10-11/, holding the same
// "list%7C<ns>.json" / "map%7C<id>.json" files the phone keeps (so a day can simply be copied back) plus a manifest.
//   * during a day the folder is overwritten with the latest state;
//   * on a new day a new folder is created and the old one is left untouched;
//   * a folder is written to a temporary place first and swapped in, so a crash never leaves a half-written day;
//   * an empty account never replaces anything (deleting everything must not wipe the day's backup);
//   * the app's preference files (Documents/jya2/databases) go into a "databases" sub-folder of the day, the same way;
//     whichever half (keymaps or preference files) is empty at the moment keeps what the day already holds.

const fs = require('node:fs');
const path = require('node:path');

const { encode, decode, nameProblem } = require('./databases');

const DB_DIR = 'databases';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MANIFEST = '_manifest.json';
const CACHE_NAME_RE = /^(list|map)%7C[A-Za-z0-9._-]+\.json$/;
const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);

// "2026-10-11" for the instant `ms` in the time zone `tz` (the container itself usually runs in UTC)
function dayString(ms, tz = 'Asia/Ho_Chi_Minh') {
  const format = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  try { return format(tz); } catch { return format('UTC'); }
}

// The documents of an account as phone-cache files (| is stored as %7C in file names).
function buildCacheFiles(acc) {
  const byNs = new Map();
  for (const d of Object.values(acc.docs).sort((a, b) => a.seq - b.seq)) {
    if (!byNs.has(d.ns)) byNs.set(d.ns, []);
    byNs.get(d.ns).push(d);
  }
  const files = [];
  for (const [ns, docs] of [...byNs].sort(([a], [b]) => a.localeCompare(b))) {
    const items = docs.map((d) => {
      const it = { id: d.id, name: d.add_time, game: d.ns, public: Boolean(d.public) };
      if (d.metadata && Object.keys(d.metadata).length) it.meta = JSON.stringify(d.metadata);
      return it;
    });
    const sel = own(acc.selected, ns);
    const list = sel && own(acc.docs, sel) ? { selected: sel, items } : { items };
    files.push({ name: `list%7C${ns}.json`, text: JSON.stringify(list) });
    for (const d of docs) files.push({ name: `map%7C${d.id}.json`, text: JSON.stringify(d.keymap) });
  }
  return files;
}

class DailyBackups {
  // build(): the files to back up (see buildCacheFiles). clock(): current time in ms.
  constructor({ dir, tz = 'Asia/Ho_Chi_Minh', keepDays = 0, clock = Date.now, build, buildExtra = () => [] }) {
    this.dir = dir;
    this.tz = tz;
    this.keepDays = keepDays;
    this.clock = clock;
    this.build = build;
    this.buildExtra = buildExtra; // the preference files [{name,text}] to put in the day's "databases" folder
    this.actor = null; // who caused the change being backed up (a device name, the web page…), informational
  }

  today() { return dayString(this.clock(), this.tz); }

  folder(day) { return path.join(this.dir, day); }

  // Backs up the current state into today's folder. Returns { day, files } or null when there is nothing to back up.
  snapshot() {
    const day = this.today();
    const exists = fs.existsSync(this.folder(day));
    let files = this.build().filter((f) => CACHE_NAME_RE.test(f.name));
    let extra = this.buildExtra().filter((f) => nameProblem(f.name) === null);
    if (!files.length && exists) files = this.readCacheFiles(day); // keep what the day holds
    if (!extra.length && exists) extra = this.readDatabases(day);
    if (!files.length && !extra.length) return null;
    const manifest = {
      date: day,
      updated_at: new Date(this.clock()).toISOString(),
      docs: files.filter((f) => f.name.startsWith('map%7C')).length,
      files: files.length,
      databases: extra.length,
      bytes: [...files, ...extra].reduce((n, f) => n + Buffer.byteLength(f.text), 0),
      last_actor: this.actor || null,
    };
    this.write(day, files, manifest, extra);
    this.prune();
    return { day, files, databases: extra };
  }

  readCacheFiles(day) {
    try {
      return fs.readdirSync(this.folder(day)).filter((n) => CACHE_NAME_RE.test(n)).sort()
        .map((name) => ({ name, text: fs.readFileSync(path.join(this.folder(day), name), 'utf8') }));
    } catch { return []; }
  }

  // the preference files of a day, with their real (decoded) names
  readDatabases(day) {
    const dir = path.join(this.folder(day), DB_DIR);
    let stored = [];
    try { stored = fs.readdirSync(dir); } catch { return []; }
    return stored.map((n) => ({ name: decode(n), stored: n })).filter((f) => f.name && nameProblem(f.name) === null)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ name: f.name, text: fs.readFileSync(path.join(dir, f.stored), 'utf8') }));
  }

  // The first activity of a new day creates that day's folder (a copy of the current state) even when nothing changed.
  ensureToday() {
    if (fs.existsSync(this.folder(this.today()))) return;
    const previous = this.list()[0];
    const keep = this.actor;
    this.actor = previous ? previous.last_actor : null;
    try { this.snapshot(); } finally { this.actor = keep; }
  }

  write(day, files, manifest, extra = []) {
    fs.mkdirSync(this.dir, { recursive: true });
    const salt = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = path.join(this.dir, `.tmp-${day}-${salt}`);
    fs.mkdirSync(tmp);
    try {
      for (const f of files) fs.writeFileSync(path.join(tmp, f.name), f.text);
      if (extra.length) {
        fs.mkdirSync(path.join(tmp, DB_DIR));
        for (const f of extra) fs.writeFileSync(path.join(tmp, DB_DIR, encode(f.name)), f.text);
      }
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
      const files = fs.readdirSync(this.folder(date)).filter((n) => CACHE_NAME_RE.test(n));
      return {
        date,
        files: m.files ?? files.length,
        databases: m.databases ?? this.readDatabases(date).length,
        docs: m.docs ?? files.filter((n) => n.startsWith('map%7C')).length,
        bytes: m.bytes ?? 0,
        updated_at: m.updated_at ?? null,
        last_actor: m.last_actor ?? null,
      };
    });
  }

  read(day) {
    if (!DAY_RE.test(day) || !fs.existsSync(this.folder(day))) return null;
    const files = fs.readdirSync(this.folder(day)).filter((n) => CACHE_NAME_RE.test(n)).sort()
      .map((name) => ({ name, text: fs.readFileSync(path.join(this.folder(day), name), 'utf8') }));
    return { date: day, files, manifest: this.readManifest(day) };
  }

  prune() {
    if (!(this.keepDays > 0)) return;
    const days = this.list().map((d) => d.date); // newest first
    for (const old of days.slice(this.keepDays)) fs.rmSync(this.folder(old), { recursive: true, force: true });
  }
}

module.exports = { DailyBackups, buildCacheFiles, dayString, DAY_RE };
