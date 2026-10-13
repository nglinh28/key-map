'use strict';
// admin/cachexml.js: reads Android SharedPreferences XML and analyses gamwing_keymap_cache.xml.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./admin/cachexml');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const prefs = (...lines) => `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n${lines.map((l) => `    ${l}`).join('\n')}\n</map>\n`;
const str = (name, value) => `<string name="${name}">${esc(value)}</string>`;
const j = (v) => JSON.stringify(v);

const KM_NS = 'com.vng.pubgmobile';
const RC_NS = 'com.zjx.pubg.rcConfig2';
const AI_NS = 'com.zjx.pubg.recognition.com.vng.pubgmobile';
const id = (c) => c.repeat(32);

const keymapDoc = { version: '0.0.1', components: [{ 'base:componentIdentifier': 'com.zjx.app:joystick', 'base:x': 1, 'base:y': 2, 'base:width': 3, 'base:height': 4 }] };
const recoilDoc = (name) => ({ name, recoil_value_coefficient: 100, recoil_data: [{ v: [], coefficients: [] }], sensitivity: [100, 50, 30, 22, 14, 12, 10] });
const aiDoc = { name: 'Map của tôi', vehicleCarRectLeft: 1, components: [{ type: 4, 'base:x': 1, 'base:y': 2, 'base:width': 3, 'base:height': 4 }] };

const cache = () => prefs(
  str(`list|${KM_NS}`, j({ selected: id('a'), items: [{ id: id('a'), name: '2026-10-03 13:49:27', game: KM_NS, public: false, meta: j({ componentCount: 1, name: 'Sơ đồ của tôi' }) }] })),
  str(`map|${id('a')}`, j(keymapDoc)),
  str(`map|${id('b')}`, j({ ...keymapDoc, version: 'old' })), // not in any list: orphan
  str(`list|${RC_NS}`, j({ selected: id('c'), items: [
    { id: id('c'), name: '2026-03-31 12:38:17', game: RC_NS, public: false, meta: j({ name: '安卓游戏厅-和平精英-平板-2.0数据' }) },
    { id: id('d'), name: '2026-02-05 11:38:00', game: RC_NS, public: false, meta: j({ name: 'no map for this one' }) },
  ] })),
  str(`map|${id('c')}`, j(recoilDoc('安卓游戏厅-和平精英-平板-4.0数据'))), // name differs from the list
  str(`list|${AI_NS}`, j({ selected: id('e'), items: [{ id: id('e'), name: '2026-10-03 13:49:08', game: AI_NS, public: false, meta: '{}' }] })),
  str(`map|${id('e')}`, j(aiDoc)),
);

test('parse: strings, numbers, booleans, sets and every entity, in file order', () => {
  const xml = prefs(
    '<int name="a" value="2" />', '<boolean name="b" value="true" />', '<float name="c" value="1.5" />', '<long name="d" value="9" />',
    '<string name="e">x &quot;y&quot; &lt;z&gt; &amp;amp; &apos;q&apos; &#65;&#x4E2D;</string>', '<string name="f" />', '<string name="g"></string>',
    '<set name="h"><string>one</string><string>t&amp;o</string></set>',
  );
  const { entries } = C.parse(xml);
  assert.deepEqual(entries.map((e) => [e.tag, e.name]), [['int', 'a'], ['boolean', 'b'], ['float', 'c'], ['long', 'd'], ['string', 'e'], ['string', 'f'], ['string', 'g'], ['set', 'h']]);
  assert.deepEqual(entries.map((e) => e.value), ['2', 'true', '1.5', '9', 'x "y" <z> &amp; \'q\' A中', '', '', ['one', 't&o']]);
});

test('parse: an empty map is fine; anything else is a clear error', () => {
  assert.deepEqual(C.parse("<?xml version='1.0' ?>\n<map />\n").entries, []);
  assert.deepEqual(C.parse('<map></map>').entries, []);
  for (const bad of ['', 'hello', '<html></html>', '<map><string name="a">x</string>', '<resources></resources>']) {
    assert.throws(() => C.parse(bad), /SharedPreferences/, JSON.stringify(bad));
  }
  assert.throws(() => C.parse(null), /SharedPreferences/);
});

