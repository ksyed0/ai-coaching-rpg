// Run under tsx by apps/web/e2e/helpers/reports.ts (the web app and its specs never import the runtime; the runtime's own fixtures
// are the honest way to get a released review folder). Not a test: vitest only collects *.test.ts.
// Usage: tsx seed-report-folders.ts <reportsDir> <sessionId> [released | draft | release <role> | resolve <role> <outcome> <reason> |
//        export <subject> <destDir>]
//
// released (the default) writes what an operator's `evaluate` and `moderate` leave under <CONTROL_DATA_DIR>/reports:
//   <id>    a first run, opened, every item accepted and released (alice and bob), then SUPERSEDED by
//   <id>-2  a re-run whose bob draft differs (a changed strength line), moderated and released: the live review.
// So a reader that picks the wrong folder shows bob's OLD text, and the e2e can tell.
//
// draft writes ONE live /2 review where alice is released and bob is still a draft. Bob's draft carries recognisable evaluator
// strings (CANARY_LEVEL as the level label, CANARY_RATIONALE in the rationale) so a spec can prove they never reach the page before
// release. The same strings are declared in apps/web/e2e/helpers/reports.ts.
//   release <role>   releases that role's report in the draft review (a facilitator releasing mid-test).
//   resolve <role> <outcome> <reason>   resolves that role's first open dispute with the facilitator's reason.
//   export <subject> <destDir>   the terminal's facilitator export of that subject into a new directory (the console e2e's oracle).
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateSession } from "../../../runtime/src/evaluator/evaluate.js";
import { parseEvalConfig } from "../../../runtime/src/evaluator/config.js";
import { writeReports } from "../../../runtime/src/evaluator/report-write.js";
import {
  sampleEvents,
  sampleProvider,
  sampleRubrics,
  sampleScenario,
} from "../../../runtime/src/evaluator/__tests__/fixtures.js";
import { makeRunner } from "../../../runtime/src/review/__tests__/fixtures.js";
import { loadReview } from "../../../runtime/src/review/store.js";

export const OLD_BOB = "Clear on effort.";
export const NEW_BOB = "Clear on effort and on the re-run.";
export const CANARY_LEVEL = "Canary-Level-Zebra";
export const CANARY_RATIONALE = "Canary-Rationale-Quokka";

const [reportsDir, sessionId, mode = "released", ...rest] = process.argv.slice(2);
if (!reportsDir || !sessionId) throw new Error("usage: seed-reports <reportsDir> <sessionId> [mode]");

const parsed = parseEvalConfig({});
if (!parsed.ok) throw new Error("evaluator config");
const cfg = parsed;

async function draft(): Promise<string> {
  const events = sampleEvents().map((e) => ({ ...e, sessionId }));
  const result = await evaluateSession({ events, scenario: sampleScenario(), rubrics: sampleRubrics(), provider: sampleProvider(), config: cfg, nonce: "n" });
  const w = await writeReports(result, { outDir: reportsDir!, evaluator: { provider: "scripted mock", scripted: true, rubricHash: "h1", variant: "v1" } });
  return w.dir;
}

const run = makeRunner(reportsDir);
async function ok(argv: string[]): Promise<void> {
  const r = await run(argv);
  if (r.code !== 0) throw new Error(`moderate ${argv[0]} failed (${r.code})`);
}
async function resolveAll(dir: string): Promise<void> {
  const rel = path.relative(reportsDir!, dir);
  const l = await loadReview(dir);
  for (const sv of l.view.subjects.values()) {
    for (const c of sv.criteria.filter((x) => x.status === "needs_review")) await ok(["accept", rel, sv.id, c.id, "--by", "kamal"]);
    const cur = (await loadReview(dir)).view.subjects.get(sv.id)!;
    if (cur.summaryStale) await ok(["accept", rel, sv.id, "--summary", "--by", "kamal"]);
  }
}

async function seedReleased(): Promise<void> {
  const dir1 = await draft();
  await ok(["open", path.relative(reportsDir, dir1), "--by", "kamal"]);
  await resolveAll(dir1);
  await ok(["release", path.relative(reportsDir, dir1), "--all", "--by", "kamal"]);

  const dir2 = await draft();
  const bob = path.join(dir2, "bob.json");
  const text = await readFile(bob, "utf8");
  if (!text.includes(OLD_BOB)) throw new Error("the fixture's bob draft changed");
  await writeFile(bob, text.replace(OLD_BOB, NEW_BOB));
  await ok(["supersede", path.relative(reportsDir, dir1), path.relative(reportsDir, dir2), "--by", "kamal"]);
  await resolveAll(dir2);
  await ok(["release", path.relative(reportsDir, dir2), "--all", "--by", "kamal"]);
  console.log(`seeded ${path.basename(dir1)} (superseded) and ${path.basename(dir2)} (live)`);
}

/** The one live review of the draft seed (the reports folder holds nothing else). */
async function onlyDir(): Promise<string> {
  const names = (await readdir(reportsDir!, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  if (names.length !== 1) throw new Error(`expected one review folder, found ${names.length}`);
  return path.join(reportsDir!, names[0]!);
}

async function seedDraft(): Promise<void> {
  const dir = await draft();
  const bob = path.join(dir, "bob.json");
  const doc = JSON.parse(await readFile(bob, "utf8")) as { criteria: { level_label: string; rationale: string }[] };
  for (const c of doc.criteria) {
    c.level_label = CANARY_LEVEL;
    c.rationale = `${CANARY_RATIONALE} for this criterion.`;
  }
  await writeFile(bob, JSON.stringify(doc, null, 2));
  const rel = path.relative(reportsDir!, dir);
  await ok(["open", rel, "--by", "kamal"]);
  await resolveAll(dir);
  await ok(["release", rel, "alice", "--by", "kamal"]);
  console.log(`seeded ${path.basename(dir)} (alice released, bob a draft)`);
}

async function releaseRole(role: string | undefined): Promise<void> {
  if (!role) throw new Error("release needs a role");
  const dir = await onlyDir();
  await ok(["release", path.relative(reportsDir!, dir), role, "--by", "kamal"]);
  console.log(`released ${role}`);
}

async function resolveDispute(role: string | undefined, outcome: string | undefined, reason: string | undefined): Promise<void> {
  if (!role || !outcome || !reason) throw new Error("resolve needs a role, an outcome and a reason");
  const dir = await onlyDir();
  const sv = (await loadReview(dir)).view.subjects.get(role);
  const open = sv?.responses.find((r) => r.dispute && !r.resolution);
  if (!open) throw new Error(`no open dispute for ${role}`);
  await ok(["resolve", path.relative(reportsDir!, dir), String(open.seq), "--outcome", outcome, "--reason", reason, "--by", "kamal"]);
  console.log(`resolved dispute #${open.seq}`);
}

async function exportFacilitator(subject: string | undefined, dest: string | undefined): Promise<void> {
  if (!subject || !dest) throw new Error("export needs a subject and a destination");
  const dir = await onlyDir();
  await ok(["export", path.relative(reportsDir!, dir), subject, "--for", "facilitator", "--to", dest, "--by", "kamal"]);
  console.log(`exported ${subject}`);
}

if (mode === "released") await seedReleased();
else if (mode === "draft") await seedDraft();
else if (mode === "release") await releaseRole(rest[0]);
else if (mode === "resolve") await resolveDispute(rest[0], rest[1], rest[2]);
else if (mode === "export") await exportFacilitator(rest[0], rest[1]);
else throw new Error(`unknown mode ${mode}`);
