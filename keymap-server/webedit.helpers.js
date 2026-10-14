'use strict';
// A small gamwing_keymap_cache.xml for tests: a = listed keymap, b = orphan, c/d = recoil configs.
const C = require('./admin/cachexml');
const id = (c) => c.repeat(32);
const KM = 'com.vng.pubgmobile';
const RC = 'com.zjx.pubg.rcConfig2';
const str = (name, value) => `<string name="${C.escapeXml(name)}">${C.escapeXml(value)}</string>`;
const prefs = (...lines) => `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n${lines.map((l) => `    ${l}`).join('\n')}\n</map>\n`;
const keymap = { version: '1', components: [{ 'base:componentIdentifier': 'com.zjx.app:joystick' }] };
const item = (i, game, name) => ({ id: i, name: '2026-01-01 00:00:00', game, public: false, meta: JSON.stringify({ name }) });
const cacheXml = () => prefs(
  str(`list|${KM}`, JSON.stringify({ selected: id('a'), items: [item(id('a'), KM, 'Mine')] })),
  str(`map|${id('a')}`, JSON.stringify(keymap)),
  str(`map|${id('b')}`, JSON.stringify({ ...keymap, version: 'old' })),
  str(`list|${RC}`, JSON.stringify({ selected: id('c'), items: [item(id('c'), RC, 'Recoil C'), item(id('d'), RC, 'Recoil D')] })),
  str(`map|${id('c')}`, JSON.stringify({ name: 'Recoil C', recoil_data: [] })),
  str(`map|${id('d')}`, JSON.stringify({ name: 'Recoil D', recoil_data: [] })),
);
module.exports = { id, cacheXml };