test('kindOf follows the namespace', () => {
  assert.equal(C.kindOf(RC_NS), 'recoil');
  assert.equal(C.kindOf(AI_NS), 'recognition');
  assert.equal(C.kindOf(KM_NS), 'keymap');
  assert.equal(C.kindOf('com.zjx.generalrc.rcConfig2'), 'keymap');
  assert.equal(C.kindOf(undefined), 'keymap');
});

test('analyze: namespaces, selected item, names, sizes and kinds', () => {
  const a = C.analyze(C.parse(cache()));
  assert.deepEqual(a.namespaces.map((n) => [n.ns, n.kind, n.selected, n.items.length]), [[KM_NS, 'keymap', id('a'), 1], [AI_NS, 'recognition', id('e'), 1], [RC_NS, 'recoil', id('c'), 2]],
    'keymaps first, then recognition, then recoil; by namespace inside a kind');
  const km = a.namespaces.find((n) => n.ns === KM_NS).items[0];
  assert.deepEqual([km.id, km.listName, km.dataName, km.addTime, km.hasMap, km.nameMismatch], [id('a'), 'Sơ đồ của tôi', '', '2026-10-03 13:49:27', true, false]);
  assert.equal(km.bytes, j(keymapDoc).length);
  assert.deepEqual(a.docs.get(id('a')), keymapDoc);
  assert.deepEqual(a.problems, []);
});

test('analyze: finds orphan maps, missing maps and names that differ from the list', () => {
  const a = C.analyze(C.parse(cache()));
  assert.deepEqual(a.orphans.map((o) => [o.id, o.kind, o.bytes > 0]), [[id('b'), 'keymap', true]]);
  assert.deepEqual(a.missingMaps.map((m) => [m.id, m.ns]), [[id('d'), RC_NS]]);
  const rc = a.namespaces.find((n) => n.ns === RC_NS).items;
  const c = rc.find((i) => i.id === id('c'));
  assert.deepEqual([c.listName, c.dataName, c.nameMismatch], ['安卓游戏厅-和平精英-平板-2.0数据', '安卓游戏厅-和平精英-平板-4.0数据', true]);
  const d = rc.find((i) => i.id === id('d'));
  assert.deepEqual([d.hasMap, d.nameMismatch, d.bytes], [false, false, 0]);
  const ai = a.namespaces.find((n) => n.ns === AI_NS).items[0];
  assert.deepEqual([ai.listName, ai.dataName, ai.nameMismatch], ['', 'Map của tôi', false], 'a list entry without a name is not a mismatch');
});

test('analyze: guesses the kind of an orphan from its content', () => {
  const x = prefs(str(`map|${id('1')}`, j(recoilDoc('r'))), str(`map|${id('2')}`, j(aiDoc)), str(`map|${id('3')}`, j(keymapDoc)), str(`map|${id('4')}`, j({ other: 1 })));
  const a = C.analyze(C.parse(x));
  assert.deepEqual(a.orphans.map((o) => o.kind), ['recoil', 'recognition', 'keymap', 'unknown']);
  assert.deepEqual(a.namespaces, []);
});

test('analyze: damaged JSON is reported, not thrown; other entries and unrelated keys are ignored', () => {
  const x = prefs(
    str(`list|${KM_NS}`, '{not json'), str(`list|${RC_NS}`, j({ selected: 'zzz', items: [{ id: id('c'), name: '2026-01-01 00:00:00' }, { nope: 1 }, null] })),
    str(`map|${id('c')}`, '{"truncated":'), str(`map|${id('f')}`, j(keymapDoc)), '<int name="unrelated" value="1" />', str('document|client|x', 'com.a.b'),
  );
  const a = C.analyze(C.parse(x));
  assert.equal(a.problems.length, 2);
  assert.match(a.problems.map((p) => p.message).join('\n'), /list\|com\.vng\.pubgmobile.*JSON/s);
  assert.match(a.problems.map((p) => p.message).join('\n'), new RegExp(`map\\|${id('c')}.*JSON`, 's'));
  const rc = a.namespaces.find((n) => n.ns === RC_NS);
  assert.deepEqual([rc.selected, rc.items.map((i) => i.id), rc.items[0].hasMap], ['', [id('c')], true], 'a selection that points nowhere is dropped; the broken map still counts as present');
  assert.equal(a.docs.get(id('c')), null);
  assert.deepEqual(a.orphans.map((o) => o.id), [id('f')]);
});

