import { stampFromBody } from "./nonce.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@acr/events";
import { loadScenario, type NpcRole } from "@acr/script";
import { REPO_ROOT } from "../../main.js";
import { runDemo, type RunDeps } from "../runner.js";
import { hiddenFactMatches, releaseEvents, releasedFacts, showcaseMarkers } from "../showcase.js";
import type { ShowcaseReport } from "../showcase-report.js";

// US-0016: the showcase's scripted release of the CFO's hidden fact (scene s5, after line 1).
const EXTENDED = path.join(REPO_ROOT, "scenarios", "friday-escalation-extended");
const FACT = "Can approve a priced change request without escalation if it is fixed-fee and tied to a firm date";
const NOTE = "facilitator released hidden fact number 1 of cfo";
const SHARE = "## What you may now share";

type Captured = { out: string[]; err: string[]; stdout: { write(s: string): void; isTTY?: boolean }; stderr: { write(s: string): void; isTTY?: boolean } };
const capture = (): Captured => {
  const out: string[] = []; const err: string[] = [];
  return { out, err, stdout: { write: (s) => { out.push(s); }, isTTY: false }, stderr: { write: (s) => { err.push(s); }, isTTY: false } };
};
const PARENT = mkdtempSync(path.join(os.tmpdir(), "acr-release-parent-"));
afterAll(() => rmSync(PARENT, { recursive: true, force: true }));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const tmp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), "acr-release-test-")); cleanups.push(() => rm(d, { recursive: true, force: true })); return d; };

const run = async (argv: string[], over: Partial<RunDeps> = {}) => {
  const c = capture();
  const r = await runDemo({
    argv, stdout: c.stdout, stderr: c.stderr, env: { PATH: "/usr/bin" }, sleep: async () => {}, repoRoot: REPO_ROOT, version: "0.0.0-test", tempParent: PARENT,
    resolveLiveEnv: () => { throw new Error("the live environment must not be read here"); }, ...over,
  });
  return { ...r, stdout: c.out.join(""), stderr: c.err.join(""), showcase: r.report?.showcase as ShowcaseReport };
};
const result = (r: Awaited<ReturnType<typeof run>>, id: string) => r.report!.results.find((x) => x.id === id)!;

describe("the scripted release in scene s5 (mock mode)", () => {
  it("releases fact 1 of the CFO after line 1, passes every check, and shows it by number only", async () => {
    const r = await run(["--showcase", "--fast", "--no-color"]);
    expect(r.report!.results.filter((x) => x.status !== "passed")).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(NOTE);
    expect(r.stdout).not.toContain(FACT);
    expect(r.showcase.observations).toEqual([]);
    expect(r.showcase.lines.some((l) => l.text === NOTE)).toBe(true);
    expect(result(r, "S-06").details).toMatch(/1 released hidden fact\(s\) appeared only in the "What you may now share" section of their own character's prompt \(3 prompt\(s\)\)/);
  });

  it("the transcript, the JSON report and the evaluation reports never hold the fact text", async () => {
    const dir = await tmp();
    const r = await run(["--showcase", "--fast", "--no-color", "--json", "-", "--transcript", "t.md", "--evaluate", "--eval-out", path.join(dir, "rep")], { cwd: dir });
    expect(r.exitCode).toBe(0);
    const md = readFileSync(path.join(dir, "t.md"), "utf8");
    expect(md).toContain(NOTE);
    expect(md).not.toContain(FACT);
    expect(r.stdout).not.toContain(FACT);
    const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
    const reports = files(path.join(dir, "rep"));
    expect(reports.length).toBeGreaterThan(0);
    for (const f of reports) expect(readFileSync(f, "utf8"), f).not.toContain(FACT);
  });

  it("the CFO's prompts hold the fact only from the release on, only in the final share section, and no other prompt holds it", async () => {
    let seen: { npc: { system: string }[]; gm: { system: string; messages: unknown }[] } | undefined;
    const hooks = { beforeAdvance: async () => undefined, beforeLine: async ({ sys }: { sys?: { npc?: { calls: { system: string }[] }; gm?: { calls: { system: string; messages: unknown }[] } } }) => { if (sys) seen = { npc: sys.npc!.calls, gm: sys.gm!.calls }; } };
    const r = await run(["--showcase", "--fast", "--no-color"], { showcaseHooks: hooks as never });
    expect(r.exitCode).toBe(0);
    const withFact = seen!.npc.filter((c) => c.system.includes(FACT));
    expect(withFact.length).toBeGreaterThan(0);
    for (const c of withFact) {
      expect(c.system).toContain("You are playing Helena Brandt");
      expect(c.system.indexOf(FACT)).toBeGreaterThan(c.system.indexOf(SHARE));
      expect(c.system.indexOf(SHARE)).toBeGreaterThan(c.system.indexOf("## Rules you must follow"));
    }
    expect(seen!.gm.some((c) => c.system.includes(FACT) || JSON.stringify(c.messages).includes(FACT))).toBe(false);
  });

  it("a scene before s5 never has the fact in any prompt (the first CFO prompts precede the release)", async () => {
    let calls: { system: string }[] = [];
    const hooks = { beforeLine: async ({ sceneId, index, sys }: { sceneId: string; index: number; sys?: { npc?: { calls: { system: string }[] } } }) => { if (sceneId === "s5_final_terms" && index === 0 && sys) calls = [...sys.npc!.calls]; } };
    await run(["--showcase", "--fast", "--no-color"], { showcaseHooks: hooks as never });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.system.includes(FACT))).toBe(false);
  });

  it("a cap of one line still releases (the step follows line 1); a step after a line the cap never reaches is skipped, and S-06 says no fact was released", async () => {
    const capped = await run(["--showcase", "--fast", "--no-color", "--max-lines", "1"]);
    expect(capped.report!.results.filter((x) => x.status === "failed")).toEqual([]);
    expect(capped.stdout).toContain(NOTE);
    const dir = await tmp();
    await cp(EXTENDED, dir, { recursive: true });
    const file = path.join(dir, "showcase.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("after_line: 1, release_hidden", "after_line: 3, release_hidden"));
    const skipped = await run(["--showcase", "--fast", "--no-color", "--scenario", dir, "--max-lines", "2"]);
    expect(skipped.report!.results.filter((x) => x.status === "failed")).toEqual([]);
    expect(skipped.stdout).not.toContain(NOTE);
    expect(result(skipped, "S-06").details).toContain("no hidden fact was released");
  });
});

