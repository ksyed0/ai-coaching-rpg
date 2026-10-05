import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { REPO_ROOT, bootstrap } from "../../main.js";
import { CHECKS, CHECK_IDS } from "../checks.js";
import { FAKE_KEY, makeTempRoot } from "../harness.js";
import { loadLiveEnv, runDemo, type RunDeps } from "../runner.js";
import type { Report } from "../report.js";

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
const demoTempDirs = () => readdirSync(os.tmpdir()).filter((d) => d.startsWith("acr-demo-"));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

describe("the demo runner, in-process, fast, mock mode", () => {
  it("plays the whole scenario, passes every check, closes everything and removes its temp dir", async () => {
    const dirsBefore = demoTempDirs(); const tcpBefore = tcpHandles();
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--fast", "--no-color"]));
    const stdout = c.out.join("");
    expect(report!.results.filter((r) => r.status !== "passed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(report!.summary).toEqual({ passed: CHECKS.length, failed: 0, skipped: 0 });
    expect(report!.results.map((r) => r.id)).toEqual([...CHECK_IDS]);
    expect(report!.mode).toBe("mock");
    expect(CHECKS.length).toBe(29);
    // Narrated acts and the final checklist, plain text (not a TTY).
    for (const act of ["ACT 1", "ACT 2", "ACT 3", "ACT 4", "ACT 5", "ACT 6", "ACT 7"]) expect(stdout).toContain(act);
    expect(stdout).toContain("Checklist");
    expect(stdout).toContain(`Summary: ${CHECKS.length} passed, 0 failed, 0 skipped (mock mode`);
    expect(stdout).not.toContain("\u001b");
    expect(stdout).not.toContain(FAKE_KEY);
    expect(stdout).not.toContain(os.homedir());
    expect(c.err).toEqual([]);
    // Nothing left behind.
    expect(tcpHandles()).toBe(tcpBefore);
    expect(demoTempDirs()).toEqual(dirsBefore);
  });

  it("uses the injected sleep for pacing and none of it with --fast", async () => {
    const delays: number[] = [];
    const slow = capture();
    await runDemo(deps(slow, ["--speed", "20", "--no-color"], { sleep: async (ms) => { delays.push(ms); } }));
    expect(delays.length).toBeGreaterThan(50);
    expect(Math.max(...delays)).toBeLessThanOrEqual(700 / 20 + 1e-9);
    expect(Math.min(...delays)).toBeGreaterThan(0);
    const fastDelays: number[] = [];
    await runDemo(deps(capture(), ["--fast"], { sleep: async (ms) => { fastDelays.push(ms); } }));
    expect(fastDelays).toEqual([]);
  });

  it("never reads the live environment or the repo .env in the default mode", async () => {
    const tmp = await makeTempRoot(REPO_ROOT);
    cleanups.push(() => tmp.cleanup());
    writeFileSync(path.join(tmp.root, ".env"), "MODEL_PROVIDER=anthropic\nANTHROPIC_API_KEY=SENTINEL-NEVER-READ-12345678\n");
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--fast"], { repoRoot: tmp.root }));
    expect(exitCode).toBe(0);
    expect(report!.mode).toBe("mock");
    expect(c.out.join("") + c.err.join("")).not.toContain("SENTINEL");
  });

  it("injects one failing check: exit code 1, a failed entry, the others still reported", async () => {
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--fast", "--no-color"], { forceFail: ["F-12"] }));
    expect(exitCode).toBe(1);
    expect(report!.summary).toEqual({ passed: CHECKS.length - 1, failed: 1, skipped: 0 });
    expect(report!.results.find((r) => r.id === "F-12")).toMatchObject({ status: "failed", details: "forced failure (test hook)" });
    expect(c.out.join("")).toContain("✗ F-12");
  });

  it("aborts a hung run with a failure report, closes everything and removes the temp dir (watchdog)", async () => {
    const dirsBefore = demoTempDirs(); const tcpBefore = tcpHandles();
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--fast", "--no-color"], { watchdogMs: 100, beforeAct: () => new Promise(() => {}) }));
    expect(exitCode).toBe(1);
    expect(report!.results.find((r) => r.id === "WATCHDOG")).toMatchObject({ status: "failed" });
    // In mock mode every check that did not run is a failure, so an aborted run can never look healthy.
    const failed = report!.results.filter((r) => r.status === "failed");
    expect(failed).toHaveLength(CHECKS.length + 1);
    expect(failed.filter((r) => r.id !== "WATCHDOG").every((r) => r.details === "did not run (run aborted)")).toBe(true);
    expect(report!.summary.passed).toBe(0);
    expect(tcpHandles()).toBe(tcpBefore);
    expect(demoTempDirs()).toEqual(dirsBefore);
  });

  it("reports an unexpected error (an unloadable scenario) as a failure, exit 1", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "acr-demo-test-empty-"));
    cleanups.push(() => rm(empty, { recursive: true, force: true }));
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--fast"], { repoRoot: empty }));
    expect(exitCode).toBe(1);
    expect(report!.results.find((r) => r.id === "ERROR")).toMatchObject({ status: "failed" });
  });
});

