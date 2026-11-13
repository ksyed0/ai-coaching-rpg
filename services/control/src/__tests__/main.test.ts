import http from "node:http";
import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadScenario } from "@acr/script";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../runtime/src/engine/clock.js";
import { JsonlEventLog } from "../../../runtime/src/engine/event-log.js";
import { SessionEngine } from "../../../runtime/src/engine/session-engine.js";
import { makeDraftDir } from "../../../runtime/src/review/__tests__/fixtures.js";
import { REPO_ROOT } from "../config.js";
import { BotHost } from "../bots/bot-host.js";
import { startControl, type RunningControl } from "../main.js";
import * as participantWrites from "../participant-writes.js";
import * as reportsModule from "../reports.js";
import { startAudioSweep } from "../voice/sweep.js";
import { SessionList } from "../session-list.js";
import type { EvalSpawnFn } from "../eval-child.js";
import type { SpawnFn } from "../supervisor.js";
import { FakeChild, READY, sid } from "./fake-child.js";

vi.mock("../reports.js", async (orig) => {
  const m = await orig<typeof import("../reports.js")>();
  return { ...m, createReportService: vi.fn(m.createReportService) };
});
vi.mock("../participant-writes.js", async (orig) => {
  const m = await orig<typeof import("../participant-writes.js")>();
  return { ...m, createParticipantWriteService: vi.fn(m.createParticipantWriteService), warnIfReportsNotWritable: vi.fn(m.warnIfReportsNotWritable) };
});

vi.mock("../voice/sweep.js", async (orig) => {
  const m = await orig<typeof import("../voice/sweep.js")>();
  return { ...m, startAudioSweep: vi.fn(m.startAudioSweep) };
});

const TOKEN = "k".repeat(40);
let root: string;
let env: NodeJS.ProcessEnv;
let running: RunningControl | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ctl-main-"));
  mkdirSync(path.join(root, "scenarios", "friday-escalation"), { recursive: true });
  env = { CONTROL_DATA_DIR: path.join(root, "data"), LAUNCHER_TOKEN: TOKEN, SCENARIOS_DIR: path.join(root, "scenarios"), CONTROL_GRACE_MS: "200" };
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** A fake runtime that says ready at once and exits when the service disconnects or kills it. */
const mortal = (c: FakeChild): FakeChild => {
  c.disconnect = () => { c.disconnected++; setImmediate(() => c.exit(0)); };
  c.onKill = () => setImmediate(() => c.exit(null));
  setImmediate(() => c.emit(READY));
  return c;
};

