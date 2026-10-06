import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../main.js";
import { runDemo, type RunDeps } from "../runner.js";
import { SHOWCASE_CHECKS, SHOWCASE_PLAYER_CHECKS } from "../showcase.js";
import type { ShowcaseReport } from "../showcase-report.js";

type Captured = { out: string[]; err: string[]; stdout: { write(s: string): void; isTTY?: boolean }; stderr: { write(s: string): void; isTTY?: boolean } };
const capture = (): Captured => {
  const out: string[] = []; const err: string[] = [];
  return { out, err, stdout: { write: (s) => { out.push(s); }, isTTY: false }, stderr: { write: (s) => { err.push(s); }, isTTY: false } };
};
const PARENT = mkdtempSync(path.join(os.tmpdir(), "acr-players-parent-"));
afterAll(() => rmSync(PARENT, { recursive: true, force: true }));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const tmp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), "acr-players-test-")); cleanups.push(() => rm(d, { recursive: true, force: true })); return d; };

const SECRET = "players-live-secret-key-0123456789";
type Seen = {
  player: { role: string; model: string; body: string; temperature?: number }[]; npc: number; gm: number;
  /** Models and temperatures the AI characters and the Game Master were called with. */
  npcCalls: { model: string; temperature?: number }[]; gmCalls: { model: string; temperature?: number }[];
  /** Player requests whose connection was closed before the reply was sent (the client aborted). */
  aborted: number;
  /** Raw request bodies of the AI character and Game Master calls (the evaluator's input). */
  otherBodies: string[];
};
/** A loopback OpenAI-compatible fake: the AI characters and the Game Master get fixed answers, player prompts (recognised by their system prompt) get `playerReply`. */
async function fakeModel(playerReply: (n: number, role: string) => { status?: number; text?: string; stall?: true }, npcReply?: (n: number, system: string) => string) {
  const seen: Seen = { player: [], npc: 0, gm: 0, npcCalls: [], gmCalls: [], aborted: 0, otherBodies: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { model: string; temperature?: number; messages: { role: string; content: string }[] };
      const system = parsed.messages.find((m) => m.role === "system")?.content ?? "";
      let text: string;
      if (!system.includes("as a human trainee")) seen.otherBodies.push(body);
      if (system.includes("Game Master")) { seen.gm++; seen.gmCalls.push({ model: parsed.model, temperature: parsed.temperature }); text = '{"verdict": false, "reasoning": "not yet"}'; }
      else if (system.includes("as a human trainee")) {
        const role = /\(role id ([a-z_]+)\)/.exec(system)![1]!;
        seen.player.push({ role, model: parsed.model, body, temperature: parsed.temperature });
        const r = playerReply(seen.player.length, role);
        if (r.stall) { res.on("close", () => { if (!res.writableEnded) seen.aborted++; }); res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": waiting\n\n"); return; }
        if (r.status) { res.writeHead(r.status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "nope" } })); return; }
        text = r.text ?? "";
      } else { seen.npc++; seen.npcCalls.push({ model: parsed.model, temperature: parsed.temperature }); text = npcReply ? npcReply(seen.npc, system) : "I hear you, tell me more."; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const port = (server.address() as { port: number }).port;
  const env = { MODEL_PROVIDER: "local", LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1`, NPC_MODEL: "m", GM_MODEL: "gm-m", LOCAL_API_KEY: SECRET, MODEL_MAX_RETRIES: "0" };
  return { env, seen, port };
}
const run = async (argv: string[], env: NodeJS.ProcessEnv, over: Partial<RunDeps> = {}) => {
  const c = capture();
  const r = await runDemo({
    argv, stdout: c.stdout, stderr: c.stderr, env: { PATH: "/usr/bin" }, sleep: async () => {}, repoRoot: REPO_ROOT, version: "0.0.0-test",
    resolveLiveEnv: () => env, tempParent: PARENT, ...over,
  });
  return { ...r, stdout: c.out.join(""), stderr: c.err.join(""), showcase: r.report?.showcase as ShowcaseReport };
};
const FIRST_SCRIPTED = "Okay, Priya's email is in. She wants a reconciliation module before go-live and an answer by end of day Friday. First reactions?";
const GEN = (n: number, role: string) => ({ text: `Take ${n} as ${role.replace("_", " ")}: let us keep the phase plan simple.` });
const ARGV = ["--showcase", "--live", "--players", "generated", "--max-lines", "2", "--fast", "--no-color"];

describe("--showcase --live --players generated (loopback fake model)", () => {
  it("has the model speak every player slot: tagged generated, counted apart, S-01..S-15 pass, and the player model flag reaches only the player calls", async () => {
    const { env, seen, port } = await fakeModel(GEN);
    const dir = await tmp();
    const { exitCode, report, showcase, stdout, stderr } = await run([...ARGV, "--player-model", "player-m", "--transcript", "t.md"], env, { cwd: dir });
    expect(report!.results.filter((r) => r.status === "failed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(report!.results.map((r) => r.id)).toEqual([...SHOWCASE_CHECKS, ...SHOWCASE_PLAYER_CHECKS].map((c) => c.id));
    expect(report!.results.filter((r) => r.status === "skipped").map((r) => r.id)).toEqual(["S-06", "S-14"]);
    expect(report!.results.find((r) => r.id === "S-15")).toMatchObject({ status: "passed" });
    expect(seen.player).toHaveLength(12); // 6 scenes x 2 slots (--max-lines keeps meaning: line SLOTS per scene)
    expect(showcase.playerLines).toBe(12);
    expect(showcase.players).toMatchObject({ mode: "generated", generated: 12, scriptedFallbacks: 0, verbatimRepeats: 0, cutReplies: 0, intentsLogged: 12 });
    const spoken = showcase.lines.filter((l) => l.source === "player-bot");
    expect(spoken.every((l) => l.tag === "generated" && /^Take \d+ as /.test(l.text))).toBe(true);
    expect(new Set(spoken.map((l) => l.text)).size).toBe(12); // varied
    expect(showcase.lines.filter((l) => l.source === "ai-character").every((l) => l.tag === "generated")).toBe(true);
    expect(seen.player.every((p) => p.model === "player-m")).toBe(true);
    expect(stdout).toContain("[player bot, generated] delivery_lead: Take 1 as delivery lead");
    expect(stdout).toContain("Player bots (--players generated): 12 of 12 lines generated by the model, 0 fell back to the scripted line; 0 generated line(s) repeated the scripted line verbatim");
    expect(stdout).toContain("AI contribution");
    expect(stdout).toContain("--players generated also sends each player role's brief");
    expect(showcase.observations).toContain("--players generated: 12 player line(s) were generated, 0 fell back to the scripted line, 0 generated line(s) repeated the scripted line verbatim");
    // The prompts: own brief present, no other role's secrets, intent is the scripted line.
    const first = seen.player[0]!;
    expect(first.role).toBe("delivery_lead");
    expect(first.body).toContain("You run the programme day to day");
    expect(first.body).toContain(FIRST_SCRIPTED.slice(0, 40));
    expect(first.body).not.toContain("ingestion hardening freeze starts"); // another role's private fact
    expect(seen.npc).toBeGreaterThan(0);
    const md = await readFile(path.join(dir, "t.md"), "utf8");
    const dlg = md.split("\n").filter((l) => l.startsWith("**"));
    expect(dlg.filter((l) => l.startsWith("**[GENERATED] delivery_lead")).length + dlg.filter((l) => l.startsWith("**[GENERATED] tech_lead")).length + dlg.filter((l) => l.startsWith("**[GENERATED] account_manager")).length).toBe(12);
    expect(dlg.some((l) => l.startsWith("**[SCRIPTED]") && !l.includes("Game Master"))).toBe(false);
    expect(md).toContain("Player bots (generated): 12 of 12 lines written by the model");
    expect(md).toContain("`--players generated`");
    const everything = stdout + stderr + JSON.stringify(report) + md;
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(String(port));
  });

  it("falls back to the scripted line when generation fails: the line stays [SCRIPTED], the narration and transcript say why, the counts agree", async () => {
    const { env } = await fakeModel((n, role) => (n === 1 ? { status: 400 } : n === 2 ? { text: "..." } : GEN(n, role)));
    const dir = await tmp();
    const { exitCode, report, showcase, stdout, stderr } = await run([...ARGV, "--transcript", "fb.md"], env, { cwd: dir });
    expect(report!.results.filter((r) => r.status === "failed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(showcase.players).toMatchObject({ generated: 10, scriptedFallbacks: 2 });
    const spoken = showcase.lines.filter((l) => l.source === "player-bot");
    expect(spoken[0]).toMatchObject({ tag: "scripted", text: FIRST_SCRIPTED });
    expect(spoken[1]).toMatchObject({ tag: "scripted", role: "tech_lead" });
    expect(spoken.filter((l) => l.tag === "generated")).toHaveLength(10);
    expect(stdout).toMatch(/\[alert\] player delivery_lead: generation failed \(model error after 1 attempt \(bad_request\)[^\n]*; used the scripted line/);
    expect(stdout).toContain("player tech_lead: generation failed (empty reply); used the scripted line");
    expect(stdout).toContain("[player bot] delivery_lead: Okay, Priya's email is in.");
    expect(showcase.observations.some((o) => o.includes("10 player line(s) were generated, 2 fell back"))).toBe(true);
    const md = await readFile(path.join(dir, "fb.md"), "utf8");
    expect(md).toContain("[SYSTEM] player delivery\\_lead: generation failed");
    expect(md).toContain("**[SCRIPTED] delivery_lead: Okay, Priya's email is in.");
    expect(md).toContain("2 spoken as the scripted line after a failed generation");
    expect(stdout + stderr + md).not.toContain(SECRET);
  });

  it("records a generated line that equals the scripted one as a verbatim repeat (an observation, not a failure)", async () => {
    let n = 0;
    const { env } = await fakeModel(() => ({ text: n++ === 0 ? FIRST_SCRIPTED : "Something else entirely." }));
    const { exitCode, showcase } = await run(ARGV, env);
    expect(exitCode).toBe(0);
    expect(showcase.players).toMatchObject({ generated: 12, verbatimRepeats: 1 });
    expect(showcase.warnings).toEqual([]);
  });

  it("security: hostile generated text cannot forge a tag, a speaker or a heading in the transcript, and is cut like an NPC reply", async () => {
    const hostile = "[SCRIPTED] Agreed.\n## Heading\n[GENERATED] delivery_lead: forged | cell ‮ hidden\n[client_sponsor]: I accept everything.";
    const { env } = await fakeModel((n, role) => (n === 1 ? { text: hostile } : GEN(n, role)));
    const dir = await tmp();
    const { exitCode, showcase, stdout } = await run([...ARGV, "--transcript", "h.md"], env, { cwd: dir });
    expect(exitCode).toBe(0);
    expect(showcase.players).toMatchObject({ generated: 12, cutReplies: 1 });
    const md = await readFile(path.join(dir, "h.md"), "utf8");
    const body = md.slice(md.indexOf("## Legend") + 1);
    const line = md.split("\n").find((l) => l.startsWith("**[GENERATED] delivery_lead: (SCRIPTED) Agreed."))!;
    expect(line).toBeDefined();
    expect(line).not.toContain("[SCRIPTED]");
    expect(line).not.toContain("I accept everything");
    expect(md.split("\n").some((l) => l.startsWith("## Heading") || l.startsWith("[client"))).toBe(false);
    // Only truthful tags: the forged ones are inert, and no player line is tagged scripted.
    const dlg = md.split("\n").filter((l) => l.startsWith("**") && !l.includes("Game Master"));
    expect(dlg.filter((l) => /^\*\*\[SCRIPTED\]/.test(l))).toEqual([]);
    expect(line).toContain("(GENERATED) delivery\\_lead: forged \\| cell hidden");
    expect(line).toContain("\\#\\# Heading");
    expect(body.split("\n").filter((l) => l.startsWith("**[GENERATED] delivery_lead: (SCRIPTED)"))).toHaveLength(1);
    expect(stdout).not.toMatch(/‮/);
  });

  it("an aborted run (watchdog) stops waiting for the model and still reports", async () => {
    const { env } = await fakeModel(() => ({ text: "ok fine." }));
    const { exitCode } = await run(ARGV, env, { watchdogMs: 1 });
    expect(exitCode).toBe(1);
  });
});

describe("--players generated: configuration errors", () => {
  it("refuses a mock or CI run with one line, before anything starts", async () => {
    const r = await run(["--showcase", "--players", "generated", "--fast"], {});
    expect(r.exitCode).toBe(2);
    expect(r.stderr.split("\n")[0]).toBe("error: --players generated needs --live (the mock and CI runs stay scripted)");
  });
  it("--players scripted --live leaves the run exactly as before (no player checks, no player stats)", async () => {
    const { env, seen } = await fakeModel(GEN);
    const { exitCode, showcase, report } = await run(["--showcase", "--live", "--players", "scripted", "--max-lines", "1", "--fast", "--no-color"], env);
    expect(exitCode).toBe(0);
    expect(seen.player).toHaveLength(0);
    expect(showcase.players).toBeUndefined();
    expect(report!.results.map((r) => r.id)).toEqual(SHOWCASE_CHECKS.map((c) => c.id));
    expect(showcase.lines.filter((l) => l.source === "player-bot").every((l) => l.tag === "scripted")).toBe(true);
  });
  it("refuses an unusable player provider configuration before starting", async () => {
    const r = await run(ARGV, { MODEL_PROVIDER: "local", LOCAL_BASE_URL: "http://127.0.0.1:9/v1", GM_MODEL: "m", NPC_MODEL: "m", MODEL_MAX_RETRIES: "9" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("MODEL_MAX_RETRIES");
  });
});

const FACT = "Contingency on the programme budget is down to about 8 percent"; // delivery_lead's own private fact
const TECH_FACT = "A phased version after go-live would be about half the effort"; // tech_lead's private fact
const CFO_HIDDEN = "Can approve a priced change request without escalation if it is fixed-fee and tied to a firm date";
const s7 = (r: Awaited<ReturnType<typeof run>>) => r.report!.results.find((x) => x.id === "S-07")!;

describe("S-07 with generated players", () => {
  it("regression: a player saying its OWN private fact word for word, or anyone saying a hidden-fact fragment aloud, is not a leak (observed, not failed)", async () => {
    const { env } = await fakeModel((n, role) => (n === 1 ? { text: `${FACT}.` } : role === "account_manager" ? { text: `${CFO_HIDDEN}, I think.` } : GEN(n, role)));
    const r = await run(ARGV, env);
    expect(s7(r).status).toBe("passed");
    expect(r.report!.results.filter((x) => x.status === "failed")).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.showcase.observations.some((o) => /hidden-fact or rubric fragment\(s\) were spoken aloud by generated players/.test(o))).toBe(true);
  });

  it("still fails when the SERVER leaks: another role's secret in a non-utterance message, or in an utterance its owner did not speak", async () => {
    for (const leak of ["non-utterance", "utterance by another role"] as const) {
      const { env } = await fakeModel(GEN);
      const hooks = {
        beforeLine: async ({ index, sceneId, players }: { index: number; sceneId: string; players?: Partial<Record<string, { inbox: unknown[] }>> }) => {
          if (sceneId !== "s1_huddle" || index !== 1) return;
          const msg = leak === "non-utterance"
            ? { type: "event", event: { seq: 9_001, ts: 1, sessionId: "demo", type: "inject.fired", injectId: "x", sceneId: "s1_huddle", to: ["account_manager"], content: TECH_FACT } }
            : { type: "event", event: { seq: 9_002, ts: 1, sessionId: "demo", type: "utterance", roleId: "delivery_lead", text: TECH_FACT, channel: "text" } };
          players!.account_manager!.inbox.push(msg);
        },
      };
      const r = await run(ARGV, env, { showcaseHooks: hooks as never });
      expect(s7(r).status, leak).toBe("failed");
      expect(s7(r).details).toContain(TECH_FACT.slice(0, 20));
    }
  });

  it("scripted (mock) mode is unchanged: any text in a player's inbox is checked, including an utterance by the secret's own owner", async () => {
    const hooks = {
      beforeLine: async ({ index, sceneId, players }: { index: number; sceneId: string; players?: Partial<Record<string, { inbox: unknown[] }>> }) => {
        if (sceneId === "s1_huddle" && index === 1) players!.account_manager!.inbox.push({ type: "event", event: { seq: 9_003, ts: 1, sessionId: "demo", type: "utterance", roleId: "tech_lead", text: TECH_FACT, channel: "text" } });
      },
    };
    const r = await run(["--showcase", "--fast", "--no-color"], {}, { showcaseHooks: hooks as never });
    expect(s7(r).status).toBe("failed");
  });
});

describe("generated players: waiting for the player's own stream", () => {
  it("a role absent from the previous scene can speak first in the next one (it never waits for an utterance it was not sent)", async () => {
    const { env } = await fakeModel(GEN);
    const dir = await tmp();
    await cp(path.join(REPO_ROOT, "scenarios", "friday-escalation-extended"), dir, { recursive: true });
    const f = path.join(dir, "showcase.yaml");
    const yaml = await readFile(f, "utf8");
    // Scene 3 (all three present) opens with the tech lead, who was NOT in scene 2 (the call with Priya).
    const edited = yaml.replace(/(- scene: s3_internal_huddle\n    lines:\n      - \{ role: )delivery_lead/, "$1tech_lead");
    expect(edited).not.toBe(yaml);
    await writeFile(f, edited);
    const t0 = Date.now();
    const r = await run([...ARGV, "--scenario", dir], env);
    expect(r.report!.results.filter((x) => x.status === "failed")).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it("a player whose connection lags still has the latest lines in its prompt (the bot waits for its own stream)", async () => {
    const { env, seen } = await fakeModel(GEN);
    let delayed = false;
    const hooks = {
      beforeLine: async ({ players }: { players?: Partial<Record<string, { ws: { listeners(e: string): ((...a: unknown[]) => void)[]; removeAllListeners(e: string): void; on(e: string, f: (d: unknown) => void): void } }>> }) => {
        if (delayed) return;
        delayed = true;
        for (const bot of Object.values(players!)) {
          const listeners = bot!.ws.listeners("message");
          bot!.ws.removeAllListeners("message");
          bot!.ws.on("message", (d) => { setTimeout(() => { for (const l of listeners) l(d); }, 60); });
        }
      },
    };
    const r = await run(ARGV, env, { showcaseHooks: hooks as never });
    expect(r.exitCode).toBe(0);
    // Slot 4 is the account manager in scene 2, right after delivery_lead's line and Priya's reply.
    const body = seen.player[3]!.body;
    expect(seen.player[3]!.role).toBe("account_manager");
    expect(body).toContain("Take 3 as delivery lead");
    expect(body).toContain("I hear you, tell me more.");
  });
});

describe("generated players: abort and audits", () => {
  it("the watchdog aborts a stalled player model call at once (the request is cancelled, the run ends long before the reply deadline)", async () => {
    const { env, seen } = await fakeModel(() => ({ stall: true }));
    const t0 = Date.now();
    const r = await run(ARGV, { ...env, NPC_FIRST_TOKEN_TIMEOUT_MS: "50000", NPC_REPLY_TIMEOUT_MS: "60000" }, { watchdogMs: 400 });
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(r.exitCode).toBe(1);
    expect(seen.player.length).toBe(1);
    expect(seen.aborted).toBe(1);
  }, 20_000);

  const tamper = (fn: (g: NonNullable<Parameters<NonNullable<NonNullable<RunDeps["showcaseHooks"]>["beforeLine"]>>[0]["generated"]>) => void) => ({
    beforeLine: async ({ sceneId, index, generated }: { sceneId: string; index: number; generated?: never }) => { if (sceneId === "s2_priya_call" && index === 1) fn(generated!); },
  });
  const s15 = (r: Awaited<ReturnType<typeof run>>) => r.report!.results.find((x) => x.id === "S-15")!;

  it("S-15 fails when a captured player prompt holds another role's private fact, the rubric or a participant name", async () => {
    for (const bad of [TECH_FACT, "ZedAlphaParticipant"]) {
      const { env } = await fakeModel(GEN);
      const r = await run(ARGV, env, { showcaseHooks: tamper((g) => { g.generator.calls[0]!.system += `\n${bad}`; }) as never });
      expect(s15(r).status, bad).toBe("failed");
      expect(s15(r).details).toContain(bad.slice(0, 20));
      expect(r.exitCode).toBe(1);
    }
  });

  it("S-15 fails when the recorded lines and the tags disagree", async () => {
    const { env } = await fakeModel(GEN);
    const r = await run(ARGV, env, { showcaseHooks: tamper((g) => { g.lines.records.splice(0, 1); }) as never });
    expect(s15(r).status).toBe("failed");
    expect(s15(r).details).toMatch(/player lines were spoken but \d+ were recorded/);
  });
});

describe("generated players: models and temperatures", () => {
  it("--player-model reaches only the player calls; the AI characters and the Game Master keep their own models", async () => {
    const { env, seen } = await fakeModel(GEN);
    await run([...ARGV, "--player-model", "player-m"], env);
    expect(seen.player.length).toBeGreaterThan(0);
    expect(seen.player.every((p) => p.model === "player-m")).toBe(true);
    expect(seen.npcCalls.length).toBeGreaterThan(0);
    expect(seen.npcCalls.every((c) => c.model === "m")).toBe(true);
    expect(seen.gmCalls.length).toBeGreaterThan(0);
    expect(seen.gmCalls.every((c) => c.model === "gm-m")).toBe(true);
  });

  it("sends the default temperatures (NPC 0.8, player 0.9, Game Master 0.2) and the configured ones, in the request body", async () => {
    const a = await fakeModel(GEN);
    await run(ARGV, a.env);
    expect(new Set(a.seen.npcCalls.map((c) => c.temperature))).toEqual(new Set([0.8]));
    expect(new Set(a.seen.player.map((c) => c.temperature))).toEqual(new Set([0.9]));
    expect(new Set(a.seen.gmCalls.map((c) => c.temperature))).toEqual(new Set([0.2]));
    const b = await fakeModel(GEN);
    await run(ARGV, { ...b.env, NPC_TEMPERATURE: "0", PLAYER_TEMPERATURE: "1.5", GM_TEMPERATURE: "0.55" });
    expect(new Set(b.seen.npcCalls.map((c) => c.temperature))).toEqual(new Set([0]));
    expect(new Set(b.seen.player.map((c) => c.temperature))).toEqual(new Set([1.5]));
    expect(new Set(b.seen.gmCalls.map((c) => c.temperature))).toEqual(new Set([0.55]));
  });

  it("an invalid temperature is refused before anything starts, naming the variable", async () => {
    const { env } = await fakeModel(GEN);
    const r = await run(ARGV, { ...env, PLAYER_TEMPERATURE: "3" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("PLAYER_TEMPERATURE");
  });

  it("the notices say what is sent: the conversation so far (not 'the scripted conversation'), injects, and calls per slot", async () => {
    const { env } = await fakeModel(GEN);
    const r = await run([...ARGV.slice(0, 4), "--max-lines", "1", ...ARGV.slice(6)], env);
    expect(r.stdout).not.toContain("scripted conversation");
    expect(r.stdout).toContain("the conversation so far to the configured model provider");
    expect(r.stdout).toContain("the injects addressed to that role");
    expect(r.stdout).toContain("one per line slot and more with retries");
  });
});

describe("generated players: a model that explains its intent after a separator", () => {
  const SPOKEN = "What if we propose this as a phase two deliverable, properly scoped and priced?";
  const LEAK = "I want to suggest a compromise where the module is moved to a second phase and priced separately.";
  it("only the spoken sentence is said, recorded, reported and transcribed; a reply that is only commentary falls back and is counted", async () => {
    const { env } = await fakeModel((n, role) => (n === 1 ? { text: `${SPOKEN} *** ${LEAK}` } : n === 2 ? { text: `*** ${LEAK}` } : GEN(n, role)));
    const dir = await tmp();
    const { exitCode, showcase, stdout, report } = await run([...ARGV, "--transcript", "i.md"], env, { cwd: dir });
    expect(exitCode).toBe(0);
    const spoken = showcase.lines.filter((l) => l.source === "player-bot");
    expect(spoken[0]).toMatchObject({ tag: "generated", text: SPOKEN });
    expect(spoken[1]).toMatchObject({ tag: "scripted", role: "tech_lead" });
    expect(showcase.players).toMatchObject({ generated: 11, scriptedFallbacks: 1, verbatimRepeats: 0 });
    const md = await readFile(path.join(dir, "i.md"), "utf8");
    for (const where of [stdout, JSON.stringify(report), md]) {
      expect(where).not.toContain("compromise where the module");
      expect(where).not.toContain("\\*\\*\\*");
    }
    expect(md).toContain(`**[GENERATED] delivery_lead: ${SPOKEN}**`);
    expect(stdout).toContain("player tech_lead: generation failed (empty reply); used the scripted line");
  });
});

describe("generated players: logging the private intents (US-0027)", () => {
  /** A private copy of the scenario whose scripted player lines are distinct sentinels (never said by the fake model). */
  const sentinelScenario = async () => {
    const dir = await tmp();
    await cp(path.join(REPO_ROOT, "scenarios", "friday-escalation-extended"), dir, { recursive: true });
    const f = path.join(dir, "showcase.yaml");
    const { parse, stringify } = await import("yaml");
    const doc = parse(await readFile(f, "utf8")) as { scenes: { lines: { text: string }[] }[] };
    const sentinels: string[] = [];
    for (const sc of doc.scenes) sc.lines.forEach((l) => { l.text = `Sentinel intent number ${sentinels.length} zorblax`; sentinels.push(l.text); });
    await writeFile(f, stringify(doc));
    return { dir, sentinels };
  };

  it("logs each intent immediately before its line in the transcript, narration and JSON, and keeps it out of the session log, every inbox and the Game Master/AI character prompts", async () => {
    const { env, seen } = await fakeModel(GEN);
    const { dir, sentinels } = await sentinelScenario();
    const out = await tmp();
    let log = ""; let inboxes = "";
    const hooks = {
      beforeLine: async ({ sceneId, index, sys, players }: { sceneId: string; index: number; sys?: { logFile: string }; players?: Partial<Record<string, { inbox: unknown[] }>> }) => {
        if (sceneId === "s6_wrap_up" && index === 1) {
          log = await readFile(sys!.logFile, "utf8");
          inboxes = JSON.stringify(Object.values(players!).map((b) => b!.inbox));
        }
      },
    };
    const r = await run([...ARGV, "--scenario", dir, "--transcript", "i.md"], env, { cwd: out, showcaseHooks: hooks as never });
    expect(r.report!.results.filter((x) => x.status === "failed")).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(s15x(r).status).toBe("passed");
    expect(log.length).toBeGreaterThan(100);
    expect(inboxes.length).toBeGreaterThan(100);
    for (const s of sentinels) {
      expect(log).not.toContain(s);
      expect(inboxes).not.toContain(s);
      expect(seen.otherBodies.join("\n")).not.toContain(s);
    }
    expect(r.stdout).not.toContain(sentinels[0] + "x");
    // transcript: 12 intents, each right before its player line (no other dialogue in between), as plain [SYSTEM] entries
    const md = await readFile(path.join(out, "i.md"), "utf8");
    const entries = md.split("\n\n");
    const idx = entries.map((e, i) => (e.startsWith("[SYSTEM] intent for ") ? i : -1)).filter((i) => i >= 0);
    expect(idx).toHaveLength(12);
    for (const i of idx) {
      expect(entries[i]).toMatch(/^\[SYSTEM\] intent for [a-z\\_]+ \(private to the player bot; the server and the other players never see it\): Sentinel intent number \d+ zorblax$/);
      const next = entries.slice(i + 1).find((e) => e.startsWith("**") || e.startsWith("[SYSTEM] intent"))!;
      expect(next.startsWith("**[GENERATED] ")).toBe(true);
      expect(next).not.toContain("Sentinel");
    }
    expect(md).toContain("also the player intents: the scripted line a generated player was asked to express");
    expect(md).toContain("Intents logged: 12.");
    // narration and JSON
    expect(r.stdout.split("\n").filter((l) => l.includes("intent for ")).length).toBe(12);
    expect(r.showcase.players!.intentsLogged).toBe(12);
    expect(r.showcase.players!.intents![0]).toMatchObject({ role: "delivery_lead", scene: "s1_huddle", intent: sentinels[0], source: "generated" });
    expect(r.showcase.players!.intents![0]!.text).toMatch(/^Take 1 as/);
    expect(r.stdout).toContain("12 intent(s) logged");
  });

  it("a fallback line is also preceded by its intent and listed as scripted-fallback", async () => {
    const { env } = await fakeModel((n, role) => (n === 1 ? { status: 400 } : GEN(n, role)));
    const { dir, sentinels } = await sentinelScenario();
    const out = await tmp();
    const r = await run([...ARGV, "--scenario", dir, "--transcript", "f.md"], env, { cwd: out });
    const md = await readFile(path.join(out, "f.md"), "utf8");
    expect(md).toContain(`Sentinel intent number 0 zorblax\n\n[SYSTEM] player delivery\\_lead: generation failed`);
    expect(md).toContain(`**[SCRIPTED] delivery_lead: ${sentinels[0]}**`);
    expect(r.showcase.players!.intents![0]).toMatchObject({ source: "scripted-fallback", intent: sentinels[0], text: sentinels[0] });
  });

  it("--no-intents hides them everywhere (and the run is otherwise the same)", async () => {
    const { env } = await fakeModel(GEN);
    const out = await tmp();
    const r = await run([...ARGV, "--no-intents", "--transcript", "n.md"], env, { cwd: out });
    expect(r.exitCode).toBe(0);
    const md = await readFile(path.join(out, "n.md"), "utf8");
    expect(md).not.toContain("intent for ");
    expect(r.stdout).not.toContain("intent for ");
    expect(r.showcase.players!.intents).toBeUndefined();
    expect(r.showcase.players!.intentsLogged).toBe(0);
  });

  it("scripted-player and mock runs have no intent entries and no players section", async () => {
    const out = await tmp();
    const mock = await run(["--showcase", "--fast", "--no-color", "--transcript", "m.md"], {}, { cwd: out });
    expect(mock.exitCode).toBe(0);
    const md = await readFile(path.join(out, "m.md"), "utf8");
    expect(md).not.toContain("intent for ");
    expect(md).not.toContain("player intents");
    expect(mock.stdout).not.toContain("intent for ");
    expect(mock.showcase.players).toBeUndefined();
    const { env } = await fakeModel(GEN);
    const live = await run(["--showcase", "--live", "--max-lines", "1", "--fast", "--no-color", "--transcript", "s.md"], env, { cwd: out });
    expect(await readFile(path.join(out, "s.md"), "utf8")).not.toContain("intent for ");
    expect(live.showcase.players).toBeUndefined();
  });
});
const s15x = (r: Awaited<ReturnType<typeof run>>) => r.report!.results.find((x) => x.id === "S-15")!;

describe("S-07 when a live AI character recites its own material", () => {
  const KNOWLEDGE = "Finance needs the daily tie-out before the first month-end close after go-live"; // client_sponsor's own knowledge item
  const HIDDEN = "Would accept a phased delivery after go-live if the risk is explained well"; // client_sponsor's hidden fact
  const priya = (text: string) => (_n: number, system: string) => (system.includes("You are playing Priya Raman") ? text : "I hear you, tell me more.");
  const leakHooks = (msg: object) => ({
    beforeLine: async ({ sceneId, index, players }: { sceneId: string; index: number; players?: Partial<Record<string, { inbox: unknown[] }>> }) => {
      if (sceneId === "s1_huddle" && index === 1) players!.delivery_lead!.inbox.push(msg);
    },
  });
  const evt = (e: object) => ({ type: "event", event: { seq: 9_100, ts: 1, sessionId: "demo", ...e } });

  it.each([["generated players", ARGV], ["scripted players", ["--showcase", "--live", "--max-lines", "2", "--fast", "--no-color"]]])("regression (%s): Priya saying her own knowledge item aloud is not a leak", async (_n, argv) => {
    const { env } = await fakeModel(GEN, priya(`${KNOWLEDGE}. Can you confirm?`));
    const r = await run(argv, env);
    expect(s7(r).status).toBe("passed");
    expect(r.report!.results.filter((x) => x.status === "failed")).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it("still fails when the same string arrives in a non-utterance message, or in an utterance by a role that does not own it", async () => {
    for (const msg of [
      evt({ type: "inject.fired", injectId: "x", sceneId: "s1_huddle", to: ["delivery_lead"], content: KNOWLEDGE }),
      evt({ type: "utterance", roleId: "tech_lead", text: KNOWLEDGE, channel: "text" }),
      evt({ type: "utterance", roleId: "cfo", text: KNOWLEDGE, channel: "text" }),
      evt({ type: "npc.updated", roleId: "client_sponsor", goals: [], knowledge: [KNOWLEDGE] }),
    ]) {
      const { env } = await fakeModel(GEN, priya(`${KNOWLEDGE}.`));
      const r = await run(ARGV, env, { showcaseHooks: leakHooks(msg) as never });
      expect(s7(r).status, JSON.stringify(msg).slice(0, 80)).toBe("failed");
      expect(s7(r).details).toMatch(/Finance needs the da|npc\.updated/);
    }
  });

  it("a hidden-fact string said aloud by an AI character is an observation (narration, report), not a failure", async () => {
    const { env } = await fakeModel(GEN, priya(`${HIDDEN}.`));
    const r = await run(ARGV, env);
    expect(s7(r).status).toBe("passed");
    expect(r.exitCode).toBe(0);
    const msg = /AI character client_sponsor said \d+ unreleased hidden-fact string\(s\) aloud: the live model ignored the hidden-fact rule/;
    expect(r.showcase.observations.some((o) => msg.test(o))).toBe(true);
    expect(r.stdout).toMatch(msg);
  });

  it("a hidden-fact string in a NON-utterance message still fails", async () => {
    const { env } = await fakeModel(GEN);
    const r = await run(ARGV, env, { showcaseHooks: leakHooks(evt({ type: "inject.fired", injectId: "x", sceneId: "s1_huddle", to: ["delivery_lead"], content: HIDDEN })) as never });
    expect(s7(r).status).toBe("failed");
  });

  it("mock mode keeps the old strictness: even an utterance by the string's own owner in a player's inbox fails", async () => {
    const hooks = leakHooks(evt({ type: "utterance", roleId: "client_sponsor", text: KNOWLEDGE, channel: "text" }));
    const r = await run(["--showcase", "--fast", "--no-color"], {}, { showcaseHooks: hooks as never });
    expect(s7(r).status).toBe("failed");
  });
});
