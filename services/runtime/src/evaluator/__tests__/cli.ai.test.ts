import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatRequest } from "@acr/adapters";
import { loadScenario } from "@acr/script";
import { FakeClock } from "../../engine/clock.js";
import { JsonlEventLog } from "../../engine/event-log.js";
import { SessionEngine } from "../../engine/session-engine.js";
import { AI_STAMP_NOTE } from "../../calibration/stamp.js";
import { runEvaluate } from "../cli.js";
import { AI_GROUP_OFF_NOTE, AI_GROUP_ON_NOTE } from "../report-model.js";

// US-0061: a REAL SessionEngine writes the log, the evaluator CLI reads it: producer and consumer agree on the log contract.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const SID = "ai-e2e";
const ENV = { MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-secret-value-12345" };
const INDIVIDUAL_SENTENCE = (r: string) => `score only the participant with role id "${r}"`;
const SAYS: [string, string][] = [
  ["delivery_lead", "Okay, Priya's email is in. First reactions on the request from the client?"],
  ["tech_lead", "My worry is the ingestion layer. Anything we add now competes with go-live."],
  ["account_manager", "I would rather not say no outright. The renewal is in play, so a refusal lands badly."],
  ["account_manager", "A refusal would cost us the renewal conversation, so I want a yes with conditions."],
  ["delivery_lead", "So what if we offer a phased module after go-live, scoped and priced?"],
  ["tech_lead", "I can live with that. The phased version is roughly half the work."],
];

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-cliai-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A log written by a real engine: friday-escalation, tech_lead as the AI player, the given option, utterances, then ended. */
async function engineLog(opts: { aiRoles?: string[]; includeInGroup?: boolean }): Promise<string> {
  const scenario = await loadScenario(path.join(REPO, "scenarios/friday-escalation"));
  const log = new JsonlEventLog(SID, dir, { sync: false });
  const engine = new SessionEngine({ scenario, log, clock: new FakeClock(1_000_000) });
  const assign = Object.fromEntries(Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => [r.id, `p_${r.id}`]));
  await engine.start(assign, opts);
  for (const [r, t] of SAYS) await engine.say(r, t);
  await engine.endNow({ actor: "facilitator" });
  await log.close?.();
  return log.file;
}
/** Rewrites the first line of a log (the rest is untouched); `edit` returns the new first event. */
async function rewriteFirst(file: string, edit: (e: Record<string, unknown>) => Record<string, unknown>): Promise<string> {
  const [first, ...rest] = (await readFile(file, "utf8")).split("\n");
  const out = path.join(dir, `${SID}.edited.jsonl`);
  await writeFile(out, [JSON.stringify(edit(JSON.parse(first!))), ...rest].join("\n"));
  return out;
}
const seqOfTechLead = async (file: string): Promise<{ seq: number; text: string }> => {
  const evs = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { seq: number; type: string; roleId?: string; text?: string });
  const u = evs.find((e) => e.type === "utterance" && e.roleId === "tech_lead")!;
  return { seq: u.seq, text: u.text! };
};

function recorder(quote: { seq: number; text: string }) {
  const calls: ChatRequest[] = [];
  const ok = { criteria: [{ id: "discovery", score: null }, { id: "shared_understanding", score: null }], talking_points: ["x"] };
  const group = { criteria: [{ id: "shared_understanding", score: 3, rationale: "r", confidence: "high", evidence: [{ seq: quote.seq, quote: quote.text }] }], talking_points: ["t"] };
  return {
    name: "rec", calls,
    async *stream(req: ChatRequest): AsyncIterable<string> {
      calls.push(req);
      yield JSON.stringify(/score only the participant with role id/.test(req.system) ? ok : group);
    },
  };
}
async function evaluate(file: string, over: { quote?: { seq: number; text: string } } = {}) {
  const provider = recorder(over.quote ?? (await seqOfTechLead(file)));
  const out: string[] = []; const err: string[] = [];
  const reports = path.join(dir, "reports");
  const r = await runEvaluate({ argv: [file, "--out", reports, "--json", "-"], stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: ENV, repoRoot: REPO, cwd: dir, provider });
  return { r, provider, out: out.join(""), err: err.join(""), dir: path.join(reports, SID), read: (f: string) => readFile(path.join(reports, SID, f), "utf8") };
}
const requestsFor = (calls: ChatRequest[], role: string) => calls.filter((c) => c.system.includes(INDIVIDUAL_SENTENCE(role)));