describe("output routing and the machine-readable report", () => {
  it("--json - puts only the JSON report on stdout and all narration on stderr", async () => {
    const c = capture();
    const { exitCode } = await runDemo(deps(c, ["--fast", "--no-color", "--json", "-"]));
    expect(exitCode).toBe(0);
    const report = JSON.parse(c.out.join("")) as Report;
    expect(report).toMatchObject({ tool: "acr-demo", version: "0.0.0-test", mode: "mock", summary: { failed: 0, skipped: 0 } });
    expect(Object.keys(report)).toEqual(["tool", "version", "mode", "startedAt", "durationMs", "summary", "results"]);
    expect(report.results).toHaveLength(CHECKS.length);
    for (const r of report.results) expect(Object.keys(r)).toEqual(["id", "title", "status", "details", "durationMs"]);
    const err = c.err.join("");
    expect(err).toContain("ACT 1");
    expect(err).toContain("Checklist");
    const text = c.out.join("") + err;
    expect(text).not.toContain(FAKE_KEY);
    expect(c.out.join("")).not.toContain(os.homedir());
  });

  it("--json <path> writes the report file and keeps narration on stdout", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-demo-test-json-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "report.json");
    const c = capture();
    const { exitCode } = await runDemo(deps(c, ["--fast", "--no-color", "--json", file]));
    expect(exitCode).toBe(0);
    const report = JSON.parse(readFileSync(file, "utf8")) as Report;
    expect(report.summary.failed).toBe(0);
    expect(c.out.join("")).toContain("ACT 1");
    expect(c.err).toEqual([]);
  });

  it("resolves a relative --json path from INIT_CWD (where pnpm was run), not from the package dir", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-demo-test-cwd-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const c = capture();
    const { exitCode } = await runDemo({ ...deps(c, ["--fast", "--json", "rel.json"]), env: { INIT_CWD: dir } });
    expect(exitCode).toBe(0);
    expect((JSON.parse(readFileSync(path.join(dir, "rel.json"), "utf8")) as Report).summary.failed).toBe(0);
    const viaCwd = capture();
    await runDemo({ ...deps(viaCwd, ["--fast", "--json", "rel2.json"]), cwd: dir });
    expect(readFileSync(path.join(dir, "rel2.json"), "utf8")).toContain('"tool": "acr-demo"');
  });

  it("exits 1 when the report cannot be written", async () => {
    const c = capture();
    const { exitCode } = await runDemo(deps(c, ["--fast", "--json", path.join(os.tmpdir(), "acr-demo-does-not-exist", "x", "report.json")]));
    expect(exitCode).toBe(1);
    expect(c.err.join("")).toContain("cannot write the report");
  });

  it("colours output only for a TTY", async () => {
    const c = capture();
    c.stdout.isTTY = true;
    await runDemo({ ...deps(c, ["--fast"]), env: {} });
    expect(c.out.join("")).toContain("\u001b[");
    const plain = capture(); plain.stdout.isTTY = true;
    await runDemo({ ...deps(plain, ["--fast"]), env: { NO_COLOR: "1" } });
    expect(plain.out.join("")).not.toContain("\u001b");
  });
});

