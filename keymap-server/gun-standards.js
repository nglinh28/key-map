'use strict';
// The user's corrections of the table of accessories ("Tiêu chuẩn súng" → "Sửa tiêu chuẩn"): gun code -> rule (or null = no rule), kept in
// DATA_DIR/gun-standards.json and pushed into RecoilLib, so the server's checks, suggestions, scans and AI questions all use them. The page loads the
// same corrections (GET /admin/api/standards) into its own copy of RecoilLib.

const fs = require('node:fs');
const path = require('node:path');
const R = require('./admin/recoil');

class GunStandards {
  constructor({ file = '' } = {}) {
    this.file = file;
    let saved = {};
    if (file) { try { saved = JSON.parse(fs.readFileSync(file, 'utf8')).overrides || {}; } catch { saved = {}; } }
    this.overrides = R.setRuleOverrides(saved); // what is not valid any more is dropped
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ overrides: this.overrides }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // code: gun code (RecoilLib.WEAPONS); rule: { muzzles, grips, stocks, maxZoom, note } or null ("no rule"). -> { ok } or { ok:false, error }
  set(code, rule) {
    if (typeof code !== 'string' || !R.WEAPONS.includes(code) || code === R.WEAPONS[0]) return { ok: false, error: 'Mã súng không hợp lệ.' };
    let value = null;
    if (rule !== null) {
      const c = R.checkRule(rule);
      if (!c.ok) return c;
      value = c.rule;
    }
    this.overrides = R.setRuleOverrides({ ...this.overrides, [code]: value });
    this.save();
    return { ok: true };
  }

  // back to the built-in table for this gun
  reset(code) {
    if (!Object.prototype.hasOwnProperty.call(this.overrides, code)) return { ok: false, error: 'Súng này chưa được sửa.' };
    const next = { ...this.overrides };
    delete next[code];
    this.overrides = R.setRuleOverrides(next);
    this.save();
    return { ok: true };
  }

  list() { return R.getRuleOverrides(); }
}

module.exports = { GunStandards };
