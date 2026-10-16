'use strict';
// The tables of the admin page mark a clickable row with the class "pick" (tr.pick). A rule written for the bare class would restyle every such row
// (a pill-shaped, inline-flex row): the pickers of the "Thêm mốc cho súng" window once did, and every table lost its columns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, 'admin', 'app.css'), 'utf8');
const js = ['analysis.js', 'standards.js', 'ui.js'].map((f) => fs.readFileSync(path.join(__dirname, 'admin', f), 'utf8')).join('\n');

test('no rule of app.css styles the bare class .pick (it is the class of a table row, tr.pick)', () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.split('{')[0]);
  const bad = rules.flatMap((sel) => sel.split(',')).map((s) => s.trim()).filter((s) => /(^|[\s>+~])\.pick(?![\w-])/.test(s) && !/\btr\.pick\b|\btr\s*\.pick\b|\.pick\s+\.hover-actions/.test(s));
  assert.deepEqual(bad, [], `selectors that would restyle every row: ${bad.join(' | ')}`);
});

test('the class "pick" is only given to table rows in the page scripts', () => {
  const uses = [...js.matchAll(/class: [`'"]pick[`'" ]/g)];
  for (const u of uses) assert.match(js.slice(Math.max(0, u.index - 40), u.index), /el\('tr',\s*\{\s*$/, `a non-row element has class "pick" near ${u.index}`);
});
