import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlConfig } from "../../config.js";
import { TIMING_LOG_FILE, TIMING_LOG_MAX_BYTES, timingLogSink } from "../../voice/timing-log.js";
import { VoiceHost, type SpeechSpawnFn, type WorkerHandle } from "../../voice/voice-host.js";
import { AI_CONFIG } from "../fake-child.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 12): the timing record is a private file (0600 in the 0700 log folder, never through a link),
 * bounded in size, and holds milliseconds and the session id only. Private temp folders; no real time.
 */
let dir: string, logs: string[];
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "ctl-timing-")); logs = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const MODULE = fileURLToPath(new URL("../../voice/timing-log.ts", import.meta.url));

describe("timingLogSink (US-0072, A1c Task 12)", () => {
  it.skipIf(process.platform === "win32")("review C M1: a FIFO at the record's path is refused at once, never waited on (a child process with a 20 s bound)", () => {
    execFileSync("mkfifo", [path.join(dir, TIMING_LOG_FILE)]);
    const script = 'const [mod, dir] = process.argv.slice(1); const { timingLogSink } = await import(mod); const logs = []; timingLogSink(dir, { log: (m) => logs.push(m) })("x"); process.stdout.write(JSON.stringify(logs));';
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, pathToFileURL(MODULE).href, dir], { cwd: path.dirname(MODULE), timeout: 20_000, encoding: "utf8" });
    expect(r.error, "the child did not finish in time (the open blocked)").toBeUndefined();
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout) as string[]).toEqual([expect.stringMatching(/^voice timing line could not be written \([A-Z]+\)$/)]);
  });

  it("review C M6: a write failure and a full log are each reported once, separately", () => {
    const file = path.join(dir, TIMING_LOG_FILE);
    mkdirSync(file); // a folder where the record should be: the open fails
    const sink = timingLogSink(dir, { log: (m) => logs.push(m), maxBytes: 22 });
    sink("0123456789"); sink("0123456789");
    rmdirSync(file);
    for (let i = 0; i < 5; i++) sink("0123456789");
    expect(logs).toEqual([expect.stringMatching(/^voice timing line could not be written \(/), "voice timing log is full; no more timing lines are written"]);
  });

  it("appends one line per call to <log dir>/voice-timing.log, mode 0600, the folder 0700", () => {
    const logDir = path.join(dir, "child-logs");
    const sink = timingLogSink(logDir, { log: (m) => logs.push(m) });
    sink("a 1");
    sink("b 2");
    const file = path.join(logDir, TIMING_LOG_FILE);
    expect(readFileSync(file, "utf8")).toBe("a 1\nb 2\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(logDir).mode & 0o777).toBe(0o700);
    expect(TIMING_LOG_FILE).toBe("voice-timing.log");
  });

  it("an existing wider file is set to 0600 before it is written", () => {
    const file = path.join(dir, TIMING_LOG_FILE);
    writeFileSync(file, "", { mode: 0o644 });
    timingLogSink(dir, { log: (m) => logs.push(m) })("x");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("never writes through a symlink, and says so once by a fixed sentence (no path)", () => {
    const target = path.join(dir, "elsewhere");
    writeFileSync(target, "");
    symlinkSync(target, path.join(dir, TIMING_LOG_FILE));
    const sink = timingLogSink(dir, { log: (m) => logs.push(m) });
    sink("x"); sink("y");
    expect(readFileSync(target, "utf8")).toBe("");
    expect(lstatSync(path.join(dir, TIMING_LOG_FILE)).isSymbolicLink()).toBe(true);
    expect(logs).toEqual(["voice timing line could not be written (ELOOP)"]);
  });

  it("stops at TIMING_LOG_MAX_BYTES: no line is written past it, one fixed sentence says the log is full", () => {
    expect(TIMING_LOG_MAX_BYTES).toBe(1024 * 1024);
    const sink = timingLogSink(dir, { log: (m) => logs.push(m), maxBytes: 22 }); // two lines of 11 bytes fit exactly
    for (let i = 0; i < 10; i++) sink("0123456789");
    expect(readFileSync(path.join(dir, TIMING_LOG_FILE), "utf8")).toBe("0123456789\n0123456789\n");
    expect(logs).toEqual(["voice timing log is full; no more timing lines are written"]);
  });

  it("a folder that is not a folder: one fixed sentence by error code, never thrown", () => {
    const notDir = path.join(dir, "file");
    writeFileSync(notDir, "");
    const sink = timingLogSink(path.join(notDir, "sub"), { log: (m) => logs.push(m) });
    expect(() => { sink("x"); sink("y"); }).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^voice timing line could not be written \([A-Z]+\)$/);
  });

  it("a produced log holds no transcript text, role, participant id, segment id, token or path (marker scan)", async () => {
    const MARK = { text: "MARKERTEXT the secret plan", role: "markerrole", participant: "markerparticipant", segment: "feedfacefeedface" };
    const logDir = path.join(dir, "child-logs");
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    type W = WorkerHandle & { emit(m: unknown): void };
    let w: W | undefined;
    const spawn: SpeechSpawnFn = () => {
      const msg: ((raw: unknown) => void)[] = [];
      w = { send: () => true, onMessage: (fn) => { msg.push(fn); }, onExit: () => {}, kill: () => {}, forceKill: () => {}, disconnect: () => {}, emit: (m) => { for (const f of msg) f(m); } };
      return w;
    };
    let t = 50_000;
    const ID = "c".repeat(32);
    const v = new VoiceHost({
      spawn, config: { graceMs: 1, logDir, ...AI_CONFIG } as ControlConfig, parentEnv: { PATH: "/bin", STT_PROVIDER: "fake", LIVEKIT_API_SECRET: "markersecret" },
      log: (m) => logs.push(m), setTimer: () => () => {}, toRuntime: () => true, now: () => t, timingLog: timingLogSink(logDir, { log: (m) => logs.push(m) }),
    });
    v.attach(ID, { voice: true, roles: [MARK.role] });
    w!.emit({ type: "worker_ready", stt: "ok" });
    for (let i = 0; i < 3; i++) {
      const segmentId = `${MARK.segment.slice(0, 15)}${i}`;
      w!.emit({ type: "voice_line", segmentId, roleId: MARK.role, participantId: MARK.participant, text: MARK.text, startMs: 40_000, endMs: 49_000 });
      t += 100;
      v.fromRuntime(ID, { type: "voice_line_ack", segmentId, seq: 1 + i });
    }
    const text = readFileSync(path.join(logDir, TIMING_LOG_FILE), "utf8");
    expect(text.trim().split("\n")).toEqual([100, 200, 300].map((d) => `session ${ID} voice line timing end_to_append_ms=${1000 + d} start_to_append_ms=${10_000 + d}`));
    for (const bad of ["MARKER", "secret", MARK.role, MARK.participant, MARK.segment.slice(0, 15), "markersecret", dir, "/"]) expect(text, bad).not.toContain(bad);
  });
});
