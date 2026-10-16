'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('./admin/layout');

test('key labels: letters, digits, specials, modifiers (signed HID bytes) and mouse codes', () => {
  assert.deepEqual(L.keyLabel(4), { text: 'A', guess: false });
  assert.equal(L.keyLabel(26).text, 'W');
  assert.equal(L.keyLabel(30).text, '1');
  assert.equal(L.keyLabel(39).text, '0');
  assert.equal(L.keyLabel(44).text, 'Space');
  assert.equal(L.keyLabel(41).text, 'Esc');
  assert.equal(L.keyLabel(43).text, 'Tab');
  assert.equal(L.keyLabel(57).text, 'Caps Lock');
  assert.equal(L.keyLabel(59).text, 'F2');
  assert.equal(L.keyLabel(-32).text, 'Ctrl trái');
  assert.equal(L.keyLabel(-31).text, 'Shift trái');
  assert.equal(L.keyLabel(-30).text, 'Alt trái');
  assert.equal(L.keyLabel(-1).text, 'Chưa gán');
  assert.equal(L.keyLabel(null).text, 'Chưa gán');
  assert.equal(L.keyLabel(undefined).text, 'Chưa gán');
  assert.deepEqual(L.keyLabel(65535), { text: 'Chuột trái', guess: true });
  assert.equal(L.keyLabel(65534).text, 'Chuột phải');
  assert.equal(L.keyLabel(65533).text, 'Chuột giữa');
  assert.match(L.keyLabel(65532).text, /65532/);
  assert.equal(L.keyLabel(12345).text, 'Mã 12345');
});

test('component names: known loaders are Vietnamese, unknown ones keep their raw id', () => {
  assert.equal(L.componentInfo('com.zjx.app:joystick').name, 'Joystick di chuyển');
  assert.equal(L.componentInfo('com.zjx.app:ntp').name, 'Điểm chạm thường');
  assert.equal(L.componentInfo('com.zjx.app:stp').name, 'Điểm vuốt');
  assert.equal(L.componentInfo('com.zjx.app:freelook').name, 'Nhìn tự do');
  assert.equal(L.componentInfo('com.zjx.pubgext:switchScope').name, 'Đổi ống ngắm');
  const unknown = L.componentInfo('com.example:weird');
  assert.equal(unknown.name, 'com.example:weird');
  assert.equal(unknown.cls, 'other');
});

test('recognition box types 0-23 all have a unique Vietnamese name and a group', () => {
  assert.equal(L.RECOGNITION_TYPES.length, 24);
  assert.equal(new Set(L.RECOGNITION_TYPES.map((t) => t.name)).size, 24);
  assert.ok(L.RECOGNITION_TYPES.every((t) => t.name && t.group));
  assert.equal(L.recognitionType(2).name, 'Biểu tượng tư thế ngồi');
  assert.equal(L.recognitionType(3).name, 'Biểu tượng tư thế nằm');
  assert.equal(L.recognitionType(4).name, 'Ô súng 1');
  assert.equal(L.recognitionType(5).name, 'Ô súng 2');
  assert.equal(L.recognitionType(23).name, 'Biểu tượng nạp đạn');
  assert.equal(L.recognitionType(99).name, 'Ô loại 99');
});

test('geometry: top-left and centre origin', () => {
  const c = { 'base:x': 100, 'base:y': 200, 'base:width': 40, 'base:height': 20 };
  assert.deepEqual(L.rectOf(c, 'topleft'), { x: 100, y: 200, w: 40, h: 20 });
  assert.deepEqual(L.rectOf(c, 'center'), { x: 80, y: 190, w: 40, h: 20 });
});

test('canvas is at least the screen and never clips the content', () => {
  const comps = [{ 'base:x': 2900, 'base:y': 1800, 'base:width': 100, 'base:height': 90 }];
  assert.deepEqual(L.canvasSize(comps, { w: 2960, h: 1848 }, 'topleft'), { w: 3000, h: 1890 });
  assert.deepEqual(L.canvasSize([], { w: 2960, h: 1848 }, 'topleft'), { w: 2960, h: 1848 });
  assert.deepEqual(L.canvasSize([{ 'base:x': 10, 'base:y': 10, 'base:width': 5, 'base:height': 5 }], { w: 2960, h: 1848 }, 'topleft'), { w: 2960, h: 1848 });
});

