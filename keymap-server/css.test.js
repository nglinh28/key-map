'use strict';
// The tables of the admin page mark a clickable row with the class "pick" (tr.pick). A rule written for the bare class would restyle every such row
// (a pill-shaped, inline-flex row): the pickers of the "Thêm mốc cho súng" window once did, and every table lost its columns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// every compound selector (a part between combinators) of every rule, also inside @media / @container, that has the class .pick but does not start with "tr"
function rowClassMisuse(cssText) {
  const selectors = [...cssText.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith('@'));
  const bad = [];
  for (const sel of selectors.flatMap((s) => s.split(','))) {
    for (const compound of sel.trim().split(/\s*[\s>+~]\s*/)) if (/\.pick(?![\w-])/.test(compound) && !compound.startsWith('tr')) bad.push(sel.trim());
  }
  return bad;
}

test('rowClassMisuse finds the bare class wherever it hides, and leaves the valid selectors alone', () => {
  for (const css of ['.pick { display: flex; }', '@media (max-width: 600px) { .pick { display: flex } }', '@container (max-width: 900px) { .x, .pick:hover { color: red } }',
    '.active.pick { color: red }', ':is(.pick) { color: red }', 'tr.pick td .pick { color: red }', '.pick input { margin: 0 }']) {
    assert.notDeepEqual(rowClassMisuse(css), [], css);
  }
  for (const css of ['tr.pick { cursor: pointer }', 'tr.pick:hover td { background: red }', 'table.stack tr.pick:hover { color: red }', '.pick-card { display: block }', '.pick-grid, .pick-head input { margin: 0 }',
    '@media (hover: hover) { tr.pick .hover-actions { opacity: 0 } }', '.combo-table tbody tr.pick:hover td { background: none }']) {
    assert.deepEqual(rowClassMisuse(css), [], css);
  }
});

test('no rule of app.css styles the bare class .pick (it is the class of a table row, tr.pick)', () => {
  const bad = rowClassMisuse(fs.readFileSync(path.join(__dirname, 'admin', 'app.css'), 'utf8'));
  assert.deepEqual(bad, [], `selectors that would restyle every row: ${bad.join(' | ')}`);
});

test('the class "pick" is only given to table rows by the page scripts (el(...) style; classList / className are not used for it)', () => {
  const dir = path.join(__dirname, 'admin');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const js = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const u of js.matchAll(/class: [`'"]pick(?![\w-])/g)) assert.match(js.slice(Math.max(0, u.index - 40), u.index), /el\('tr',\s*\{\s*$/, `${f}: a non-row element has class "pick" near ${u.index}`);
    assert.doesNotMatch(js, /classList\.(add|toggle)\(\s*['"`]pick['"`]|className\s*=\s*['"`]pick(?![\w-])/, `${f} gives the class "pick" by classList / className`);
  }
});
