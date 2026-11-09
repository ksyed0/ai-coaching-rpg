import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ControlToWorker } from "@acr/speech/protocol";
import type { ControlConfig } from "../../config.js";
import type { ParentMessage } from "../../protocol.js";
import { VOICE_LINE_TIMEOUT_MS, VoiceHost, type SpeechSpawnFn, type WorkerHandle } from "../../voice/voice-host.js";
import { AI_CONFIG } from "../fake-child.js";

class FakeWorker implements WorkerHandle {
  sent: ControlToWorker[] = [];
  killed = 0; forced = 0; disconnected = 0;
  readonly pid = 4242;
  private msg: ((raw: unknown) => void)[] = [];
  private exitFns: ((c: number | null) => void)[] = [];
  constructor(readonly env: NodeJS.ProcessEnv, readonly logFile: string) {}
  send(m: ControlToWorker): boolean { this.sent.push(m); return true; }
  onMessage(fn: (raw: unknown) => void): void { this.msg.push(fn); }
  onExit(fn: (c: number | null) => void): void { this.exitFns.push(fn); }
  kill(): void { this.killed++; }
  forceKill(): void { this.forced++; }
  disconnect(): void { this.disconnected++; }
  emit(m: unknown): void { for (const f of this.msg) f(m); }
  exit(code: number | null = 1): void { for (const f of this.exitFns) f(code); }
}

type T = { fn: () => void; ms: number; cancelled: boolean };
const ID = "a".repeat(32);
const SEG = "0123456789abcdef";
const TEXT = "We can ship in May, the secret plan";
const holders = [{ roleId: "tech_lead", participantId: "p-secret-1", recording: true }];
const seats = (o: { paused?: boolean; ended?: boolean; holders?: typeof holders } = {}) =>
  ({ type: "voice_seats" as const, paused: o.paused ?? false, ended: o.ended ?? false, holders: o.holders ?? holders });

