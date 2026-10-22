import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rubricHash } from "../../calibration/rubric-hash.js";
import { summaryFile } from "../../calibration/report.js";
import { parseEvalConfig } from "../config.js";
import { PROMPT_VARIANT, buildEvaluatorInfo } from "../provider.js";
import { sampleRubrics } from "./fixtures.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-info-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const cfgOf = (env: NodeJS.ProcessEnv) => { const c = parseEvalConfig(env); if (!c.ok) throw new Error("cfg"); return c; };
const base = { scenarioId: "esc-scope-creep-01", rubrics: sampleRubrics() };
const SUMMARY = (hash: string) => ({ schema: "acr.calibration.summary/1", scenarioId: "esc-scope-creep-01", rubricHash: hash, variant: PROMPT_VARIANT, judge: { label: "primary", model: "m1" }, ranAt: "2026-10-08T00:00:00.000Z",
  probes: { total: 30, tune: 15, holdout: 15 }, exact: { n: 28, of: 30 }, bias: 0.1, contrast: { ordered: 3, of: 3, probes: 3 }, usable: { n: 30, of: 30 }, label: "PASS" });

describe("buildEvaluatorInfo", () => {
  it("a real evaluator: effective model from NPC_MODEL, variant, rubric hash and the matching calibration", async () => {
    const hash = rubricHash(base.rubrics);
    const f = summaryFile(dir, base.scenarioId, "m1", PROMPT_VARIANT);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify(SUMMARY(hash)));
    const env = { MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-secret-value-12345", NPC_MODEL: " m1 " };
    const info = await buildEvaluatorInfo({ env, cfg: cfgOf(env), scripted: false, ...base, calibrationDir: dir });
    expect(info).toMatchObject({ model: "m1", variant: "v1", rubricHash: hash, calibration: { state: "ok" } });
    expect(info.scripted).toBeUndefined();
  });
  it("EVAL_MODEL wins over NPC_MODEL; no model at all means no lookup", async () => {
    const env = { MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-secret-value-12345", NPC_MODEL: "a", EVAL_MODEL: "b" };
    expect((await buildEvaluatorInfo({ env, cfg: cfgOf(env), scripted: false, ...base, calibrationDir: dir })).model).toBe("b");
    const none = { MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-secret-value-12345" };
    const info = await buildEvaluatorInfo({ env: none, cfg: cfgOf(none), scripted: false, ...base, calibrationDir: dir });
    expect(info).not.toHaveProperty("model");
    expect(info.calibration).toEqual({ state: "not_calibrated" });
  });
  it("scripted: constant not_calibrated, no model, even with a matching file", async () => {
    const f = summaryFile(dir, base.scenarioId, "m1", PROMPT_VARIANT);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify(SUMMARY(rubricHash(base.rubrics))));
    const env = { NPC_MODEL: "m1" };
    const info = await buildEvaluatorInfo({ env, cfg: cfgOf(env), scripted: true, ...base, calibrationDir: dir });
    expect(info).toMatchObject({ scripted: true, variant: "v1", calibration: { state: "not_calibrated" } });
    expect(info).not.toHaveProperty("model");
  });
  it("an unhashable rubric gives not_calibrated and no rubricHash", async () => {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    const env = { MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-secret-value-12345", EVAL_MODEL: "m1" };
    const info = await buildEvaluatorInfo({ env, cfg: cfgOf(env), scripted: false, scenarioId: base.scenarioId, rubrics: [circular as never], calibrationDir: dir });
    expect(info.calibration).toEqual({ state: "not_calibrated" });
    expect(info).not.toHaveProperty("rubricHash");
  });
});