test('describe lists the key bindings and the parameters of a component', () => {
  const ntp = { 'base:componentIdentifier': 'com.zjx.app:ntp', 'base:x': 793, 'base:y': 1491, 'base:width': 48, 'base:height': 48, 'base:uniqueIdentifier': 'uid-1', 'singlehotkeyproperty:first': 30, 'singlehotkeyproperty:second': -1, 'ntp:ClickDuration': 50 };
  const d = L.describe('keymap', ntp);
  assert.equal(d.title, 'Điểm chạm thường');
  assert.equal(d.keys.join(' '), '1');
  const byRaw = Object.fromEntries(d.rows.map((r) => [r.raw, r]));
  assert.equal(byRaw['base:x'].label, 'Vị trí X');
  assert.equal(byRaw['singlehotkeyproperty:first'].label, 'Phím chính');
  assert.equal(byRaw['singlehotkeyproperty:first'].display, '1 (mã 30)');
  assert.equal(byRaw['ntp:ClickDuration'].label, 'ntp:ClickDuration', 'unvetted parameters keep their raw name');
  const joy = L.describe('keymap', { 'base:componentIdentifier': 'com.zjx.app:joystick', 'base:x': 1, 'base:y': 2, 'base:width': 3, 'base:height': 4, 'joystick:northKeyCode': 26, 'joystick:westKeyCode': 4, 'joystick:southKeyCode': 22, 'joystick:eastKeyCode': 7 });
  assert.equal(joy.keys.join(''), 'WASD');
  const rec = L.describe('recognition', { 'base:componentIdentifier': '', 'base:x': 1, 'base:y': 2, 'base:width': 3, 'base:height': 4, type: 4 });
  assert.equal(rec.title, 'Ô súng 1');
  assert.deepEqual(rec.keys, []);
});

test('overlays: mainView custom rectangle and vehicle rectangle', () => {
  const km = { components: [{ 'base:componentIdentifier': 'com.zjx.app:mainView', 'mainview:customViewRectangle.left': 610, 'mainview:customViewRectangle.top': 96, 'mainview:customViewRectangle.right': 1580, 'mainview:customViewRectangle.bottom': 712 }] };
  assert.deepEqual(L.overlays('keymap', km), [{ id: 'view', name: 'Vùng nhìn tùy chỉnh (mainView)', rect: { x: 610, y: 96, w: 970, h: 616 } }]);
  assert.deepEqual(L.overlays('recognition', { vehicleCarRectLeft: 1844, vehicleCarRectTop: 1250, vehicleCarRectRight: 2004, vehicleCarRectBottom: 1410, components: [] }),
    [{ id: 'car', name: 'Vùng nhận diện xe (vehicleCarRect)', rect: { x: 1844, y: 1250, w: 160, h: 160 } }]);
  assert.deepEqual(L.overlays('recognition', { vehicleCarRectLeft: 5, vehicleCarRectTop: 5, vehicleCarRectRight: 1, vehicleCarRectBottom: 1 }), [], 'an inverted rectangle is ignored, like the app does');
  assert.deepEqual(L.overlays('keymap', { components: [] }), []);
});

// ---- real data
const RAW = path.join(__dirname, '..', 'keymap_analysis', 'raw');
test('real backup: every component of every document can be described and placed', (t) => {
  if (!fs.existsSync(RAW)) return t.skip('backup folder not available');
  let count = 0;
  for (const f of fs.readdirSync(RAW).filter((n) => n.startsWith('map'))) {
    const doc = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
    if (!Array.isArray(doc.components)) continue;
    const kind = doc.components.every((c) => c['base:componentIdentifier'] === '') ? 'recognition' : 'keymap';
    for (const c of doc.components) {
      const d = L.describe(kind, c);
      assert.ok(d.title && d.rows.length >= 5, `${f}: ${JSON.stringify(c).slice(0, 80)}`);
      const r = L.rectOf(c, 'topleft');
      assert.ok(Number.isFinite(r.x + r.y + r.w + r.h));
      count++;
    }
  }
  assert.ok(count >= 100, `components checked: ${count}`);
});

test('legend: the classes that occur, counted, in legend order', () => {
  const comps = [
    { 'base:componentIdentifier': 'com.zjx.app:ntp' }, { 'base:componentIdentifier': 'com.zjx.app:joystick' }, { 'base:componentIdentifier': 'com.zjx.app:ntp' },
    { 'base:componentIdentifier': 'com.zjx.app:mainView' },
  ];
  assert.deepEqual(L.legend('keymap', comps), [{ cls: 'joystick', name: 'Joystick', count: 1 }, { cls: 'ntp', name: 'Chạm', count: 2 }, { cls: 'mainview', name: 'Màn hình chính', count: 1 }]);
  assert.deepEqual(L.legend('keymap', []), []);
  assert.deepEqual(L.legend('recognition', [{ type: 4 }, { type: 5 }, { type: 1 }]), [{ cls: 'button', name: 'Nút', count: 1 }, { cls: 'weapon', name: 'Ô súng', count: 2 }]);
});

