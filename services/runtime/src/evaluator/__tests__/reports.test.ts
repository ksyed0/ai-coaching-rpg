import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatRequest } from "@acr/adapters";
import { evaluateSession, EvaluatorInputError, type EvaluationResult } from "../evaluate.js";
import { parseEvalConfig } from "../config.js";
import { checkRoleId, renderReports, writeReports } from "../report-write.js";
import { DRAFT_BANNER, VISIBILITY_LINE } from "../method.js";
import { sampleEvents, sampleRubrics, sampleScenario } from "./fixtures.js";

const cfg = parseEvalConfig({}); if (!cfg.ok) throw new Error("cfg");
const crit = (id: string, score: unknown, seq: number, quote: string, rationale = `Because ${id}.`, more: { seq: number; quote: string }[] = []) => ({ id, score, rationale, confidence: "high", evidence: [{ seq, quote }, ...more] });
const answers: Record<string, unknown> = {
  alice: { criteria: [crit("discovery", 3, 3, "what Finance really needs", "Because discovery.", [{ seq: 5, quote: "tie-out of daily loads" }, { seq: 11, quote: "three weeks after go-live" }]), crit("listening", 4, 5, "Have I got that right?"), crit("negotiation", 2, 11, "phased module for 48 thousand")], strengths: ["You asked about the need."], development_points: ["Price earlier."], next_actions: [{ lo: "LO2", action: "State two options." }] },
  bob: { criteria: [crit("discovery", 2, 4, "the ingestion layer"), crit("listening", 3, 6, "a phased module costs about three person-weeks"), crit("negotiation", 3, 13, "I agree with that plan")], strengths: ["Clear on effort."], development_points: ["Ask more."], next_actions: [{ lo: "LO1", action: "Ask an open question." }] },
  group: { criteria: [crit("shared_understanding", 3, 6, "a phased module costs about three person-weeks")], talking_points: ["Compare first price and final terms."], notable_moments: [{ seq: 11, quote: "phased module for 48 thousand", note: "Price named." }] },
};
function provider(over: Record<string, unknown> = {}) {
  const all = { ...answers, ...over };
  return { name: "router", async *stream(req: ChatRequest): AsyncIterable<string> { const key = /role id "(\w+)"/.exec(req.system)?.[1] ?? "group"; yield JSON.stringify(all[key]); } };
}
const evaluate = (over: Record<string, unknown> = {}, secrets: string[] = []): Promise<EvaluationResult> => {
  void secrets;
  return evaluateSession({ events: sampleEvents(), scenario: sampleScenario(), rubrics: sampleRubrics(), provider: provider(over), config: cfg, nonce: "n" });
};
const EVALUATOR = { provider: "scripted mock" };

