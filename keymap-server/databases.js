'use strict';
// The preference files of the Gamwing app on the phone (Documents/jya2/databases/*.xml), kept apart from the keymaps.
//   * only the latest copy of each file is kept here (data/databases/); the daily backups (backup.js) snapshot the set;
//   * files are never deleted by a push (a phone that stops sending a file does not make it disappear);
//   * names come from the network, so they are checked hard and stored percent-encoded (the phone has names like
//     "Cài đặt cơ bản.xml"); nothing is ever stored outside the folder;
//   * files that carry license or session state are refused: backing those up would let them be replayed elsewhere;
//   * for every file we also remember the folder it lives in on the phone and which device sent it (.sources.json, display only);
//   * a file edited on the web page is marked (.webedits.json) until the phone holds the same text: while it is marked, a push of
//     DIFFERENT text from the phone is refused, so the old copy on the phone cannot silently wipe the edit.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const CacheXml = require('./admin/cachexml');

const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_NAME_CHARS = 120;
const EXCLUDED = /entitlement|ipc[-_ ]?session|licen[cs]e/i;
const MAX_VERSIONS = 10;
const VERSION_RE = /^\d{8}T\d{9}Z-[0-9a-f]{4}$/;
const MAX_FOLDER_CHARS = 300;
const MAX_DEVICE_CHARS = 60;
const WEB_EDIT_REASON = 'Bản sửa trên web chưa đưa xuống máy: khôi phục trên app (Khôi phục theo ngày) trước, hoặc bấm "Chấp nhận bản từ máy" trên web';
const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
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

  // where each file lives on the phone: { "<name>": { folder, device } }
  sources() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, '.sources.json'), 'utf8')); } catch { return {}; }
  }

  sourceOf(sources, name) {
    const s = Object.hasOwn(sources, name.normalize('NFC')) ? sources[name.normalize('NFC')] : null;
    return { folder: (s && s.folder) || '', device: (s && s.device) || '' };
  }

  saveSources(sources) {
    const target = path.join(this.dir, '.sources.json');
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sources));
    fs.renameSync(tmp, target);
  }

  // files edited on the web page and not yet seen on the phone: { "<name>": { at, etag } }
  webEdits() {
    try { const v = JSON.parse(fs.readFileSync(path.join(this.dir, '.webedits.json'), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
  }

  saveWebEdits(marks) {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = path.join(this.dir, '.webedits.json');
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(marks));
    fs.renameSync(tmp, target);
  }

  webEditOf(marks, name) {
    const m = Object.hasOwn(marks, name.normalize('NFC')) ? marks[name.normalize('NFC')] : null;
    return m ? { at: String(m.at || ''), etag: String(m.etag || '') } : null;
  }

  markWebEdit(name, etag) {
    const marks = this.webEdits();
    marks[name.normalize('NFC')] = { at: new Date(this.clock()).toISOString(), etag };
    this.saveWebEdits(marks);
  }

  // true when there was a mark to remove
  clearWebEdit(name) {
    const marks = this.webEdits();
    const key = name.normalize('NFC');
    if (!Object.hasOwn(marks, key)) return false;
    delete marks[key];
    this.saveWebEdits(marks);
    return true;
  }

  // What the phone pushed, minus the files it must not overwrite yet: { allowed, blocked:[{name,reason}] }.
  // A pushed text equal to the stored one means the phone now has the web edit: the mark goes away.
  filterDevicePush(files) {
    const marks = this.webEdits();
    const allowed = [];
    const blocked = [];
    let cleared = false;
    for (const f of files) {
      const key = f && typeof f.name === 'string' ? f.name.normalize('NFC') : '';
      if (!key || !Object.hasOwn(marks, key)) { allowed.push(f); continue; }
      let current = null;
      try { current = fs.readFileSync(this.file(f.name), 'utf8'); } catch { /* the stored file is gone: nothing to protect */ }
      if (current === null || current === f.text) { delete marks[key]; cleared = true; allowed.push(f); continue; }
      blocked.push({ name: f.name, reason: WEB_EDIT_REASON });
    }
    if (cleared) this.saveWebEdits(marks);
    return { allowed, blocked };
  }

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

  // every file that has older versions: [{ name, versions: [{ version, saved_at, bytes }] }] (names sorted)
  allVersions() {
    let stored = [];
    try { stored = fs.readdirSync(path.join(this.dir, '.history')); } catch { return []; }
    return stored.map((n) => decode(n)).filter((n) => n && nameProblem(n) === null).sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, versions: this.versions(name) })).filter((f) => f.versions.length);
  }

  // Removes older versions of one file (the file itself stays). -> { deleted: [versions], freed: bytes, missing: [versions] }
  deleteVersions(name, versions) {
    const out = { deleted: [], freed: 0, missing: [] };
    if (nameProblem(name)) return out;
    for (const v of [...new Set(versions)]) {
      const f = path.join(this.historyDir(name), `${v}.xml`);
      if (!VERSION_RE.test(v) || !fs.existsSync(f)) { out.missing.push(v); continue; }
      out.freed += fs.statSync(f).size;
      fs.rmSync(f, { force: true });
      out.deleted.push(v);
    }
    return out;
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
    try { CacheXml.parse(text); } catch { return { status: 400, error: 'Not a valid preferences XML file' }; }
    if (typeof etag !== 'string' || etag !== current.etag) return { status: 409, error: 'Conflict', etag: current.etag };
    const r = this.put([{ name, text }]);
    if (r.skipped.length) return { status: 400, error: r.skipped[0].reason };
    return { status: 200, saved: r.saved, etag: etagOf(text), history: this.versions(name).length };
  }

  names() {
    let stored = [];
    try { stored = fs.readdirSync(this.dir); } catch { return []; }
    const decoded = stored
      .filter((n) => !n.startsWith('.'))
      .map((n) => {
        const d = decode(n);
        return d ? d.normalize('NFC') : null;
      })
      .filter((n) => n && nameProblem(n) === null);
    return [...new Set(decoded)].sort((a, b) => a.localeCompare(b));
  }

  // files: [{name,text}]; source: { folder, device } of the phone they came from (optional, display only).
  // Returns { saved, unchanged, skipped:[{name,reason}], changed:[names] }
  put(files, source = {}) {
    const result = { saved: 0, unchanged: 0, skipped: [], changed: [] };
    fs.mkdirSync(this.dir, { recursive: true });
    const known = new Set(this.names());
    const folder = cleanText(source && source.folder, MAX_FOLDER_CHARS);
    const device = cleanText(source && source.device, MAX_DEVICE_CHARS);
    const sources = folder ? this.sources() : null;
    const remember = (name) => {
      if (!sources) return;
      const key = name.normalize('NFC');
      const before = Object.hasOwn(sources, key) ? sources[key] : null;
      sources[key] = { folder, device: device || (before && before.device) || '' };
    };
    for (const f of files) {
      const name = f && f.name;
      const why = nameProblem(name) || (typeof f.text !== 'string' ? 'nội dung không phải chuỗi' : null);
      if (why) { result.skipped.push({ name: typeof name === 'string' ? name : String(name), reason: why }); continue; }
      if (Buffer.byteLength(f.text) > MAX_FILE_BYTES) { result.skipped.push({ name, reason: 'file quá lớn (tối đa 24 MB)' }); continue; }
      if (!known.has(name.normalize('NFC')) && known.size >= MAX_FILES) { result.skipped.push({ name, reason: `đã đủ ${MAX_FILES} file` }); continue; }
      const target = this.file(name);
      let current = null;
      try { current = fs.readFileSync(target, 'utf8'); } catch { /* new file */ }
      if (current === f.text) { result.unchanged++; remember(name); continue; }
      if (current !== null) this.keepVersion(name, current);
      const tmp = path.join(this.dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
      fs.writeFileSync(tmp, f.text);
      fs.renameSync(tmp, target);
      known.add(name.normalize('NFC'));
      result.saved++;
      result.changed.push(name);
      remember(name);
    }
    if (sources) this.saveSources(sources);
    return result;
  }

  list() {
    const sources = this.sources();
    const marks = this.webEdits();
    return this.names().map((name) => {
      const st = fs.statSync(this.file(name));
      return { name, bytes: st.size, updated_at: new Date(st.mtimeMs).toISOString(), ...this.sourceOf(sources, name), web_edit: this.webEditOf(marks, name) };
    });
  }

  read(name) {
    if (nameProblem(name)) return null;
    try {
      const target = this.file(name);
      const st = fs.statSync(target);
      const text = fs.readFileSync(target, 'utf8');
      return { name, text, bytes: st.size, updated_at: new Date(st.mtimeMs).toISOString(), etag: etagOf(text), ...this.sourceOf(this.sources(), name), web_edit: this.webEditOf(this.webEdits(), name) };
    } catch { return null; }
  }

  all() {
    const sources = this.sources();
    return this.names().map((name) => ({ name, text: fs.readFileSync(this.file(name), 'utf8'), ...this.sourceOf(sources, name) }));
  }
}

module.exports = { DatabasesStore, nameProblem, encode, decode, etagOf, MAX_FILE_BYTES, MAX_FILES, MAX_VERSIONS };
