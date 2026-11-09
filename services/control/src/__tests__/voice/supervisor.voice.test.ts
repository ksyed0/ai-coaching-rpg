import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlToWorker } from "@acr/speech/protocol";
import type { BotHost } from "../../bots/bot-host.js";
import type { ControlConfig } from "../../config.js";
import { ChildMessageSchema } from "../../protocol.js";
import { SessionList } from "../../session-list.js";
import { Supervisor, type SetTimer, type SpawnFn } from "../../supervisor.js";
import { VoiceHost, type SpeechSpawnFn, type WorkerHandle } from "../../voice/voice-host.js";
import { AI_CONFIG, CODES, FakeChild, READY, flush } from "../fake-child.js";

class FakeWorker implements WorkerHandle {
  sent: ControlToWorker[] = [];
  killed = 0; forced = 0; disconnected = 0;
  readonly pid = 77;
  private msg: ((raw: unknown) => void)[] = [];
  private exitFns: ((c: number | null) => void)[] = [];
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
let root: string, config: ControlConfig, list: SessionList, children: FakeChild[], workers: FakeWorker[], spawn: SpawnFn, timers: T[], turns: [string, boolean][], logs: string[];
const setTimer: SetTimer = (fn, ms) => { const t: T = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await flush(); };
const speechSpawn: SpeechSpawnFn = () => { const w = new FakeWorker(); workers.push(w); return w; };
const SEATS = { type: "voice_seats", paused: false, ended: false, holders: [{ roleId: "cfo", participantId: "p1", recording: true, voiceChosen: true }], open: [] } as const;
const STATE = { type: "voice_state", paused: false, ended: false, holders: SEATS.holders };

const make = (withVoice = true) => new Supervisor({
  config, list, scenarios: async () => [{ id: "other", title: "Other" }], spawn, setTimer, now: () => 1234, log: (m) => logs.push(m),
  bots: () => ({ attach: async () => {}, end: async () => {}, detach: async () => {}, close: async () => {}, forget: async () => {}, voiceTurn: (id: string, open: boolean) => { turns.push([id, open]); } } as unknown as BotHost),
  ...(withVoice ? { voice: (deps) => new VoiceHost({ spawn: speechSpawn, config, parentEnv: {}, log: (m) => logs.push(m), setTimer, ...deps }) } : {}),
});

/** A create whose runtime says ready and then, in the SAME turn (before the supervisor's continuation runs), its first voice_seats. */
const boot = async (sup: Supervisor, o: { voice?: boolean; seatsRightAfterReady?: boolean } = {}): Promise<{ id: string; c: FakeChild }> => {
  const p = sup.create("other");
  await settle();
  const c = children.at(-1)!;
  c.emit({ type: "codes", codes: CODES });
  c.emit({ ...READY, ...(o.voice === false ? {} : { voice: true }) });
  if (o.seatsRightAfterReady !== false) c.emit(SEATS);
  const r = await p;
  await settle();
  return { id: r.sessionId, c };
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ctl-voice-"));
  const scenariosDir = path.join(root, "scenarios");
  mkdirSync(path.join(scenariosDir, "other"), { recursive: true });
  config = {
    port: 1, serviceToken: "t".repeat(40), maxSessions: 5, dataDir: root, sessionsDir: path.join(root, "sessions"),
    listFile: path.join(root, "sessions.json"), scenariosDir, logDir: path.join(root, "child-logs"), graceMs: 777, readyTimeoutMs: 5000, ...AI_CONFIG,
  };
  mkdirSync(config.sessionsDir, { recursive: true });
  list = new SessionList(config.listFile);
  children = []; workers = []; timers = []; turns = []; logs = [];
  spawn = ({ env, logFile }) => { const c = new FakeChild(env, logFile); writeFileSync(logFile, "log"); children.push(c); return c; };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Supervisor and the VoiceHost (US-0070)", () => {
  it("the first voice_seats, sent right after ready, is held and reaches the worker (control's awaitReady drops other late messages)", async () => {
    const sup = make();
    await boot(sup);
    expect(workers).toHaveLength(1);
    workers[0]!.emit({ type: "worker_ready", stt: "ok" });
    expect(workers[0]!.sent).toEqual([STATE]);
  });

  // F9c (review fix wave): once the held message is handed over, the early listener no longer parses anything for the child's life.
  it("after the hand-over, a later voice_seats is parsed by the live handler only", async () => {
    const sup = make();
    const { c } = await boot(sup);
    workers[0]!.emit({ type: "worker_ready", stt: "ok" });
    const parse = vi.spyOn(ChildMessageSchema, "safeParse");
    try {
      c.emit({ ...SEATS, paused: true });
      c.emit({ type: "ended" });
      expect(parse).toHaveBeenCalledTimes(2); // one parse per message: the live handler's
    } finally { parse.mockRestore(); }
    expect(workers[0]!.sent.at(-2)).toEqual({ ...STATE, paused: true });
  });

  it("no worker for a runtime whose ready has no voice", async () => {
    const sup = make();
    await boot(sup, { voice: false, seatsRightAfterReady: false });
    expect(workers).toEqual([]);
  });

  it("a supervisor without a voice factory ignores the voice messages", async () => {
    const sup = make(false);
    const { id, c } = await boot(sup);
    c.emit({ type: "voice_turn", open: true }); // still reaches the bots (no VoiceHost needed for that)
    expect(turns).toEqual([[id, true]]);
    expect(sup.get(id)!.status).toBe("running");
  });

  it("voice messages are routed both ways through the running child", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    const w = workers[0]!;
    w.emit({ type: "worker_ready", stt: "ok" });
    w.emit({ type: "voice_line", segmentId: "0123456789abcdef", roleId: "cfo", participantId: "p1", text: "Hello.", startMs: 1, endMs: 2 });
    expect(c.voice).toEqual([{ type: "voice_line", segmentId: "0123456789abcdef", roleId: "cfo", participantId: "p1", text: "Hello." }]);
    c.emit({ type: "voice_line_ack", segmentId: "0123456789abcdef", seq: 7 });
    expect(w.sent.at(-1)).toEqual({ type: "voice_line_result", segmentId: "0123456789abcdef", seq: 7 });
    c.emit({ type: "voice_turn", open: true });
    expect(turns).toEqual([[id, true]]);
    c.emit({ ...SEATS, paused: true });
    expect(w.sent.at(-1)).toEqual({ ...STATE, paused: true });
  });

