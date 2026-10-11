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

  return { parse, analyze, diffEntries, entryValue, kindOf, guessKind };
});
