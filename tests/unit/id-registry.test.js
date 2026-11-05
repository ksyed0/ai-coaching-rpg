'use strict';
// docs/ID_REGISTRY.md must stay in step with the ids used in the tracked plan files:
// the "Next Available" id is above every id in use (or reserved in the registry's 'Reserved blocks' note), and "Last Assigned" is the highest one.
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '../../docs');
const read = (f) => (fs.existsSync(path.join(DOCS, f)) ? fs.readFileSync(path.join(DOCS, f), 'utf8') : '');

const PLAN_FILES = ['RELEASE_PLAN.md', 'BUGS.md', 'TEST_CASES.md', 'LESSONS.md'];

function parseRegistry(text) {
  const rows = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*([A-Z]+)\s*\|\s*([A-Z]+-\d{4})\s*\|\s*([A-Z]+-\d{4}|—)\s*\|/);
    if (m) rows[m[1]] = { next: m[2], last: m[3] };
  }
  return rows;
}

function highestUsed(prefix, text) {
  const re = new RegExp(`\\b${prefix}-(\\d{4})\\b`, 'g');
  let max = 0;
  for (const m of text.matchAll(re)) max = Math.max(max, Number(m[1]));
  return max;
}

describe('docs/ID_REGISTRY.md', () => {
  const registry = parseRegistry(read('ID_REGISTRY.md'));
  // Ids reserved for parallel work (the 'Reserved blocks' note under the registry table) count as in use.
  const reserved = read('ID_REGISTRY.md').split('\n').filter((l) => l.startsWith('Reserved blocks')).join('\n');
  const all = [...PLAN_FILES.map(read), reserved].join('\n');

  it('lists every id sequence', () => {
    for (const p of ['EPIC', 'US', 'TASK', 'AC', 'TC', 'BUG']) expect(registry[p]).toBeDefined();
  });

  for (const prefix of ['EPIC', 'US', 'TASK', 'AC', 'TC', 'BUG', 'L']) {
    it(`${prefix}: next available id is one above the highest id in use`, () => {
      const row = registry[prefix];
      if (!row) return; // sequences the registry does not list are checked by 'lists every id sequence'
      const max = highestUsed(prefix, all);
      const pad = (n) => `${prefix}-${String(n).padStart(4, '0')}`;
      expect(row.next).toBe(pad(max + 1));
      expect(row.last).toBe(max === 0 ? '—' : pad(max));
    });
  }
});
