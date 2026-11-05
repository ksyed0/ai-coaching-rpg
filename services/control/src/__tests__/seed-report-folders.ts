// Run under tsx by apps/web/e2e/helpers/reports.ts (the web app and its specs never import the runtime; the runtime's own fixtures
// are the honest way to get a released review folder). Not a test: vitest only collects *.test.ts. Usage: tsx seed-report-folders.ts <reportsDir> <sessionId>
//
// It writes what an operator's `evaluate` and `moderate` leave under <CONTROL_DATA_DIR>/reports:
//   <id>    a first run, opened, every item accepted and released (alice and bob), then SUPERSEDED by
//   <id>-2  a re-run whose bob draft differs (a changed strength line), moderated and released: the live review.
// So a reader that picks the wrong folder shows bob's OLD text, and the e2e can tell.
import { readFile, writeFile } from "node:fs/promises";
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

const [reportsDir, sessionId] = process.argv.slice(2);
if (!reportsDir || !sessionId) throw new Error("usage: seed-reports <reportsDir> <sessionId>");

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
