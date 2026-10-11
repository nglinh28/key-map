'use strict';
// Logic for the on-screen layout view of key maps and AI recognition maps.
// Works in the browser (window.LayoutLib) and in Node (tests).
//
// Facts this file relies on, and where they come from:
//   * every component stores base:x / base:y / base:width / base:height in screen pixels;
//   * keys are USB-HID usage codes (4=A … 29=Z, 30=1 … 39=0, 44=Space) written as signed bytes,
//     so 224..226 (Ctrl/Shift/Alt left) appear as -32..-30  (table in base/util/C8994b.java);
//   * "ntp" is NormalTouchPoint and "stp" is SwipeTouch (module/keymapeditor/componentsettingsview/*);
//   * AI recognition boxes are told apart by "type" 0-23 (Extensions/pubg/C8711b.m35922y, accessory_rects.json keys).
// Anything that was inferred rather than read is flagged (guess: true / sure: false) and the UI says "suy ra".

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LayoutLib = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  // ---------------------------------------------------------------- key names
  const KEYS = { 40: 'Enter', 41: 'Esc', 42: 'Backspace', 43: 'Tab', 44: 'Space', 45: '-', 46: '=', 47: '[', 48: ']', 49: '\\', 51: ';', 52: "'", 53: '` (~)',
    54: ', (<)', 55: '. (>)', 56: '/', 57: 'Caps Lock', 70: 'Print Screen', 71: 'Scroll Lock', 72: 'Pause', 73: 'Insert', 74: 'Home', 75: 'Page Up', 76: 'Delete',
    77: 'End', 78: 'Page Down', 79: '→', 80: '←', 81: '↓', 82: '↑', 83: 'Num Lock', 84: '/ (Numpad)', 85: '* (Numpad)', 86: '- (Numpad)', 87: '+ (Numpad)',
    88: 'Enter (Numpad)', 98: '0 (Numpad)', 99: '. (Numpad)', 101: 'Menu', '-32': 'Ctrl trái', '-31': 'Shift trái', '-30': 'Alt trái', '-28': 'Ctrl phải',
    '-27': 'Shift phải', '-26': 'Alt phải', '-25': 'Win' };
  for (let i = 0; i < 26; i++) KEYS[4 + i] = String.fromCharCode(65 + i);
  for (let i = 0; i < 9; i++) KEYS[30 + i] = String(i + 1);
  KEYS[39] = '0';
  for (let i = 0; i < 12; i++) KEYS[58 + i] = `F${i + 1}`;
  for (let i = 0; i < 9; i++) KEYS[89 + i] = `${i + 1} (Numpad)`;

  const MOUSE_GUESS = { 65535: 'Chuột trái', 65534: 'Chuột phải', 65533: 'Chuột giữa' }; // positions in the user's map: fire / aim buttons

  function keyLabel(code) {
    if (code === null || code === undefined || code === -1) return { text: 'Chưa gán', guess: false };
    if (Object.prototype.hasOwnProperty.call(KEYS, code)) return { text: KEYS[code], guess: false };
    if (MOUSE_GUESS[code]) return { text: MOUSE_GUESS[code], guess: true };
    if (code >= 65527 && code <= 65532) return { text: `Nút chuột phụ (mã ${code})`, guess: true };
    if (code >= 64000 && code <= 64002) return { text: `Phím đặc biệt (mã ${code})`, guess: true };
    return { text: `Mã ${code}`, guess: false };
  }
  const validKey = (c) => typeof c === 'number' && c !== -1;

  // ---------------------------------------------------------------- component types
  const COMPONENTS = {
    'com.zjx.app:joystick': { name: 'Joystick di chuyển', short: 'Joystick', cls: 'joystick' },
    'com.zjx.app:ntp': { name: 'Điểm chạm thường', short: 'Chạm', cls: 'ntp' },
    'com.zjx.app:stp': { name: 'Điểm vuốt', short: 'Vuốt', cls: 'stp' },
    'com.zjx.app:freelook': { name: 'Nhìn tự do', short: 'Nhìn', cls: 'freelook' },
    'com.zjx.app:mainView': { name: 'Màn hình chính (xoay góc nhìn)', short: 'Màn hình', cls: 'mainview' },
    'com.zjx.pubgext:switchScope': { name: 'Đổi ống ngắm', short: 'Ngắm', cls: 'switch' },
    'com.zjx.pubgext:bindhorizontalrecoilcontrol': { name: 'Điều khiển độ giật ngang', short: 'Giật', cls: 'recoil' },
  };
  function componentInfo(id) {
    return COMPONENTS[id] || { name: id || '(không rõ)', short: '?', cls: 'other' };
  }

  // sure=false: inferred from how the code uses the box, not from a name
  const T = (name, group, sure = true) => ({ name, group, sure });
  const RECOGNITION_TYPES = [
    T('Biểu tượng ống ngắm đang gắn', 'sight'), // 0
    T('Nút ngắm (ADS)', 'button'), // 1
    T('Biểu tượng tư thế ngồi', 'posture'), // 2
    T('Biểu tượng tư thế nằm', 'posture'), // 3
    T('Ô súng 1', 'weapon'), // 4
    T('Ô súng 2', 'weapon'), // 5
    T('Đổi tỉ lệ ống ngắm: tùy chọn A', 'button', false), // 6
    T('Đổi tỉ lệ ống ngắm: tùy chọn B', 'button', false), // 7
    T('Nòng súng 1', 'accessory'), // 8
    T('Tay cầm súng 1', 'accessory'), // 9
    T('Báng súng 1', 'accessory'), // 10
    T('Nòng súng 2', 'accessory'), // 11
    T('Tay cầm súng 2', 'accessory'), // 12
    T('Báng súng 2', 'accessory'), // 13
    T('Nút mở đổi tỉ lệ ống ngắm', 'button', false), // 14
    T('Ô loại 15 (code không dùng)', 'unknown', false), // 15
    T('Ô loại 16 (code không dùng)', 'unknown', false), // 16
    T('Nút nghiêng người 1', 'button', false), // 17
    T('Nút nghiêng người 2', 'button', false), // 18
    T('Ô phụ kiện 1 (tự đặt, thử nghiệm)', 'accessory'), // 19
    T('Ô phụ kiện 2 (tự đặt, thử nghiệm)', 'accessory'), // 20
    T('Biểu tượng đổi chỗ ngồi (xe)', 'vehicle'), // 21
    T('Biểu tượng ô tô', 'vehicle'), // 22
    T('Biểu tượng nạp đạn', 'reload'), // 23
  ];
  const recognitionType = (n) => RECOGNITION_TYPES[n] || { name: `Ô loại ${n}`, group: 'unknown', sure: false };

  // ---------------------------------------------------------------- geometry
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  function rectOf(comp, origin = 'topleft') {
    const x = num(comp['base:x']);
    const y = num(comp['base:y']);
    const w = num(comp['base:width']);
    const h = num(comp['base:height']);
    return origin === 'center' ? { x: x - w / 2, y: y - h / 2, w, h } : { x, y, w, h };
  }
  function canvasSize(components, screen, origin = 'topleft') {
    let w = screen.w;
    let h = screen.h;
    for (const c of components) {
      const r = rectOf(c, origin);
      w = Math.max(w, Math.ceil(r.x + r.w));
      h = Math.max(h, Math.ceil(r.y + r.h));
    }
    return { w, h };
  }
  const SCREEN_PRESETS = [
    { id: 'tab-s8-ultra', label: 'Máy của bạn (Galaxy Tab S8 Ultra) 2960×1848', w: 2960, h: 1848 },
    { id: '3200x1440', label: '3200×1440', w: 3200, h: 1440 },
    { id: '2400x1080', label: '2400×1080', w: 2400, h: 1080 },
    { id: '2560x1600', label: '2560×1600', w: 2560, h: 1600 },
    { id: '3048x2032', label: '3048×2032', w: 3048, h: 2032 },
    { id: '3096x2064', label: '3096×2064', w: 3096, h: 2064 },
  ];

  // ---------------------------------------------------------------- component details
  const ROW_LABELS = {
    'base:componentIdentifier': 'Loại', 'base:x': 'Vị trí X', 'base:y': 'Vị trí Y', 'base:width': 'Rộng', 'base:height': 'Cao',
    'base:uniqueIdentifier': 'Mã định danh', 'singlehotkeyproperty:first': 'Phím chính', 'singlehotkeyproperty:second': 'Phím phụ',
    'joystick:northKeyCode': 'Phím lên', 'joystick:southKeyCode': 'Phím xuống', 'joystick:westKeyCode': 'Phím trái', 'joystick:eastKeyCode': 'Phím phải',
    'joystick:smallAngleKeyCode': 'Phím góc nhỏ', 'joystick:largeAngleKeyCode': 'Phím góc lớn', 'joystick:switchRadiusKeyCode': 'Phím đổi bán kính',
    'freelook:sensitivity': 'Độ nhạy nhìn tự do', type: 'Loại ô',
  };
  const KEY_FIELDS = new Set(['singlehotkeyproperty:first', 'singlehotkeyproperty:second', 'joystick:northKeyCode', 'joystick:southKeyCode',
    'joystick:westKeyCode', 'joystick:eastKeyCode', 'joystick:smallAngleKeyCode', 'joystick:largeAngleKeyCode', 'joystick:switchRadiusKeyCode']);
  const ROW_ORDER = Object.keys(ROW_LABELS);

  function describe(kind, comp) {
    const isRec = kind === 'recognition';
    const info = isRec ? recognitionType(comp.type) : componentInfo(comp['base:componentIdentifier']);
    const rows = [];
    const add = (raw) => {
      const value = comp[raw];
      let display;
      if (KEY_FIELDS.has(raw)) display = `${keyLabel(value).text} (mã ${value})`;
      else if (raw === 'type' && isRec) display = `${info.name} (loại ${value})`;
      else if (value !== null && typeof value === 'object') display = JSON.stringify(value);
      else display = String(value);
      rows.push({ raw, label: ROW_LABELS[raw] || raw, value, display });
    };
    for (const raw of ROW_ORDER) if (Object.prototype.hasOwnProperty.call(comp, raw)) add(raw);
    for (const raw of Object.keys(comp).sort()) if (!ROW_ORDER.includes(raw)) add(raw);

    const keys = [];
    if (!isRec) {
      if (comp['base:componentIdentifier'] === 'com.zjx.app:joystick') {
        for (const f of ['joystick:northKeyCode', 'joystick:westKeyCode', 'joystick:southKeyCode', 'joystick:eastKeyCode']) {
          if (validKey(comp[f])) keys.push(keyLabel(comp[f]).text);
        }
      } else if (validKey(comp['singlehotkeyproperty:first'])) {
        const first = keyLabel(comp['singlehotkeyproperty:first']).text;
        keys.push(validKey(comp['singlehotkeyproperty:second']) ? `${first} + ${keyLabel(comp['singlehotkeyproperty:second']).text}` : first);
      }
    }
    return { title: info.name, subtitle: isRec ? `type ${comp.type}` : comp['base:componentIdentifier'], cls: isRec ? info.group : info.cls, sure: info.sure !== false, keys, rows };
  }

  // Extra rectangles that are part of the document but not components (not draggable).
  function overlays(kind, doc) {
    const out = [];
    const valid = (l, t, r, b) => [l, t, r, b].every(Number.isFinite) && r > l && b > t;
    if (kind === 'recognition') {
      const l = doc.vehicleCarRectLeft; const t = doc.vehicleCarRectTop; const r = doc.vehicleCarRectRight; const b = doc.vehicleCarRectBottom;
      if (valid(l, t, r, b)) out.push({ id: 'car', name: 'Vùng nhận diện xe (vehicleCarRect)', rect: { x: l, y: t, w: r - l, h: b - t } });
    } else {
      for (const c of doc.components || []) {
        if (c['base:componentIdentifier'] !== 'com.zjx.app:mainView') continue;
        const l = c['mainview:customViewRectangle.left']; const t = c['mainview:customViewRectangle.top'];
        const r = c['mainview:customViewRectangle.right']; const b = c['mainview:customViewRectangle.bottom'];
        if (valid(l, t, r, b)) out.push({ id: 'view', name: 'Vùng nhìn tùy chỉnh (mainView)', rect: { x: l, y: t, w: r - l, h: b - t } });
      }
    }
    return out;
  }

  return { keyLabel, componentInfo, COMPONENTS, RECOGNITION_TYPES, recognitionType, rectOf, canvasSize, SCREEN_PRESETS, describe, overlays };
});
