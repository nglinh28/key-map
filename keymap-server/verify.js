'use strict';
// "Kiểm tra đồng bộ": fingerprints of the stored files (name, size in utf-8 bytes, sha-256 of the text) and the comparison of the
// latest copy with the newest backup day. The phone app compares its own files against the same fingerprints.

const crypto = require('node:crypto');

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// files: [{name,text}] -> [{name,bytes,sha256}] sorted by name
function manifestOf(files) {
  return files.map((f) => ({ name: f.name, bytes: Buffer.byteLength(f.text), sha256: sha256(f.text) })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// The latest copy of every file against the files of the newest backup day.
//   different      : the day holds other text than the latest copy
//   missing_in_day : the latest copy has a file the day does not
//   extra_in_day   : the day has a file the latest copy does not
function serverCheck({ databases, backups, now = new Date() }) {
  const at = now.toISOString();
  const latest = manifestOf(databases.all());
  const days = backups.list();
  if (!days.length) return { ok: false, reason: 'no_backup_day', at, day: null, checked: latest.length, same: 0, problems: [] };
  const day = days[0].date;
  const inDay = new Map(manifestOf(backups.readDatabases(day)).map((f) => [f.name, f]));
  const problems = [];
  let same = 0;
  for (const f of latest) {
    const d = inDay.get(f.name);
    if (!d) problems.push({ name: f.name, kind: 'missing_in_day', latest_sha256: f.sha256, latest_bytes: f.bytes });
    else if (d.sha256 !== f.sha256) problems.push({ name: f.name, kind: 'different', latest_sha256: f.sha256, day_sha256: d.sha256, latest_bytes: f.bytes, day_bytes: d.bytes });
    else same++;
    inDay.delete(f.name);
  }
  for (const d of inDay.values()) problems.push({ name: d.name, kind: 'extra_in_day', day_sha256: d.sha256, day_bytes: d.bytes });
  return { ok: problems.length === 0, at, day, checked: latest.length, same, problems };
}

module.exports = { sha256, manifestOf, serverCheck };