describe("CLI behaviour", () => {
  it("--help prints the usage on stdout and exits 0 without running anything", async () => {
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--help"]));
    expect(exitCode).toBe(0);
    expect(report).toBeUndefined();
    expect(c.out.join("")).toContain("usage: pnpm demo");
  });
  it.each([[["--bogus"]], [["--speed", "0"]], [["--fast", "--speed", "2"]], [["--url", "http://x"]], [["--session", "a b"]]])("a usage error (%j) prints the usage on stderr and exits 2", async (argv) => {
    const tcpBefore = tcpHandles();
    const c = capture();
    const { exitCode } = await runDemo(deps(c, argv));
    expect(exitCode).toBe(2);
    expect(c.err.join("")).toContain("usage: pnpm demo");
    expect(c.out).toEqual([]);
    expect(tcpHandles()).toBe(tcpBefore);
  });
});

describe("--live", () => {
  it("refuses with exit code 2 when the provider resolves to mock, before starting anything", async () => {
    const dirsBefore = demoTempDirs();
    const c = capture();
    const { exitCode } = await runDemo(deps(c, ["--live", "--fast"], { resolveLiveEnv: () => ({ MODEL_PROVIDER: "mock" }) }));
    expect(exitCode).toBe(2);
    expect(c.err.join("")).toMatch(/resolves to mock/);
    expect(c.out).toEqual([]);
    expect(demoTempDirs()).toEqual(dirsBefore);
  });
  it("a bypassed check is a failure in --live mode too, while the intended live skips stay allowed", async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok then" } }] })}\n\n`); res.end("data: [DONE]\n\n"); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
    const port = (server.address() as { port: number }).port;
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--live", "--fast"], {
      bypass: ["F-17"], resolveLiveEnv: () => ({ MODEL_PROVIDER: "local", LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1`, NPC_MODEL: "m", GM_MODEL: "m" }),
    }));
    expect(exitCode).toBe(1);
    expect(report!.results.find((r) => r.id === "F-17")).toMatchObject({ status: "failed", details: expect.stringContaining("did not run") });
    expect(report!.results.filter((r) => r.status === "skipped").every((r) => r.details === "skipped (live mode)")).toBe(true);
  });

  it("also refuses when MODEL_PROVIDER is unset, and names variables (never values) when the config is incomplete", async () => {
    const unset = capture();
    expect((await runDemo(deps(unset, ["--live"], { resolveLiveEnv: () => ({}) }))).exitCode).toBe(2);
    const noKey = capture();
    const r = await runDemo(deps(noKey, ["--live"], { resolveLiveEnv: () => ({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "" }) }));
    expect(r.exitCode).toBe(2);
    expect(noKey.err.join("")).toContain("ANTHROPIC_API_KEY");
    const bad = capture();
    expect((await runDemo(deps(bad, ["--live"], { resolveLiveEnv: () => ({ MODEL_PROVIDER: "nonsense" }) }))).exitCode).toBe(2);
  });

  // A tiny OpenAI-compatible server on loopback: no network, no real model, no .env.
  const startFakeModel = async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        const isGm = body.includes("Game Master");
        const text = isGm ? '{"verdict": false, "reasoning": "not yet"}' : "I hear you, tell me more.";
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
    return (server.address() as { port: number }).port;
  };

  // A model that is "briefly overloaded": the FIRST time it sees a request it answers 503, an identical retry succeeds.
  const startFlakyModel = async () => {
    const seenBodies = new Set<string>(); const stats = { requests: 0, failed: 0 };
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        stats.requests++;
        if (!seenBodies.has(body)) { seenBodies.add(body); stats.failed++; res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Service temporarily overloaded" } })); return; }
        const text = body.includes("Game Master") ? '{"verdict": false, "reasoning": "not yet"}' : "I hear you, tell me more.";
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
    return { port: (server.address() as { port: number }).port, stats };
  };

  it("retries transient 503s on the live path: the transcript shows [GENERATED] and no [FALLBACK] outside the side room", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-live-retry-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const { port, stats } = await startFlakyModel();
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--live", "--fast", "--no-color", "--transcript", "live.md"], {
      cwd: dir, resolveLiveEnv: () => ({ MODEL_PROVIDER: "local", LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1`, NPC_MODEL: "m", GM_MODEL: "m", MODEL_RETRY_BASE_MS: "100" }),
    }));
    expect(report!.results.filter((r) => r.status === "failed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(stats.failed).toBeGreaterThan(0); // the 503s really happened
    const md = await readFile(path.join(dir, "live.md"), "utf8");
    const count = (tag: string) => (md.match(new RegExp(`^\\*\\*\\[${tag}\\] `, "gm")) ?? []).length;
    expect(count("GENERATED")).toBeGreaterThan(0);
    // The only fallbacks are the side room's two deliberately misbehaving (scripted) model replies, as in the mock run.
    expect(count("FALLBACK")).toBe(2);
    expect(md).toMatch(/\*\*\[GENERATED\] [^\n]*I hear you, tell me more\.\*\*/);
  });
  it("refuses a bad MODEL_MAX_RETRIES / MODEL_RETRY_BASE_MS before starting anything (exit 2, variable named)", async () => {
    for (const [name, value] of [["MODEL_MAX_RETRIES", "9"], ["MODEL_RETRY_BASE_MS", "5"]] as const) {
      const c = capture();
      const { exitCode } = await runDemo(deps(c, ["--live", "--fast"], { resolveLiveEnv: () => ({ MODEL_PROVIDER: "local", LOCAL_BASE_URL: "http://127.0.0.1:9/v1", NPC_MODEL: "m", GM_MODEL: "m", [name]: value }) }));
      expect(exitCode).toBe(2);
      expect(c.err.join("")).toContain(name);
      expect(c.out).toEqual([]);
    }
  });

  it("runs against a configured provider, skips the scripted checks, passes the rest and never prints the key or endpoint", async () => {
    const tcpBefore = tcpHandles(); const dirsBefore = demoTempDirs();
    const port = await startFakeModel();
    const c = capture();
    const secret = "live-test-secret-key-0123456789";
    const { exitCode, report } = await runDemo(deps(c, ["--live", "--fast", "--no-color"], {
      resolveLiveEnv: () => ({ MODEL_PROVIDER: "local", LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1`, NPC_MODEL: "m", GM_MODEL: "m", LOCAL_API_KEY: secret }),
    }));
    expect(report!.results.filter((r) => r.status === "failed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(report!.mode).toBe("live");
    const skipped = report!.results.filter((r) => r.status === "skipped");
    expect(skipped.map((r) => r.id)).toEqual(CHECKS.filter((x) => x.kind === "scripted").map((x) => x.id));
    expect(skipped.every((r) => r.details === "skipped (live mode)")).toBe(true);
    const text = c.out.join("") + c.err.join("") + JSON.stringify(report);
    expect(text).toContain("may cost money");
    expect(text).toContain("local OpenAI-compatible server (custom endpoint: yes)");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(String(port));
    // Once the test's own fake model is closed, nothing of the demo is left open (the client side of fetch included).
    for (const cl of cleanups.splice(0).reverse()) await cl();
    await vi.waitFor(() => expect(tcpHandles()).toBe(tcpBefore));
    expect(demoTempDirs()).toEqual(dirsBefore);
  });
});

describe("--url (smoke test of a running server)", () => {
  it("passes the externally observable checks against a real in-process server and skips the rest", async () => {
    const tmp = await makeTempRoot(REPO_ROOT);
    cleanups.push(() => tmp.cleanup());
    const boot = await bootstrap({
      env: { RUNTIME_PORT: "0", SESSION_ID: "smoke", MODEL_PROVIDER: "mock" }, root: tmp.root, logDir: tmp.dataDir, log: () => {}, warn: () => {}, tickMs: 60_000,
    });
    if (!boot.ok) throw new Error(boot.errors.join("; "));
    cleanups.push(() => boot.runtime.stop());
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--url", `ws://127.0.0.1:${boot.runtime.port}`, "--session", "smoke", "--fast", "--no-color"]));
    expect(report!.results.filter((r) => r.status === "failed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(report!.mode).toBe("url");
    const external = CHECKS.filter((x) => x.kind === "any").map((x) => x.id);
    expect(report!.results.filter((r) => r.status === "passed").map((r) => r.id)).toEqual(external);
    const skipped = report!.results.filter((r) => r.status === "skipped");
    expect(skipped.map((r) => r.id)).toEqual(CHECKS.filter((x) => x.kind !== "any").map((x) => x.id));
    expect(skipped.every((r) => r.details === "skipped (needs in-process server)")).toBe(true);
    const text = c.out.join("");
    expect(text).toContain("no authentication");
    expect(text).toContain("Structure is checked, not model content");
  });

  it("reports a server that is not there as a failure, not a hang, after telling the user exactly what it will send", async () => {
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--url", "ws://127.0.0.1:9", "--fast", "--no-color"], { watchdogMs: 10_000 }));
    expect(exitCode).toBe(1);
    expect(report!.results.find((r) => r.id === "F-01")?.status).toBe("failed");
    const text = c.out.join("");
    for (const phrase of [
      "TARGET server's real session and writes to its permanent event log", "throwaway server with a FRESH session", "ADVANCES THE SESSION TO ITS END (script_complete)",
      "cannot be resumed", "a facilitator join and the commands start, pause, resume, advance and whisper", "scripted player lines", "escape sequence and a forged newline",
      "speech while the session is paused", "role-claim attempts (a taken, an NPC and an unknown role)", "forged-token takeover attempts", "rejoin with the real token",
      "player-issued start and pause", "a facilitator say", "speech from a role that is absent from the scene", "speech and a resume command after the session ends", "speech before joining", "a whisper to the NPC role", "malformed frames", "an over-long line", "oversized (~70 kB) frame", "allow facilitator joins", "no authentication",
    ]) expect(text, phrase).toContain(phrase);
  });

  it("a bypassed check is a failure in --url mode too, while the intended mode skips stay allowed", async () => {
    const tmp = await makeTempRoot(REPO_ROOT);
    cleanups.push(() => tmp.cleanup());
    const boot = await bootstrap({ env: { RUNTIME_PORT: "0", SESSION_ID: "smoke", MODEL_PROVIDER: "mock" }, root: tmp.root, logDir: tmp.dataDir, log: () => {}, warn: () => {}, tickMs: 60_000 });
    if (!boot.ok) throw new Error(boot.errors.join("; "));
    cleanups.push(() => boot.runtime.stop());
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--url", `ws://127.0.0.1:${boot.runtime.port}`, "--session", "smoke", "--fast"], { bypass: ["F-17"] }));
    expect(exitCode).toBe(1);
    expect(report!.results.find((r) => r.id === "F-17")).toMatchObject({ status: "failed", details: expect.stringContaining("did not run") });
    expect(report!.results.filter((r) => r.status === "skipped").every((r) => r.details === "skipped (needs in-process server)")).toBe(true);
  });

  it("fails cleanly, with bounded memory, against a server that floods the client", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => wss.once("listening", r));
    wss.on("connection", (ws) => { for (let i = 0; i < 8_000; i++) ws.send(JSON.stringify({ type: "noise", pad: "x".repeat(200) })); });
    cleanups.push(() => new Promise<void>((r) => { for (const cl of wss.clients) cl.terminate(); wss.close(() => r()); }));
    const tcpBefore = tcpHandles();
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--url", `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, "--fast"], { watchdogMs: 20_000 }));
    expect(exitCode).toBe(1);
    expect(report!.results.find((r) => r.id === "F-01")).toMatchObject({ status: "failed" });
    expect(report!.results.find((r) => r.id === "F-01")!.details).toMatch(/flooded the client/);
    await vi.waitFor(() => expect(tcpHandles()).toBeLessThanOrEqual(tcpBefore + 1)); // only the test's own listening server remains
  });

  it("fails cleanly against a server that sends an oversized frame", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => wss.once("listening", r));
    wss.on("connection", (ws) => ws.send(Buffer.alloc(3 * 1024 * 1024, 0x61)));
    cleanups.push(() => new Promise<void>((r) => { for (const cl of wss.clients) cl.terminate(); wss.close(() => r()); }));
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--url", `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, "--fast"], { watchdogMs: 20_000 }));
    expect(exitCode).toBe(1);
    expect(report!.results.find((r) => r.id === "F-01")?.status).toBe("failed");
  });
});

describe("strict mock mode and interrupts", () => {
  it("a check that never ran is a failure in mock mode (exit 1), never a quiet skip", async () => {
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--fast", "--no-color"], { bypass: ["F-12"] }));
    expect(exitCode).toBe(1);
    expect(report!.results.find((r) => r.id === "F-12")).toMatchObject({ status: "failed", details: expect.stringContaining("did not run") });
    expect(report!.summary.skipped).toBe(0);
  });

  it("an interrupt aborts the run, runs the cleanups (temp dir, sockets) and exits 130 / 143", async () => {
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const dirsBefore = demoTempDirs(); const tcpBefore = tcpHandles();
      const signals = new EventEmitter();
      const c = capture();
      const { exitCode, report } = await runDemo(deps(c, ["--fast", "--no-color"], {
        signals: { on: (e, f) => signals.on(e, f), off: (e, f) => signals.off(e, f) },
        beforeAct: () => { setImmediate(() => signals.emit(sig)); return new Promise(() => {}); },
      }));
      expect(exitCode).toBe(code);
      expect(report!.results.find((r) => r.id === "INTERRUPTED")).toMatchObject({ status: "failed", details: `stopped by ${sig}` });
      expect(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM")).toBe(0); // handlers removed
      expect(tcpHandles()).toBe(tcpBefore);
      expect(demoTempDirs()).toEqual(dirsBefore);
    }
  });
});

describe("loadLiveEnv", () => {
  it("treats a missing .env as empty, merges a present one with the real environment winning (a temp dir, never the repo's .env)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acrx-env-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    expect(loadLiveEnv(dir, { A: "1" })).toEqual({ A: "1" });
    writeFileSync(path.join(dir, ".env"), "A=file\nB=file\n");
    expect(loadLiveEnv(dir, { A: "real" })).toEqual({ A: "real", B: "file" });
  });
  it("rethrows an unreadable .env (not ENOENT)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acrx-env-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, ".env")); // a directory: EISDIR
    expect(() => loadLiveEnv(dir, {})).toThrow();
  });
});

