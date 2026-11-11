import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlToWorker } from "@acr/speech/protocol";
import type { BotHost } from "../../bots/bot-host.js";
import type { ControlConfig } from "../../config.js";
import { ChildMessageSchema } from "../../protocol.js";
import type { RoomAdmin } from "@acr/adapters/livekit";
import { SessionList } from "../../session-list.js";
import { Supervisor, type SetTimer, type SpawnFn } from "../../supervisor.js";
import { VoiceTokenRefused, VoiceTokens } from "../../voice/tokens.js";
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
    port: 1, serviceToken: "t".repeat(40), maxSessions: 5, dataDir: root, audioDir: path.join(root, "audio"), audioMinFreeMb: 2048, audioMaxRetentionDays: 30, sessionsDir: path.join(root, "sessions"),
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
    expect(c.voice.filter((m) => m.type !== "voice_availability")).toEqual([{ type: "voice_line", segmentId: "0123456789abcdef", roleId: "cfo", participantId: "p1", text: "Hello." }]);
    expect(c.voice.filter((m) => m.type === "voice_availability")).toEqual([{ type: "voice_availability", available: false, off: false }, { type: "voice_availability", available: true, off: false }]);
    c.emit({ type: "voice_line_ack", segmentId: "0123456789abcdef", seq: 7 });
    expect(w.sent.at(-1)).toEqual({ type: "voice_line_result", segmentId: "0123456789abcdef", seq: 7 });
    c.emit({ type: "voice_turn", open: true });
    expect(turns).toEqual([[id, true]]);
    c.emit({ ...SEATS, paused: true });
    expect(w.sent.at(-1)).toEqual({ ...STATE, paused: true });
  });

  it("a killed worker is restarted and voice lines flow again; the session keeps running throughout (US-0071, A1b Task 8)", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    workers[0]!.emit({ type: "worker_ready", stt: "ok" });
    workers[0]!.exit(null); // SIGKILL
    expect(sup.get(id)!.status).toBe("running");
    expect(c.voice.filter((m) => m.type === "voice_alert")).toEqual([{ type: "voice_alert", code: "worker_restarting" }]);
    expect(c.killed).toBe(0);
    const restart = timers.find((t) => t.ms === 500 && !t.cancelled)!;
    restart.cancelled = true; restart.fn();
    expect(workers).toHaveLength(2);
    expect(sup.get(id)!.status).toBe("running");
    const w2 = workers[1]!;
    w2.emit({ type: "worker_ready", stt: "ok" });
    expect(w2.sent.filter((m) => m.type === "voice_state")).toEqual([STATE]); // the seats it missed, without the runtime's help
    w2.emit({ type: "voice_line", segmentId: "0123456789abcdef", roleId: "cfo", participantId: "p1", text: "Hello again.", startMs: 1, endMs: 2 });
    expect(c.voice.filter((m) => m.type === "voice_line")).toEqual([{ type: "voice_line", segmentId: "0123456789abcdef", roleId: "cfo", participantId: "p1", text: "Hello again." }]);
    c.emit({ type: "voice_line_ack", segmentId: "0123456789abcdef", seq: 8 });
    expect(w2.sent.at(-1)).toEqual({ type: "voice_line_result", segmentId: "0123456789abcdef", seq: 8 });
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

  it("a restarted runtime is told the current voice availability at its ready, before any voice line (US-0071, A1b Task 9)", async () => {
    const sup = make();
    const { id, c } = await boot(sup);
    const w = workers[0]!;
    w.emit({ type: "worker_ready", stt: "ok" });
    w.emit({ type: "stt_health", ok: false });
    expect(c.voice.filter((m) => m.type === "voice_availability").at(-1)).toEqual({ type: "voice_availability", available: false, off: false });
    c.exit(1);
    const p = sup.restart(id);
    await settle();
    const c2 = children.at(-1)!;
    c2.emit({ ...READY, voice: true });
    c2.emit({ ...SEATS, paused: true });
    await p;
    await settle();
    expect(c2.voice[0]).toEqual({ type: "voice_availability", available: false, off: false });
    w.emit({ type: "stt_health", ok: true });
    expect(c2.voice.filter((m) => m.type !== "voice_availability")).toEqual([{ type: "voice_alert", code: "stt_recovered" }]);
    expect(c2.voice.filter((m) => m.type === "voice_availability").at(-1)).toEqual({ type: "voice_availability", available: true, off: false });
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

describe("Supervisor and LiveKit tokens (US-0071, A1b Task 5)", () => {
  type Link = ConstructorParameters<typeof Supervisor>[0]["voice"];
  const fakeLink = () => {
    const calls: string[] = [];
    let answer: () => Promise<{ token: string; expiresAt: number }> = async () => ({ token: "jwt", expiresAt: 5 });
    const link = {
      attach: () => {}, fromRuntime: () => {}, detach: () => {}, end: () => {}, shutdown: async () => {},
      voiceToken: (id: string, roleId: string, participantId: string) => { calls.push(`token ${id === "" ? "?" : "id"} ${roleId} ${participantId}`); return answer(); },
      roleReissued: (_id: string, roleId: string) => { calls.push(`reissued ${roleId}`); },
    };
    return { link, calls, setAnswer: (f: typeof answer) => { answer = f; } };
  };
  const withLink = (l: ReturnType<typeof fakeLink>) => new Supervisor({
    config, list, scenarios: async () => [{ id: "other", title: "Other" }], spawn, setTimer, now: () => 1234, log: (m) => logs.push(m),
    voice: (() => l.link) as Link,
  });
  const errOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (err) { return err as { code: string; message: string }; } };

  it("a successful reissue tells the voice host the seat changed hands; a failed one does not", async () => {
    const l = fakeLink();
    const sup = withLink(l);
    const { id, c } = await boot(sup);
    const p = sup.reissue(id, "cfo");
    await settle();
    c.emit({ type: "reissued", requestId: c.sent.at(-1)!.requestId, code: "new-1" });
    await expect(p).resolves.toBe("new-1");
    expect(l.calls).toEqual(["reissued cfo"]);
    const q = errOf(sup.reissue(id, "cto"));
    await settle();
    c.emit({ type: "reissue_failed", requestId: c.sent.at(-1)!.requestId, reason: "no" });
    expect(await q).toMatchObject({ code: "conflict" });
    expect(l.calls).toEqual(["reissued cfo"]);
  });

  it("a whole-session reissue tells the voice host for every role that got a new code", async () => {
    const l = fakeLink();
    const sup = withLink(l);
    const { id, c } = await boot(sup);
    c.onKill = () => setImmediate(() => c.exit(null));
    const p = sup.reissueAll(id);
    await settle();
    const c2 = children.at(-1)!;
    const fresh = [{ roleId: "cfo", code: "n-1" }, { roleId: "cto", code: "n-2" }];
    c2.emit({ type: "codes", codes: fresh }); c2.emit({ ...READY, port: 7001 });
    await expect(p).resolves.toEqual(fresh);
    expect(l.calls).toEqual(["reissued cfo", "reissued cto"]);
  });

  it("voiceToken: unknown session not_found, no voice host voice_unavailable, refusals become their control errors", async () => {
    const l = fakeLink();
    const sup = withLink(l);
    const { id } = await boot(sup);
    expect(await errOf(sup.voiceToken("f".repeat(32), "cfo", "p1"))).toMatchObject({ code: "not_found" });
    await expect(sup.voiceToken(id, "cfo", "p1")).resolves.toEqual({ token: "jwt", expiresAt: 5 });
    for (const [code, message] of [
      ["voice_refused", "Voice is not available for this seat."], ["voice_off", "Voice is off for this session."], ["voice_unavailable", "Voice is not available right now."],
    ] as const) {
      l.setAnswer(async () => { throw new VoiceTokenRefused(code); });
      expect(await errOf(sup.voiceToken(id, "cfo", "p1"))).toMatchObject({ name: "ControlError", code, message });
    }
    l.setAnswer(async () => { throw new Error("tech_lead.g12345678 secret"); });
    expect(await errOf(sup.voiceToken(id, "cfo", "p1"))).toMatchObject({ code: "voice_unavailable", message: "Voice is not available right now." });
    const none = new Supervisor({ config, list, scenarios: async () => [], spawn, setTimer, now: () => 1, log: () => {} });
    expect(await errOf(none.voiceToken(id, "cfo", "p1"))).toMatchObject({ code: "voice_unavailable" });
  });
});

describe("Supervisor and a LiveKit outage (US-0072, A1c Task 11)", () => {
  it("a worker that exits 3 while LiveKit is down is restarted when LiveKit answers", async () => {
    const answers: ((ok: boolean) => void)[] = [];
    const admin: RoomAdmin = { removeParticipant: async () => {}, listParticipants: async () => [], deleteRoom: async () => {} };
    let i = 0;
    const tokens = new VoiceTokens({
      cfg: { apiKey: "APIkey", apiSecret: "s".repeat(40), host: new URL("http://127.0.0.1:7880"), workerUrl: "ws://127.0.0.1:7880" }, admin,
      random: (k) => Buffer.alloc(k, i++), setTimer: () => () => {}, log: () => {},
      mint: async () => ({ token: "jwt-p", expiresAt: 1 }), mintWorker: async () => ({ token: "jwt-w", expiresAt: 1 }),
    });
    const sup = new Supervisor({
      config, list, scenarios: async () => [{ id: "other", title: "Other" }], spawn, setTimer, now: () => 1234, log: (m) => logs.push(m),
      voice: (deps) => new VoiceHost({
        spawn: speechSpawn, config, parentEnv: { SPEECH_INGEST: "livekit" }, log: (m) => logs.push(m), setTimer, ...deps, tokens,
        livekitReachable: () => new Promise<boolean>((resolve) => { answers.push(resolve); }),
      }),
    });
    const { c } = await boot(sup);
    workers[0]!.emit({ type: "worker_ready", stt: "ok" });
    workers[0]!.exit(3);
    await settle(); // the probe is called on a microtask (review C M2)
    answers.shift()!(false);
    await settle();
    expect(c.voice.filter((m) => m.type === "voice_alert")).toEqual([{ type: "voice_alert", code: "livekit_lost" }]);
    const retry = timers.filter((t) => !t.cancelled && t.ms === 2000);
    expect(retry).toHaveLength(1);
    retry[0]!.cancelled = true; retry[0]!.fn();
    await settle();
    answers.shift()!(true);
    await settle();
    expect(workers).toHaveLength(2);
    expect(c.voice.filter((m) => m.type === "voice_alert")).toEqual([{ type: "voice_alert", code: "livekit_lost" }, { type: "voice_alert", code: "livekit_recovered" }]);
    workers[1]!.emit({ type: "worker_ready", stt: "ok" });
    expect(c.voice.filter((m) => m.type === "voice_availability").at(-1)).toEqual({ type: "voice_availability", available: true, off: false });
    expect(workers[1]!.sent.at(-1)).toMatchObject({ type: "voice_state", holders: [{ roleId: "cfo", participantId: "p1" }] });
  });
});