let timers: T[], workers: FakeWorker[], toRuntime: { id: string; m: ParentMessage }[], logs: string[], turns: [string, boolean][], runtimeUp: boolean;
const config = { graceMs: 700, logDir: "/data/child-logs" } as ControlConfig;
const spawn: SpeechSpawnFn = ({ env, logFile }) => { const w = new FakeWorker(env, logFile); workers.push(w); return w; };
const make = () => new VoiceHost({
  spawn, config: { ...config, ...AI_CONFIG }, parentEnv: { PATH: "/bin", STT_PROVIDER: "fake", LIVEKIT_API_SECRET: "nope" }, log: (m) => logs.push(m),
  setTimer: (fn, ms) => { const t: T = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
  toRuntime: (id, m) => { if (!runtimeUp) return false; toRuntime.push({ id, m }); return true; },
  bots: { voiceTurn: (id, open) => { turns.push([id, open]); } },
});
const fire = (ms: number) => { for (const t of timers.filter((x) => x.ms === ms && !x.cancelled)) { t.cancelled = true; t.fn(); } };
const ready = (w: FakeWorker, stt: "ok" | "unavailable" = "ok") => w.emit({ type: "worker_ready", stt });
const line = (segmentId = SEG) => ({ type: "voice_line", segmentId, roleId: "tech_lead", participantId: "p-secret-1", text: TEXT, startMs: 10, endMs: 20 });
const live = (v: VoiceHost) => { v.attach(ID, { voice: true, roles: ["tech_lead", "pm"] }); const w = workers.at(-1)!; ready(w); return w; };

beforeEach(() => { timers = []; workers = []; toRuntime = []; logs = []; turns = []; runtimeUp = true; });

describe("VoiceHost (US-0070): one speech worker per voice session", () => {
  it("no worker without ready.voice", () => {
    const v = make();
    v.attach(ID, { roles: ["tech_lead"] });
    expect(workers).toEqual([]);
    expect(v.workerPid(ID)).toBeUndefined();
  });

  it("one worker per session, forked with the speech allowlist, the player roles and its own log file", () => {
    const v = make();
    v.attach(ID, { voice: true, roles: ["tech_lead", "pm"] });
    v.attach(ID, { voice: true, roles: ["tech_lead", "pm"] });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.env).toEqual({ PATH: "/bin", STT_PROVIDER: "fake", SPEECH_INGEST_ROLES: "tech_lead,pm" });
    expect(workers[0]!.logFile).toBe(path.join("/data/child-logs", `${ID}.speech.log`));
    expect(v.workerPid(ID)).toBe(4242);
    expect(logs).toEqual([`session ${ID} speech worker started`]);
  });

  it("voice_seats becomes voice_state, held until the worker is ready", () => {
    const v = make();
    v.fromRuntime(ID, seats({ paused: true })); // arrives before the attach (the supervisor hands over the one held at ready)
    v.attach(ID, { voice: true, roles: ["tech_lead"] });
    const w = workers[0]!;
    v.fromRuntime(ID, seats());
    expect(w.sent).toEqual([]); // the worker may not listen yet
    ready(w);
    expect(w.sent).toEqual([{ type: "voice_state", paused: false, ended: false, holders }]); // only the latest
    v.fromRuntime(ID, seats({ holders: [] }));
    expect(w.sent.at(-1)).toEqual({ type: "voice_state", paused: false, ended: false, holders: [] });
  });

  it("voice_line is relayed and the ack returns as voice_line_result with the seq", () => {
    const v = make();
    const w = live(v);
    w.emit(line());
    expect(toRuntime).toEqual([{ id: ID, m: { type: "voice_line", segmentId: SEG, roleId: "tech_lead", participantId: "p-secret-1", text: TEXT } }]);
    v.fromRuntime(ID, { type: "voice_line_ack", segmentId: SEG, seq: 42 });
    expect(w.sent).toEqual([{ type: "voice_line_result", segmentId: SEG, seq: 42 }]);
    expect(timers.filter((t) => t.ms === VOICE_LINE_TIMEOUT_MS && !t.cancelled)).toEqual([]);
    v.fromRuntime(ID, { type: "voice_line_ack", segmentId: SEG, seq: 43 }); // a second answer has no pending entry: dropped
    expect(w.sent).toHaveLength(1);
  });

  it("a refused line returns refused with the code", () => {
    const v = make();
    const w = live(v);
    w.emit(line());
    v.fromRuntime(ID, { type: "voice_line_refused", segmentId: SEG, code: "not_holder" });
    expect(w.sent).toEqual([{ type: "voice_line_result", segmentId: SEG, refused: "not_holder" }]);
  });

  it(`a line with no answer in ${VOICE_LINE_TIMEOUT_MS / 1000} s returns refused failed, and a late answer is dropped`, () => {
    expect(VOICE_LINE_TIMEOUT_MS).toBe(10_000);
    const v = make();
    const w = live(v);
    w.emit(line());
    fire(VOICE_LINE_TIMEOUT_MS);
    expect(w.sent).toEqual([{ type: "voice_line_result", segmentId: SEG, refused: "failed" }]);
    v.fromRuntime(ID, { type: "voice_line_ack", segmentId: SEG, seq: 9 });
    expect(w.sent).toHaveLength(1);
  });

  it("a line the runtime cannot take (not running, a duplicate segment id) is refused failed at once", () => {
    const v = make();
    const w = live(v);
    w.emit(line());
    w.emit(line()); // the same id while the first is pending
    expect(w.sent).toEqual([{ type: "voice_line_result", segmentId: SEG, refused: "failed" }]);
    runtimeUp = false;
    w.emit(line("fedcba9876543210"));
    expect(w.sent.at(-1)).toEqual({ type: "voice_line_result", segmentId: "fedcba9876543210", refused: "failed" });
  });

  it("speech_activity is relayed as is", () => {
    const v = make();
    const w = live(v);
    w.emit({ type: "speech_activity", roleId: "tech_lead", active: true });
    w.emit({ type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 600 });
    expect(toRuntime.map((x) => x.m)).toEqual([{ type: "speech_activity", roleId: "tech_lead", active: true }, { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 600 }]);
  });

  it("segment_failed stt_failed becomes the speaker's voice_notice and a facilitator alert; empty gives neither (owner decision 2026-11-08)", () => {
    const v = make();
    const w = live(v);
    w.emit({ type: "segment_failed", segmentId: SEG, roleId: "tech_lead", participantId: "p-secret-1", status: "stt_failed" });
    expect(toRuntime.map((x) => x.m)).toEqual([
      { type: "voice_notice", roleId: "tech_lead", participantId: "p-secret-1", code: "stt_failed" }, { type: "voice_alert", code: "stt_failed" },
    ]);
    w.emit({ type: "segment_failed", segmentId: SEG, roleId: "tech_lead", participantId: "p-secret-1", status: "empty" });
    expect(toRuntime).toHaveLength(2);
  });

  it("worker_ready with stt unavailable alerts the facilitator", () => {
    const v = make();
    v.attach(ID, { voice: true, roles: ["tech_lead"] });
    ready(workers[0]!, "unavailable");
    expect(toRuntime.map((x) => x.m)).toEqual([{ type: "voice_alert", code: "stt_unavailable" }]);
  });

  it("voice_turn reaches the bots; voice_choice is dropped in A1a", () => {
    const v = make();
    live(v);
    expect(v.voiceTurnOpen(ID)).toBe(false);
    v.fromRuntime(ID, { type: "voice_turn", open: true });
    expect(v.voiceTurnOpen(ID)).toBe(true); // the last relayed state (the demo's V-07 waits on it)
    v.fromRuntime(ID, { type: "voice_turn", open: false });
    expect(v.voiceTurnOpen(ID)).toBe(false);
    v.fromRuntime(ID, { type: "voice_choice", roleId: "tech_lead", participantId: "p-secret-1", choice: "voice", at: 5 });
    expect(turns).toEqual([[ID, true], [ID, false]]);
    expect(v.voiceTurnOpen("b".repeat(32))).toBe(false);
    expect(toRuntime).toEqual([]);
  });

  it("a worker exit while the session runs: one worker_down alert, pending lines forgotten, no restart", () => {
    const v = make();
    const w = live(v);
    w.emit(line());
    w.exit(1);
    expect(toRuntime.map((x) => x.m).filter((m) => m.type === "voice_alert")).toEqual([{ type: "voice_alert", code: "worker_down" }]);
    expect(timers.filter((t) => t.ms === VOICE_LINE_TIMEOUT_MS && !t.cancelled)).toEqual([]);
    expect(v.workerPid(ID)).toBeUndefined();
    v.fromRuntime(ID, seats());
    v.attach(ID, { voice: true, roles: ["tech_lead"] }); // even a later ready does not bring it back in A1a
    expect(workers).toHaveLength(1);
    expect(logs).toContain(`session ${ID} speech worker stopped unexpectedly`);
  });

  it("a runtime restart keeps the worker and pushes the new state (nothing records in between)", () => {
    const v = make();
    const w = live(v);
    v.fromRuntime(ID, seats());
    w.emit(line());
    v.detach(ID);
    // The old runtime's seats are gone: the worker stops recording at once, and the line in flight is answered failed.
    expect(w.sent.slice(1)).toEqual([{ type: "voice_line_result", segmentId: SEG, refused: "failed" }, { type: "voice_state", paused: false, ended: false, holders: [] }]);
    w.emit(line("fedcba9876543210"));
    expect(w.sent.at(-1)).toEqual({ type: "voice_line_result", segmentId: "fedcba9876543210", refused: "failed" });
    v.attach(ID, { voice: true, roles: ["tech_lead"] });
    expect(workers).toHaveLength(1);
    v.fromRuntime(ID, seats({ paused: true }));
    expect(w.sent.at(-1)).toEqual({ type: "voice_state", paused: true, ended: false, holders });
  });

  it("end sends ended then stops the worker (kill after graceMs, forceKill after another), and its exit is no alert", () => {
    const v = make();
    const w = live(v);
    v.fromRuntime(ID, seats());
    v.end(ID);
    expect(w.sent.at(-1)).toEqual({ type: "voice_state", paused: false, ended: true, holders });
    expect(w.killed).toBe(0);
    fire(700);
    expect(w.killed).toBe(1);
    fire(700);
    expect(w.forced).toBe(1);
    w.exit(null);
    expect(toRuntime.filter((x) => x.m.type === "voice_alert")).toEqual([]);
    v.end(ID); // idempotent
    expect(w.killed).toBe(1);
  });

  it("an invalid worker message is dropped", () => {
    const v = make();
    const w = live(v);
    for (const bad of [null, "x", { type: "voice_line" }, { ...line(), extra: 1 }, { ...line(), segmentId: "../x" }, { ...line(), roleId: "facilitator" }, { type: "worker_ready", stt: "maybe" }]) w.emit(bad);
    expect(toRuntime).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it("nothing logged contains the transcript text or a participant id", () => {
    const v = make();
    const w = live(v);
    v.fromRuntime(ID, seats());
    w.emit(line());
    fire(VOICE_LINE_TIMEOUT_MS);
    w.emit({ type: "segment_failed", segmentId: SEG, roleId: "tech_lead", participantId: "p-secret-1", status: "stt_failed" });
    w.exit(1);
    const all = logs.join("\n");
    expect(all).not.toContain("secret");
    expect(all).not.toContain("May");
    expect(all).not.toContain(SEG);
  });

  it("a spawn that throws is logged by name and leaves no worker", () => {
    const v = new VoiceHost({
      spawn: () => { throw new TypeError("bad /path/x"); }, config: { ...config, ...AI_CONFIG }, parentEnv: {}, log: (m) => logs.push(m),
      setTimer: () => () => {}, toRuntime: (id, m) => { toRuntime.push({ id, m }); return true; },
    });
    v.attach(ID, { voice: true, roles: [] });
    expect(logs).toEqual([`session ${ID} speech worker could not start (TypeError)`]);
    expect(toRuntime.map((x) => x.m)).toEqual([{ type: "voice_alert", code: "worker_down" }]);
  });

  it("shutdown disconnects every worker and force-kills one that stays", async () => {
    const v = make();
    const w = live(v);
    const done = v.shutdown();
    expect(w.disconnected).toBe(1);
    fire(700);
    await done;
    expect(w.forced).toBe(1);
    w.exit(0);
    expect(toRuntime.filter((x) => x.m.type === "voice_alert")).toEqual([]);
  });
});
