import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatRequest } from "@acr/adapters";
import { evaluateSession } from "../evaluate.js";
import { parseEvalConfig } from "../config.js";
import { writeReports } from "../report-write.js";
import { verifyReportFiles } from "../verify.js";
import { createScriptedEvaluator } from "../../demo/eval-mock.js";
import { sampleEvents, sampleRubrics, sampleScenario } from "./fixtures.js";

const parsed = parseEvalConfig({}); if (!parsed.ok) throw new Error("cfg");
const cfg = parsed;

async function written() {
  const out = await mkdtemp(path.join(os.tmpdir(), "acr-ver-"));
  const provider = createScriptedEvaluator(sampleEvents(), sampleScenario(), sampleRubrics());
  const result = await evaluateSession({ events: sampleEvents(), scenario: sampleScenario(), rubrics: sampleRubrics(), provider, config: cfg });
  const w = await writeReports(result, { outDir: out, evaluator: { provider: "scripted" } });
  return { out, w };
}

describe("verifyReportFiles", () => {
  it("passes for reports from the scripted evaluator and counts what it checked", async () => {
    const { out, w } = await written();
    try {
      const v = await verifyReportFiles(w.dir, sampleEvents(), sampleScenario());
      expect(v.problems).toEqual([]);
      expect(v.reports).toBe(3);
      expect(v.quotes).toBeGreaterThan(3);
      expect(v.scores).toBeGreaterThan(5);
    } finally { await rm(out, { recursive: true, force: true }); }
  });
  it("catches a doctored quote, a score out of range, a missing method and a missing file", async () => {
    const { out, w } = await written();
    try {
      const file = path.join(w.dir, "alice.json");
      const j = JSON.parse(await readFile(file, "utf8"));
      const withEvidence = j.criteria.find((c: { evidence: unknown[] }) => c.evidence.length > 0);
      withEvidence.evidence[0].quote = "words nobody ever said at all";
      j.criteria[0].score = 7;
      j.method = { sections: [] };
      await writeFile(file, JSON.stringify(j));
      await writeFile(path.join(w.dir, "bob.md"), "# no method here\n");
      await rm(path.join(w.dir, "group.json"));
      const v = await verifyReportFiles(w.dir, sampleEvents(), sampleScenario());
      const text = v.problems.join("\n");
      expect(text).toMatch(/alice: .* quote is not verbatim/);
      expect(text).toMatch(/alice: criterion discovery has the score 7/);
      expect(text).toMatch(/alice.json has no method/);
      expect(text).toMatch(/bob.md has no method section/);
      expect(text).toMatch(/group.json is missing/);
    } finally { await rm(out, { recursive: true, force: true }); }
  });
  it("catches a quote of another participant's line and an unknown line", async () => {
    const { out, w } = await written();
    try {
      const file = path.join(w.dir, "alice.json");
      const j = JSON.parse(await readFile(file, "utf8"));
      const c = j.criteria.find((x: { evidence: unknown[] }) => x.evidence.length > 0);
      c.evidence = [{ seq: 4, quote: "the ingestion layer", role: "bob" }, { seq: 999, quote: "whatever it says", role: "alice" }];
      await writeFile(file, JSON.stringify(j));
      const v = await verifyReportFiles(w.dir, sampleEvents(), sampleScenario());
      expect(v.problems.join("\n")).toMatch(/quotes line #4, spoken by bob/);
      expect(v.problems.join("\n")).toMatch(/line #999, which is not an utterance/);
    } finally { await rm(out, { recursive: true, force: true }); }
  });
  it("an empty directory reports every file as missing without throwing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-ver-"));
    try { expect((await verifyReportFiles(dir, sampleEvents(), sampleScenario())).problems.length).toBeGreaterThan(5); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("the scripted evaluator", () => {
  it("answers each request from the recorded session, deterministically", async () => {
    const run = async () => {
      const p = createScriptedEvaluator(sampleEvents(), sampleScenario(), sampleRubrics());
      const texts: string[] = [];
      for (const system of ['score only the participant with role id "alice"', 'score only the participant with role id "bob"', "score the TEAM"]) {
        let t = ""; for await (const c of p.stream({ system, messages: [], maxTokens: 1 } as ChatRequest)) t += c; texts.push(t);
      }
      return texts;
    };
    const a = await run(); const b = await run();
    expect(a).toEqual(b);
    expect(a.every((t) => JSON.parse(t).criteria.length > 0)).toBe(true);
    expect(a[1]).toContain("never said by anyone");
  });
  it("stops yielding when aborted", async () => {
    const p = createScriptedEvaluator(sampleEvents(), sampleScenario(), sampleRubrics());
    const ac = new AbortController(); ac.abort();
    let t = ""; for await (const c of p.stream({ system: "score the TEAM", messages: [], maxTokens: 1 } as ChatRequest, ac.signal)) t += c;
    expect(t).toBe("");
  });
});