test('labelOf: the whole label, never cut', () => {
  const ntp = (first, second) => ({ 'base:componentIdentifier': 'com.zjx.app:ntp', 'singlehotkeyproperty:first': first, 'singlehotkeyproperty:second': second });
  assert.equal(L.labelOf('keymap', ntp(65535, -1)), 'Chuột trái');
  assert.equal(L.labelOf('keymap', ntp(-32, 4)), 'Ctrl trái + A');
  assert.equal(L.labelOf('keymap', ntp(-1, -1)), 'Chạm', 'no key: the short name of the type');
  assert.equal(L.labelOf('keymap', { 'base:componentIdentifier': 'com.zjx.app:joystick', 'joystick:northKeyCode': 26 }), 'Joystick');
  assert.equal(L.labelOf('recognition', { type: 8 }), '8');
});

test('listRows and matchRow: one row per component, found without case or accents, every word must match', () => {
  const comps = [
    { 'base:componentIdentifier': 'com.zjx.app:ntp', 'base:x': 10.4, 'base:y': 20.6, 'base:width': 100, 'base:height': 50, 'singlehotkeyproperty:first': 65535, 'singlehotkeyproperty:second': -1 },
    { 'base:componentIdentifier': 'com.zjx.app:ntp', 'base:x': 0, 'base:y': 0, 'base:width': 5, 'base:height': 5, 'singlehotkeyproperty:first': 44, 'singlehotkeyproperty:second': -1 },
    null,
  ];
  const rows = L.listRows('keymap', comps);
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].i, rows[0].x, rows[0].y, rows[0].w, rows[0].h, rows[0].cls, rows[0].keys], [0, 10, 21, 100, 50, 'ntp', ['Chuột trái']]);
  assert.equal(L.listRows('keymap', comps, 'center')[0].x, -40);
  assert.equal(L.matchRow(rows[0], 'CHUOT trai'), true);
  assert.equal(L.matchRow(rows[0], 'chuot phai'), false);
  assert.equal(L.matchRow(rows[1], 'space'), true);
  assert.equal(L.matchRow(rows[1], 'cham'), true, 'the class name counts');
  assert.equal(L.matchRow(rows[1], '   '), true, 'nothing typed: everything matches');
});

test('fontUnits: about px pixels on the page, within bounds, and safe on a bad scale', () => {
  assert.equal(Math.round(L.fontUnits(0.5, 13)), 26);
  assert.equal(L.fontUnits(10, 13), 1.3, 'zoomed in: small in units, still 13 px on the page');
  assert.equal(L.fontUnits(0.01, 13), 140);
  for (const bad of [0, -1, NaN, Infinity, undefined]) assert.equal(L.fontUnits(bad), 22);
});

test('recognition maps: the number on the box is searchable, and a bad type from the file cannot break the name', () => {
  const rows = L.listRows('recognition', [{ type: 8 }, { type: 'constructor' }, { type: 1.5 }, 'abc', null]);
  assert.equal(rows[0].label, '8');
  assert.equal(L.matchRow(rows[0], '8'), true);
  for (const r of rows.slice(1)) { assert.equal(typeof r.title, 'string'); assert.notEqual(r.cls, undefined); assert.ok(L.CLASS_NAMES[r.cls] || r.cls === 'unknown'); }
  assert.equal(L.recognitionType('length').group, 'unknown');
  assert.equal(L.legend('keymap', ['abc', 5, null]).length, 1, 'primitives count as unknown components, not junk');
});

test('visibleRows and validFilter: the filter and the text together, and a stale filter is dropped', () => {
  const comps = [
    { 'base:componentIdentifier': 'com.zjx.app:ntp', 'singlehotkeyproperty:first': 44, 'singlehotkeyproperty:second': -1 },
    { 'base:componentIdentifier': 'com.zjx.app:joystick' },
  ];
  const rows = L.listRows('keymap', comps);
  assert.equal(L.visibleRows(rows, null, '').length, 2);
  assert.deepEqual(L.visibleRows(rows, 'ntp', '').map((r) => r.i), [0]);
  assert.deepEqual(L.visibleRows(rows, 'ntp', 'joystick'), []);
  assert.equal(L.validFilter('keymap', comps, 'ntp'), 'ntp');
  assert.equal(L.validFilter('recognition', [{ type: 4 }], 'ntp'), null, 'a class this document does not have');
  assert.equal(L.validFilter('keymap', comps, null), null);
});
