#!/usr/bin/env node
// npm audit gate: fails on high/critical advisories except those listed in
// .audit-ignore (one GHSA id per line, '#' comments). npm has no native ignore.
// The same advisories are ignored for pnpm via auditConfig in pnpm-workspace.yaml.
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const MIN = LEVELS.high;

function loadIgnored(file) {
  if (!fs.existsSync(file)) return new Set();
  return new Set(
    fs.readFileSync(file, 'utf8').split('\n')
      .map((l) => l.replace(/#.*/, '').trim()).filter(Boolean),
  );
}

function findBlocking(report, ignored) {
  const out = new Map();
  for (const vuln of Object.values(report.vulnerabilities || {})) {
    for (const via of vuln.via || []) {
      if (typeof via !== 'object') continue; // propagated from another package
      const ghsa = (via.url || '').split('/').pop();
      if (LEVELS[via.severity] >= MIN && !ignored.has(ghsa)) {
        out.set(ghsa || via.source, `${via.name} ${via.range} (${via.severity}) ${via.url || ''}`);
      }
    }
  }
  return out;
}

if (require.main === module) {
  const res = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  let report;
  try { report = JSON.parse(res.stdout); } catch { console.error('npm audit gave no JSON:\n' + res.stderr); process.exit(2); }
  if (report.error) { console.error('npm audit error:', report.error.summary || report.error); process.exit(2); }
  const ignored = loadIgnored(path.join(__dirname, '..', '.audit-ignore'));
  const blocking = findBlocking(report, ignored);
  if (ignored.size) console.log(`Ignoring ${[...ignored].join(', ')} (see .audit-ignore)`);
  if (blocking.size) {
    console.error('High/critical advisories:');
    for (const v of blocking.values()) console.error('  ' + v);
    process.exit(1);
  }
  console.log('npm audit: no high/critical advisories outside .audit-ignore');
}
module.exports = { findBlocking, loadIgnored };
