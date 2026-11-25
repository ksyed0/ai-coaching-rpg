'use strict';
// tools/ci-docs-only.js decides which CI jobs a pull request may skip. A wrong "docs only" skips real checks, so both the
// classification and the list of docs that workspace tests read are pinned here.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { classify, isDoc, TEST_READ_DOCS } = require('../../tools/ci-docs-only');

const ROOT = path.join(__dirname, '../..');

describe('classify', () => {
  it('treats Markdown and PNG under docs/ and root Markdown as docs only', () => {
    const r = classify(['docs/VOICE_TEST_CHECKLIST.md', 'docs/img/a.png', 'progress.md', 'CHANGELOG.md']);
    expect(r).toEqual({ docsOnly: true, docTests: false });
  });

  it('is not docs only when any one file is code, even among many docs', () => {
    expect(classify(['docs/a.md', 'tools/x.js', 'docs/b.md']).docsOnly).toBe(false);
    expect(classify(['docs/a.md', 'services/runtime/src/a.ts']).docsOnly).toBe(false);
  });

  it('fails closed on an empty change list', () => {
    expect(classify([])).toEqual({ docsOnly: false, docTests: false });
    expect(classify(['', '  '])).toEqual({ docsOnly: false, docTests: false });
  });

  it.each([
    'docs/plan-status.json',
    'docs/sdlc-status.json',
    'docs/plan-status.html',
    'docs/demo/demo-up.sh',
    'docs/pitch/deck.pptx',
    'consent/v3.md',
    'tests/fixtures/sample.md',
    'packages/core/README.md',
    '.github/workflows/ci.yml',
    'package.json',
    'pnpm-lock.yaml',
    '"docs/caf\\303\\251.md"', // git quotes non-ASCII paths: never matches, so it counts as code
  ])('counts %s as code', (file) => {
    expect(classify(['docs/a.md', file]).docsOnly).toBe(false);
  });

  it('asks for the doc-reading workspace tests only when such a doc changed', () => {
    expect(classify(['docs/RELEASE_PLAN.md', 'progress.md'])).toEqual({ docsOnly: true, docTests: true });
    expect(classify(['AGENTS.md'])).toEqual({ docsOnly: true, docTests: true });
    expect(classify(['docs/other.md']).docTests).toBe(false);
  });

  it('never asks for doc tests on a PR that already runs everything', () => {
    expect(classify(['docs/RELEASE_PLAN.md', 'tools/x.js'])).toEqual({ docsOnly: false, docTests: false });
  });
});

describe('isDoc', () => {
  it('matches only root-level Markdown, not Markdown in other folders', () => {
    expect(isDoc('README.md')).toBe(true);
    expect(isDoc('services/x/README.md')).toBe(false);
  });
});

describe('command line', () => {
  const run = (input) =>
    execFileSync('node', [path.join(ROOT, 'tools/ci-docs-only.js')], { input, encoding: 'utf8' });

  it('prints the two outputs for $GITHUB_OUTPUT', () => {
    expect(run('docs/a.md\nprogress.md\n')).toBe('docs_only=true\ndoc_tests=false\n');
    expect(run('docs/RELEASE_PLAN.md\n')).toBe('docs_only=true\ndoc_tests=true\n');
    expect(run('tools/x.js\n')).toBe('docs_only=false\ndoc_tests=false\n');
    expect(run('')).toBe('docs_only=false\ndoc_tests=false\n');
  });
});

describe('TEST_READ_DOCS stays in step with the workspace tests', () => {
  const WORKSPACES = ['apps', 'packages', 'services'];
  const isTestFile = (f) => /(__tests__\/|\.test\.|\.spec\.)/.test(f) && /\.(ts|tsx|js|mjs)$/.test(f);

  const trackedTests = () =>
    execFileSync('git', ['ls-files', '--', ...WORKSPACES], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(isTestFile);

  // Repo documents (docs/**.md and root *.md) that a test file names in a string literal, whether as 'docs/X.md', 'AGENTS.md' or "docs", "X.md".
  const docsNamedIn = (text) => {
    const found = new Set();
    for (const m of text.matchAll(/['"`](docs\/[^'"`\s]+\.md)['"`]/g)) found.add(m[1]);
    for (const m of text.matchAll(/['"`]docs['"`],\s*(?:['"`]([^'"`]+)['"`],\s*)*['"`]([^'"`]+\.md)['"`]/g)) found.add(`docs/${m[2]}`);
    for (const m of text.matchAll(/['"`]([A-Za-z_]+\.md)['"`]/g)) found.add(m[1]);
    return [...found].filter((f) => fs.existsSync(path.join(ROOT, f)));
  };

  // Test files that name a repo document without reading it (a string compared against, or a file made in a temp folder). Add with a reason.
  const NAMED_NOT_READ = new Set([
    'services/voice-ops/src/__tests__/up.test.ts', // expects the message to mention docs/VOICE_RUNBOOK.md
    'services/voice-ops/src/__tests__/checks/local.test.ts', // expects the message to mention docs/VOICE_RUNBOOK.md
    'services/voice-ops/src/__tests__/checks/http.test.ts', // expects the message to mention docs/VOICE_RUNBOOK.md
    'services/runtime/src/review/__tests__/cli.test.ts', // writes a README.md into a temp folder
  ]);

  it('lists every repo document a workspace test reads', () => {
    const missing = [];
    for (const rel of trackedTests()) {
      if (NAMED_NOT_READ.has(rel)) continue;
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      if (!/readFile|readFileSync|createReadStream/.test(text)) continue;
      for (const doc of docsNamedIn(text)) {
        if (!TEST_READ_DOCS.includes(doc)) missing.push(`${rel} reads ${doc}`);
      }
    }
    // A failure here means: add the document to TEST_READ_DOCS in tools/ci-docs-only.js (and, if it is not
    // yet covered, to the `ws-doc-tests` job's test list in .github/workflows/ci.yml).
    expect(missing).toEqual([]);
  });

  it('only lists documents that exist', () => {
    for (const doc of TEST_READ_DOCS) expect(fs.existsSync(path.join(ROOT, doc))).toBe(true);
  });

  it('is read by the ws-doc-tests job, which runs the vitest files that read them', () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    for (const t of [
      'src/__tests__/plan-text.test.ts',
      'src/calibration/__tests__/docs-example.test.ts',
      'src/review/__tests__/agent-rule.test.ts',
    ]) {
      expect(ci).toContain(t);
    }
  });
});
