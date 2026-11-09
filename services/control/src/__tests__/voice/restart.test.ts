import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ControlToWorker } from "@acr/speech/protocol";
import type { RoomAdmin } from "@acr/adapters/livekit";
import type { ControlConfig } from "../../config.js";
import type { ParentMessage } from "../../protocol.js";
import { RESTART_BASE_MS, RESTART_STABLE_MS, RESTART_TRIES, restartDelay } from "../../voice/restart.js";
import { VoiceTokens } from "../../voice/tokens.js";
import { VoiceHost, type SpeechSpawnFn, type WorkerHandle } from "../../voice/voice-host.js";
import { AI_CONFIG } from "../fake-child.js";

/**
 * US-0071 (EPIC-0003 voice A1b, Task 8, AC-0410): the speech worker is restarted with a bounded CONSECUTIVE backoff (500 ms doubling),
 * the count reset after a worker has been ready for 60 s; after 5 failed restarts in a row voice is off for the session. Fake workers
 * and manual timers: no process, no real time.
 */
class FakeWorker implements WorkerHandle {
  sent: ControlToWorker[] = [];
  killed = 0; forced = 0; disconnected = 0;
  readonly pid: number;
  private msg: ((raw: unknown) => void)[] = [];
  private exitFns: ((c: number | null) => void)[] = [];
  constructor(readonly env: NodeJS.ProcessEnv, n: number) { this.pid = 1000 + n; }
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
const ID2 = "b".repeat(32);
const SEG = "0123456789abcdef";
const holders = [{ roleId: "tech_lead", participantId: "p-secret-1", recording: true, voiceChosen: true }];
const seats = (o: { paused?: boolean } = {}) => ({ type: "voice_seats" as const, paused: o.paused ?? false, ended: false, holders, open: [] });

let timers: T[], workers: FakeWorker[], toRuntime: { id: string; m: ParentMessage }[], logs: string[], spawnThrows: number, runtimeUp: boolean;
const config = { graceMs: 700, logDir: "/data/child-logs" } as ControlConfig;
const setTimer = (fn: () => void, ms: number) => { const t: T = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
const spawn: SpeechSpawnFn = ({ env }) => {
  if (spawnThrows > 0) { spawnThrows--; throw new TypeError("spawn failed /secret/path"); }
  const w = new FakeWorker(env, workers.length); workers.push(w); return w;
};
const make = (tokens?: VoiceTokens) => new VoiceHost({
  spawn, config: { ...config, ...AI_CONFIG }, parentEnv: { PATH: "/bin", STT_PROVIDER: "fake", ...(tokens ? { SPEECH_INGEST: "livekit" } : {}) }, log: (m) => logs.push(m), setTimer,
  toRuntime: (id, m) => { if (!runtimeUp) return false; toRuntime.push({ id, m }); return true; },
  ...(tokens ? { tokens } : {}),
});
const pendingRestarts = () => timers.filter((t) => !t.cancelled && [500, 1000, 2000, 4000, 8000].includes(t.ms));
/** Fires the one pending restart timer and returns its delay. */
const fireRestart = (): number => {
  const p = pendingRestarts();
  expect(p).toHaveLength(1);
  p[0]!.cancelled = true; p[0]!.fn();
  return p[0]!.ms;
};
const fireStable = () => { for (const t of timers.filter((x) => x.ms === RESTART_STABLE_MS && !x.cancelled)) { t.cancelled = true; t.fn(); } };
const alerts = () => toRuntime.map((x) => x.m).filter((m) => m.type === "voice_alert").map((m) => (m as { code: string }).code);
const ready = (w: FakeWorker) => w.emit({ type: "worker_ready", stt: "ok" });
const attach = (v: VoiceHost, roles = ["tech_lead", "pm"]) => v.attach(ID, { voice: true, roles });

beforeEach(() => { timers = []; workers = []; toRuntime = []; logs = []; spawnThrows = 0; runtimeUp = true; });

describe("restartDelay and the restart constants (US-0071, A1b Task 8)", () => {
  it("the delays are 500, 1000, 2000, 4000, 8000; 5 tries; 60 s ready resets", () => {
    expect([1, 2, 3, 4, 5].map(restartDelay)).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(RESTART_TRIES).toBe(5);
    expect(RESTART_BASE_MS).toBe(500);
    expect(RESTART_STABLE_MS).toBe(60_000);
    for (const bad of [0, 6, 1.5, -1]) expect(() => restartDelay(bad)).toThrow(RangeError);
  });
});

describe("VoiceHost restarts the speech worker with bounded consecutive backoff (US-0071, A1b Task 8)", () => {
  it("consecutive failures are restarted after 500, 1000, 2000, 4000 and 8000 ms, each with the attach's roles", () => {
    const v = make();
    attach(v);
    const delays: number[] = [];
    for (let i = 0; i < RESTART_TRIES; i++) { workers.at(-1)!.exit(1); delays.push(fireRestart()); }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(workers).toHaveLength(6);
    for (const w of workers) expect(w.env.SPEECH_INGEST_ROLES).toBe("tech_lead,pm");
  });

  it("every unexpected exit sends worker_restarting (the runtime closes the voice turn each time and rate-limits the alert)", () => {
    const v = make();
    attach(v);
    for (let i = 0; i < 3; i++) { workers.at(-1)!.exit(1); fireRestart(); }
    expect(alerts()).toEqual(["worker_restarting", "worker_restarting", "worker_restarting"]);
    expect(logs.filter((l) => l === `session ${ID} speech worker stopped unexpectedly`)).toHaveLength(3);
  });

  it("an exit with code 3 (a lost LiveKit room), 0, or a signal (null) is unexpected like any other and restarted", () => {
    const v = make();
    attach(v);
    for (const code of [3, 0, null]) { workers.at(-1)!.exit(code); fireRestart(); }
    expect(workers).toHaveLength(4);
    expect(alerts()).toEqual(["worker_restarting", "worker_restarting", "worker_restarting"]);
  });

  it("after 5 failed restarts in a row (the 6th exit): one voice_off alert, no further spawn, tokens refused voice_off", async () => {
    const tokens = withTokens();
    const v = make(tokens);
    attach(v);
    v.fromRuntime(ID, seats());
    for (let i = 0; i < RESTART_TRIES; i++) { workers.at(-1)!.exit(1); fireRestart(); }
    workers.at(-1)!.exit(3);
    expect(pendingRestarts()).toEqual([]);
    expect(alerts()).toEqual([...Array(RESTART_TRIES).fill("worker_restarting"), "voice_off"]);
    expect(workers).toHaveLength(1 + RESTART_TRIES);
    await expect(v.voiceToken(ID, "tech_lead", "p-secret-1")).rejects.toMatchObject({ code: "voice_off" });
    expect(logs).toContain(`session ${ID} voice is off after repeated speech worker faults`);
    // A later runtime ready (a runtime restart) never brings the worker back; nor does another seats report.
    attach(v);
    v.fromRuntime(ID, seats());
    expect(workers).toHaveLength(1 + RESTART_TRIES);
    expect(alerts().filter((c) => c === "voice_off")).toHaveLength(1);
  });

  it("a worker ready for 60 s resets the count: 5 failures, a stable worker, then 5 more before voice off", () => {
    const v = make();
    attach(v);
    for (let i = 0; i < RESTART_TRIES; i++) { workers.at(-1)!.exit(1); fireRestart(); }
    const stable = workers.at(-1)!;
    ready(stable);
    fireStable();
    const delays: number[] = [];
    stable.exit(1);
    delays.push(fireRestart());
    for (let i = 1; i < RESTART_TRIES; i++) { workers.at(-1)!.exit(1); delays.push(fireRestart()); }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000]);
    workers.at(-1)!.exit(1);
    expect(alerts().at(-1)).toBe("voice_off");
    expect(alerts().filter((c) => c === "voice_off")).toHaveLength(1);
  });

  it("a worker that exits after 59 s ready (its 60 s timer not yet fired) still counts", () => {
    const v = make();
    attach(v);
    workers[0]!.exit(1);
    fireRestart();
    ready(workers[1]!);
    expect(timers.filter((t) => t.ms === RESTART_STABLE_MS && !t.cancelled)).toHaveLength(1);
    workers[1]!.exit(1);
    expect(timers.filter((t) => t.ms === RESTART_STABLE_MS && !t.cancelled)).toEqual([]); // cancelled at the exit
    expect(fireRestart()).toBe(1000);
  });

  it("a worker that never says worker_ready and exits counts as a try", () => {
    const v = make();
    attach(v);
    workers[0]!.exit(1);
    expect(fireRestart()).toBe(500);
    workers[1]!.exit(1);
    expect(fireRestart()).toBe(1000);
  });

  it("a spawn that throws in attach counts as a try and is retried with the attach's roles", () => {
    const v = make();
    spawnThrows = 1;
    attach(v, ["tech_lead"]);
    expect(workers).toEqual([]);
    expect(logs).toEqual([`session ${ID} speech worker could not start (TypeError)`]);
    expect(alerts()).toEqual(["worker_restarting"]);
    expect(fireRestart()).toBe(500);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.env.SPEECH_INGEST_ROLES).toBe("tech_lead");
  });

