import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ControlToWorkerSchema, type ControlToWorker } from "@acr/speech/protocol";
import type { ControlConfig } from "../../config.js";
import type { ParentMessage } from "../../protocol.js";
import { createHash } from "node:crypto";
import { parseParticipantIdentity, type RoomAdmin } from "@acr/adapters/livekit";
import { VoiceTokenRefused, VoiceTokens } from "../../voice/tokens.js";
import { VOICE_LINE_TIMEOUT_MS, VoiceHost, type SpeechSpawnFn, type WorkerHandle } from "../../voice/voice-host.js";
import { AI_CONFIG } from "../fake-child.js";
import type { AuditEvent } from "../../voice/audit-log.js";

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
const holders = [{ roleId: "tech_lead", participantId: "p-secret-1", recording: true, voiceChosen: true }];
const seats = (o: { paused?: boolean; ended?: boolean; holders?: typeof holders; open?: string[] } = {}) =>
  ({ type: "voice_seats" as const, paused: o.paused ?? false, ended: o.ended ?? false, holders: o.holders ?? holders, open: o.open ?? [] });

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
/** What reached the runtime besides voice_availability (Task 9 sends it on every attach and change; its own tests are below). */
const relayed = () => toRuntime.filter((x) => x.m.type !== "voice_availability");
const live = (v: VoiceHost) => { v.attach(ID, { voice: true, roles: ["tech_lead", "pm"] }); const w = workers.at(-1)!; ready(w); return w; };

beforeEach(() => { timers = []; workers = []; toRuntime = []; logs = []; turns = []; runtimeUp = true; });