const get = (port: number, p: string, token: string | null = TOKEN): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${p}`, { headers: token === null ? {} : { "x-service-token": token } });

describe("startControl", () => {
  it("US-0073 (A2a Task 9b): the audio sweep runs at start with VOICE_ENABLED=0 and stops at close", async () => {
    const audioDir = path.join(root, "audio");
    const sidHex = "a".repeat(32);
    mkdirSync(path.join(audioDir, sidHex, "r"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(audioDir, sidHex, "ended.json"), JSON.stringify({ v: 1, endedAtMs: 1_000 }));
    writeFileSync(path.join(audioDir, sidHex, "r", "seg0.wav"), "RIFF");
    running = await startControl({ ...env, VOICE_ENABLED: "0", AUDIO_DIR: audioDir }, { port: 0, spawn: (() => { throw new Error("no spawn"); }) as unknown as SpawnFn });
    for (let i = 0; i < 100 && existsSync(path.join(audioDir, sidHex)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(path.join(audioDir, sidHex))).toBe(false);
    const sched = vi.mocked(startAudioSweep).mock.results.at(-1)!.value as { stop(): Promise<void> };
    const stop = vi.spyOn(sched, "stop");
    await running.close();
    expect(stop).toHaveBeenCalled(); // close() stops the schedule and waits (bounded) for a run in flight
  });

  it("US-0071: refuses to start with SPEECH_INGEST=livekit and no LiveKit key, and with a bad LiveKit setting (names only, no value)", async () => {
    await expect(startControl({ ...env, SPEECH_INGEST: "livekit" }, { port: 0 })).rejects.toThrow(/SPEECH_INGEST=livekit needs LIVEKIT_API_KEY/);
    const err = await startControl({ ...env, LIVEKIT_API_KEY: "APIkey", LIVEKIT_API_SECRET: "short-secret-value" }, { port: 0 }).catch((e: Error) => e);
    expect(String(err)).toContain("LIVEKIT_API_SECRET");
    expect(String(err)).not.toContain("short-secret-value");
  });

  it("US-0071 (batch 3 review F8): LiveKit keys with a file-ingest worker give no tokens (voice_unavailable), only SPEECH_INGEST=livekit does", async () => {
    const lk = { LIVEKIT_API_KEY: "APIkey", LIVEKIT_API_SECRET: "s".repeat(40) };
    const hosts: unknown[] = [];
    running = await startControl({ ...env, ...lk, SPEECH_INGEST: "file" }, { port: 0, onVoiceHost: (v) => hosts.push(v) });
    expect((hosts[0] as { o: { tokens?: unknown } }).o.tokens).toBeUndefined();
    await running.close();
    running = await startControl({ ...env, ...lk, SPEECH_INGEST: "livekit" }, { port: 0, onVoiceHost: (v) => hosts.push(v) });
    expect((hosts[1] as { o: { tokens?: unknown } }).o.tokens).toBeDefined();
  });

  it("US-0072 (A1c Task 11): the LiveKit probe is wired exactly with the tokens, and it asks LIVEKIT_HOST", async () => {
    const lk = { LIVEKIT_API_KEY: "APIkey", LIVEKIT_API_SECRET: "s".repeat(40) };
    const hosts: unknown[] = [];
    const probeOf = (i: number) => (hosts[i] as { o: { livekitReachable?: () => Promise<boolean> } }).o.livekitReachable;
    running = await startControl({ ...env, ...lk, SPEECH_INGEST: "file" }, { port: 0, onVoiceHost: (v) => hosts.push(v) });
    expect(probeOf(0)).toBeUndefined();
    await running.close();
    const seen: string[] = [];
    const stand = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.statusCode = 404; res.end(); });
    await new Promise<void>((r) => stand.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (stand.address() as { port: number }).port;
      running = await startControl({ ...env, ...lk, SPEECH_INGEST: "livekit", LIVEKIT_HOST: `http://127.0.0.1:${port}` }, { port: 0, onVoiceHost: (v) => hosts.push(v) });
      expect(await probeOf(1)!()).toBe(true);
      expect(seen).toEqual(["GET /"]);
    } finally { stand.closeAllConnections(); await new Promise<void>((r) => stand.close(() => r())); }
  });

  it("US-0072 (A1c Task 12): VOICE_TIMING_LOG is exactly 0 or 1 (default 0); VOICE_TIMING_LOG=yes stops the start naming the variable only", async () => {
    for (const bad of ["yes", "true", "2", " 1", "1 "]) {
      const err = await startControl({ ...env, VOICE_TIMING_LOG: bad }, { port: 0 }).catch((e: Error) => e);
      expect(String(err), bad).toContain("VOICE_TIMING_LOG must be 0 or 1");
      expect(String(err)).not.toContain(`"${bad}"`);
    }
    const hosts: unknown[] = [];
    const sinkOf = (i: number) => (hosts[i] as { o: { timingLog?: unknown } }).o.timingLog;
    for (const [value, on] of [[undefined, false], ["", false], ["0", false], ["1", true]] as const) {
      running = await startControl({ ...env, ...(value === undefined ? {} : { VOICE_TIMING_LOG: value }) }, { port: 0, onVoiceHost: (v) => hosts.push(v) });
      expect(sinkOf(hosts.length - 1) !== undefined, String(value)).toBe(on);
      await running.close();
      running = undefined;
    }
  });

  it("US-0071: starts with LiveKit configured and SPEECH_INGEST=livekit", async () => {
    running = await startControl({ ...env, SPEECH_INGEST: "livekit", LIVEKIT_API_KEY: "APIkey", LIVEKIT_API_SECRET: "s".repeat(40) }, { port: 0 });
    expect(running.port).toBeGreaterThan(0);
  });

  it("wires the report service: an exchange of an unknown token is the neutral 404, not the missing-route 404 of an unwired service", async () => {
    running = await startControl(env, { port: 0 });
    const exchange = (token: string) => fetch(`http://127.0.0.1:${running!.port}/report-access/exchange`, { method: "POST", headers: { "x-service-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const a = await exchange("nope");
    expect(a.status).toBe(404);
    const links = await get(running.port, `/sessions/${sid(1)}/report-links`);
    expect(links.status).toBe(404); // no such session; reached the report route's session check
    expect((await links.json()).error.message).toBe("That session does not exist.");
  });

  it("both report services receive the same ReportAccessStore instance", async () => {
    vi.mocked(reportsModule.createReportService).mockClear();
    vi.mocked(participantWrites.createParticipantWriteService).mockClear();
    running = await startControl(env, { port: 0 });
    const a = vi.mocked(reportsModule.createReportService).mock.calls[0]![0].store;
    const b = vi.mocked(participantWrites.createParticipantWriteService).mock.calls[0]![0].store;
    expect(a).toBe(b);
  });

  it("main calls warnIfReportsNotWritable at start-up", async () => {
    const warn = vi.mocked(participantWrites.warnIfReportsNotWritable);
    warn.mockClear();
    const logs: string[] = [];
    running = await startControl(env, { port: 0, log: (m) => logs.push(m) });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(path.join(env.CONTROL_DATA_DIR!, "reports"));
    expect(logs).not.toContain(participantWrites.NOT_WRITABLE_LOG); // a fresh deploy has no reports directory yet: quiet
  });

  it("warns when CONTROL_READY_TIMEOUT_MS + 2 * CONTROL_GRACE_MS exceeds what the web server waits, and stays quiet otherwise", async () => {
    const logs: string[] = [];
    running = await startControl({ ...env, CONTROL_READY_TIMEOUT_MS: "100000", CONTROL_GRACE_MS: "10000" }, { port: 0, log: (m) => logs.push(m) });
    expect(logs.filter((l) => l.startsWith("warning: CONTROL_READY_TIMEOUT_MS"))).toHaveLength(1);
    expect(logs.join("\n")).toContain("120000 ms");
    expect(logs.join("\n")).not.toContain(TOKEN);
    await running.close();
    logs.length = 0;
    running = await startControl({ ...env, CONTROL_READY_TIMEOUT_MS: "90000", CONTROL_GRACE_MS: "10000" }, { port: 0, log: (m) => logs.push(m) });
    expect(logs.filter((l) => l.includes("CONTROL_READY_TIMEOUT_MS"))).toEqual([]);
  });

  it("wires a BotHost whose close is awaited by close()", async () => {
    let finished = false;
    const close = vi.spyOn(BotHost.prototype, "close").mockImplementation(async () => { await new Promise((r) => setTimeout(r, 30)); finished = true; });
    try {
      running = await startControl(env, { port: 0 });
      const r = running;
      running = undefined;
      await r.close();
      expect(close).toHaveBeenCalledTimes(1);
      expect(finished).toBe(true);
    } finally { close.mockRestore(); }
  });

  it("listens on loopback, answers with the token only and close() stops it", async () => {
    const logs: string[] = [];
    running = await startControl(env, { port: 0, log: (m) => logs.push(m) });
    expect(running.port).toBeGreaterThan(0);
    expect((await get(running.port, "/scenarios", null)).status).toBe(401);
    const ok = await get(running.port, "/scenarios");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ success: true, data: [], error: null }); // the empty fixture folder is not a scenario
    expect(logs.join("\n")).toContain("scenario folder skipped: friday-escalation");
    expect(logs.join("\n")).not.toContain(TOKEN);
    const { port } = running;
    await running.close();
    await running.close(); // idempotent
    running = undefined;
    await expect(get(port, "/scenarios")).rejects.toThrow();
  });

  it("refuses a bad configuration with one plain message that names the variables but no values", async () => {
    const bad = { CONTROL_DATA_DIR: "relative/secret-looking", LAUNCHER_TOKEN: "short-token-value", CONTROL_PORT: "99999" };
    const err = await startControl(bad, { port: 0 }).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("CONTROL_DATA_DIR");
    expect(err!.message).toContain("LAUNCHER_TOKEN");
    expect(err!.message).toContain("CONTROL_PORT");
    expect(err!.message).not.toContain("secret-looking");
    expect(err!.message).not.toContain("short-token-value");
  });

  it("refuses a port that is already taken and stops the sessions it resumed", async () => {
    running = await startControl(env, { port: 0 });
    const taken = running.port;
    const children: FakeChild[] = [];
    const spawn: SpawnFn = ({ env: e, logFile }) => { const c = mortal(new FakeChild(e, logFile)); children.push(c); return c; };
    // a resumable session in a second data dir
    const other = { ...env, CONTROL_DATA_DIR: path.join(root, "data2") };
    mkdirSync(path.join(other.CONTROL_DATA_DIR!, "sessions"), { recursive: true });
    new SessionList(path.join(other.CONTROL_DATA_DIR!, "sessions.json")).upsert({ sessionId: sid(1), scenarioId: "friday-escalation", status: "running" });
    const err = await startControl(other, { port: taken, spawn }).then(() => null, (e: Error) => e);
    expect(err?.message).toBe(`cannot listen on 127.0.0.1:${taken} (EADDRINUSE)`);
    expect(children).toHaveLength(1);
    expect(children[0]!.disconnected).toBeGreaterThan(0); // shutdown() disconnects, it does not leave the child running
  });

  it("resumes existing sessions before it listens and disconnects their children on close", async () => {
    mkdirSync(path.join(env.CONTROL_DATA_DIR!, "sessions"), { recursive: true });
    new SessionList(path.join(env.CONTROL_DATA_DIR!, "sessions.json")).upsert({ sessionId: sid(2), scenarioId: "friday-escalation", status: "running" });
    const children: FakeChild[] = [];
    const spawn: SpawnFn = ({ env: e, logFile }) => {
      const c = mortal(new FakeChild(e, logFile));
      children.push(c);
      return c;
    };
    running = await startControl(env, { port: 0, spawn });
    expect(children).toHaveLength(1); // already running before the first request could be answered
    expect(children[0]!.env.SESSION_START).toBe("resume");
    const info = await (await get(running.port, `/sessions/${sid(2)}`)).json() as { data: { status: string; port: number } };
    expect(info.data.status).toBe("running");
    await running.close();
    running = undefined;
    expect(children[0]!.disconnected).toBeGreaterThan(0);
    // an orderly shutdown is not a crash: the list still says running and nothing is logged as unexpected
    const listed = new SessionList(path.join(env.CONTROL_DATA_DIR!, "sessions.json")).read();
    expect(listed.map((e) => e.status)).toEqual(["running"]);
  });

  it("passes the merged environment (including values read from .env) to the allowlist, not process.env", async () => {
    const spawned: NodeJS.ProcessEnv[] = [];
    mkdirSync(path.join(env.CONTROL_DATA_DIR!, "sessions"), { recursive: true });
    new SessionList(path.join(env.CONTROL_DATA_DIR!, "sessions.json")).upsert({ sessionId: sid(3), scenarioId: "friday-escalation", status: "running" });
    const spawn: SpawnFn = ({ env: e, logFile }) => { spawned.push(e); return mortal(new FakeChild(e, logFile)); };
    running = await startControl({ ...env, MODEL_PROVIDER: "mock", GM_MODEL: "from-dotenv" }, { port: 0, spawn });
    expect(spawned[0]!.MODEL_PROVIDER).toBe("mock");
    expect(spawned[0]!.GM_MODEL).toBe("from-dotenv");
    expect(spawned[0]!.LAUNCHER_TOKEN).toBeUndefined();
  });

  it("an evaluate by a typed name opens the review once, authored <name>-console with exactly one suffix", async () => {
    const draft = await makeDraftDir();
    try {
      const id = path.basename(draft.dir);
      const data = env.CONTROL_DATA_DIR!;
      mkdirSync(path.join(data, "sessions"), { recursive: true });
      const scenario = await loadScenario(path.join(REPO_ROOT, "scenarios", "friday-escalation"));
      const log = new JsonlEventLog(id, path.join(data, "sessions"), { sync: false });
      const engine = new SessionEngine({ scenario, log, clock: new FakeClock(1_000_000) });
      await engine.start(Object.fromEntries(Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => [r.id, `p_${r.id}`])), {});
      await engine.endNow({ actor: "facilitator" });
      await log.close?.();
      new SessionList(path.join(data, "sessions.json")).upsert({ sessionId: id, scenarioId: "friday-escalation", status: "ended" });
      const evalSpawn: EvalSpawnFn = ({ argv }) => {
        const out = argv[argv.indexOf("--out") + 1]!;
        const stdout = new PassThrough();
        const exits: ((c: number | null, s: string | null) => void)[] = [];
        queueMicrotask(() => {
          cpSync(draft.dir, path.join(out, id), { recursive: true });
          stdout.write(JSON.stringify({ ok: true, session: id, dir: path.join(out, id), files: ["index.md"], modelCalls: 7, participants: [], group: { status: "ok" }, failures: [] }));
          stdout.end();
          for (const f of exits) f(0, null);
        });
        return { stdout, stderr: new PassThrough(), kill: () => {}, onExit: (cb) => { exits.push(cb); } };
      };
      running = await startControl({ ...env, SCENARIOS_DIR: path.join(REPO_ROOT, "scenarios") }, { port: 0, evalSpawn });
      const r = await fetch(`http://127.0.0.1:${running.port}/sessions/${id}/report/evaluate`, {
        method: "POST", headers: { "x-service-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ confirmedCalls: 8, by: "priya" }),
      });
      expect(r.status).toBe(200);
      const review = path.join(data, "reports", id, "review.jsonl");
      await vi.waitFor(() => expect(readFileSync(review, "utf8")).toContain("review.opened"));
      const first = JSON.parse(readFileSync(review, "utf8").split("\n")[0]!) as { type: string; actor: { kind: string; by: string } };
      expect(first.type).toBe("review.opened");
      expect(first.actor).toEqual({ kind: "facilitator", by: "priya-console" });
      expect(readFileSync(review, "utf8")).not.toContain("priya-console-console");
    } finally { rmSync(draft.root, { recursive: true, force: true }); }
  });

  it("logs one fixed line when the review cannot be opened after an evaluate", async () => {
    const draft = await makeDraftDir();
    try {
      const id = path.basename(draft.dir);
      const data = env.CONTROL_DATA_DIR!;
      mkdirSync(path.join(data, "sessions"), { recursive: true });
      const scenario = await loadScenario(path.join(REPO_ROOT, "scenarios", "friday-escalation"));
      const log = new JsonlEventLog(id, path.join(data, "sessions"), { sync: false });
      const engine = new SessionEngine({ scenario, log, clock: new FakeClock(1_000_000) });
      await engine.start(Object.fromEntries(Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => [r.id, `p_${r.id}`])), {});
      await engine.endNow({ actor: "facilitator" });
      await log.close?.();
      new SessionList(path.join(data, "sessions.json")).upsert({ sessionId: id, scenarioId: "friday-escalation", status: "ended" });
      const evalSpawn: EvalSpawnFn = ({ argv }) => {
        const out = argv[argv.indexOf("--out") + 1]!;
        const stdout = new PassThrough();
        const exits: ((c: number | null, s: string | null) => void)[] = [];
        queueMicrotask(() => {
          cpSync(draft.dir, path.join(out, id), { recursive: true });
          rmSync(path.join(data, "sessions", `${id}.jsonl`)); // the session log is gone, so the review cannot be bound to it
          stdout.write(JSON.stringify({ ok: true, session: id, dir: path.join(out, id), files: ["index.md"], modelCalls: 7, participants: [], group: { status: "ok" }, failures: [] }));
          stdout.end();
          for (const f of exits) f(0, null);
        });
        return { stdout, stderr: new PassThrough(), kill: () => {}, onExit: (cb) => { exits.push(cb); } };
      };
      const logs: string[] = [];
      running = await startControl({ ...env, SCENARIOS_DIR: path.join(REPO_ROOT, "scenarios") }, { port: 0, evalSpawn, log: (m) => logs.push(m) });
      const r = await fetch(`http://127.0.0.1:${running.port}/sessions/${id}/report/evaluate`, {
        method: "POST", headers: { "x-service-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ confirmedCalls: 8, by: "priya" }),
      });
      expect(r.status).toBe(200);
      await vi.waitFor(() => expect(logs).toContain("report open after evaluate did not complete"));
      expect(logs.filter((l) => l.includes("report open after evaluate"))).toHaveLength(1);
    } finally { rmSync(draft.root, { recursive: true, force: true }); }
  });
});