  it("a spawn that throws in a respawn counts as a try too", () => {
    const v = make();
    attach(v);
    workers[0]!.exit(1);
    spawnThrows = 1;
    expect(fireRestart()).toBe(500);
    expect(fireRestart()).toBe(1000);
    expect(workers).toHaveLength(2);
    expect(logs.join("\n")).not.toContain("/secret/path");
  });

  it("the timer respawn uses the last attach's roles", () => {
    const v = make();
    attach(v, ["tech_lead"]);
    workers[0]!.exit(1);
    attach(v, ["tech_lead", "cfo"]); // a runtime restart while the restart is pending: no spawn now, the newer roles later
    expect(workers).toHaveLength(1);
    fireRestart();
    expect(workers[1]!.env.SPEECH_INGEST_ROLES).toBe("tech_lead,cfo");
  });

  it("a restarted worker gets the current voice_state after worker_ready and asks for its own tokens", async () => {
    const tokens = withTokens();
    const v = make(tokens);
    attach(v);
    v.fromRuntime(ID, seats());
    ready(workers[0]!);
    workers[0]!.exit(3);
    fireRestart();
    const w2 = workers[1]!;
    expect(w2.sent).toEqual([]);
    ready(w2);
    expect(w2.sent).toEqual([{ type: "voice_state", paused: false, ended: false, holders: [{ ...holders[0]!, generation: tokens.generation(ID, "tech_lead", "p-secret-1") }] }]);
    w2.emit({ type: "livekit_token_request", roleId: "tech_lead" });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(w2.sent.at(-1)).toMatchObject({ type: "livekit_join", roleId: "tech_lead", room: tokens.roomOf(ID, "tech_lead") });
    expect(workers[0]!.sent.filter((m) => m.type === "livekit_join")).toEqual([]);
  });