describe("the audits can fail (tampered captures)", () => {
  const FAIL = ["--showcase", "--fast", "--no-color"];
  type Sys = { npc?: { calls: { system: string; messages: unknown }[] }; gm?: { calls: { system: string; messages: unknown }[] } };
  const at = (scene: string, index: number, fn: (a: { sys?: Sys; players?: Record<string, { inbox: unknown[] }> }) => void) => ({
    beforeLine: async (a: { sceneId: string; index: number; sys?: Sys; players?: Record<string, { inbox: unknown[] }> }) => { if (a.sceneId === scene && a.index === index) fn(a); },
  });

  it("S-06 fails when the released fact reaches another character's prompt", async () => {
    const r = await run(FAIL, { showcaseHooks: at("s5_final_terms", 3, ({ sys }) => { const c = sys!.npc!.calls.find((x) => x.system.includes("You are playing Priya Raman"))!; c.system += `\n${SHARE}\n- ${FACT}`; }) as never });
    expect(result(r, "S-06").status).toBe("failed");
    expect(result(r, "S-06").details).toMatch(/client_sponsor's "What you may now share" section contained|a model prompt contained/);
  });

  it("S-06 fails when an unreleased fact appears in a character's prompt, or in the Game Master's", async () => {
    const PRIYA_HIDDEN = "Would accept a phased delivery after go-live if the risk is explained well";
    for (const target of ["npc", "gm"] as const) {
      const r = await run(FAIL, { showcaseHooks: at("s4_escalation_call", 2, ({ sys }) => { const c = sys![target]!.calls[0]!; c.system += `\n${SHARE}\n- ${PRIYA_HIDDEN}`; }) as never });
      expect(result(r, "S-06").status, target).toBe("failed");
    }
  });

  it("S-06 fails when the fact is placed outside the share section of the CFO's own prompt (for example under What you know)", async () => {
    const r = await run(FAIL, { showcaseHooks: at("s6_wrap_up", 0, ({ sys }) => { const c = sys!.npc!.calls.find((x) => x.system.includes("You are playing Helena Brandt") && !x.system.includes(FACT))!; c.system += `\n- ${FACT}`; }) as never });
    expect(result(r, "S-06").status).toBe("failed");
  });

  it("S-06 fails when the release never reached the character's prompt (a vacuous audit)", async () => {
    const r = await run(FAIL, { showcaseHooks: at("s6_wrap_up", 0, ({ sys }) => { for (const c of sys!.npc!.calls) c.system = c.system.replace(FACT, "(removed)"); }) as never });
    expect(result(r, "S-06").status).toBe("failed");
    expect(result(r, "S-06").details).toContain("never reached that character's prompt");
  });

  it("S-07 fails when a player receives the release command", async () => {
    const hooks = at("s6_wrap_up", 0, ({ players }) => { players!.delivery_lead!.inbox.push({ type: "event", event: { seq: 9_100, ts: 1, sessionId: "demo", type: "facilitator.command", command: "release_hidden", roleId: "cfo", fact: 1 } }); });
    const r = await run(FAIL, { showcaseHooks: hooks as never });
    expect(result(r, "S-07").status).toBe("failed");
    expect(result(r, "S-07").details).toContain("release command");
  });

  it("S-07 fails when the released fact text reaches a player (mock strictness)", async () => {
    const hooks = at("s6_wrap_up", 0, ({ players }) => { players!.delivery_lead!.inbox.push({ type: "event", event: { seq: 9_100, ts: 1, sessionId: "demo", type: "inject.fired", injectId: "x", sceneId: "s5_final_terms", to: ["delivery_lead"], content: FACT } }); });
    const r = await run(FAIL, { showcaseHooks: hooks as never });
    expect(result(r, "S-07").status).toBe("failed");
  });
});

describe("hiddenFactMatches (the S-07 observation)", () => {
  const ev = (seq: number, e: object): SessionEvent => ({ seq, ts: seq, sessionId: "s", ...e }) as SessionEvent;
  async function ctx() {
    const scenario = await loadScenario(EXTENDED);
    return { scenario, markers: showcaseMarkers(scenario) };
  }
  const SPONSOR = "Would accept a phased delivery after go-live if the risk is explained well";
  it("counts an AI line that holds an unreleased hidden fact, whole, and a phrase apart from it", async () => {
    const { scenario, markers } = await ctx();
    const m = hiddenFactMatches([ev(1, { type: "scene.entered", sceneId: "s2", participants: [] }), ev(2, { type: "utterance", roleId: "cfo", text: `${FACT}.`, channel: "text" })], scenario, markers);
    expect(m.get("cfo")).toEqual({ facts: 1, phrases: 0 });
  });
  it("does not count a fact released to the character", async () => {
    const { scenario, markers } = await ctx();
    const events = [ev(1, { type: "scene.entered", sceneId: "s5", participants: [] }), ev(2, { type: "npc.updated", roleId: "cfo", goals: [], knowledge: [], released: [FACT] }), ev(3, { type: "utterance", roleId: "cfo", text: `As agreed: ${FACT}.`, channel: "text" })];
    expect(hiddenFactMatches(events, scenario, markers).size).toBe(0);
  });
  it("does not count a string a player said earlier in the same scene, but counts it in a later scene", async () => {
    const { scenario, markers } = await ctx();
    const player = (seq: number) => ev(seq, { type: "utterance", roleId: "delivery_lead", text: `Is this true: ${SPONSOR}?`, channel: "text" });
    const ai = (seq: number) => ev(seq, { type: "utterance", roleId: "client_sponsor", text: `${SPONSOR}.`, channel: "text" });
    const same = hiddenFactMatches([ev(1, { type: "scene.entered", sceneId: "a", participants: [] }), player(2), ai(3)], scenario, markers);
    expect(same.has("client_sponsor")).toBe(false);
    const next = hiddenFactMatches([ev(1, { type: "scene.entered", sceneId: "a", participants: [] }), player(2), ev(3, { type: "scene.entered", sceneId: "b", participants: [] }), ai(4)], scenario, markers);
    expect(next.get("client_sponsor")).toEqual({ facts: 1, phrases: 1 }); // the whole fact, and the shorter phrase the player script shares with it
    // the player's own first line is still reported for the player (an observation, never a leak)
    expect(same.get("delivery_lead")).toEqual({ facts: 1, phrases: 1 });
  });
  it("releasedFacts and releaseEvents read the facilitator stream", () => {
    const events = [
      ev(1, { type: "npc.updated", roleId: "cfo", goals: [], knowledge: [], released: [] }),
      ev(2, { type: "facilitator.command", command: "release_hidden", roleId: "cfo", fact: 1 }),
      ev(3, { type: "npc.updated", roleId: "cfo", goals: [], knowledge: [], released: [FACT] }),
      ev(4, { type: "npc.updated", roleId: "cfo", goals: ["x"], knowledge: [] }),
    ];
    expect(releasedFacts(events).get("cfo")).toEqual([FACT]);
    expect(releaseEvents(events)).toEqual([{ seq: 2, roleId: "cfo", fact: 1, text: FACT }]);
    expect(releaseEvents(events.slice(0, 2))).toEqual([]);
  });
});

describe("a live run with a loopback model: the release and every place the text could go", () => {
  const SECRET = "release-live-secret-key-0123456789";
  async function fakeModel(gm: string) {
    const bodies: { system: string; body: string; kind: "npc" | "gm" | "eval" | "player" }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] };
        const system = parsed.messages.find((m) => m.role === "system")?.content ?? "";
        let text: string; let kind: "npc" | "gm" | "eval" | "player";
        if (system.includes("learning-and-development assessor")) { kind = "eval"; text = JSON.stringify({ criteria: ["discovery", "listening", "negotiation", "commercial_judgement", "stakeholder_management", "team_alignment", "role_clarity", "shared_understanding", "decision_quality", "role_clarity_group", "escalation_discipline"].map((id) => ({ id, score: null })), talking_points: ["x"] }); }
        else if (system.includes("Game Master")) { kind = "gm"; text = gm; }
        else { kind = "npc"; text = "I hear you, tell me more."; }
        bodies.push({ system, body, kind });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: stampFromBody(text, body) } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
    const port = (server.address() as { port: number }).port;
    return { bodies, env: { MODEL_PROVIDER: "local", LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1`, NPC_MODEL: "m", GM_MODEL: "gm-m", LOCAL_API_KEY: SECRET, MODEL_MAX_RETRIES: "0" } };
  }
  const liveArgv = ["--showcase", "--live", "--max-lines", "2", "--fast", "--no-color"];

  it("only the CFO's prompts after the release hold the text; the Game Master, Priya and the evaluator never do", async () => {
    const { env, bodies } = await fakeModel('{"verdict": false, "reasoning": "not yet"}');
    const dir = await tmp();
    const r = await run([...liveArgv, "--evaluate", "--eval-out", path.join(dir, "rep"), "--transcript", "l.md", "--json", "-"], { resolveLiveEnv: () => env, cwd: dir });
    expect(r.report!.results.filter((x) => x.status === "failed")).toEqual([]);
    expect(r.exitCode).toBe(0);
    const holding = bodies.filter((b) => b.body.includes(JSON.stringify(FACT).slice(1, -1)));
    expect(holding.length).toBeGreaterThan(0);
    for (const b of holding) {
      expect(b.kind).toBe("npc");
      expect(b.system).toContain("You are playing Helena Brandt");
      expect(b.system.slice(b.system.indexOf(SHARE))).toContain(FACT);
    }
    expect(bodies.filter((b) => b.kind === "eval").length).toBeGreaterThan(0);
    expect(r.stdout).not.toContain(FACT);
    expect(readFileSync(path.join(dir, "l.md"), "utf8")).not.toContain(FACT);
    expect(r.stdout).toContain(NOTE);
    expect(await readFile(path.join(dir, "l.md"), "utf8")).toContain(NOTE);
  }, 30_000);

  it("a step whose scene has already ended is skipped with an observation, and nothing is released", async () => {
    const { env, bodies } = await fakeModel('{"verdict": true, "reasoning": "settled"}');
    const r = await run(liveArgv, { resolveLiveEnv: () => env });
    expect(r.report!.results.filter((x) => x.status === "failed")).toEqual([]);
    expect(r.showcase.observations.join("\n")).toMatch(/facilitator step skipped: s5_final_terms had already ended, so hidden fact #1 of cfo was not released/);
    expect(bodies.some((b) => b.body.includes(FACT))).toBe(false);
    expect(r.stdout).not.toContain(NOTE);
  }, 30_000);
});

describe("the CFO file still holds the fact the showcase releases", () => {
  it("is fact number 1 of the CFO, so the script and the scenario agree", async () => {
    const scenario = await loadScenario(EXTENDED);
    expect((scenario.roles.cfo as NpcRole).hidden[0]).toBe(FACT);
  });
});