describe("startControl accounts (US-0083)", () => {
  it("creates the default admin before listening, serves the account routes, and logs no password", async () => {
    const logs: string[] = [];
    running = await startControl({ ...env, ADMIN_BOOTSTRAP_PASSWORD: "Boot-Secret-12345" }, { log: (m) => logs.push(m), port: 0 });
    const file = readFileSync(path.join(root, "data", "accounts.json"), "utf8");
    expect(file).toContain('"login":"admin"');
    expect(file).not.toContain("Boot-Secret-12345");
    const res = await fetch(`http://127.0.0.1:${running.port}/accounts/login`, {
      method: "POST", headers: { "x-service-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ login: "admin", password: "Boot-Secret-12345" }),
    });
    expect(res.status).toBe(200);
    expect(logs.some((l) => l.includes("default admin must still change"))).toBe(true);
    expect(logs.join("\n")).not.toContain("Boot-Secret-12345");
  });
  it("refuses to start on an unusable accounts file and leaves it untouched", async () => {
    mkdirSync(path.join(root, "data"), { recursive: true });
    writeFileSync(path.join(root, "data", "accounts.json"), "{not json", { mode: 0o600 });
    await expect(startControl(env, { port: 0 })).rejects.toThrow(/accounts file/);
    expect(readFileSync(path.join(root, "data", "accounts.json"), "utf8")).toBe("{not json");
  });
  it("refuses to start on a corrupt session owners file and leaves it untouched", async () => {
    mkdirSync(path.join(root, "data"), { recursive: true });
    writeFileSync(path.join(root, "data", "session-owners.json"), "{not json", { mode: 0o600 });
    await expect(startControl(env, { port: 0 })).rejects.toThrow(/session owners file/);
    expect(readFileSync(path.join(root, "data", "session-owners.json"), "utf8")).toBe("{not json");
  });
  it("refuses to start on a group-writable session owners file and leaves it untouched", async () => {
    mkdirSync(path.join(root, "data"), { recursive: true });
    const f = path.join(root, "data", "session-owners.json");
    writeFileSync(f, '{"owners":{}}', { mode: 0o600 });
    chmodSync(f, 0o660);
    await expect(startControl(env, { port: 0 })).rejects.toThrow(/session owners file/);
    expect(readFileSync(f, "utf8")).toBe('{"owners":{}}');
  });
  it("starts when the session owners file is missing", async () => {
    running = await startControl(env, { port: 0 });
    expect(running.port).toBeGreaterThan(0);
  });
});