describe("evaluating a real engine log with an AI player", () => {
  it.each([[true, "on"], [false, "off"]] as const)("includeInGroup %s (%s): exit 0, no tech_lead report, index row, group labels and stamp note", async (on) => {
    const file = await engineLog({ aiRoles: ["tech_lead"], includeInGroup: on });
    const e = await evaluate(file);
    expect(e.r.exitCode).toBe(0);
    expect(e.err).toContain("tech_lead: AI player, not scored");
    const names = (await readdir(e.dir)).sort();
    expect(names).toEqual(["account_manager.json", "account_manager.md", "delivery_lead.json", "delivery_lead.md", "group.json", "group.md", "index.md", "method.md"]);
    const index = await e.read("index.md");
    expect(index).toContain("- `tech_lead`: AI player, not scored");
    expect(index).toContain(AI_STAMP_NOTE);
    const md = await e.read("group.md");
    expect(md).toContain("| AI players (not scored individually) | `tech_lead` (AI player) |");
    const g = JSON.parse(await e.read("group.json"));
    expect(g.ai_players).toEqual({ roles: ["tech_lead"], included_in_group: on });
    expect(g.notes).toContain(on ? AI_GROUP_ON_NOTE : AI_GROUP_OFF_NOTE);
    expect(g.notes).not.toContain(on ? AI_GROUP_OFF_NOTE : AI_GROUP_ON_NOTE);
    const q = await seqOfTechLead(file);
    const ev = g.criteria.find((c: { id: string }) => c.id === "shared_understanding").evidence as { seq: number; ai?: true }[];
    if (on) {
      expect(ev.find((x) => x.seq === q.seq)).toMatchObject({ role: "tech_lead", ai: true });
      expect(md.split("\n").filter((l) => l.includes(`line #${q.seq},`)).every((l) => l.includes("(AI player)"))).toBe(true);
    } else expect(ev.some((x) => x.seq === q.seq)).toBe(false); // an AI line is never team evidence when off
    // the individual evaluation was asked for the humans only
    expect(requestsFor(e.provider.calls, "tech_lead")).toHaveLength(0);
    expect(requestsFor(e.provider.calls, "delivery_lead").length).toBeGreaterThan(0);
    expect(requestsFor(e.provider.calls, "account_manager").length).toBeGreaterThan(0);
  });

  it("a hand-written 3b-style log (format 3, aiRoles, no includeInGroup) evaluates as on", async () => {
    const file = await rewriteFirst(await engineLog({ aiRoles: ["tech_lead"], includeInGroup: false }), (e) => { delete e.includeInGroup; return { ...e, logFormat: 3, aiRoles: ["tech_lead"] }; });
    expect(Object.hasOwn(JSON.parse((await readFile(file, "utf8")).split("\n")[0]!), "includeInGroup")).toBe(false);
    const e = await evaluate(file);
    expect(e.r.exitCode).toBe(0);
    expect(JSON.parse(await e.read("group.json")).ai_players).toEqual({ roles: ["tech_lead"], included_in_group: true });
    expect(e.out).toContain('"includeInGroup": true');
  });

  it("a format-2 log evaluates with no AI output", async () => {
    const file = await engineLog({});
    expect(JSON.parse((await readFile(file, "utf8")).split("\n")[0]!)).toMatchObject({ logFormat: 2 });
    const e = await evaluate(file);
    expect(e.r.exitCode).toBe(0);
    expect((await readdir(e.dir)).sort()).toContain("tech_lead.md");
    expect(requestsFor(e.provider.calls, "tech_lead").length).toBeGreaterThan(0);
    for (const f of await readdir(e.dir)) expect(await e.read(f), f).not.toMatch(/AI player/);
    expect(e.err).not.toContain("AI player");
    expect(JSON.parse(await e.read("group.json")).ai_players).toBeUndefined();
  });

  it("includeInGroup 1 exits 2 with the input error", async () => {
    const file = await rewriteFirst(await engineLog({ aiRoles: ["tech_lead"], includeInGroup: true }), (e) => ({ ...e, includeInGroup: 1 }));
    const e = await evaluate(file, { quote: { seq: 1, text: "x" } });
    expect(e.r.exitCode).toBe(2);
    expect(e.err).toContain("session.started.includeInGroup is not true or false");
    expect(e.provider.calls).toHaveLength(0);
    expect(await stat(path.join(dir, "reports", SID)).then(() => true, () => false)).toBe(false);
  });

  it('the provider received no request naming "score only the participant with role id \\"tech_lead\\""', async () => {
    for (const on of [true, false]) {
      const file = await engineLog({ aiRoles: ["tech_lead"], includeInGroup: on });
      const e = await evaluate(file);
      expect(e.r.exitCode).toBe(0);
      expect(e.provider.calls.length).toBeGreaterThan(0);
      expect(e.provider.calls.some((c) => c.system.includes('score only the participant with role id "tech_lead"') || JSON.stringify(c).includes('score only the participant with role id \\"tech_lead\\"'))).toBe(false);
      await rm(path.join(dir, "reports"), { recursive: true, force: true });
      await rm(file, { force: true });
    }
  });
});