describe("VoiceHost and the US-0071 worker messages (A1b Task 2, characterisation; Task 5 for LiveKit)", () => {
  it("without LiveKit, livekit_token_request is ignored, and a health result equal to the current one changes nothing; livekit_status is a fixed log line", () => {
    const v = make();
    const w = live(v);
    const sentBefore = w.sent.length; const logsBefore = logs.length;
    for (const m of [
      { type: "livekit_token_request", roleId: "tech_lead" }, { type: "livekit_status", state: "connected" }, { type: "stt_health", ok: true },
    ]) w.emit(m);
    expect(w.sent.slice(sentBefore)).toEqual([]);
    expect(relayed()).toEqual([]);
    expect(logs.slice(logsBefore)).toEqual([`session ${ID} speech room connected`]);
    expect(v.workerPid(ID)).toBe(4242);
  });
});

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
    expect(relayed()).toEqual([{ id: ID, m: { type: "voice_line", segmentId: SEG, roleId: "tech_lead", participantId: "p-secret-1", text: TEXT } }]);
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
    expect(relayed().map((x) => x.m)).toEqual([{ type: "speech_activity", roleId: "tech_lead", active: true }, { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 600 }]);
  });

  it("segment_failed stt_failed becomes the speaker's voice_notice and a facilitator alert; empty gives neither (owner decision 2026-11-08)", () => {
    const v = make();
    const w = live(v);
    w.emit({ type: "segment_failed", segmentId: SEG, roleId: "tech_lead", participantId: "p-secret-1", status: "stt_failed" });
    expect(relayed().map((x) => x.m)).toEqual([
      { type: "voice_notice", roleId: "tech_lead", participantId: "p-secret-1", code: "stt_failed" }, { type: "voice_alert", code: "stt_failed" },
    ]);
    w.emit({ type: "segment_failed", segmentId: SEG, roleId: "tech_lead", participantId: "p-secret-1", status: "empty" });
    expect(relayed()).toHaveLength(2);
  });

  it("worker_ready with stt unavailable alerts the facilitator", () => {
    const v = make();
    v.attach(ID, { voice: true, roles: ["tech_lead"] });
    ready(workers[0]!, "unavailable");
    expect(relayed().map((x) => x.m)).toEqual([{ type: "voice_alert", code: "stt_unavailable" }]);
  });

  it("voice_turn reaches the bots; voice_choice is relayed nowhere (A2a only audits it, Task 8)", () => {
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
    expect(relayed()).toEqual([]);
  });

  it("a worker exit while the session runs: one worker_restarting alert, pending lines forgotten, a restart scheduled (A1b Task 8)", () => {
    const v = make();
    const w = live(v);
    w.emit(line());
    w.exit(1);
    expect(toRuntime.map((x) => x.m).filter((m) => m.type === "voice_alert")).toEqual([{ type: "voice_alert", code: "worker_restarting" }]);
    expect(timers.filter((t) => t.ms === VOICE_LINE_TIMEOUT_MS && !t.cancelled)).toEqual([]);
    expect(v.workerPid(ID)).toBeUndefined();
    expect(workers).toHaveLength(1); // the restart waits for its backoff (restart.test.ts)
    expect(timers.filter((t) => t.ms === 500 && !t.cancelled)).toHaveLength(1);
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

  // F9b (review fix wave): a session's entry is removed once it has ended and its worker has stopped; late runtime messages do not
  // bring it back.
  it("an ended session's entry is removed after its worker stops, and late runtime messages do not recreate it", () => {
    const v = make();
    const size = () => (v as unknown as { sessions: Map<string, unknown> }).sessions.size;
    const w = live(v);
    v.fromRuntime(ID, seats());
    v.end(ID);
    expect(size()).toBe(1); // still stopping: late messages are absorbed by the ended entry
    fire(700);
    w.exit(null);
    expect(size()).toBe(0);
    v.fromRuntime(ID, seats({ ended: true }));
    v.fromRuntime(ID, { type: "voice_line_ack", segmentId: SEG, seq: 3 });
    v.fromRuntime(ID, { type: "voice_turn", open: false });
    v.detach(ID);
    expect(size()).toBe(0);
  });

  it("an ended session that never had a worker leaves no entry; end for an unknown session creates none", () => {
    const v = make();
    const size = () => (v as unknown as { sessions: Map<string, unknown> }).sessions.size;
    v.attach(ID, { roles: ["tech_lead"] }); // no voice: no worker
    expect(size()).toBe(1);
    v.end(ID);
    expect(size()).toBe(0);
    v.end("b".repeat(32));
    expect(size()).toBe(0);
  });

  it("an invalid worker message is dropped", () => {
    const v = make();
    const w = live(v);
    for (const bad of [null, "x", { type: "voice_line" }, { ...line(), extra: 1 }, { ...line(), segmentId: "../x" }, { ...line(), roleId: "facilitator" }, { type: "worker_ready", stt: "maybe" }]) w.emit(bad);
    expect(relayed()).toEqual([]);
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
    expect(toRuntime.map((x) => x.m).filter((m) => m.type === "voice_alert")).toEqual([{ type: "voice_alert", code: "worker_restarting" }]);
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

describe("VoiceHost and voice availability (US-0071, A1b Task 9)", () => {
  const avail = () => toRuntime.map((x) => x.m).filter((m) => m.type === "voice_availability");
  const alertCodes = () => toRuntime.map((x) => x.m).filter((m) => m.type === "voice_alert").map((m) => (m as { code: string }).code);
  const A = (available: boolean, off = false) => ({ type: "voice_availability", available, off });

  it("an attach tells the runtime at once (not available until the worker is ready), and worker_ready ok makes voice available", () => {
    const v = make();
    v.attach(ID, { voice: true, roles: ["tech_lead"] });
    expect(avail()).toEqual([A(false)]);
    ready(workers[0]!);
    expect(avail()).toEqual([A(false), A(true)]);
    expect(alertCodes()).toEqual([]);
  });

  it("stt_health false gives one stt_unavailable alert and voice_availability available false; a repeat changes nothing", () => {
    const v = make();
    const w = live(v);
    w.emit({ type: "stt_health", ok: false });
    w.emit({ type: "stt_health", ok: false });
    expect(avail().at(-1)).toEqual(A(false));
    expect(avail()).toHaveLength(3); // attach, ready, the change
    expect(alertCodes()).toEqual(["stt_unavailable"]);
  });

  it("false, true gives stt_recovered and available true", () => {
    const v = make();
    const w = live(v);
    w.emit({ type: "stt_health", ok: false });
    w.emit({ type: "stt_health", ok: true });
    expect(avail().slice(-2)).toEqual([A(false), A(true)]);
    expect(alertCodes()).toEqual(["stt_unavailable", "stt_recovered"]);
  });

  it("worker_ready unavailable is unhealthy: one stt_unavailable alert, voice stays unavailable until a healthy result", () => {
    const v = make();
    v.attach(ID, { voice: true, roles: ["tech_lead"] });
    ready(workers[0]!, "unavailable");
    expect(avail()).toEqual([A(false)]);
    expect(alertCodes()).toEqual(["stt_unavailable"]);
    workers[0]!.emit({ type: "stt_health", ok: true });
    expect(avail()).toEqual([A(false), A(true)]);
    expect(alertCodes()).toEqual(["stt_unavailable", "stt_recovered"]);
  });

  it("a restarted worker whose warm-up succeeds makes voice available again (no stt_health needed)", () => {
    const v = make();
    const w = live(v);
    w.emit({ type: "stt_health", ok: false });
    w.exit(1);
    const restart = timers.find((t) => t.ms === 500 && !t.cancelled)!;
    restart.cancelled = true; restart.fn();
    ready(workers[1]!, "ok");
    expect(avail().at(-1)).toEqual(A(true));
    expect(alertCodes()).toEqual(["stt_unavailable", "worker_restarting", "stt_recovered"]);
  });

  it("a worker exit sends available false; the next worker_ready ok sends true", () => {
    const v = make();
    const w = live(v);
    w.exit(3);
    expect(avail().at(-1)).toEqual(A(false));
    const restart = timers.find((t) => t.ms === 500 && !t.cancelled)!;
    restart.cancelled = true; restart.fn();
    ready(workers[1]!);
    expect(avail().slice(-2)).toEqual([A(false), A(true)]);
  });

  it("voice off sends off true, and every later runtime ready is told off true", () => {
    const v = make();
    live(v);
    for (let i = 0; i < 6; i++) {
      workers.at(-1)!.exit(1);
      const restart = timers.find((t) => [500, 1000, 2000, 4000, 8000].includes(t.ms) && !t.cancelled);
      if (restart) { restart.cancelled = true; restart.fn(); }
    }
    expect(avail().at(-1)).toEqual(A(false, true));
    v.detach(ID);
    v.attach(ID, { voice: true, roles: ["tech_lead"] });
    expect(avail().at(-1)).toEqual(A(false, true));
  });

  it("every runtime ready receives the current voice_availability (unavailable, runtime restart, new ready: the new runtime is told)", () => {
    const v = make();
    const w = live(v);
    w.emit({ type: "stt_health", ok: false });
    const n = avail().length;
    v.detach(ID);
    v.attach(ID, { voice: true, roles: ["tech_lead"] });
    expect(avail().slice(n)).toEqual([A(false)]);
    w.emit({ type: "stt_health", ok: true });
    v.detach(ID);
    v.attach(ID, { voice: true, roles: ["tech_lead"] });
    expect(avail().slice(-1)).toEqual([A(true)]); // available again: a restarted runtime is told so too (it starts with nothing known)
  });

  it("an availability change while the runtime is down is told at the next ready", () => {
    const v = make();
    const w = live(v);
    v.detach(ID);
    runtimeUp = false;
    w.emit({ type: "stt_health", ok: false });
    runtimeUp = true;
    v.attach(ID, { voice: true, roles: ["tech_lead"] });
    expect(avail().at(-1)).toEqual(A(false));
  });

  it("no availability is sent for a runtime without voice, or after the end", () => {
    const v = make();
    v.attach(ID, { roles: ["tech_lead"] });
    expect(avail()).toEqual([]);
    const ID2 = "b".repeat(32);
    v.attach(ID2, { voice: true, roles: ["tech_lead"] });
    const w = workers.at(-1)!;
    ready(w);
    const n = avail().length;
    v.end(ID2);
    w.emit({ type: "stt_health", ok: false });
    expect(avail()).toHaveLength(n);
  });

  // R13 (A1a carry-over), decision: document, no fix. Both characterisation (expected PASS before any Task 9 code).
  it("R13: a line sent between a runtime exit and the next ready is refused failed and gives no notice", () => {
    const v = make();
    const w = live(v);
    v.fromRuntime(ID, seats());
    v.detach(ID);
    const before = toRuntime.length;
    w.emit(line());
    expect(w.sent.at(-1)).toEqual({ type: "voice_line_result", segmentId: SEG, refused: "failed" });
    w.emit({ type: "segment_failed", segmentId: SEG, roleId: "tech_lead", participantId: "p-secret-1", status: "stt_failed" });
    v.attach(ID, { voice: true, roles: ["tech_lead"] });
    expect(toRuntime.slice(before).map((x) => x.m).filter((m) => m.type === "voice_line" || m.type === "voice_notice")).toEqual([]);
  });

  it("R13: the runtime exit sends the worker an empty voice_state before any later line is relayed", () => {
    const v = make();
    const w = live(v);
    v.fromRuntime(ID, seats());
    v.detach(ID);
    const emptyAt = w.sent.findIndex((m) => m.type === "voice_state" && m.holders.length === 0);
    expect(emptyAt).toBeGreaterThan(-1);
    w.emit(line());
    expect(w.sent.findIndex((m) => m.type === "voice_line_result")).toBeGreaterThan(emptyAt);
    expect(toRuntime.filter((x) => x.m.type === "voice_line")).toEqual([]);
  });

  // The A1a refusal window after a runtime restart, pinned (decision: document, no fix): from the new runtime's first seats until its
  // attach (the supervisor reads the player roles first) a line is refused `failed`. A new runtime always starts in the lobby (nothing
  // records) or resumed PAUSED (the worker's gate stops every pipeline), so no line can be cut in that window.
  it("the refusal window: a line between a new runtime's first seats and its attach is refused failed (pinned)", () => {
    const v = make();
    const w = live(v);
    v.detach(ID);
    v.fromRuntime(ID, seats({ paused: true }));
    expect(w.sent.at(-1)).toEqual({ type: "voice_state", paused: true, ended: false, holders });
    w.emit(line());
    expect(w.sent.at(-1)).toEqual({ type: "voice_line_result", segmentId: SEG, refused: "failed" });
    v.attach(ID, { voice: true, roles: ["tech_lead"] });
    w.emit(line("fedcba9876543210"));
    expect(toRuntime.filter((x) => x.m.type === "voice_line")).toHaveLength(1); // relayed once the runtime is attached
  });
});

describe("VoiceHost and the global speech-to-text budget (US-0071, A1b Task 6)", () => {
  const ID2 = "b".repeat(32);
  const LEASE = 35_000; // STT_COLD_TIMEOUT_MS (default 30 s) + 5 s
  const ask = (w: FakeWorker, slot: string) => w.emit({ type: "stt_slot_request", slot });
  const grants = (w: FakeWorker) => w.sent.filter((m) => m.type === "stt_slot_grant");
  const two = (v: VoiceHost) => {
    const a = live(v);
    v.attach(ID2, { voice: true, roles: ["tech_lead"] });
    const b = workers.at(-1)!;
    ready(b);
    return { a, b };
  };

  it("with two voice sessions at most 2 transcriptions run at once across both", () => {
    const v = make();
    const { a, b } = two(v);
    ask(a, "1111111111111111"); ask(a, "2222222222222222");
    ask(b, "3333333333333333"); ask(b, "4444444444444444");
    expect(grants(a)).toEqual([{ type: "stt_slot_grant", slot: "1111111111111111" }, { type: "stt_slot_grant", slot: "2222222222222222" }]);
    expect(grants(b)).toEqual([]);
    a.emit({ type: "stt_slot_release", slot: "1111111111111111" });
    expect(grants(b)).toEqual([{ type: "stt_slot_grant", slot: "3333333333333333" }]);
    for (const m of [...a.sent, ...b.sent]) expect(ControlToWorkerSchema.safeParse(m).success).toBe(true);
  });

  it("a worker exit releases its slots: the other session's waiter is granted at once", () => {
    const v = make();
    const { a, b } = two(v);
    ask(a, "1111111111111111"); ask(a, "2222222222222222"); ask(b, "3333333333333333");
    a.exit(1);
    expect(grants(b)).toEqual([{ type: "stt_slot_grant", slot: "3333333333333333" }]);
    expect(timers.filter((t) => t.ms === LEASE && !t.cancelled)).toHaveLength(1);
  });

  it("an expired lease kills that session's worker only (kill, then forceKill after graceMs), and grants the next waiter", () => {
    const v = make();
    const { a, b } = two(v);
    ask(a, "1111111111111111"); ask(a, "2222222222222222"); ask(b, "3333333333333333");
    const lease = timers.find((t) => t.ms === LEASE && !t.cancelled)!;
    lease.cancelled = true; lease.fn();
    expect(a.killed).toBe(1);
    expect(b.killed).toBe(0);
    expect(grants(b)).toEqual([{ type: "stt_slot_grant", slot: "3333333333333333" }]);
    expect(logs).toContain(`session ${ID} speech slot lease expired (timeout)`);
    fire(700);
    expect(a.forced).toBe(1);
    expect(b.forced).toBe(0);
  });

  it("a request from a worker that is no longer the session's is ignored", () => {
    const v = make();
    const a = live(v);
    a.exit(1);
    ask(a, "1111111111111111");
    expect(grants(a)).toEqual([]);
  });
});

describe("VoiceHost and LiveKit (US-0071, A1b Task 5)", () => {
  const CFG = { apiKey: "APIkey", apiSecret: "s".repeat(40), host: new URL("http://127.0.0.1:7880"), workerUrl: "ws://127.0.0.1:7880" };
  let n = 0;
  const seeded = (n0: number) => { let i = n0; return (k: number) => { const b = Buffer.alloc(k); for (let o = 0; o < k; o += 32) createHash("sha256").update(String(i++)).digest().copy(b, o); return b; }; };
  type Admin = RoomAdmin & { rooms: Map<string, Set<string>>; calls: string[] };
  const fakeAdmin = (): Admin => {
    const rooms = new Map<string, Set<string>>();
    const calls: string[] = [];
    return {
      rooms, calls,
      async removeParticipant(room, identity) { calls.push(`remove ${identity}`); rooms.get(room)?.delete(identity); },
      async listParticipants(room) { calls.push("list"); return [...(rooms.get(room) ?? [])]; },
      async deleteRoom(room) { calls.push("delete"); rooms.delete(room); },
    };
  };
  const withLiveKit = (ingest: "file" | "livekit" = "livekit") => {
    const admin = fakeAdmin();
    const tokens = new VoiceTokens({
      cfg: CFG, admin, random: seeded(1), log: (m) => logs.push(m),
      setTimer: (fn, ms) => { const t: T = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
      mint: async () => ({ token: `jwt-p-${++n}`, expiresAt: 1 }), mintWorker: async () => ({ token: `jwt-w-${++n}`, expiresAt: 1 }),
    });
    const v = new VoiceHost({
      spawn, config: { ...config, ...AI_CONFIG }, parentEnv: { PATH: "/bin", STT_PROVIDER: "fake", SPEECH_INGEST: ingest }, log: (m) => logs.push(m),
      setTimer: (fn, ms) => { const t: T = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
      toRuntime: (id, m) => { if (!runtimeUp) return false; toRuntime.push({ id, m }); return true; },
      tokens,
    });
    return { v, tokens, admin };
  };
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  it("livekit_token_request is answered with a fresh livekit_join for that role", async () => {
    const { v, tokens } = withLiveKit();
    const w = live(v);
    v.fromRuntime(ID, seats());
    w.emit({ type: "livekit_token_request", roleId: "tech_lead" });
    w.emit({ type: "livekit_token_request", roleId: "tech_lead" });
    await settle();
    const joins = w.sent.filter((m) => m.type === "livekit_join");
    expect(joins).toEqual([
      { type: "livekit_join", roleId: "tech_lead", url: "ws://127.0.0.1:7880", token: expect.stringMatching(/^jwt-w-/), room: tokens.roomOf(ID, "tech_lead") },
      { type: "livekit_join", roleId: "tech_lead", url: "ws://127.0.0.1:7880", token: expect.stringMatching(/^jwt-w-/), room: tokens.roomOf(ID, "tech_lead") },
    ]);
    expect((joins[0] as { token: string }).token).not.toBe((joins[1] as { token: string }).token);
  });

  it("a token request for a seat that does not record is logged by name and answered livekit_join_refused (batch 3 review F1)", async () => {
    const { v } = withLiveKit();
    const w = live(v);
    v.fromRuntime(ID, seats({ holders: [{ ...holders[0]!, recording: false }] }));
    w.emit({ type: "livekit_token_request", roleId: "tech_lead" });
    await settle();
    expect(w.sent.filter((m) => m.type === "livekit_join")).toEqual([]);
    expect(w.sent.filter((m) => m.type === "livekit_join_refused")).toEqual([{ type: "livekit_join_refused", roleId: "tech_lead" }]);
    for (const m of w.sent) expect(ControlToWorkerSchema.safeParse(m).success).toBe(true);
    expect(logs.at(-1)).toBe(`session ${ID} speech room token refused (VoiceTokenRefused)`);
  });

  it("a refused join for a worker that exited meanwhile is answered to nobody", async () => {
    const { v } = withLiveKit();
    const w = live(v);
    v.fromRuntime(ID, seats({ paused: true }));
    w.emit({ type: "livekit_token_request", roleId: "tech_lead" });
    w.exit(1);
    await settle();
    expect(w.sent.filter((m) => m.type === "livekit_join_refused")).toEqual([]);
  });

  it("a join minted for a worker that exited meanwhile is not sent to its successor", async () => {
    const { v } = withLiveKit();
    const w = live(v);
    v.fromRuntime(ID, seats());
    w.emit({ type: "livekit_token_request", roleId: "tech_lead" });
    w.exit(1);
    await settle();
    expect(w.sent.filter((m) => m.type === "livekit_join")).toEqual([]);
  });

  it("pushState carries generation only with SPEECH_INGEST=livekit", () => {
    const lk = withLiveKit("livekit");
    const w1 = live(lk.v);
    lk.v.fromRuntime(ID, seats());
    expect(w1.sent.at(-1)).toEqual({ type: "voice_state", paused: false, ended: false, holders: [{ ...holders[0]!, generation: lk.tokens.generation(ID, "tech_lead", "p-secret-1") }] });
    const file = withLiveKit("file");
    const ID2 = "b".repeat(32);
    file.v.attach(ID2, { voice: true, roles: ["tech_lead"] });
    const w2 = workers.at(-1)!;
    ready(w2);
    file.v.fromRuntime(ID2, seats());
    expect(w2.sent.at(-1)).toEqual({ type: "voice_state", paused: false, ended: false, holders });
    // Without LiveKit at all (control without keys) the file ingest gets no generation either.
    const plain = make();
    const ID3 = "c".repeat(32);
    plain.attach(ID3, { voice: true, roles: ["tech_lead"] });
    const w3 = workers.at(-1)!;
    ready(w3);
    plain.fromRuntime(ID3, seats());
    expect(w3.sent.at(-1)).toEqual({ type: "voice_state", paused: false, ended: false, holders });
  });

  it("voiceToken issues for the holder who chose voice, waits for seats, and is voice_unavailable without LiveKit", async () => {
    const { v } = withLiveKit();
    live(v);
    v.fromRuntime(ID, seats());
    await expect(v.voiceToken(ID, "tech_lead", "p-secret-1")).resolves.toEqual({ token: expect.stringMatching(/^jwt-p-/), expiresAt: 1 });
    await expect(make().voiceToken(ID, "tech_lead", "p-secret-1")).rejects.toEqual(new VoiceTokenRefused("voice_unavailable"));
  });

  it("a session without voice (no attach with voice) is voice_unavailable", async () => {
    const { v } = withLiveKit();
    v.attach(ID, { roles: ["tech_lead"] });
    await expect(v.voiceToken(ID, "tech_lead", "p-secret-1")).rejects.toMatchObject({ code: "voice_unavailable" });
  });

  it("seats that arrived before the attach are given to the tokens at the attach", async () => {
    const { v } = withLiveKit();
    v.fromRuntime(ID, seats());
    v.attach(ID, { voice: true, roles: ["tech_lead"] });
    await expect(v.voiceToken(ID, "tech_lead", "p-secret-1")).resolves.toMatchObject({ expiresAt: 1 });
  });

  it("a new holder in voice_seats removes the old identity from the seat room; the end deletes the room", async () => {
    const { v, tokens, admin } = withLiveKit();
    live(v);
    v.fromRuntime(ID, seats());
    await v.voiceToken(ID, "tech_lead", "p-secret-1");
    const room = tokens.roomOf(ID, "tech_lead");
    const old = `tech_lead.g${tokens.generation(ID, "tech_lead", "p-secret-1")}`;
    admin.rooms.set(room, new Set([old]));
    v.fromRuntime(ID, seats({ holders: [{ ...holders[0]!, participantId: "p-secret-2" }] }));
    await settle();
    expect(admin.calls).toContain(`remove ${old}`);
    expect(parseParticipantIdentity(old)?.roleId).toBe("tech_lead");
    v.end(ID);
    await settle();
    expect(admin.calls.at(-1)).toBe("delete");
  });

  // Review finding (case 8): deleting the room kicks the worker out of it, so `ended` (the final flush) must reach the worker FIRST.
  // The live check saw it arrive first every time, but that was a race between IPC and an HTTP call plus the server's kick.
  it("end sends the worker its final ended state BEFORE any seat room is deleted (even when deleteRoom resolves at once)", async () => {
    const { v, admin } = withLiveKit();
    const w = live(v);
    v.fromRuntime(ID, seats());
    await v.voiceToken(ID, "tech_lead", "p-secret-1"); // the seat room exists
    const order: string[] = [];
    const send = w.send.bind(w);
    w.send = (m) => { if (m.type === "voice_state" && m.ended) order.push("ended to the worker"); return send(m); };
    const del = admin.deleteRoom.bind(admin);
    admin.deleteRoom = (room) => { order.push("deleteRoom"); return del(room); };
    v.end(ID);
    await settle();
    expect(order).toEqual(["ended to the worker", "deleteRoom"]);
  });

  it("roleReissued sweeps the seat at once; a runtime exit forgets the seats (a token request then waits for the next ones)", async () => {
    const { v, tokens, admin } = withLiveKit();
    live(v);
    v.fromRuntime(ID, seats());
    await v.voiceToken(ID, "tech_lead", "p-secret-1");
    const room = tokens.roomOf(ID, "tech_lead");
    admin.rooms.set(room, new Set([`tech_lead.g${tokens.generation(ID, "tech_lead", "p-secret-1")}`]));
    v.roleReissued(ID, "tech_lead");
    await settle();
    expect(admin.rooms.get(room)!.size).toBe(0);
    v.detach(ID);
    const p = v.voiceToken(ID, "tech_lead", "p-secret-1");
    fire(1000);
    await expect(p).rejects.toMatchObject({ code: "voice_refused" });
  });

  it("livekit_status is logged as a fixed sentence with no role, room or identity", () => {
    const { v } = withLiveKit();
    const w = live(v);
    for (const state of ["connected", "failed", "disconnected"]) w.emit({ type: "livekit_status", state });
    expect(logs.slice(-3)).toEqual([`session ${ID} speech room connected`, `session ${ID} speech room failed`, `session ${ID} speech room disconnected`]);
  });
});

describe("the room-test timing record (US-0072, A1c Task 12)", () => {
  /** A host with the timing sink and an injected clock (`clock.t`). */
  const timed = (clock: { t: number }, sink?: string[]) => new VoiceHost({
    spawn, config: { ...config, ...AI_CONFIG }, parentEnv: { PATH: "/bin", STT_PROVIDER: "fake" }, log: (m) => logs.push(m),
    setTimer: (fn, ms) => { const t: T = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    toRuntime: (id, m) => { toRuntime.push({ id, m }); return true; }, now: () => clock.t,
    ...(sink ? { timingLog: (l: string) => { sink.push(l); } } : {}),
  });
  const timedLine = (segmentId: string, startMs: number, endMs: number) => ({ type: "voice_line", segmentId, roleId: "tech_lead", participantId: "p-secret-1", text: TEXT, startMs, endMs });

  it("no timing line without VOICE_TIMING_LOG (no sink), and nothing new in the log", () => {
    const clock = { t: 5000 };
    const v = timed(clock);
    const w = live(v);
    const before = logs.length;
    w.emit(timedLine(SEG, 1000, 3000));
    v.fromRuntime(ID, { type: "voice_line_ack", segmentId: SEG, seq: 1 });
    expect(logs.slice(before)).toEqual([]);
  });

  it("one line per acknowledged voice line with the two numbers from the injected clock (clamped at 0)", () => {
    const clock = { t: 0 };
    const sink: string[] = [];
    const v = timed(clock, sink);
    const w = live(v);
    w.emit(timedLine("0000000000000001", 10_000, 12_500));
    w.emit(timedLine("0000000000000002", 20_000, 20_400));
    clock.t = 13_250;
    v.fromRuntime(ID, { type: "voice_line_ack", segmentId: "0000000000000001", seq: 1 });
    clock.t = 20_100; // a worker clock ahead of control's: never a negative number
    v.fromRuntime(ID, { type: "voice_line_ack", segmentId: "0000000000000002", seq: 2 });
    expect(sink).toEqual([
      `session ${ID} voice line timing end_to_append_ms=750 start_to_append_ms=3250`,
      `session ${ID} voice line timing end_to_append_ms=0 start_to_append_ms=100`,
    ]);
  });

  it("a timing line holds no role, segment id, participant id or text", () => {
    const clock = { t: 9000 };
    const sink: string[] = [];
    const v = timed(clock, sink);
    const w = live(v);
    w.emit(timedLine(SEG, 1000, 2000));
    v.fromRuntime(ID, { type: "voice_line_ack", segmentId: SEG, seq: 77 });
    expect(sink).toHaveLength(1);
    for (const bad of ["tech_lead", "p-secret-1", SEG, TEXT, "secret", "77", "pm"]) expect(sink[0], bad).not.toContain(bad);
    expect(logs.join("\n")).not.toContain("timing"); // the record goes to its own sink only, never the service log
  });

  it("a refused line, a timed-out line and a line refused at once log no timing", () => {
    const clock = { t: 9000 };
    const sink: string[] = [];
    const v = timed(clock, sink);
    const w = live(v);
    w.emit(timedLine("0000000000000001", 1000, 2000));
    v.fromRuntime(ID, { type: "voice_line_refused", segmentId: "0000000000000001", code: "not_holder" });
    w.emit(timedLine("0000000000000002", 1000, 2000));
    fire(VOICE_LINE_TIMEOUT_MS);
    v.fromRuntime(ID, { type: "voice_line_ack", segmentId: "0000000000000002", seq: 3 }); // too late: no pending entry
    v.detach(ID);
    w.emit(timedLine("0000000000000003", 1000, 2000)); // refused at once (no runtime)
    expect(sink).toEqual([]);
  });

  it("a sink that throws never breaks the ack", () => {
    const clock = { t: 9000 };
    const v = new VoiceHost({
      spawn, config: { ...config, ...AI_CONFIG }, parentEnv: { PATH: "/bin", STT_PROVIDER: "fake" }, log: (m) => logs.push(m),
      setTimer: (fn, ms) => { const t: T = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
      toRuntime: (id, m) => { toRuntime.push({ id, m }); return true; }, now: () => clock.t, timingLog: () => { throw new Error("disk full /secret/path"); },
    });
    const w = live(v);
    w.emit(timedLine(SEG, 1000, 2000));
    v.fromRuntime(ID, { type: "voice_line_ack", segmentId: SEG, seq: 5 });
    expect(w.sent.at(-1)).toEqual({ type: "voice_line_result", segmentId: SEG, seq: 5 });
    expect(logs.join("\n")).not.toContain("/secret/path");
  });
});

describe("VoiceHost log identity hand-off (US-0073, A2a Task 3)", () => {
  const IDENT = "0123456789abcdef0123456789abcdef";
  const OTHER = "fedcba9876543210fedcba9876543210";
  const makeAudio = () => new VoiceHost({
    spawn, config: { ...config, ...AI_CONFIG, sessionsDir: "/data/sessions" }, parentEnv: { PATH: "/bin", STT_PROVIDER: "fake", AUDIO_DIR: "/data/audio", SPEECH_LOG_IDENTITY: "e".repeat(32) }, log: (m) => logs.push(m),
    setTimer: (fn, ms) => { const t: T = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    toRuntime: (id, m) => { if (!runtimeUp) return false; toRuntime.push({ id, m }); return true; },
  });

  it("a valid identity from attach reaches the worker env with the sessions dir; AUDIO_DIR comes from the parent env", () => {
    const v = makeAudio();
    v.attach(ID, { voice: true, roles: ["tech_lead"], logIdentity: IDENT });
    expect(workers[0]!.env.SPEECH_LOG_IDENTITY).toBe(IDENT);
    expect(workers[0]!.env.SPEECH_SESSIONS_DIR).toBe("/data/sessions");
    expect(workers[0]!.env.AUDIO_DIR).toBe("/data/audio");
  });

  it("the identity set at ready (before attach) is used by the spawn", () => {
    const v = makeAudio();
    v.setIdentity(ID, IDENT);
    v.attach(ID, { voice: true, roles: ["tech_lead"] , logIdentity: IDENT });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.env.SPEECH_LOG_IDENTITY).toBe(IDENT);
  });

  it.each([["../x"], ["A".repeat(32)], ["a".repeat(31)], ["a".repeat(33)], [""], [42], [undefined]])("an invalid identity (%j) records no audio: no SPEECH_LOG_IDENTITY, voice still attaches", (bad) => {
    const v = makeAudio();
    v.setIdentity(ID, bad);
    v.attach(ID, { voice: true, roles: ["tech_lead"], ...(typeof bad === "string" ? { logIdentity: bad } : {}) });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.env.SPEECH_LOG_IDENTITY).toBeUndefined();
    expect(workers[0]!.env.SPEECH_SESSIONS_DIR).toBeUndefined();
    ready(workers[0]!);
    expect(v.workerPid(ID)).toBe(4242);
  });

  it("a voice_choice (and voice_seats) between ready and attach does not lose the identity (it is stored at ready, before attach)", () => {
    const v = makeAudio();
    v.setIdentity(ID, IDENT);
    v.fromRuntime(ID, { type: "voice_choice", roleId: "tech_lead", participantId: "p-secret-1", choice: "voice", at: 5 });
    v.fromRuntime(ID, seats());
    expect(workers).toEqual([]); // nothing spawns before attach
    v.attach(ID, { voice: true, roles: ["tech_lead"] , logIdentity: IDENT });
    expect(workers[0]!.env.SPEECH_LOG_IDENTITY).toBe(IDENT);
  });

  it("a runtime restart with the SAME identity keeps the worker", () => {
    const v = makeAudio();
    v.attach(ID, { voice: true, roles: ["tech_lead"], logIdentity: IDENT });
    const w = workers[0]!; ready(w);
    v.detach(ID);
    v.setIdentity(ID, IDENT);
    v.attach(ID, { voice: true, roles: ["tech_lead"], logIdentity: IDENT });
    expect(workers).toHaveLength(1);
    expect(w.killed).toBe(0);
  });

  it("a runtime restart with a DIFFERENT identity stops the kept worker and respawns it with the new one, without counting a failure", () => {
    const v = makeAudio();
    v.attach(ID, { voice: true, roles: ["tech_lead"], logIdentity: IDENT });
    const w1 = workers[0]!; ready(w1);
    v.detach(ID);
    v.setIdentity(ID, OTHER);
    v.attach(ID, { voice: true, roles: ["tech_lead"], logIdentity: OTHER });
    expect(w1.killed).toBe(1);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.env.SPEECH_LOG_IDENTITY).toBe(OTHER);
    w1.exit(0); // the old worker's exit is a clean stop: no restart, no alert
    expect(workers).toHaveLength(2);
    expect(toRuntime.some((x) => x.m.type === "voice_alert")).toBe(false);
    // no failure was counted: RESTART_TRIES + 1 failures are still needed to turn voice off
    for (let i = 0; i < 6; i++) { workers.at(-1)!.exit(1); for (const t of timers.filter((x) => !x.cancelled && x.ms !== 700)) { t.cancelled = true; t.fn(); } }
    expect(toRuntime.filter((x) => x.m.type === "voice_alert" && (x.m as { code: string }).code === "voice_off")).toHaveLength(1);
  });
});

describe("VoiceHost audit log and store alerts (US-0073, A2a Task 8)", () => {
  const IDENT = "0123456789abcdef0123456789abcdef";
  let audited: { id: string; e: AuditEvent }[];
  const makeAudited = () => new VoiceHost({
    spawn, config: { ...config, ...AI_CONFIG }, parentEnv: { PATH: "/bin", STT_PROVIDER: "fake" }, log: (m) => logs.push(m),
    setTimer: (fn, ms) => { const t: T = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    toRuntime: (id, m) => { if (!runtimeUp) return false; toRuntime.push({ id, m }); return true; },
    audit: { append: async (id, e) => { audited.push({ id, e }); } },
  });
  const liveWith = (v: VoiceHost, logIdentity?: string) => {
    v.attach(ID, { voice: true, roles: ["tech_lead"], ...(logIdentity ? { logIdentity } : {}) });
    const w = workers.at(-1)!; ready(w); return w;
  };
  beforeEach(() => { audited = []; });

  it.each([["disk_low"], ["write_error"]] as const)("store_stopped %s raises the facilitator alert and audits voice.recording_stopped", (reason) => {
    const v = makeAudited();
    const w = liveWith(v, IDENT);
    w.emit({ type: "store_stopped", reason });
    expect(relayed().map((x) => x.m)).toEqual([{ type: "voice_alert", code: reason }]);
    expect(audited).toEqual([{ id: IDENT, e: { type: "voice.recording_stopped", reason } }]);
  });

  it("store_stopped while the runtime is down: no alert reaches it, but the stop is still audited", () => {
    const v = makeAudited();
    const w = liveWith(v, IDENT);
    v.detach(ID); runtimeUp = false;
    w.emit({ type: "store_stopped", reason: "disk_low" });
    expect(relayed().filter((x) => x.m.type === "voice_alert")).toEqual([]);
    expect(audited).toEqual([{ id: IDENT, e: { type: "voice.recording_stopped", reason: "disk_low" } }]);
  });

  it("a malformed store_stopped is ignored (schema-validated)", () => {
    const v = makeAudited();
    const w = liveWith(v, IDENT);
    for (const m of [{ type: "store_stopped", reason: "full" }, { type: "store_stopped" }, { type: "store_stopped", reason: "disk_low", text: "x" }]) w.emit(m);
    expect(relayed()).toEqual([]);
    expect(audited).toEqual([]);
  });

  it("voice_choice voice / text_only audits voice.opted_in (notice v3) / voice.opted_out with ids only, and is relayed nowhere", () => {
    const v = makeAudited();
    const w = liveWith(v, IDENT);
    const sent = w.sent.length;
    v.fromRuntime(ID, { type: "voice_choice", roleId: "tech_lead", participantId: "p-secret-1", choice: "voice", at: 5 });
    v.fromRuntime(ID, { type: "voice_choice", roleId: "tech_lead", participantId: "p-secret-1", choice: "text_only", at: 6 });
    expect(audited).toEqual([
      { id: IDENT, e: { type: "voice.opted_in", role: "tech_lead", participant: "p-secret-1", noticeVersion: "v3" } },
      { id: IDENT, e: { type: "voice.opted_out", role: "tech_lead", participant: "p-secret-1" } },
    ]);
    for (const a of audited) expect(a.e).not.toHaveProperty("text");
    expect(relayed()).toEqual([]);
    expect(w.sent.length).toBe(sent);
    expect(turns).toEqual([]);
  });

  it("with no valid identity nothing is audited (store_stopped still alerts)", () => {
    const v = makeAudited();
    const w = liveWith(v);
    v.fromRuntime(ID, { type: "voice_choice", roleId: "tech_lead", participantId: "p-secret-1", choice: "voice", at: 5 });
    w.emit({ type: "store_stopped", reason: "write_error" });
    expect(audited).toEqual([]);
    expect(relayed().map((x) => x.m)).toEqual([{ type: "voice_alert", code: "write_error" }]);
    v.setIdentity(ID, "A".repeat(32));
    v.fromRuntime(ID, { type: "voice_choice", roleId: "tech_lead", participantId: "p-secret-1", choice: "text_only", at: 6 });
    expect(audited).toEqual([]);
  });

  it("R1 (shared with Task 3): a voice_choice after setIdentity at ready but BEFORE attach is audited with that identity", () => {
    const v = makeAudited();
    v.setIdentity(ID, IDENT);
    v.fromRuntime(ID, { type: "voice_choice", roleId: "tech_lead", participantId: "p-secret-1", choice: "voice", at: 5 });
    expect(workers).toEqual([]);
    expect(audited).toEqual([{ id: IDENT, e: { type: "voice.opted_in", role: "tech_lead", participant: "p-secret-1", noticeVersion: "v3" } }]);
  });

  it("without an injected audit log, store_stopped and voice_choice still work (no-op audit)", () => {
    const v = make();
    v.setIdentity(ID, IDENT);
    const w = live(v);
    v.fromRuntime(ID, { type: "voice_choice", roleId: "tech_lead", participantId: "p-secret-1", choice: "voice", at: 5 });
    w.emit({ type: "store_stopped", reason: "disk_low" });
    expect(relayed().map((x) => x.m)).toEqual([{ type: "voice_alert", code: "disk_low" }]);
  });
});
