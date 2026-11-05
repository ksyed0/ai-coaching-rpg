import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatRequest } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import { evaluateSession, EvaluatorInputError } from "../evaluate.js";
import { parseEvalConfig } from "../config.js";
import { renderReports, writeReports } from "../report-write.js";
import { AI_GROUP_OFF_NOTE, AI_GROUP_ON_NOTE, AI_PARTICIPANT_NOTE } from "../report-model.js";
import { verifyReportFiles } from "../verify.js";
import { sampleAnswers, sampleEvents, sampleRubrics, sampleScenario } from "./fixtures.js";

const cfg = parseEvalConfig({}); if (!cfg.ok) throw new Error("cfg");
const EVALUATOR = { provider: "scripted mock" };
const BOB_SEQ = 6;
const BOB_TEXT = "a phased module costs about three person-weeks";

const aiLog = (includeInGroup: boolean | undefined, roles: string[] = ["bob"]): SessionEvent[] => {
  const evs = sampleEvents().map((e) => ({ ...e })) as SessionEvent[];
  Object.assign(evs[0] as unknown as Record<string, unknown>, { logFormat: 3, aiRoles: roles, ...(includeInGroup === undefined ? {} : { includeInGroup }) });
  return evs;
};
const provider = {
  name: "router",
  async *stream(req: ChatRequest): AsyncIterable<string> {
    const key = /role id "(\w+)"/.exec(req.system)?.[1] ?? "group";
    const group = { criteria: [{ id: "shared_understanding", score: 3, rationale: "r", confidence: "high", evidence: [{ seq: BOB_SEQ, quote: BOB_TEXT }] }], talking_points: ["t"],
      notable_moments: [{ seq: BOB_SEQ, quote: BOB_TEXT, note: "effort named" }, { seq: 11, quote: "phased module for 48 thousand", note: "price named" }] };
    yield JSON.stringify(key === "group" ? group : sampleAnswers[key]);
  },
};
const evaluate = (on: boolean | undefined) => evaluateSession({ events: aiLog(on), scenario: sampleScenario(), rubrics: sampleRubrics(), provider, config: cfg, nonce: "n" });

async function inTmp<T>(fn: (out: string) => Promise<T>): Promise<T> {
  const out = await mkdtemp(path.join(os.tmpdir(), "acr-rai-"));
  try { return await fn(out); } finally { await rm(out, { recursive: true, force: true }); }
}

describe("reports of a session with an AI player", () => {
  it('on: group.md quotes bob as "(line #6, `bob` (AI player))" and group.json evidence has ai true', async () => {
    const { files, group } = renderReports(await evaluate(true), EVALUATOR);
    const md = files.get("group.md")!;
    expect(md).toContain(`(line #${BOB_SEQ}, \`bob\` (AI player))`);
    expect(md.split("\n").filter((l) => l.includes(`line #${BOB_SEQ},`)).every((l) => l.includes("(AI player)"))).toBe(true);
    const json = JSON.parse(files.get("group.json")!);
    expect(json.criteria[0].evidence[0]).toMatchObject({ seq: BOB_SEQ, role: "bob", ai: true });
    expect(json.notable_moments.find((m: { seq: number }) => m.seq === BOB_SEQ).ai).toBe(true);
    expect(json.notable_moments.find((m: { seq: number }) => m.seq === 11).ai).toBeUndefined();
    expect(group.ai_players).toEqual({ roles: ["bob"], included_in_group: true });
  });

  it("no file named bob.md or bob.json is written", async () => {
    await inTmp(async (out) => {
      const w = await writeReports(await evaluate(true), { outDir: out, evaluator: EVALUATOR });
      expect((await readdir(w.dir)).sort()).toEqual(["alice.json", "alice.md", "group.json", "group.md", "index.md", "method.md"]);
    });
  });

  it('index.md lists "- `bob`: AI player, not scored" and has no bob column', async () => {
    const md = renderReports(await evaluate(true), EVALUATOR).files.get("index.md")!;
    expect(md).toContain("- `bob`: AI player, not scored");
    expect(md).not.toContain("bob.md");
    const header = md.split("\n").find((l) => l.startsWith("| Learning objective"))!;
    expect(header).not.toContain("bob");
    expect(md.indexOf("- [How scores are produced](method.md)")).toBeLessThan(md.indexOf("AI player, not scored"));
  });

  it('the group header row reads "AI players (not scored individually)" with "bob (AI player)"', async () => {
    const md = renderReports(await evaluate(true), EVALUATOR).files.get("group.md")!;
    expect(md).toContain("| AI players (not scored individually) | `bob` (AI player) |");
    expect(md.indexOf("| Players |")).toBeLessThan(md.indexOf("| AI players (not scored individually) |"));
  });

  it("alice.json notes end with AI_PARTICIPANT_NOTE and group.json notes hold AI_GROUP_ON_NOTE", async () => {
    const files = renderReports(await evaluate(true), EVALUATOR).files;
    const a = JSON.parse(files.get("alice.json")!);
    expect(a.notes[a.notes.length - 1]).toBe(AI_PARTICIPANT_NOTE);
    expect(files.get("alice.md")).toContain(`Note: ${AI_PARTICIPANT_NOTE}`);
    const g = JSON.parse(files.get("group.json")!);
    expect(g.notes).toContain(AI_GROUP_ON_NOTE);
    expect(g.notes).not.toContain(AI_GROUP_OFF_NOTE);
    expect(AI_PARTICIPANT_NOTE).toBe("AI players took part in this session (marked AI player). Their lines are context only for your scores and are never quoted as your evidence.");
  });

  it("off: group.json notes hold AI_GROUP_OFF_NOTE and no evidence names bob", async () => {
    const files = renderReports(await evaluate(false), EVALUATOR).files;
    const g = JSON.parse(files.get("group.json")!);
    expect(g.notes).toContain(AI_GROUP_OFF_NOTE);
    expect(g.ai_players).toEqual({ roles: ["bob"], included_in_group: false });
    expect(JSON.stringify([g.criteria.map((c: { evidence: unknown }) => c.evidence), g.notable_moments])).not.toContain('"bob"');
  });

  it("method players is 1 for alice and an AI bob", async () => {
    const files = renderReports(await evaluate(true), EVALUATOR).files;
    expect(files.get("alice.md")).toMatch(/small: one player in one session/);
    expect(files.get("method.md")).toMatch(/small: one player in one session/);
  });

  it("an unsafe AI role id is refused before anything is rendered", async () => {
    const r = await evaluate(true);
    r.ai = { roles: ["Bad Id"], includeInGroup: true };
    expect(() => renderReports(r, EVALUATOR)).toThrow(EvaluatorInputError);
    r.ai = { roles: ["index"], includeInGroup: true };
    expect(() => renderReports(r, EVALUATOR)).toThrow(/reserved/);
  });

  it("every quote from an AI line in every written file is marked", async () => {
    await inTmp(async (out) => {
      for (const on of [true, false]) {
        const w = await writeReports(await evaluate(on), { outDir: out, evaluator: EVALUATOR });
        for (const name of await readdir(w.dir)) {
          const text = await readFile(path.join(w.dir, name), "utf8");
          if (name.endsWith(".md")) for (const l of text.split("\n")) if (l.includes(`line #${BOB_SEQ},`)) expect(l, `${name}: ${l}`).toContain("(AI player)");
          if (name.endsWith(".json")) {
            const j = JSON.parse(text);
            const quotes = [...(j.criteria ?? []).flatMap((c: { evidence: unknown[] }) => c.evidence), ...(j.notable_moments ?? [])] as { seq: number; ai?: true }[];
            for (const q of quotes.filter((x) => x.seq === BOB_SEQ)) expect(q.ai, `${name} seq ${BOB_SEQ}`).toBe(true);
          }
        }
      }
    });
  });
});