// Kept in this file on purpose: the default run's temp directories (acr-demo-*) are counted by the tests above, so no other test file may run the default story in parallel.
describe("--transcript with the default 29-check run", () => {
  const tags = (md: string) => {
    const body = md.slice(md.indexOf("## Legend") + 1);
    const n = (t: string) => (body.match(new RegExp(`(?<!\\\\)\\[${t}\\]`, "g")) ?? []).length - 1; // the legend names each tag once
    return { scripted: n("SCRIPTED"), generated: n("GENERATED"), fallback: n("FALLBACK"), system: n("SYSTEM") };
  };
  const bold = (md: string) => md.split("\n").filter((l) => l.startsWith("**"));
  it("the default 29-check run writes a transcript: scripted dialogue, FALLBACK only from the side room, no GENERATED, hostile text inert", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-transcript-test-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--fast", "--no-color", "--transcript", "out/default.md"], { cwd: dir }));
    expect(exitCode).toBe(0);
    expect(report!.summary.passed).toBe(29);
    const md = await readFile(path.join(dir, "out", "default.md"), "utf8");
    const t = tags(md);
    expect(t.generated).toBe(0);
    expect(t.fallback).toBe(2); // the side room's stalled and empty model replies
    expect(t.scripted).toBeGreaterThan(20);
    expect(t.system).toBeGreaterThan(20);
    expect(bold(md)).toHaveLength(t.scripted + t.fallback);
    expect(bold(md).every((l) => l.endsWith("**") && /^\*\*\[(SCRIPTED|FALLBACK)\] /.test(l))).toBe(true);
    expect(md).toMatch(/\*\*\[FALLBACK\] Priya Raman \(client_sponsor\): Sorry, you cut out for a second there\. Say that again\?\*\*/);
    expect(md).toContain("**[SCRIPTED] facilitator (whisper to delivery\\_lead): WHISPER-ONLY-FOR-DELIVERY-LEAD ask about timing**");
    expect(md).toMatch(/\*\*\[SCRIPTED\] Priya Raman \(client_sponsor\): Thanks for calling\./);
    // the hostile scripted line is inert
    expect(md).not.toMatch(/\u001b|\u0007|\u202e/);
    expect(md.split("\n").some((l) => /^\[delivery_lead\]/.test(l))).toBe(false);
    expect(md).toContain("## ACT 2 · Scene 1: Team huddle");
    expect(md).toContain("## Checks");
    expect(md).toContain("| F-29 | passed |");
    expect(md).toContain("| Mode | mock |");
    expect(c.out.join("")).toContain("transcript written to out/default.md");
    expect(c.out.join("")).not.toContain("**["); // the terminal narration is unchanged
  });

});
