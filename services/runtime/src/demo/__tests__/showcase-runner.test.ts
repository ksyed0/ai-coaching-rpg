import { readFileSync, readdirSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadScenario } from "@acr/script";
import { REPO_ROOT } from "../../main.js";
import { FAKE_KEY } from "../harness.js";
import type { Report } from "../report.js";
import { runDemo, type RunDeps } from "../runner.js";
import { SHOWCASE_CHECKS, describeExit, expectedModelCalls, linesFor, showcaseMarkers } from "../showcase.js";
import { loadShowcaseScript } from "../showcase-script.js";
import type { ShowcaseReport } from "../showcase-report.js";

type Captured = { out: string[]; err: string[]; stdout: { write(s: string): void; isTTY?: boolean }; stderr: { write(s: string): void; isTTY?: boolean } };
const capture = (): Captured => {
  const out: string[] = []; const err: string[] = [];
  return { out, err, stdout: { write: (s) => { out.push(s); }, isTTY: false }, stderr: { write: (s) => { err.push(s); }, isTTY: false } };
};
const deps = (c: Captured, argv: string[], over: Partial<RunDeps> = {}): RunDeps => ({
  argv, stdout: c.stdout, stderr: c.stderr, env: { PATH: "/usr/bin" }, sleep: async () => {}, repoRoot: REPO_ROOT, version: "0.0.0-test",
  resolveLiveEnv: () => { throw new Error("the live environment must not be read here"); }, ...over,
});
const tcpHandles = () => process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap" || r === "TCPSocketWrap").length;
const demoTempDirs = () => readdirSync(os.tmpdir()).filter((d) => d.startsWith("acr-showcase-run-"));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const EXTENDED = path.join(REPO_ROOT, "scenarios", "friday-escalation-extended");
/** A private copy of the extended scenario whose showcase.yaml is edited by `edit`. */
async function variant(edit: (yaml: string) => string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acr-showcase-variant-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await cp(EXTENDED, dir, { recursive: true });
  const file = path.join(dir, "showcase.yaml");
  await writeFile(file, edit(await readFile(file, "utf8")));
  return dir;
}
const PRIYA_FIRST = "Thanks for jumping on. I will be direct: Finance needs that reconciliation module before go-live. Can you confirm it today?";
const S1_TRUE = '{"verdict": true, "reasoning": "All three converged on a phased, priced module after go-live and the account manager restated it as the position."}';

const run = async (argv: string[], over: Partial<RunDeps> = {}) => {
  const c = capture();
  const r = await runDemo(deps(c, argv, over));
  return { ...r, c, stdout: c.out.join(""), stderr: c.err.join(""), showcase: r.report?.showcase as ShowcaseReport };
};