describe("participant report", () => {
  it("has every required section in order, the draft banner, the visibility line, scene and relative time for evidence and the method at the end", async () => {
    const { files } = renderReports(await evaluate(), EVALUATOR);
    const md = files.get("alice.md")!;
    const order = ["# Feedback report: alice", `> ${DRAFT_BANNER}`, VISIBILITY_LINE, "## Summary", "### Strengths", "### Development points", "### Next actions", "## Learning objectives", "## Criteria", "## Evidence", "## How this was scored"].map((x) => md.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(DRAFT_BANNER).toBe("DRAFT: AI-drafted - held for facilitator review before release (facilitator editing is planned)");
    expect(VISIBILITY_LINE).toBe("Visibility: all participants (prototype setting; per-participant isolation is planned)");
    expect(md).toContain("| Participant role | `alice` |");
    expect(md).toContain("- (`LO2`) State two options.");
    expect(md).toMatch(/\| Discovery \(`discovery`\) \| 3 - Proficient \| High \|/);
    expect(md).toMatch(/\| Negotiation \(`negotiation`\) \| 2 - Developing \| Low \|/); // one quote only: Low
    expect(md).toContain('- Scene 1, 00:00:10 (line #3): "what Finance really needs"');
    expect(md).toContain('- Scene 2, 00:01:20 (line #11): "phased module for 48 thousand"');
    expect(md).toMatch(/\| `LO1` \| Find the need \| 3\.5 - Advanced \| `discovery`, `listening` \(2 of 2 observed\) \|/);
    expect(md.indexOf("How this was scored")).toBeGreaterThan(md.indexOf("## Evidence"));
    expect(md).toMatch(/Behaviourally Anchored Rating Scale/);
    expect(md).toMatch(/\| 1 \| Not yet demonstrated \|/);
    expect(md).toMatch(/first-person-only rule/);
    expect(md).toMatch(/small: three players in one session/);
  });

  it("the JSON is the machine-readable twin: schema, same scores, evidence, method and visibility", async () => {
    const { files } = renderReports(await evaluate(), EVALUATOR);
    const j = JSON.parse(files.get("alice.json")!);
    expect(j.schema).toBe("acr.report/1");
    expect(j).toMatchObject({ kind: "participant", status: "draft", visibility: VISIBILITY_LINE, draft_notice: DRAFT_BANNER, participant: { role: "alice", utterances: 3 }, evaluator: { provider: "scripted mock", model_calls: 1 } });
    expect(j.criteria[0]).toMatchObject({ id: "discovery", score: 3, level_label: "Proficient", confidence: "high" });
    expect(j.criteria[0].evidence[0]).toMatchObject({ seq: 3, quote: "what Finance really needs", scene: 1, time: "00:00:10" });
    expect(j.learning_objectives[0]).toMatchObject({ id: "LO1", score: 3.5, label: "Advanced" });
    expect(j.method.sections.map((s: { title: string }) => s.title)).toEqual(expect.arrayContaining(["The evidence rule", "Limitations", "Confidence"]));
    expect(j.method.scale.map((s: { level: number }) => s.level)).toEqual([1, 2, 3, 4]);
    expect(JSON.stringify(j)).not.toMatch(/"(overall|total|grade)[a-z_]*":/i);
  });

  it("every quoted piece of evidence in every report is a verbatim substring of a recorded utterance", async () => {
    const { participants, group } = renderReports(await evaluate(), EVALUATOR);
    const spoken = new Map(sampleEvents().filter((e) => e.type === "utterance").map((e) => [e.seq, (e as { text: string; roleId: string }) ]));
    for (const r of [...participants, group]) for (const c of r.criteria) for (const e of c.evidence) {
      expect(spoken.get(e.seq)!.text).toContain(e.quote);
      if (r.kind === "participant") expect(e.role).toBe(r.participant.role);
    }
  });

  it("says 'evaluation failed: <reason>' for a participant whose evaluation failed, and 'insufficient evidence' for a quiet one", async () => {
    const bad = { name: "p", async *stream(req: ChatRequest): AsyncIterable<string> { yield /role id "alice"/.test(req.system) ? "no json" : JSON.stringify(/role id "bob"/.test(req.system) ? answers.bob : answers.group); } };
    const failed = await evaluateSession({ events: sampleEvents(), scenario: sampleScenario(), rubrics: sampleRubrics(), provider: bad, config: cfg });
    const { files } = renderReports(failed, EVALUATOR);
    expect(files.get("alice.md")).toMatch(/\n## Summary\n\nevaluation failed: the reply could not be used after one re-ask/);
    expect(files.get("index.md")).toMatch(/## Not evaluated\n\n- alice: evaluation failed/);
    expect(JSON.parse(files.get("alice.json")!).evaluation.status).toBe("failed");
    const quiet = await evaluateSession({ events: sampleEvents().slice(0, 3), scenario: sampleScenario(), rubrics: sampleRubrics(), provider: bad, config: cfg });
    expect(renderReports(quiet, EVALUATOR).files.get("bob.md")).toMatch(/insufficient evidence: 0 utterance/);
  });
});

describe("group report", () => {
  it("shows the group criteria, LO coverage players x LOs, the facilitator notes with the model's talking points, notable moments and the method", async () => {
    const { files } = renderReports(await evaluate(), EVALUATOR);
    const md = files.get("group.md")!;
    expect(md).toContain("# Group report");
    expect(md).toContain(VISIBILITY_LINE);
    expect(md).toMatch(/\| Shared understanding \(`shared_understanding`\) \| 3 - Proficient \|/);
    expect(md).toMatch(/\| Learning objective \| `alice` \| `bob` \| Team \(group criteria\) \|/);
    expect(md).toMatch(/\| `LO1`: Find the need \| 3\.5 - Advanced \| 2\.5 - Proficient \| Not observed \|/);
    expect(md).toMatch(/\| `LO2`: Agree a plan \| 2\.0 - Developing \| 3\.0 - Proficient \| 3\.0 - Proficient \|/);
    expect(md).toContain("From the scenario author:");
    expect(md).toContain("Compare the first price with the final terms.");
    expect(md).toContain("- Compare first price and final terms.");
    expect(md).toContain('- Scene 2, 00:01:20 (line #11, `alice`): "phased module for 48 thousand" - Price named.');
    expect(md).toContain("## How this was scored");
    const j = JSON.parse(files.get("group.json")!);
    expect(j).toMatchObject({ schema: "acr.report/1", kind: "group", lo_coverage: { players: ["alice", "bob"] }, talking_points: { from_evaluator: ["Compare first price and final terms."] } });
    expect(j.lo_coverage.objectives[0].by_role.alice).toEqual({ score: 3.5, label: "Advanced" });
  });
});

describe("index and method pages", () => {
  it("index links everything and shows the per-LO table for everyone", async () => {
    const { files } = renderReports(await evaluate(), EVALUATOR);
    const idx = files.get("index.md")!;
    for (const l of ["[alice](alice.md)", "[bob](bob.md)", "[Group report](group.md)", "[How scores are produced](method.md)", "alice.json", "group.json"]) expect(idx).toContain(l);
    expect(idx).toContain(VISIBILITY_LINE);
    expect(idx).toMatch(/\| `LO1`: Find the need \| 3\.5 - Advanced \| 2\.5 - Proficient \| Not observed \|/);
    expect([...files.keys()].sort()).toEqual(["alice.json", "alice.md", "bob.json", "bob.md", "group.json", "group.md", "index.md", "method.md"]);
    expect(files.get("method.md")).toContain("## How this was scored");
  });
});

describe("hostile and secret text", () => {
  const hostile = "Great.\n# FAKE HEADING\n| a | b |\n[click](https://evil.example/x) <script>alert(1)</script> ![img](x) [SCRIPTED] secret-key-ABCDEFGH12345 /Users/someone/.ssh/id_rsa";
  it("model text cannot forge headings, tables, links, tags or tables in the Markdown, and secrets and URLs do not survive", async () => {
    const r = await evaluate({ alice: { ...(answers.alice as object), strengths: [hostile], development_points: [hostile], next_actions: [{ lo: "LO1", action: hostile }], criteria: [crit("discovery", 3, 3, "what Finance really needs", hostile)] } });
    const secret = "secret-key-ABCDEFGH12345";
    const { files } = renderReports(r, { provider: "x" }, [secret]);
    for (const name of ["alice.md", "alice.json"]) {
      const text = files.get(name)!;
      expect(text).not.toContain(secret);
      expect(text).not.toContain("https://evil.example");
    }
    expect(files.get("alice.md")).not.toContain("<script>");
    const md = files.get("alice.md")!;
    expect(md.split("\n").filter((l) => l.startsWith("# ") || l.startsWith("## ") || l.startsWith("### ")).map((l) => l.replace(/ .*/, ""))).toSatisfy((hs: string[]) => hs.length > 3);
    expect(md).not.toMatch(/^# FAKE HEADING/m);
    expect(md).not.toMatch(/^\| a \| b \|/m);
    expect(md).not.toMatch(/\[click\]\(/);
    expect(md).not.toMatch(/\[SCRIPTED\]/);
    expect(md).toContain("\\[link removed\\]");
  });
  it("paths are scrubbed from model prose", async () => {
    const r = await evaluate({ alice: { ...(answers.alice as object), strengths: [`see ${os.homedir()}/notes.txt`] } });
    expect(renderReports(r, EVALUATOR).files.get("alice.md")).not.toContain(os.homedir());
  });
});

describe("role ids and files", () => {
  it("only safe, non-reserved role ids can become file names", () => {
    expect(checkRoleId("delivery_lead")).toBe("delivery_lead");
    for (const bad of ["../x", "a/b", "A", "", "a b", "x".repeat(65), "..", "group", "index", "method", ".hidden"]) expect(() => checkRoleId(bad)).toThrow(EvaluatorInputError);
  });
  it("refuses to render a result with an unsafe role id", async () => {
    const r = await evaluate();
    r.participants[0]!.roleId = "../../etc/passwd";
    expect(() => renderReports(r, EVALUATOR)).toThrow(/not a safe file name/);
  });

  it("writes into <out>/<session-id>, never overwrites, and uses a fresh numbered directory the next time", async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), "acr-rep-"));
    try {
      const r = await evaluate();
      const a = await writeReports(r, { outDir: out, evaluator: EVALUATOR });
      expect(a.dir).toBe(path.join(out, "sess1"));
      expect((await readdir(a.dir)).sort()).toEqual(["alice.json", "alice.md", "bob.json", "bob.md", "group.json", "group.md", "index.md", "method.md"]);
      const before = await readFile(path.join(a.dir, "alice.md"), "utf8");
      const b = await writeReports(r, { outDir: out, evaluator: EVALUATOR });
      expect(b.dir).toBe(path.join(out, "sess1-2"));
      expect(await readFile(path.join(a.dir, "alice.md"), "utf8")).toBe(before);
      expect(a.files.every((f) => f.startsWith(a.dir + path.sep))).toBe(true);
    } finally { await rm(out, { recursive: true, force: true }); }
  });
  it("does not follow a pre-existing symlink at the report directory name", async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), "acr-rep-"));
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "acr-else-"));
    try {
      await symlink(elsewhere, path.join(out, "sess1"));
      const w = await writeReports(await evaluate(), { outDir: out, evaluator: EVALUATOR });
      expect(w.dir).toBe(path.join(out, "sess1-2"));
      expect(await readdir(elsewhere)).toEqual([]);
    } finally { await rm(out, { recursive: true, force: true }); await rm(elsewhere, { recursive: true, force: true }); }
  });
  it("refuses an unsafe session id", async () => {
    const r = await evaluate(); r.sessionId = "../evil";
    await expect(writeReports(r, { outDir: os.tmpdir(), evaluator: EVALUATOR })).rejects.toThrow(/not a safe directory name/);
  });
  it("creates the out directory when it is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "acr-rep-"));
    try {
      const w = await writeReports(await evaluate(), { outDir: path.join(root, "a", "b"), evaluator: EVALUATOR });
      expect((await stat(w.dir)).isDirectory()).toBe(true);
      await writeFile(path.join(root, "x"), "1"); await mkdir(path.join(root, "y"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