test('analyze: an empty or unrelated preferences file gives an empty analysis', () => {
  for (const x of ['<map />', prefs('<int name="a" value="1" />')]) {
    const a = C.analyze(C.parse(x));
    assert.deepEqual([a.namespaces, a.orphans, a.missingMaps, a.problems, a.docs.size], [[], [], [], [], 0]);
  }
});

test('diffEntries: added, removed and changed keys (type and value both count)', () => {
  const a = C.parse(prefs('<int name="keep" value="1" />', '<int name="gone" value="1" />', '<int name="chg" value="1" />', '<int name="ty" value="1" />', '<set name="s"><string>a</string></set>'));
  const b = C.parse(prefs('<int name="keep" value="1" />', '<int name="chg" value="2" />', '<string name="ty">1</string>', '<boolean name="new" value="true" />', '<set name="s"><string>a</string><string>b</string></set>'));
  assert.deepEqual(C.diffEntries(a, b), { added: ['new'], removed: ['gone'], changed: ['chg', 's', 'ty'], same: 1 });
  assert.deepEqual(C.diffEntries(a, a), { added: [], removed: [], changed: [], same: 5 });
  assert.deepEqual(C.diffEntries(C.parse('<map />'), a), { added: ['chg', 'gone', 'keep', 's', 'ty'], removed: [], changed: [], same: 0 });
});

test('entryValue: the text of one entry by name (for the JSON diff of a map)', () => {
  const p = C.parse(cache());
  assert.equal(C.entryValue(p, `map|${id('a')}`), j(keymapDoc));
  assert.equal(C.entryValue(p, 'nope'), undefined);
});

// ---------------------------------------------------------------- removing items from the cache file
const entryNames = (xml) => C.parse(xml).entries.map((e) => e.name);

test('escapeXml escapes the five characters the way Android writes them', () => {
  assert.equal(C.escapeXml(`a&b<c>"d'e`), 'a&amp;b&lt;c&gt;&quot;d&apos;e');
});

test('removeItems: an orphan map goes away and nothing else changes, byte for byte', () => {
  const xml = cache();
  const r = C.removeItems(xml, [id('b')]);
  assert.deepEqual([r.removedMaps, r.lists, r.missing, r.warnings], [[id('b')], [], [], []]);
  assert.equal(r.text, xml.split('\n').filter((line) => !line.includes(`<string name="map|${id('b')}">`)).join('\n'));
  assert.deepEqual(entryNames(r.text), entryNames(xml).filter((n) => n !== `map|${id('b')}`));
  assert.ok(!/\n\s*\n/.test(r.text), 'no blank line is left behind');
});

test('removeItems: a listed item leaves its map and its list entry; the selection moves to the first one left', () => {
  const r = C.removeItems(cache(), [id('c')]);
  assert.deepEqual(r.removedMaps, [id('c')]);
  assert.deepEqual(r.lists, [{ ns: RC_NS, removed: [id('c')], selectedBefore: id('c'), selectedAfter: id('d') }]);
  const a = C.analyze(C.parse(r.text));
  const rc = a.namespaces.find((n) => n.ns === RC_NS);
  assert.deepEqual([rc.selected, rc.items.map((i) => i.id)], [id('d'), [id('d')]]);
  assert.ok(!a.docs.has(id('c')));
  assert.deepEqual(a.namespaces.find((n) => n.ns === KM_NS).items.map((i) => i.id), [id('a')], 'the other lists are untouched');
});

