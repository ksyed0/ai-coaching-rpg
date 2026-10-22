import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../calibration/rubric-hash.js", () => ({ rubricHash: () => { throw new Error("cannot hash"); } }));
const lookup = vi.fn();
vi.mock("../../calibration/stamp.js", async (orig) => ({ ...(await orig<typeof import("../../calibration/stamp.js")>()), lookupCalibration: (...a: unknown[]) => lookup(...a) }));

import { runEvaluate } from "../cli.js";
import { build } from "./fixtures.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-hash-")); lookup.mockReset(); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const provider = { name: "fake", async *stream() { yield JSON.stringify({ criteria: [], talking_points: [] }); } };
it("a rubric hash that cannot be computed gives not_calibrated, no lookup, and the report still renders", async () => {
  const evs = build([
    [0, { type: "session.started", scenarioId: "esc-scope-creep-01", version: "1.2", roles: {} }],
    [1, { type: "scene.entered", sceneId: "s1_huddle", participants: ["delivery_lead", "tech_lead", "account_manager"] }],
    [200, { type: "session.ended", reason: "script_complete" }],
  ] as never, "hash-sess");
  const log = path.join(dir, "hash-sess.jsonl");
  await writeFile(log, evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await mkdir(path.join(dir, "o"));
  const out: string[] = [];
  const r = await runEvaluate({ argv: [log, "--out", path.join(dir, "o")], stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) }, env: { MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-secret-value-12345", EVAL_MODEL: "m" }, repoRoot: REPO, cwd: dir, provider });
  expect([0, 1]).toContain(r.exitCode); // the fake model's empty answers may fail an evaluation; the reports are written either way
  expect(lookup).not.toHaveBeenCalled();
  const md = await readFile(path.join(dir, "o", "hash-sess", "index.md"), "utf8");
  expect(md).toContain("Calibration: not calibrated");
  expect(JSON.parse(await readFile(path.join(dir, "o", "hash-sess", "group.json"), "utf8")).evaluator).not.toHaveProperty("rubricHash");
});