  it("a runtime ready pushes the current voice_state to a ready worker (it re-attaches without the runtime's help)", () => {
    const v = make();
    attach(v);
    const w = workers[0]!;
    ready(w);
    v.fromRuntime(ID, seats({ paused: true }));
    const n = w.sent.length;
    attach(v);
    expect(w.sent.slice(n)).toEqual([{ type: "voice_state", paused: true, ended: false, holders }]);
  });

  it("no restart after end; end cancels a pending restart", () => {
    const v = make();
    attach(v);
    workers[0]!.exit(1);
    expect(pendingRestarts()).toHaveLength(1);
    const pending = pendingRestarts()[0]!;
    v.end(ID);
    expect(pendingRestarts()).toEqual([]);
    pending.fn(); // even a timer that fires late (cancelled, but already queued) starts nothing
    expect(workers).toHaveLength(1);
  });

  it("an ended session's worker that exits is not a failure (no alert, no restart)", () => {
    const v = make();
    attach(v);
    ready(workers[0]!);
    v.fromRuntime(ID, seats());
    v.end(ID);
    workers[0]!.exit(0);
    expect(pendingRestarts()).toEqual([]);
    expect(alerts()).toEqual([]);
  });

  it("shutdown cancels a pending restart, and a worker leaving on the disconnect is not a failure", async () => {
    const v = make();
    v.attach(ID2, { voice: true, roles: ["tech_lead"] });
    attach(v);
    workers[1]!.exit(1); // ID's worker: a restart is pending
    const done = v.shutdown();
    expect(pendingRestarts()).toEqual([]);
    workers[0]!.exit(0); // ID2's worker leaves on the disconnect
    await done;
    expect(pendingRestarts()).toEqual([]);
    expect(alerts()).toEqual(["worker_restarting"]);
    expect(workers).toHaveLength(2);
  });