describe("verifyReportFiles on written AI reports", () => {
  const written = async (out: string, on: boolean) => (await writeReports(await evaluate(on), { outDir: out, evaluator: EVALUATOR })).dir;

  it("a written AI session passes verifyReportFiles", async () => {
    await inTmp(async (out) => {
      for (const on of [true, false]) {
        const v = await verifyReportFiles(await written(out, on), aiLog(on), sampleScenario());
        expect(v.problems).toEqual([]);
        expect(v.reports).toBe(2);
      }
    });
  });

  it('removing "ai": true from a bob quote in group.json is reported', async () => {
    await inTmp(async (out) => {
      const dir = await written(out, true);
      const file = path.join(dir, "group.json");
      const j = JSON.parse(await readFile(file, "utf8"));
      delete j.criteria[0].evidence[0].ai;
      await writeFile(file, JSON.stringify(j));
      const v = await verifyReportFiles(dir, aiLog(true), sampleScenario());
      expect(v.problems).toContain(`group: shared_understanding quotes AI player line #${BOB_SEQ} without the AI label`);
      const k = JSON.parse(await readFile(file, "utf8"));
      delete k.notable_moments[0].ai;
      await writeFile(file, JSON.stringify(k));
      expect((await verifyReportFiles(dir, aiLog(true), sampleScenario())).problems.join("\n")).toContain(`group: notable moment quotes AI player line #${BOB_SEQ} without the AI label`);
    });
  });

  it("a bob quote in an off session is reported", async () => {
    await inTmp(async (out) => {
      const dir = await written(out, true);
      const v = await verifyReportFiles(dir, aiLog(false), sampleScenario());
      expect(v.problems).toContain(`group: shared_understanding quotes AI player line #${BOB_SEQ} although AI players were not included in group scores`);
      expect(v.problems.join("\n")).toContain(`group: notable moment quotes AI player line #${BOB_SEQ} although AI players were not included in group scores`);
    });
  });

  it("a stray bob.md is reported", async () => {
    await inTmp(async (out) => {
      const dir = await written(out, true);
      await writeFile(path.join(dir, "bob.md"), "# stray\n");
      const v = await verifyReportFiles(dir, aiLog(true), sampleScenario());
      expect(v.problems).toContain("bob.md exists for an AI player");
    });
  });

  it("an invalid aiRoles record is reported", async () => {
    await inTmp(async (out) => {
      const dir = await written(out, true);
      const v = await verifyReportFiles(dir, aiLog(true, ["bob", "bob"]), sampleScenario());
      expect(v.problems).toContain("the log's session.started.aiRoles is not a list of distinct player roles");
    });
  });
});