test('removeItems: removing an item that is not selected keeps the selection; a listed item without a map is removed from the list only', () => {
  const r = C.removeItems(cache(), [id('d')]);
  assert.deepEqual(r.removedMaps, []);
  assert.deepEqual(r.lists, [{ ns: RC_NS, removed: [id('d')], selectedBefore: id('c'), selectedAfter: id('c') }]);
  assert.deepEqual(C.analyze(C.parse(r.text)).namespaces.find((n) => n.ns === RC_NS).items.map((i) => i.id), [id('c')]);
});

test('removeItems: the last item of a list leaves an empty list without a selection', () => {
  const r = C.removeItems(cache(), [id('e')]);
  const ai = C.analyze(C.parse(r.text)).namespaces.find((n) => n.ns === AI_NS);
  assert.deepEqual([ai.items, ai.selected], [[], '']);
  assert.deepEqual(r.lists[0], { ns: AI_NS, removed: [id('e')], selectedBefore: id('e'), selectedAfter: '' });
  assert.ok(!JSON.parse(C.parse(r.text).entries.find((e) => e.name === `list|${AI_NS}`).value).hasOwnProperty('selected'));
});

test('removeItems: several ids at once, unknown ids are reported, a second run changes nothing', () => {
  const r = C.removeItems(cache(), [id('b'), id('c'), id('9')]);
  assert.deepEqual([r.removedMaps.sort(), r.missing], [[id('b'), id('c')].sort(), [id('9')]]);
  const again = C.removeItems(r.text, [id('b'), id('c')]);
  assert.deepEqual([again.text === r.text, again.removedMaps, again.missing.sort()], [true, [], [id('b'), id('c')].sort()]);
});

test('removeItems: names with quotes, ampersands and apostrophes survive the rewrite of a list', () => {
  const tricky = prefs(
    str(`list|${KM_NS}`, j({ selected: id('1'), items: [{ id: id('1'), name: 'x', meta: j({ name: `A "q" & <b> 'c'` }) }, { id: id('2'), name: 'y', meta: j({ name: 'Cái khác' }) }] })),
    str(`map|${id('1')}`, j(keymapDoc)), str(`map|${id('2')}`, j(keymapDoc)),
  );
  const r = C.removeItems(tricky, [id('2')]);
  const a = C.analyze(C.parse(r.text));
  assert.equal(a.namespaces[0].items[0].listName, `A "q" & <b> 'c'`);
  assert.equal(a.namespaces[0].selected, id('1'));
  assert.ok(!r.text.includes("'c'"), 'an apostrophe is written as &apos; like Android does');
});

test('removeItems: a damaged list is left alone with a warning, the map is still removed; bad ids are refused', () => {
  const broken = prefs(str(`list|${KM_NS}`, '{not json'), str(`map|${id('1')}`, j(keymapDoc)));
  const r = C.removeItems(broken, [id('1')]);
  assert.deepEqual(r.removedMaps, [id('1')]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /list\|com\.vng\.pubgmobile/);
  for (const bad of ['', '../x', 'a b', 'a/b', 'x'.repeat(200), 5, null]) assert.throws(() => C.removeItems(cache(), [bad]), /id không hợp lệ/, String(bad));
  assert.throws(() => C.removeItems('<html/>', [id('1')]), /SharedPreferences/);
});

test('describeItem: where an item lives, for the web page', () => {
  const p = C.parse(cache());
  assert.deepEqual(C.sourceOf(p, id('c')), { mapEntry: `map|${id('c')}`, listEntry: `list|${RC_NS}`, hasMap: true });
  assert.deepEqual(C.sourceOf(p, id('b')), { mapEntry: `map|${id('b')}`, listEntry: '', hasMap: true });
  assert.deepEqual(C.sourceOf(p, id('d')), { mapEntry: '', listEntry: `list|${RC_NS}`, hasMap: false });
  assert.deepEqual(C.sourceOf(p, id('9')), { mapEntry: '', listEntry: '', hasMap: false });
});
