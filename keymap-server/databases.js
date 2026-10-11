'use strict';
// The preference files of the Gamwing app on the phone (Documents/jya2/databases/*.xml), kept apart from the keymaps.
//   * only the latest copy of each file is kept here (data/databases/); the daily backups (backup.js) snapshot the set;
//   * files are never deleted by a push (a phone that stops sending a file does not make it disappear);
//   * names come from the network, so they are checked hard and stored percent-encoded (the phone has names like
//     "Cài đặt cơ bản.xml"); nothing is ever stored outside the folder;
//   * files that carry license or session state are refused: backing those up would let them be replayed elsewhere.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_NAME_CHARS = 120;
const EXCLUDED = /entitlement|ipc[-_ ]?session|licen[cs]e/i;
const MAX_VERSIONS = 10;
const VERSION_RE = /^\d{8}T\d{9}Z-[0-9a-f]{4}$/;
const etagOf = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

// null when the name may be stored, otherwise the reason it may not (shown to the user)
function nameProblem(name) {
  if (typeof name !== 'string' || !name) return 'tên trống';
  if ([...name].length > MAX_NAME_CHARS) return 'tên quá dài';
  if (/[\\/\u0000-\u001f]/.test(name) || name === '.' || name === '..' || name.startsWith('.')) return 'tên không an toàn';
  if (!/\.xml$/i.test(name)) return 'không phải file .xml';
  if (EXCLUDED.test(name)) return 'file giấy phép/phiên đăng nhập không được sao lưu';
  return null;
}

const encode = (name) => encodeURIComponent(name.normalize('NFC'));
function decode(stored) {
  try { return decodeURIComponent(stored); } catch { return null; }
}

class DatabasesStore {
  constructor({ dir, clock = Date.now }) {
    this.dir = dir;
    this.clock = clock;
  }

  file(name) { return path.join(this.dir, encode(name)); }

  // Every change keeps the previous text in <dir>/.history/<encoded name>/ (newest MAX_VERSIONS only).
  historyDir(name) { return path.join(this.dir, '.history', encode(name)); }

  keepVersion(name, previousText) {
    const dir = this.historyDir(name);
    fs.mkdirSync(dir, { recursive: true });
    this.lastStamp = Math.max(this.clock(), (this.lastStamp || 0) + 1); // strictly increasing, so names sort in save order
    const iso = new Date(this.lastStamp).toISOString(); // 2026-10-11T08:41:03.123Z
    const version = `${iso.replace(/[-:]/g, '').replace('.', '')}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`;
    fs.writeFileSync(path.join(dir, `${version}.xml`), previousText);
    const old = fs.readdirSync(dir).filter((f) => f.endsWith('.xml') && VERSION_RE.test(f.slice(0, -4))).sort().reverse();
    for (const f of old.slice(MAX_VERSIONS)) fs.rmSync(path.join(dir, f), { force: true });
    return version;
  }

  versions(name) {
    if (nameProblem(name)) return [];
    let files = [];
    try { files = fs.readdirSync(this.historyDir(name)); } catch { return []; }
    return files.filter((f) => f.endsWith('.xml') && VERSION_RE.test(f.slice(0, -4))).sort().reverse().map((f) => {
      const version = f.slice(0, -4);
      const iso = `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}T${version.slice(9, 11)}:${version.slice(11, 13)}:${version.slice(13, 15)}.${version.slice(15, 18)}Z`;
      return { version, saved_at: iso, bytes: fs.statSync(path.join(this.historyDir(name), f)).size };
    });
  }

  readVersion(name, version) {
    if (nameProblem(name) || !VERSION_RE.test(version)) return null;
    try { return { version, text: fs.readFileSync(path.join(this.historyDir(name), `${version}.xml`), 'utf8') }; } catch { return null; }
  }

  // Edit made on the web page: the file must exist, and the caller must have seen its current text (etag).
  update(name, text, etag) {
    if (nameProblem(name)) return { status: 400, error: 'Invalid name' };
    if (typeof text !== 'string') return { status: 400, error: 'text must be a string' };
    const current = this.read(name);
    if (!current) return { status: 404, error: 'File not found' };
    if (typeof etag !== 'string' || etag !== current.etag) return { status: 409, error: 'Conflict', etag: current.etag };
    const r = this.put([{ name, text }]);
    if (r.skipped.length) return { status: 400, error: r.skipped[0].reason };
    return { status: 200, saved: r.saved, etag: etagOf(text), history: this.versions(name).length };
  }

  names() {
    let stored = [];
    try { stored = fs.readdirSync(this.dir); } catch { return []; }
    return stored.filter((n) => !n.startsWith('.')).map(decode).filter((n) => n && nameProblem(n) === null).sort((a, b) => a.localeCompare(b));
  }

  // files: [{name,text}]. Returns { saved, unchanged, skipped:[{name,reason}], changed:[names] }
  put(files) {
    const result = { saved: 0, unchanged: 0, skipped: [], changed: [] };
    fs.mkdirSync(this.dir, { recursive: true });
    const known = new Set(this.names());
    for (const f of files) {
      const name = f && f.name;
      const why = nameProblem(name) || (typeof f.text !== 'string' ? 'nội dung không phải chuỗi' : null);
      if (why) { result.skipped.push({ name: typeof name === 'string' ? name : String(name), reason: why }); continue; }
      if (Buffer.byteLength(f.text) > MAX_FILE_BYTES) { result.skipped.push({ name, reason: 'file quá lớn (tối đa 8 MB)' }); continue; }
      if (!known.has(name.normalize('NFC')) && known.size >= MAX_FILES) { result.skipped.push({ name, reason: `đã đủ ${MAX_FILES} file` }); continue; }
      const target = this.file(name);
      let current = null;
      try { current = fs.readFileSync(target, 'utf8'); } catch { /* new file */ }
      if (current === f.text) { result.unchanged++; continue; }
      if (current !== null) this.keepVersion(name, current);
      const tmp = path.join(this.dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
      fs.writeFileSync(tmp, f.text);
      fs.renameSync(tmp, target);
      known.add(name.normalize('NFC'));
      result.saved++;
      result.changed.push(name);
    }
    return result;
  }

  list() {
    return this.names().map((name) => {
      const st = fs.statSync(this.file(name));
      return { name, bytes: st.size, updated_at: new Date(st.mtimeMs).toISOString() };
    });
  }

  read(name) {
    if (nameProblem(name)) return null;
    try {
      const target = this.file(name);
      const st = fs.statSync(target);
      const text = fs.readFileSync(target, 'utf8');
      return { name, text, bytes: st.size, updated_at: new Date(st.mtimeMs).toISOString(), etag: etagOf(text) };
    } catch { return null; }
  }

  all() {
    return this.names().map((name) => ({ name, text: fs.readFileSync(this.file(name), 'utf8') }));
  }
}

module.exports = { DatabasesStore, nameProblem, encode, decode, etagOf, MAX_FILE_BYTES, MAX_FILES, MAX_VERSIONS };
