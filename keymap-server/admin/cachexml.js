'use strict';
// Reads Android SharedPreferences XML (the files of Documents/jya2/databases) and analyses gamwing_keymap_cache.xml.
// Works in the browser (window.CacheXml) and in Node (tests).
//
// gamwing_keymap_cache.xml is a <map> of <string> entries:
//   list|<namespace>  JSON {"selected": id, "items": [{id, name (add time), game, public, meta (JSON text with "name")}]}
//   map|<id>          JSON of one keymap, AI recognition map or recoil config
// The text of every <string> is XML-escaped JSON.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CacheXml = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const RECOIL_NS = 'com.zjx.pubg.rcConfig2';
  const RECOGNITION_PREFIX = 'com.zjx.pubg.recognition.';
  const KIND_ORDER = { keymap: 0, recognition: 1, recoil: 2 };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // namespace -> what the stored documents are (same rule as the web page's tabs)
  function kindOf(ns) {
    if (ns === RECOIL_NS) return 'recoil';
    if (typeof ns === 'string' && ns.startsWith(RECOGNITION_PREFIX)) return 'recognition';
    return 'keymap';
  }

  const NAMED = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
  // one pass, so "&amp;quot;" becomes "&quot;" and not a quote
  const unescapeXml = (s) => s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(quot|apos|lt|gt|amp));/g, (all, hex, dec, name) => {
    if (name) return NAMED[name];
    const cp = hex ? parseInt(hex, 16) : Number(dec);
    try { return String.fromCodePoint(cp); } catch { return all; }
  });

  // the five characters Android escapes when it writes a string value
  const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  const BAD = (why) => new Error(`Không phải file SharedPreferences hợp lệ: ${why}`);
  const ENTRY = /<(string|int|long|float|boolean|set)\s+name="([^"]*)"([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;

  // xml: text of a preferences file. Returns { entries: [{ tag, name, value }] } in file order.
  // value: the text for <string>, the "value" attribute (as text) for numbers and booleans, an array of texts for <set>.
  function parse(xml) {
    if (typeof xml !== 'string') throw BAD('nội dung không phải văn bản');
    const body = xml.replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
    if (/^\s*<map\s*\/>\s*$/.test(body)) return { entries: [] };
    const open = /^\s*<map(?:\s[^>]*)?>/.exec(body);
    if (!open || !/<\/map>\s*$/.test(body)) throw BAD('thiếu thẻ <map> hoặc </map>');
    const inner = body.slice(open[0].length, body.lastIndexOf('</map>'));
    const entries = [];
    ENTRY.lastIndex = 0;
    let m;
    while ((m = ENTRY.exec(inner))) {
      const [, tag, rawName, attrs, content] = m;
      const name = unescapeXml(rawName);
      if (tag === 'string') entries.push({ tag, name, value: unescapeXml(content || '') });
      else if (tag === 'set') {
        const items = [];
        const re = /<string>([\s\S]*?)<\/string>/g;
        let s;
        while ((s = re.exec(content || ''))) items.push(unescapeXml(s[1]));
        entries.push({ tag, name, value: items });
      } else {
        const v = /\bvalue="([^"]*)"/.exec(attrs);
        entries.push({ tag, name, value: v ? unescapeXml(v[1]) : '' });
      }
    }
    return { entries };
  }

  const tryJson = (text) => { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; } };

  // what an unlisted document looks like (used only for orphans, which have no namespace)
  function guessKind(doc) {
    if (!isObj(doc)) return 'unknown';
    if (Array.isArray(doc.recoil_data)) return 'recoil';
    if (Array.isArray(doc.components)) {
      if (doc.components.some((c) => isObj(c) && typeof c['base:componentIdentifier'] === 'string')) return 'keymap';
      if (doc.components.some((c) => isObj(c) && typeof c.type === 'number')) return 'recognition';
    }
    return 'unknown';
  }

  // Splits the entries into lists and maps and cross-checks them.
  function analyze(parsed) {
    const problems = [];
    const maps = new Map(); // id -> text
    const docs = new Map(); // id -> parsed JSON, or null when it is damaged
    const lists = [];
    for (const e of parsed.entries) {
      if (e.tag !== 'string') continue;
      if (e.name.startsWith('map|')) maps.set(e.name.slice(4), e.value);
      else if (e.name.startsWith('list|')) lists.push(e);
    }
    for (const [id, text] of maps) {
      const r = tryJson(text);
      docs.set(id, r.ok ? r.value : null);
      if (!r.ok) problems.push({ where: `map|${id}`, message: `map|${id}: JSON hỏng, không đọc được` });
    }

    const listed = new Set();
    const namespaces = [];
    const missingMaps = [];
    for (const e of lists) {
      const ns = e.name.slice(5);
      const r = tryJson(e.value);
      if (!r.ok || !isObj(r.value)) { problems.push({ where: e.name, message: `${e.name}: JSON hỏng, không đọc được` }); continue; }
      const items = [];
      for (const it of Array.isArray(r.value.items) ? r.value.items : []) {
        if (!isObj(it) || typeof it.id !== 'string' || !it.id) continue;
        listed.add(it.id);
        const meta = typeof it.meta === 'string' ? tryJson(it.meta).value : it.meta;
        const listName = isObj(meta) && typeof meta.name === 'string' ? meta.name : '';
        const hasMap = maps.has(it.id);
        const doc = docs.get(it.id);
        const dataName = isObj(doc) && typeof doc.name === 'string' ? doc.name : '';
        items.push({
          id: it.id, listName, dataName, addTime: typeof it.name === 'string' ? it.name : '',
          bytes: hasMap ? maps.get(it.id).length : 0, hasMap, nameMismatch: Boolean(listName && dataName && listName !== dataName),
        });
        if (!hasMap) missingMaps.push({ id: it.id, ns });
      }
      const sel = typeof r.value.selected === 'string' && items.some((i) => i.id === r.value.selected) ? r.value.selected : '';
      namespaces.push({ ns, kind: kindOf(ns), selected: sel, items });
    }
    namespaces.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.ns.localeCompare(b.ns));

    const orphans = [];
    for (const [id, text] of maps) {
      if (listed.has(id)) continue;
      const doc = docs.get(id);
      orphans.push({ id, bytes: text.length, kind: guessKind(doc), name: isObj(doc) && typeof doc.name === 'string' ? doc.name : '' });
    }
    return { namespaces, orphans, missingMaps, problems, docs, maps };
  }

  const valueKey = (e) => `${e.tag}\u0000${JSON.stringify(e.value)}`;
  const byName = (parsed) => new Map(parsed.entries.map((e) => [e.name, e]));

  // Which entries of two versions of the same file were added, removed or changed (names, sorted).
  function diffEntries(a, b) {
    const ma = byName(a);
    const mb = byName(b);
    const out = { added: [], removed: [], changed: [], same: 0 };
    for (const [name, e] of mb) {
      if (!ma.has(name)) out.added.push(name);
      else if (valueKey(ma.get(name)) === valueKey(e)) out.same++;
      else out.changed.push(name);
    }
    for (const name of ma.keys()) if (!mb.has(name)) out.removed.push(name);
    for (const k of ['added', 'removed', 'changed']) out[k].sort();
    return out;
  }

  // the value of the (last) entry with this name, or undefined
  function entryValue(parsed, name) {
    for (let i = parsed.entries.length - 1; i >= 0; i--) if (parsed.entries[i].name === name) return parsed.entries[i].value;
    return undefined;
  }

  // ---------------------------------------------------------------- editing the file as text (everything else stays byte for byte)
  const ITEM_ID = /^[A-Za-z0-9._-]{1,128}$/;

  // where <string name="…">…</string> sits in the text, or null
  function stringSpan(xml, name) {
    const open = `<string name="${escapeXml(name)}">`;
    const i = xml.indexOf(open);
    if (i < 0) return null;
    const j = xml.indexOf('</string>', i + open.length);
    return j < 0 ? null : { start: i, inner: i + open.length, innerEnd: j, end: j + '</string>'.length };
  }

  // Deletes items from gamwing_keymap_cache.xml: their map|<id> entry, and their place in the list|<namespace> they are listed in.
  // A list whose selected item goes away selects the first item left (no selection when the list becomes empty).
  // Returns { text, removedMaps, lists: [{ ns, removed, selectedBefore, selectedAfter }], missing, warnings }; ids found nowhere are "missing".
  function removeItems(xml, ids) {
    parse(xml); // refuses anything that is not a preferences file
    const wanted = [...new Set(ids)];
    for (const x of wanted) if (typeof x !== 'string' || !ITEM_ID.test(x)) throw new Error(`id không hợp lệ: ${typeof x === 'string' ? x : JSON.stringify(x)}`);
    let text = xml;
    const removedMaps = [];
    for (const x of wanted) {
      const span = stringSpan(text, `map|${x}`);
      if (!span) continue;
      let start = span.start;
      while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
      if (start > 0 && text[start - 1] === '\n') start--; // the whole line, so no blank line is left
      text = text.slice(0, start) + text.slice(span.end);
      removedMaps.push(x);
    }
    const lists = [];
    const warnings = [];
    const inLists = new Set();
    for (const e of parse(text).entries) {
      if (e.tag !== 'string' || !e.name.startsWith('list|')) continue;
      const parsed = tryJson(e.value);
      if (!parsed.ok || !isObj(parsed.value)) {
        warnings.push(`${e.name}: JSON hỏng nên không sửa được danh sách này`);
        continue;
      }
      const obj = parsed.value;
      const items = Array.isArray(obj.items) ? obj.items : [];
      const gone = wanted.filter((x) => items.some((it) => isObj(it) && it.id === x));
      for (const x of gone) inLists.add(x);
      if (!gone.length) continue;
      const kept = items.filter((it) => !(isObj(it) && gone.includes(it.id)));
      const before = typeof obj.selected === 'string' ? obj.selected : '';
      obj.items = kept;
      let after = before;
      if (gone.includes(before)) {
        const first = kept.find((it) => isObj(it) && typeof it.id === 'string');
        after = first ? first.id : '';
        if (after) obj.selected = after; else delete obj.selected;
      }
      const span = stringSpan(text, e.name);
      text = text.slice(0, span.inner) + escapeXml(JSON.stringify(obj)) + text.slice(span.innerEnd);
      lists.push({ ns: e.name.slice(5), removed: gone, selectedBefore: before, selectedAfter: after });
    }
    const missing = wanted.filter((x) => !removedMaps.includes(x) && !inLists.has(x));
    return { text, removedMaps, lists, missing, warnings };
  }

  // Where an item is stored: its map|<id> entry and the list|<ns> entry that lists it ('' when there is none).
  function sourceOf(parsed, id) {
    const mapEntry = parsed.entries.some((e) => e.tag === 'string' && e.name === `map|${id}`) ? `map|${id}` : '';
    let listEntry = '';
    for (const e of parsed.entries) {
      if (e.tag !== 'string' || !e.name.startsWith('list|')) continue;
      const r = tryJson(e.value);
      if (r.ok && isObj(r.value) && Array.isArray(r.value.items) && r.value.items.some((it) => isObj(it) && it.id === id)) { listEntry = e.name; break; }
    }
    return { mapEntry, listEntry, hasMap: Boolean(mapEntry) };
  }

  return { parse, analyze, diffEntries, entryValue, kindOf, guessKind, escapeXml, removeItems, sourceOf };
});