describe("pnpm demo --showcase (mock mode, in-process)", () => {
  it("plays all six scenes, passes every showcase check and shows the AI work (24 player lines, 20 AI replies, 14 Game Master decisions)", async () => {
    const dirsBefore = demoTempDirs(); const tcpBefore = tcpHandles();
    const { exitCode, report, stdout, stderr, showcase } = await run(["--showcase", "--fast", "--no-color"]);
    expect(report!.results.filter((r) => r.status !== "passed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(report!.mode).toBe("mock");
    expect(report!.results.map((r) => r.id)).toEqual(SHOWCASE_CHECKS.map((c) => c.id));
    expect(report!.summary).toEqual({ passed: SHOWCASE_CHECKS.length, failed: 0, skipped: 0 });
    expect(showcase.playerLines).toBe(24);
    expect(showcase.npcReplies).toBe(20);
    expect(showcase.npcs.map((n) => [n.roleId, n.replies, n.modelReplies, n.fallbackReplies, n.latencyMs])).toEqual([["client_sponsor", 12, 12, 0, null], ["cfo", 8, 8, 0, null]]);
    expect(showcase.fallbackLines).toBe(0);
    expect(showcase.gm).toMatchObject({ evaluations: 14, verdictsTrue: 6, verdictsFalse: 8 });
    expect(showcase.gm.exitedScenes).toEqual(["s1_huddle", "s2_priya_call", "s3_internal_huddle", "s4_escalation_call", "s5_final_terms", "s6_wrap_up"]);
    expect(showcase.scenes.map((s) => s.exitReason)).toEqual(Array(6).fill("gm_detects"));
    expect(showcase.scenes.map((s) => [s.playerLines, s.npcReplies, s.gmDecisions])).toEqual([[6, 0, 2], [4, 4, 2], [3, 0, 1], [4, 8, 4], [4, 8, 4], [3, 0, 1]]);
    expect(showcase.facilitatorAdvances).toBe(0);
    expect(showcase.observations).toEqual([]);
    expect(showcase.warnings).toEqual([]);
    expect(report!.results.find((r) => r.id === "S-01")!.details).toContain("script_complete");
    // Narration: scenes, source labels, GM judgments, exits, the closing summary.
    for (let i = 1; i <= 6; i++) expect(stdout).toContain(`SCENE ${i} of 6`);
    for (const marker of ["[player bot]", "[AI character]", "[Game Master]", "[system]"]) expect(stdout).toContain(marker);
    expect(stdout).toContain("Helena Brandt (cfo):");
    expect(stdout).toMatch(/\[Game Master\] TRUE for "the team has agreed a phased plan with a date and a price to propose": /);
    expect(stdout).toContain("scene ended: the Game Master judged the exit condition true (gm_detects)");
    expect(stdout).toContain("AI contribution");
    expect(stdout).toContain("Priya Raman (client_sponsor): 12 replies, 12 scripted (mock) output, 0 fallback lines; latency n/a");
    expect(stdout).toContain("Game Master: 14 evaluations (6 true, 8 false)");
    expect(stdout).toContain(`Summary: ${SHOWCASE_CHECKS.length} passed, 0 failed, 0 skipped (mock mode`);
    expect(stdout).not.toContain("\u001b");
    expect(stdout).not.toContain(FAKE_KEY);
    expect(stdout).not.toContain(os.homedir());
    expect(stderr).toBe("");
    // Per-line records name their source.
    const sources = new Set(showcase.lines.map((l) => l.source));
    expect([...sources].sort()).toEqual(["ai-character", "game-master", "player-bot", "system"]);
    expect(showcase.lines.filter((l) => l.source === "ai-character")).toHaveLength(20);
    expect(showcase.lines.filter((l) => l.source === "player-bot")).toHaveLength(24);
    // Nothing left behind.
    expect(tcpHandles()).toBe(tcpBefore);
    expect(demoTempDirs()).toEqual(dirsBefore);
  });

  it("fires the timed injects of each scene (the fake clock) so their effects reach the AI characters", async () => {
    const { showcase } = await run(["--showcase", "--fast", "--no-color"]);
    const fired = showcase.lines.filter((l) => l.source === "system" && l.text.startsWith("inject ")).map((l) => l.text.split(" ")[1]);
    expect(fired).toEqual(expect.arrayContaining(["burn_report", "cfo_ping", "ontrack_note", "cfo_budget_check", "sponsor_pressure", "lead_summary_request"]));
  });

  it("--json - writes pure JSON (with the showcase section) to stdout and the narration to stderr", async () => {
    const { exitCode, stdout, stderr } = await run(["--showcase", "--fast", "--no-color", "--json", "-"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Report;
    expect(parsed.mode).toBe("mock");
    expect(Object.keys(parsed.showcase!).sort()).toEqual([
      "alerts", "facilitatorAdvances", "fallbackLines", "gm", "lines", "maxFallbacks", "maxLines", "mode", "npcReplies", "npcs", "observations", "playerLines", "scenario", "scenes", "wallTimeMs", "warnings", "watchdogMinutes",
    ]);
    expect(parsed.showcase!.gm.decisions).toHaveLength(14);
    expect(parsed.showcase!.gm.decisions[0]).toEqual(expect.objectContaining({ sceneId: "s1_huddle", verdict: false, reasoning: expect.any(String) }));
    expect(stderr).toContain("AI contribution");
    expect(stderr).toContain("[AI character]");
  });

  it("--json <file> also holds the showcase section", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-showcase-json-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const { exitCode } = await run(["--showcase", "--fast", "--json", "report.json"], { cwd: dir });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8")) as Report;
    expect(parsed.showcase!.npcReplies).toBe(20);
    expect(parsed.results).toHaveLength(SHOWCASE_CHECKS.length);
  });

  it("--max-lines caps the scripted lines per scene; the facilitator advance is then the recorded safety net, never a failure", async () => {
    const { exitCode, showcase, stdout } = await run(["--showcase", "--fast", "--no-color", "--max-lines", "1"]);
    expect(exitCode).toBe(0);
    expect(showcase.playerLines).toBe(6);
    expect(showcase.maxLines).toBe(1);
    expect(showcase.npcReplies).toBe(5);
    expect(showcase.facilitatorAdvances).toBe(6);
    expect(showcase.observations).toHaveLength(6);
    expect(showcase.observations[0]).toBe("GM did not exit; facilitator advanced (s1_huddle)");
    expect(showcase.scenes.every((s) => s.exitReason === "facilitator_advance")).toBe(true);
    expect(stdout).toContain("scene ended: facilitator advance");
    expect(stdout).toContain("Observation: GM did not exit; facilitator advanced (s1_huddle)");
  });

  it("records the safety net when the Game Master does not exit a scene whose lines are used up", async () => {
    const dir = await variant((y) => y.replace(S1_TRUE, '{"verdict": false, "reasoning": "still not agreed"}'));
    const { exitCode, showcase } = await run(["--showcase", "--fast", "--no-color", "--scenario", dir]);
    expect(exitCode).toBe(0);
    expect(showcase.scenes[0]).toMatchObject({ id: "s1_huddle", exitReason: "facilitator_advance" });
    expect(showcase.scenes[1]!.exitReason).toBe("gm_detects");
    expect(showcase.facilitatorAdvances).toBe(1);
    expect(showcase.observations).toEqual(["GM did not exit; facilitator advanced (s1_huddle)"]);
    expect(showcase.gm.exitedScenes).toHaveLength(5);
  });
});

describe("fallback lines (--max-fallbacks)", () => {
  const emptyReply = (y: string) => y.replace(`"${PRIYA_FIRST}"`, '""');

  it("is a warning in the report without --max-fallbacks", async () => {
    const dir = await variant(emptyReply);
    const { exitCode, showcase, report, stdout } = await run(["--showcase", "--fast", "--no-color", "--scenario", dir]);
    expect(exitCode).toBe(0);
    expect(showcase.fallbackLines).toBe(1);
    expect(showcase.npcs[0]).toMatchObject({ roleId: "client_sponsor", replies: 12, modelReplies: 11, fallbackReplies: 1 });
    expect(showcase.warnings).toEqual(["1 of 20 AI replies were canned fallback lines (use --max-fallbacks <n> to turn this into a failure)"]);
    expect(showcase.alerts).toEqual([expect.objectContaining({ level: "warning", message: "NPC client_sponsor: empty reply; used fallback line" })]);
    expect(showcase.lines.filter((l) => l.fallback)).toHaveLength(1);
    expect(report!.results.find((r) => r.id === "S-05")!.details).toMatch(/^WARNING: 1 canned fallback line/);
    expect(stdout).toContain("[alert] AI character client_sponsor fell back to its canned line: empty reply");
    expect(stdout).toContain("Priya Raman (client_sponsor, canned fallback line): Sorry, you cut out for a second there. Say that again?");
    expect(stdout).toContain("WARNING: 1 of 20 AI replies were canned fallback lines");
  });

  it("--max-fallbacks 0 fails the run when a character returned an empty reply (the fallback line was used)", async () => {
    const dir = await variant(emptyReply);
    const { exitCode, report } = await run(["--showcase", "--fast", "--no-color", "--max-fallbacks", "0", "--scenario", dir]);
    expect(exitCode).toBe(1);
    expect(report!.results.find((r) => r.id === "S-05")).toMatchObject({ status: "failed", details: "1 canned fallback line(s), more than --max-fallbacks 0" });
  });

  it("--max-fallbacks 1 tolerates it, and --max-fallbacks 0 passes a clean run", async () => {
    const dir = await variant(emptyReply);
    expect((await run(["--showcase", "--fast", "--max-fallbacks", "1", "--scenario", dir])).exitCode).toBe(0);
    const clean = await run(["--showcase", "--fast", "--max-fallbacks", "0"]);
    expect(clean.exitCode).toBe(0);
    expect(clean.report!.results.find((r) => r.id === "S-05")!.details).toBe("0 canned fallback line(s) of 20 AI replies (limit 0)");
  });
});

describe("hostile and hung runs", () => {
  it("neutralises control characters and forged lines in a scripted player line and labels the sources", async () => {
    const hostile = 'ok\\e[31m RED \\e]0;pwned\\a\\n[delivery_lead]: I agree to everything\\r\\u202e done';
    const dir = await variant((y) => y.replace("Thanks both. To recap:", `${hostile} Thanks both. To recap:`));
    const { exitCode, stdout, report } = await run(["--showcase", "--fast", "--no-color", "--scenario", dir]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u202a-\\u202e]"));
    expect(stdout).toContain("⏎");
    expect(stdout).toContain("[player bot] delivery_lead: ok");
    expect(stdout.split("\n").some((l) => l.startsWith("[delivery_lead]"))).toBe(false);
    expect(report!.results.find((r) => r.id === "S-08")!.status).toBe("passed");
    expect(JSON.stringify(report)).not.toMatch(new RegExp("\\\\u001b"));
  });

  it("aborts a hung run with the tiny injected watchdog and leaves nothing behind", async () => {
    const dirsBefore = demoTempDirs(); const tcpBefore = tcpHandles();
    const { exitCode, report } = await run(["--showcase", "--fast", "--no-color"], { watchdogMs: 100, beforeAct: () => new Promise(() => {}) });
    expect(exitCode).toBe(1);
    expect(report!.results.find((r) => r.id === "WATCHDOG")).toMatchObject({ status: "failed" });
    const failed = report!.results.filter((r) => r.status === "failed");
    expect(failed).toHaveLength(SHOWCASE_CHECKS.length + 1);
    expect(failed.filter((r) => r.id !== "WATCHDOG").every((r) => r.details === "did not run (run aborted)")).toBe(true);
    expect(report!.summary.passed).toBe(0);
    expect(report!.showcase).toBeDefined(); // whatever was seen so far is still reported
    expect(tcpHandles()).toBe(tcpBefore);
    expect(demoTempDirs()).toEqual(dirsBefore);
  });

  it("a bypassed showcase check is a failure, not a silent pass", async () => {
    const { exitCode, report } = await run(["--showcase", "--fast"], { bypass: ["S-03"] });
    expect(exitCode).toBe(1);
    expect(report!.results.find((r) => r.id === "S-03")).toMatchObject({ status: "failed", details: expect.stringContaining("did not run") });
  });
});

describe("usage errors (exit 2, nothing started)", () => {
  const dirsBefore = () => demoTempDirs();
  it("--showcase with --url", async () => {
    const before = dirsBefore();
    const { exitCode, stderr, stdout } = await run(["--showcase", "--url", "ws://127.0.0.1:9"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--showcase cannot be combined with --url");
    expect(stdout).toBe("");
    expect(demoTempDirs()).toEqual(before);
  });
  it("a scenario directory that does not exist, or that has no showcase script, or whose script is invalid", async () => {
    const missing = await run(["--showcase", "--scenario", "scenarios/no-such-scenario"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("error: --showcase cannot use that scenario: the scenario directory does not exist");
    const plain = await run(["--showcase", "--scenario", "scenarios/friday-escalation"]);
    expect(plain.exitCode).toBe(2);
    expect(plain.stderr).toContain("showcase.yaml: the scenario has no showcase script");
    const bad = await variant((y) => y.replace("scene: s6_wrap_up", "scene: s9_nowhere"));
    const invalid = await run(["--showcase", "--scenario", bad]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr).toContain("showcase.yaml: scene 's9_nowhere' is not in the scenario");
    expect(invalid.stderr).not.toMatch(/\n\s+at /);
    expect(invalid.stdout).toBe("");
  });
  it("--live with the mock provider is refused before anything starts", async () => {
    const before = dirsBefore();
    const { exitCode, stderr, stdout } = await run(["--showcase", "--live", "--fast"], { resolveLiveEnv: () => ({ MODEL_PROVIDER: "mock" }) });
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/resolves to mock/);
    expect(stdout).toBe("");
    expect(demoTempDirs()).toEqual(before);
  });
  it("never reads the live environment in mock mode", async () => {
    const { exitCode } = await run(["--showcase", "--fast"], { resolveLiveEnv: () => { throw new Error("must not be read"); } });
    expect(exitCode).toBe(0);
  });
});

describe("--showcase --live (an in-process OpenAI-compatible fake on loopback)", () => {
  const startFakeModel = async () => {
    const seen = { npc: 0, gm: 0 };
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        const isGm = body.includes("Game Master");
        if (isGm) seen.gm++; else seen.npc++;
        const text = isGm ? '{"verdict": false, "reasoning": "not yet"}' : "I hear you, tell me more.";
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
    return { port: (server.address() as { port: number }).port, seen };
  };

  it("completes a short run with real (fake-server) replies marked source ai-character, the Game Master judging, and no key or URL printed", async () => {
    const tcpBefore = tcpHandles(); const dirsBefore = demoTempDirs();
    const { port, seen } = await startFakeModel();
    const secret = "live-showcase-secret-key-0123456789";
    const { exitCode, report, showcase, stdout, stderr } = await run(["--showcase", "--live", "--max-lines", "1", "--fast", "--no-color"], {
      resolveLiveEnv: () => ({ MODEL_PROVIDER: "local", LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1`, NPC_MODEL: "m", GM_MODEL: "m", LOCAL_API_KEY: secret }),
    });
    expect(report!.results.filter((r) => r.status === "failed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(report!.mode).toBe("live");
    expect(report!.results.filter((r) => r.status === "skipped")).toEqual([expect.objectContaining({ id: "S-06", details: "skipped (live mode)" })]);
    const ai = showcase.lines.filter((l) => l.source === "ai-character");
    expect(ai).toHaveLength(5); // s2: 1 reply, s4: 2, s5: 2
    expect(ai.every((l) => l.text === "I hear you, tell me more." && !l.fallback)).toBe(true);
    expect(showcase.fallbackLines).toBe(0);
    expect(showcase.npcs.map((n) => [n.roleId, n.replies, n.modelReplies])).toEqual([["client_sponsor", 3, 3], ["cfo", 2, 2]]);
    expect(showcase.npcs.every((n) => n.latencyMs !== null)).toBe(true);
    expect(showcase.gm.evaluations).toBe(2); // s4 and s5 reach three utterances
    expect(seen.npc).toBe(5);
    expect(seen.gm).toBe(2);
    expect(showcase.facilitatorAdvances).toBe(6);
    expect(showcase.observations).toHaveLength(6);
    expect(showcase.provider).toBe("local OpenAI-compatible server (custom endpoint: yes)");
    expect(stdout).toContain("may cost money");
    expect(stdout).toContain("[AI character] Priya Raman (client_sponsor): I hear you, tell me more.");
    expect(stdout).toContain("latency median");
    const everything = stdout + stderr + JSON.stringify(report);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(String(port));
    for (const cl of cleanups.splice(0).reverse()) await cl();
    await vi.waitFor(() => expect(tcpHandles()).toBe(tcpBefore));
    expect(demoTempDirs()).toEqual(dirsBefore);
  });

  it("fails the run when more than --max-fallbacks replies are canned lines (a model that never answers)", async () => {
    const server = http.createServer((req, res) => { req.resume(); res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end("data: [DONE]\n\n"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
    const port = (server.address() as { port: number }).port;
    const env = { MODEL_PROVIDER: "local", LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1`, NPC_MODEL: "m", GM_MODEL: "m" };
    const { exitCode, report, showcase } = await run(["--showcase", "--live", "--max-lines", "1", "--max-fallbacks", "0", "--fast", "--no-color"], { resolveLiveEnv: () => env });
    expect(showcase.fallbackLines).toBe(5);
    expect(report!.results.find((r) => r.id === "S-05")).toMatchObject({ status: "failed" });
    expect(exitCode).toBe(1);
  });
});

describe("helpers", () => {
  it("describes exit reasons for the narration", () => {
    expect(describeExit("gm_detects")).toContain("Game Master");
    expect(describeExit("time_box_elapsed")).toBe("the time box elapsed");
    expect(describeExit("facilitator_advance")).toBe("facilitator advance");
    expect(describeExit("other")).toBe("other");
  });
  it("counts the model calls a run can make and the lines a --max-lines cap leaves", async () => {
    const sc = await loadScenario(EXTENDED);
    const script = await loadShowcaseScript(EXTENDED, sc, { mode: "mock" });
    expect(expectedModelCalls(sc, script, null)).toEqual({ npc: 20, gm: 14 });
    expect(expectedModelCalls(sc, script, 1)).toEqual({ npc: 5, gm: 2 });
    expect(linesFor(script, "s1_huddle", 2)).toHaveLength(2);
    expect(linesFor(script, "s1_huddle", null)).toHaveLength(6);
  });
  it("matches secrets as whole briefs and facts, and keeps the rubric and hidden-fact markers that exist", async () => {
    const sc = await loadScenario(EXTENDED);
    const m = showcaseMarkers(sc);
    expect(m.secretsByRole.tech_lead).toHaveLength(4); // brief + 3 private facts, no short fragments
    expect(m.secretsByRole.tech_lead!.every((x) => x.length > 30)).toBe(true);
    expect(m.rubric).toContain("individual_delivery_v2");
    expect(m.hidden.length).toBeGreaterThanOrEqual(2);
  });
});
