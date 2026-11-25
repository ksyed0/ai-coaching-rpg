#!/usr/bin/env node
'use strict';
// Classifies the files changed by a pull request so CI can skip the code-only jobs on a docs-only PR.
//
//   git diff --name-only --no-renames HEAD^1 HEAD | node tools/ci-docs-only.js >> "$GITHUB_OUTPUT"
//
// Prints two lines: `docs_only=true|false` and `doc_tests=true|false`.
//   docs_only  every changed file is documentation (see isDoc): the code-only jobs may be skipped.
//   doc_tests  docs_only AND a changed file is read by a workspace (vitest) test, so those tests still need to run.
// It fails closed: an empty list, or any file that is not plainly documentation, gives docs_only=false.
// See the `changes` job in .github/workflows/ci.yml and the "CI Pipeline" section of AGENTS.md.

// Documentation: Markdown or PNG under docs/, or a Markdown file at the repository root.
// Deliberately not docs: docs/*.json (tool inputs), docs/*.html (generated), docs/**/*.sh, *.pptx, and any
// Markdown below the root outside docs/ (consent/*.md is copied into the runtime image; fixtures are test inputs).
const DOC_PATTERNS = [/^docs\/.+\.(md|png)$/, /^[^/]+\.md$/];

// Documentation that a workspace test reads and asserts on. Changing one still needs those tests, but not the rest of the workspace jobs.
// tests/unit/ci-docs-only.test.js fails when a workspace test starts reading a doc that is not listed here.
const TEST_READ_DOCS = [
  'AGENTS.md',
  'docs/EVALUATOR.md',
  'docs/RELEASE_PLAN.md',
  'docs/superpowers/plans/2026-10-01-slice-1-script-and-text-runtime.md',
];

function isDoc(file) {
  return DOC_PATTERNS.some((re) => re.test(file));
}

function classify(files) {
  const list = files.map((f) => f.trim()).filter(Boolean);
  const docsOnly = list.length > 0 && list.every(isDoc);
  return {
    docsOnly,
    docTests: docsOnly && list.some((f) => TEST_READ_DOCS.includes(f)),
  };
}

function main() {
  const input = require('fs').readFileSync(0, 'utf8');
  const { docsOnly, docTests } = classify(input.split('\n'));
  process.stdout.write(`docs_only=${docsOnly}\ndoc_tests=${docTests}\n`);
}

if (require.main === module) main();

module.exports = { classify, isDoc, TEST_READ_DOCS };