  it("worker exit leaves the session running: one worker_down alert, no respawn, typed lines unaffected", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    workers[0]!.emit({ type: "worker_ready", stt: "ok" });
    workers[0]!.exit(1);
    expect(sup.get(id)!.status).toBe("running");
    expect(c.voice).toEqual([{ type: "voice_alert", code: "worker_down" }]);
    expect(c.killed).toBe(0);
    c.emit(SEATS);
    await settle();
    expect(workers).toHaveLength(1);
  });

  it("the runtime's exit detaches (the worker stays, records nothing); a restart's ready re-attaches it and pushes the new seats", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    const w = workers[0]!;
    w.emit({ type: "worker_ready", stt: "ok" });
    c.exit(1);
    expect(sup.get(id)!.status).toBe("stopped");
    expect(w.sent.at(-1)).toEqual({ type: "voice_state", paused: false, ended: false, holders: [] });
    expect(w.killed + w.forced).toBe(0);
    const p = sup.restart(id);
    await settle();
    const c2 = children.at(-1)!;
    c2.emit({ ...READY, voice: true });
    c2.emit({ ...SEATS, paused: true }); // restarted runtimes come back paused
    await p;
    await settle();
    expect(workers).toHaveLength(1);
    expect(w.sent.at(-1)).toEqual({ ...STATE, paused: true });
  });

  it("ended sends the worker an ended state and then stops it", async () => {
    const sup = make();
    const { c } = await boot(sup);
    const w = workers[0]!;
    w.emit({ type: "worker_ready", stt: "ok" });
    c.emit({ type: "ended" });
    expect(w.sent.at(-1)).toMatchObject({ type: "voice_state", ended: true });
    for (const t of timers.filter((x) => x.ms === 777 && !x.cancelled)) { t.cancelled = true; t.fn(); }
    expect(w.killed).toBe(1);
  });

  it("shutdown also disconnects the workers", async () => {
    const sup = make();
    await boot(sup);
    const done = sup.shutdown();
    let finished = false;
    void done.then(() => { finished = true; });
    // The fake children never exit: fire each grace timer as it appears until the bounded shutdown gives up on them.
    for (let i = 0; i < 20 && !finished; i++) { await settle(); for (const t of timers.filter((x) => !x.cancelled)) { t.cancelled = true; t.fn(); } }
    await done;
    expect(workers[0]!.disconnected).toBe(1);
  });
});