  it("an expired speech-to-text lease kills the worker and its exit takes the restart path", () => {
    const v = make();
    attach(v);
    const w = workers[0]!;
    ready(w);
    w.emit({ type: "stt_slot_request", slot: SEG });
    const lease = timers.find((t) => t.ms === 35_000 && !t.cancelled)!;
    lease.cancelled = true; lease.fn();
    expect(w.killed).toBe(1);
    w.exit(null);
    expect(fireRestart()).toBe(500);
    expect(workers).toHaveLength(2);
  });

  it("pending lines of the dead worker are not answered to the new one; the new worker may reuse a segment id", () => {
    const v = make();
    attach(v);
    v.fromRuntime(ID, seats());
    ready(workers[0]!);
    const line = { type: "voice_line", segmentId: SEG, roleId: "tech_lead", participantId: "p-secret-1", text: "Hello.", startMs: 1, endMs: 2 };
    workers[0]!.emit(line);
    workers[0]!.exit(1);
    fireRestart();
    const w2 = workers[1]!;
    ready(w2);
    v.fromRuntime(ID, { type: "voice_line_ack", segmentId: SEG, seq: 4 }); // the old worker's line: nobody waits for it any more
    expect(w2.sent.filter((m) => m.type === "voice_line_result")).toEqual([]);
    w2.emit(line); // the same id from the new worker is a new line, answered normally
    expect(toRuntime.filter((x) => x.m.type === "voice_line")).toHaveLength(2);
    v.fromRuntime(ID, { type: "voice_line_ack", segmentId: SEG, seq: 5 });
    expect(w2.sent.filter((m) => m.type === "voice_line_result")).toEqual([{ type: "voice_line_result", segmentId: SEG, seq: 5 }]);
  });

  it("a restart happens while the runtime is down too (the worker outlives a runtime restart); the alert is then not sent", () => {
    const v = make();
    attach(v);
    v.detach(ID);
    runtimeUp = false;
    workers[0]!.exit(1);
    expect(alerts()).toEqual([]);
    expect(fireRestart()).toBe(500);
    expect(workers).toHaveLength(2);
  });
});

function withTokens(): VoiceTokens {
  const admin: RoomAdmin = { removeParticipant: async () => {}, listParticipants: async () => [], deleteRoom: async () => {} };
  let i = 0;
  return new VoiceTokens({
    cfg: { apiKey: "APIkey", apiSecret: "s".repeat(40), host: new URL("http://127.0.0.1:7880"), workerUrl: "ws://127.0.0.1:7880" }, admin,
    random: (k) => { const b = Buffer.alloc(k); for (let o = 0; o < k; o += 32) createHash("sha256").update(String(i++)).digest().copy(b, o); return b; },
    setTimer, log: (m) => logs.push(m), mint: async () => ({ token: "jwt-p", expiresAt: 1 }), mintWorker: async () => ({ token: "jwt-w", expiresAt: 1 }),
  });
}
