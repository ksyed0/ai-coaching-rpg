import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { EXIT_LIVEKIT_LOST, type ControlToWorker } from "@acr/speech/protocol";
import type { RoomAdmin } from "@acr/adapters/livekit";
import type { ControlConfig } from "../../config.js";
import type { ParentMessage } from "../../protocol.js";
import { RESTART_STABLE_MS, RESTART_TRIES } from "../../voice/restart.js";
import { LIVEKIT_PROBE_TIMEOUT_MS } from "../../voice/livekit-probe.js";
import { VoiceTokens } from "../../voice/tokens.js";
import { VoiceHost, type SpeechSpawnFn, type WorkerHandle } from "../../voice/voice-host.js";
import { AI_CONFIG } from "../fake-child.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 11, the plan's "Restart budget: the decision"): a worker exit 3 (EXIT_LIVEKIT_LOST) while control's
 * probe of LIVEKIT_HOST gets no answer is a LiveKit OUTAGE: it does not spend the five-try restart budget, voice waits (unavailable,
 * one `livekit_lost`), the probe retries after 2, 4, 8, 16, then every 30 s, and when LiveKit answers a new worker starts (one
 * `livekit_recovered`). Every other exit still counts, and so does a re-loss within RESTART_STABLE_MS of a recovery (a crash-looping
 * LiveKit, review finding 13). Fake workers whose exits carry a chosen code, a scripted probe with deferred answers, a manual timer that
 * records each delay, a fake runtime recording parent messages: no process, no network, no real time.
 */
class FakeWorker implements WorkerHandle {
  sent: ControlToWorker[] = [];
  killed = 0; forced = 0; disconnected = 0;
  private msg: ((raw: unknown) => void)[] = [];
  private exitFns: ((c: number | null) => void)[] = [];
  constructor(readonly env: NodeJS.ProcessEnv) {}
  send(m: ControlToWorker): boolean { this.sent.push(m); return true; }
  onMessage(fn: (raw: unknown) => void): void { this.msg.push(fn); }
  onExit(fn: (c: number | null) => void): void { this.exitFns.push(fn); }
  kill(): void { this.killed++; }
  forceKill(): void { this.forced++; }
  disconnect(): void { this.disconnected++; }
  emit(m: unknown): void { for (const f of this.msg) f(m); }
  exit(code: number | null): void { for (const f of this.exitFns) f(code); }
}

type T = { fn: () => void; ms: number; cancelled: boolean };
type Probe = { resolve: (ok: boolean) => void; reject: (e: unknown) => void };
const ID = "a".repeat(32);
const LOST = EXIT_LIVEKIT_LOST;

let timers: T[], tokenTimers: T[], workers: FakeWorker[], toRuntime: { id: string; m: ParentMessage }[], logs: string[], probes: Probe[], runtimeUp: boolean, spawnThrows: number;
const config = { graceMs: 700, logDir: "/data/child-logs" } as ControlConfig;
const setTimer = (fn: () => void, ms: number) => { const t: T = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
const spawn: SpeechSpawnFn = ({ env }) => {
  if (spawnThrows > 0) { spawnThrows--; throw new TypeError("spawn failed"); }
  const w = new FakeWorker(env); workers.push(w); return w;
};
/** The scripted probe: each call waits for the test to answer it (`answer`, `fail`). */
const probe = (): Promise<boolean> => new Promise<boolean>((resolve, reject) => { probes.push({ resolve, reject }); });

function withTokens(): VoiceTokens {
  const admin: RoomAdmin = { removeParticipant: async () => {}, listParticipants: async () => [], deleteRoom: async () => {} };
  let i = 0;
  return new VoiceTokens({
    cfg: { apiKey: "APIkey", apiSecret: "s".repeat(40), host: new URL("http://127.0.0.1:7880"), workerUrl: "ws://127.0.0.1:7880" }, admin,
    random: (k) => { const b = Buffer.alloc(k); for (let o = 0; o < k; o += 32) createHash("sha256").update(String(i++)).digest().copy(b, o); return b; },
    // The tokens' own timers (sweeps, seat waits) are kept apart, so the host's restart and probe delays are read exactly.
    setTimer: (fn, ms) => { const t: T = { fn, ms, cancelled: false }; tokenTimers.push(t); return () => { t.cancelled = true; }; },
    log: (m) => logs.push(m), mint: async () => ({ token: "jwt-p", expiresAt: 1 }), mintWorker: async () => ({ token: "jwt-w", expiresAt: 1 }),
  });
}

/** A LiveKit-ingest host with the probe (the production wiring of main.ts); `o.probe: false` leaves it out, `o.ingest: "file"` too. */
const make = (o: { probe?: boolean; ingest?: "livekit" | "file"; reach?: () => Promise<boolean>; log?: (m: string) => void } = {}) => {
  const ingest = o.ingest ?? "livekit";
  const tokens = withTokens();
  const v = new VoiceHost({
    spawn, config: { ...config, ...AI_CONFIG }, parentEnv: { PATH: "/bin", STT_PROVIDER: "fake", SPEECH_INGEST: ingest }, log: o.log ?? ((m) => logs.push(m)), setTimer,
    toRuntime: (id, m) => { if (!runtimeUp) return false; toRuntime.push({ id, m }); return true; },
    tokens, ...(o.probe === false ? {} : { livekitReachable: o.reach ?? probe }),
  });
  return { v, tokens };
};
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
/** Answers the oldest unanswered probe. */
const answer = async (ok: boolean): Promise<void> => { await flush(); const p = probes.shift(); expect(p, "a probe is waiting").toBeDefined(); p!.resolve(ok); await flush(); };
const fail = async (): Promise<void> => { await flush(); const p = probes.shift(); expect(p, "a probe is waiting").toBeDefined(); p!.reject(new Error("probe broke")); await flush(); };
const live = () => timers.filter((t) => !t.cancelled && t.ms !== RESTART_STABLE_MS);
/** Fires the ONE pending timer that is not a stable timer (a restart backoff or a probe retry) and returns its delay. */
const fireNext = (): number => {
  const p = live();
  expect(p.map((t) => t.ms), "exactly one pending timer").toHaveLength(1);
  p[0]!.cancelled = true; p[0]!.fn();
  return p[0]!.ms;
};
const fireStable = () => { for (const t of timers.filter((x) => x.ms === RESTART_STABLE_MS && !x.cancelled)) { t.cancelled = true; t.fn(); } };
const alerts = () => toRuntime.map((x) => x.m).filter((m) => m.type === "voice_alert").map((m) => (m as { code: string }).code);
const availability = () => toRuntime.map((x) => x.m).filter((m) => m.type === "voice_availability").map((m) => { const a = m as { available: boolean; off: boolean }; return `${a.available}/${a.off}`; });
const ready = (w: FakeWorker) => w.emit({ type: "worker_ready", stt: "ok" });
const attach = (v: VoiceHost) => v.attach(ID, { voice: true, roles: ["tech_lead"] });
const last = () => workers.at(-1)!;
/** A full outage: the live worker exits 3, the probe gets no answer: voice waits (one probe is answered here). */
const outage = async (): Promise<void> => { last().exit(LOST); await answer(false); };
/** The recovery: the next probe retry fires and LiveKit answers; a new worker is spawned. Returns the retry's delay. */
const recover = async (): Promise<number> => { const ms = fireNext(); await answer(true); return ms; };

beforeEach(() => { timers = []; tokenTimers = []; workers = []; toRuntime = []; logs = []; probes = []; runtimeUp = true; spawnThrows = 0; });

describe("a LiveKit outage does not spend the restart budget (US-0072, A1c Task 11)", () => {
  it("an exit 3 while LiveKit does not answer does not count toward the budget (no worker_restarting; the count is unchanged)", async () => {
    const { v } = make();
    attach(v);
    last().exit(1); // one counted fault: the restart after 500 ms
    expect(fireNext()).toBe(500);
    await outage();
    expect(alerts()).toEqual(["worker_restarting", "livekit_lost"]);
    expect(await recover()).toBe(2000);
    last().exit(1); // the next counted fault is the SECOND: 1000 ms (an outage neither raised nor reset the count)
    expect(fireNext()).toBe(1000);
    expect(alerts().filter((c) => c === "worker_restarting")).toHaveLength(2);
  });

  it("a 16 s LiveKit outage keeps voice: probes after 2, 4, 8 s, the worker comes back", async () => {
    const { v } = make();
    attach(v);
    ready(last());
    await outage();
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      delays.push(fireNext());
      expect(workers).toHaveLength(1); // nothing runs while LiveKit is silent
      if (i < 2) await answer(false);
    }
    await answer(true); // the third retry (after 8 s; 2 + 4 + 8 = 14 s into the outage) finds LiveKit back
    expect(delays).toEqual([2000, 4000, 8000]);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.env.SPEECH_INGEST_ROLES).toBe("tech_lead");
    ready(workers[1]!);
    expect(availability().at(-1)).toBe("true/false");
    expect(alerts()).not.toContain("voice_off");
    expect(logs).toContain(`session ${ID} LiveKit does not answer; voice waits for it`);
    expect(logs).toContain(`session ${ID} LiveKit answers again`);
  });

  it("an outage longer than the whole restart budget never turns voice off (20 unanswered probes: 2, 4, 8, 16, then 30 s each)", async () => {
    const { v } = make();
    attach(v);
    await outage();
    const delays: number[] = [];
    for (let i = 0; i < 20; i++) { delays.push(fireNext()); await answer(false); }
    expect(delays).toEqual([2000, 4000, 8000, 16_000, ...Array(16).fill(30_000)]);
    expect(alerts()).toEqual(["livekit_lost"]);
    expect(availability()).not.toContain("false/true");
    expect(workers).toHaveLength(1);
    // Tokens are never turned off by an outage: the token route still answers a holder (the page's own LiveKit connect then fails
    // until LiveKit is back; A1b behaviour, unchanged).
    v.fromRuntime(ID, { type: "voice_seats", paused: false, ended: false, holders: [{ roleId: "tech_lead", participantId: "p-1", recording: true, voiceChosen: true }], open: [] });
    await expect(v.voiceToken(ID, "tech_lead", "p-1")).resolves.toMatchObject({ token: "jwt-p" });
  });

  it("one livekit_lost alert per outage and one livekit_recovered when LiveKit answers", async () => {
    const { v } = make();
    attach(v);
    await outage();
    for (let i = 0; i < 3; i++) { fireNext(); await answer(false); }
    await recover();
    expect(alerts()).toEqual(["livekit_lost", "livekit_recovered"]);
  });

  it("two outages give two of each", async () => {
    const { v } = make();
    attach(v);
    await outage();
    await recover();
    ready(last());
    fireStable(); // the recovered worker ran for 60 s: the next loss is a plain outage again
    await outage();
    await recover();
    expect(alerts()).toEqual(["livekit_lost", "livekit_recovered", "livekit_lost", "livekit_recovered"]);
  });

  it("voice_availability stays false for the whole outage, without flapping", async () => {
    const { v } = make();
    attach(v);
    ready(last());
    const before = availability().length;
    await outage();
    for (let i = 0; i < 6; i++) { fireNext(); await answer(false); }
    attach(v); // a runtime restart in the middle: told false again (every ready is told), no change sent otherwise
    await recover();
    expect(availability().slice(before)).toEqual(["false/false", "false/false"]);
    ready(last());
    expect(availability().slice(before)).toEqual(["false/false", "false/false", "true/false"]);
  });

  it("an exit 3 while LiveKit answers counts like any fault: the 6th such exit turns voice off", async () => {
    const { v } = make();
    attach(v);
    const delays: number[] = [];
    for (let i = 0; i < RESTART_TRIES; i++) { last().exit(LOST); await answer(true); delays.push(fireNext()); }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000]);
    last().exit(LOST);
    await answer(true);
    expect(alerts()).toEqual([...Array(RESTART_TRIES).fill("worker_restarting"), "voice_off"]);
    expect(live()).toEqual([]);
    expect(probes).toEqual([]);
    await expect(v.voiceToken(ID, "tech_lead", "p-1")).rejects.toMatchObject({ code: "voice_off" });
  });

  it("a probe that rejects counts the exit", async () => {
    const { v } = make();
    attach(v);
    last().exit(LOST);
    await fail();
    expect(alerts()).toEqual(["worker_restarting"]);
    expect(fireNext()).toBe(500);
    expect(workers).toHaveLength(2);
  });

  it("a probe that throws synchronously counts the exit too", async () => {
    const throwing = (): Promise<boolean> => { throw new Error("broken probe"); };
    const v = new VoiceHost({
      spawn, config: { ...config, ...AI_CONFIG }, parentEnv: { PATH: "/bin", STT_PROVIDER: "fake", SPEECH_INGEST: "livekit" }, log: (m) => logs.push(m), setTimer,
      toRuntime: (id, m) => { toRuntime.push({ id, m }); return true; }, tokens: withTokens(), livekitReachable: throwing,
    });
    attach(v);
    last().exit(LOST);
    await flush();
    expect(alerts()).toEqual(["worker_restarting"]);
    expect(fireNext()).toBe(500);
  });

  it("exit code 1, exit 0 and a signal (null) count without a probe", async () => {
    const { v } = make();
    attach(v);
    for (const code of [1, 0, null]) { last().exit(code); await flush(); fireNext(); }
    expect(probes).toEqual([]);
    expect(alerts()).toEqual(["worker_restarting", "worker_restarting", "worker_restarting"]);
  });

  it("without a LiveKit ingest an exit 3 counts (file ingest; and a LiveKit host with no probe option)", async () => {
    for (const o of [{ ingest: "file" as const }, { probe: false }]) {
      timers = []; workers = []; toRuntime = []; probes = [];
      const { v } = make(o);
      attach(v);
      last().exit(LOST);
      await flush();
      expect(probes).toEqual([]);
      expect(alerts()).toEqual(["worker_restarting"]);
      expect(fireNext()).toBe(500);
    }
  });

  it("a LiveKit that dies again within 60 s of each recovery turns voice off after the fifth such cycle (the sixth re-loss: failures 6)", async () => {
    const { v } = make();
    attach(v);
    ready(last());
    await outage(); // the first outage is free
    await recover();
    for (let cycle = 1; cycle <= RESTART_TRIES; cycle++) {
      ready(last()); // the recovered worker is ready, but not yet for 60 s
      await outage(); // a re-loss within RESTART_STABLE_MS: counted once (failures = cycle), then the same outage wait
      expect(alerts().filter((c) => c === "voice_off")).toEqual([]);
      expect(fireNext()).toBe(2000); // the probe schedule starts again from 2 s; no backoff spawn
      await answer(true);
    }
    ready(last());
    last().exit(LOST);
    await answer(false); // the sixth re-loss makes the count 6: voice off, and no further probe
    expect(alerts().slice(-2)).toEqual(["livekit_recovered", "voice_off"]);
    expect(alerts().filter((c) => c === "livekit_lost")).toHaveLength(1 + RESTART_TRIES);
    expect(alerts().filter((c) => c === "worker_restarting")).toEqual([]);
    expect(live()).toEqual([]);
    expect(probes).toEqual([]);
    expect(availability().at(-1)).toBe("false/true");
    expect(workers).toHaveLength(2 + RESTART_TRIES);
    await expect(v.voiceToken(ID, "tech_lead", "p-1")).rejects.toMatchObject({ code: "voice_off" });
  });

  it("a re-loss after the recovered worker was ready for 60 s is a plain outage again (not counted)", async () => {
    const { v } = make();
    attach(v);
    for (let i = 0; i < 8; i++) {
      ready(last());
      fireStable();
      await outage();
      await recover();
    }
    // Eight outages, none counted: the next counted fault restarts after 500 ms (the first of five).
    last().exit(1);
    expect(fireNext()).toBe(500);
    expect(alerts().filter((c) => c === "voice_off")).toEqual([]);
  });

  it("a re-loss before the recovered worker even said worker_ready counts too", async () => {
    const { v } = make();
    attach(v);
    await outage();
    await recover();
    await outage(); // counted: failures 1
    await recover();
    last().exit(1); // failures 2: the second delay
    expect(fireNext()).toBe(1000);
  });

  it("the failure count is neither reset nor raised by an outage (three counted faults, an outage, two more, the sixth counted exit is voice off)", async () => {
    const { v } = make();
    attach(v);
    for (let i = 0; i < 3; i++) { last().exit(1); fireNext(); }
    await outage();
    await recover();
    const delays: number[] = [];
    for (let i = 0; i < 2; i++) { last().exit(1); delays.push(fireNext()); }
    expect(delays).toEqual([4000, 8000]); // the 4th and 5th counted faults
    last().exit(1); // the 6th counted exit
    expect(alerts().filter((c) => c === "voice_off")).toHaveLength(1);
    expect(live()).toEqual([]);
  });

  it("a runtime ready during an outage spawns no worker and is told available false (also while the first probe is in flight)", async () => {
    const { v } = make();
    attach(v);
    ready(last());
    last().exit(LOST);
    attach(v); // the probe has not answered yet
    expect(workers).toHaveLength(1);
    await answer(false);
    v.detach(ID);
    attach(v); // a runtime restart during the outage
    expect(workers).toHaveLength(1);
    expect(availability().at(-1)).toBe("false/false");
    expect(live().map((t) => t.ms)).toEqual([2000]); // only the probe retry is pending
  });

  it("end and shutdown during an outage cancel the probe timer and ignore a late probe answer (no spawn, no alert after end)", async () => {
    // end, with a retry probe in flight
    const a = make();
    attach(a.v);
    await outage();
    fireNext(); // a retry probe is in flight now
    a.v.end(ID);
    const n = toRuntime.length;
    await answer(true); // late: LiveKit answers after the end
    expect(workers).toHaveLength(1);
    expect(toRuntime.slice(n)).toEqual([]);
    expect(live()).toEqual([]);
    // end, with only the retry timer pending (it is cancelled; even a queued call starts nothing)
    timers = []; workers = []; toRuntime = []; probes = [];
    const b = make();
    attach(b.v);
    await outage();
    const pending = live()[0]!;
    b.v.end(ID);
    expect(live()).toEqual([]);
    pending.fn();
    expect(probes).toEqual([]);
    // end while the FIRST probe (at the exit) is in flight
    timers = []; workers = []; toRuntime = []; probes = [];
    const c = make();
    attach(c.v);
    last().exit(LOST);
    c.v.end(ID);
    await answer(false);
    expect(toRuntime.filter((x) => x.m.type === "voice_alert")).toEqual([]);
    expect(live()).toEqual([]);
    // shutdown, with a retry probe in flight and with a retry timer pending
    timers = []; workers = []; toRuntime = []; probes = [];
    const d = make();
    attach(d.v);
    d.v.attach("b".repeat(32), { voice: true, roles: ["tech_lead"] });
    workers[0]!.exit(LOST);
    await answer(false);
    workers[1]!.exit(LOST);
    await answer(false);
    fireNextOf(2000); // one session's retry probe in flight, the other's timer pending
    const done = d.v.shutdown();
    expect(live()).toEqual([]);
    await answer(true);
    await done;
    expect(workers).toHaveLength(2);
    expect(alerts().filter((x) => x === "livekit_recovered")).toEqual([]);
  });

  it("a recovered worker gets the seats with each holder's seat generation once ready, and the dead worker's slots went back", async () => {
    const { v, tokens } = make();
    attach(v);
    const holders = [{ roleId: "tech_lead", participantId: "p-1", recording: true, voiceChosen: true }];
    v.fromRuntime(ID, { type: "voice_seats", paused: false, ended: false, holders, open: [] });
    const w1 = last();
    ready(w1);
    w1.emit({ type: "stt_slot_request", slot: "0123456789abcdef" });
    expect(w1.sent.filter((m) => m.type === "stt_slot_grant")).toHaveLength(1);
    await outage();
    await recover();
    const w2 = last();
    expect(w2.sent).toEqual([]); // nothing before its ready
    ready(w2);
    expect(w2.sent).toEqual([{ type: "voice_state", paused: false, ended: false, holders: [{ ...holders[0]!, generation: tokens.generation(ID, "tech_lead", "p-1") }] }]);
    // The dead worker's slot went back at its exit: the new worker gets one at once (STT_GLOBAL_IN_FLIGHT 2: two at once).
    w2.emit({ type: "stt_slot_request", slot: "1123456789abcdef" });
    w2.emit({ type: "stt_slot_request", slot: "2123456789abcdef" });
    expect(w2.sent.filter((m) => m.type === "stt_slot_grant")).toHaveLength(2);
  });

  it("a spawn that throws at the recovery counts (the normal restart path takes over)", async () => {
    const { v } = make();
    attach(v);
    await outage();
    fireNext();
    spawnThrows = 1;
    await answer(true);
    expect(alerts()).toEqual(["livekit_lost", "livekit_recovered", "worker_restarting"]);
    expect(fireNext()).toBe(500);
    expect(workers).toHaveLength(2);
  });

  it("a retry probe that rejects ends the wait and counts (bounded by the budget)", async () => {
    const { v } = make();
    attach(v);
    await outage();
    fireNext();
    await fail();
    expect(alerts()).toEqual(["livekit_lost", "worker_restarting"]);
    expect(fireNext()).toBe(500);
    expect(workers).toHaveLength(2);
  });

  it("nothing logged names a role, a participant or the LiveKit host", async () => {
    const { v } = make();
    attach(v);
    await outage();
    await recover();
    const text = logs.join("\n");
    for (const bad of ["tech_lead", "p-1", "7880", "127.0.0.1"]) expect(text).not.toContain(bad);
  });
});

/** Fires the one pending timer of `ms` (two sessions: one each). */
function fireNextOf(ms: number): void {
  const t = live().find((x) => x.ms === ms);
  expect(t).toBeDefined();
  t!.cancelled = true; t!.fn();
}

describe("review C fix wave (US-0072, A1c Task 11)", () => {
  const WATCHDOG = 2 * LIVEKIT_PROBE_TIMEOUT_MS;
  const fireWatchdog = () => { const t = live().filter((x) => x.ms === WATCHDOG); expect(t).toHaveLength(1); t[0]!.cancelled = true; t[0]!.fn(); };

  it("M2: a probe that never settles is ended by the watchdog (2 x LIVEKIT_PROBE_TIMEOUT_MS) as an error: the exit counts", async () => {
    const { v } = make({ reach: () => new Promise<boolean>(() => {}) });
    attach(v);
    last().exit(LOST);
    await flush();
    expect(live().map((t) => t.ms)).toEqual([WATCHDOG]);
    fireWatchdog();
    await flush();
    expect(alerts()).toEqual(["worker_restarting"]);
    expect(fireNext()).toBe(500);
    expect(workers).toHaveLength(2);
  });

  it("M2: a hanging RETRY probe is ended by the watchdog too (the wait ends and counts), and a late answer after it is ignored", async () => {
    const { v } = make();
    attach(v);
    await outage();
    fireNext(); // the retry probe is out
    await flush();
    fireWatchdog();
    await flush();
    expect(alerts()).toEqual(["livekit_lost", "worker_restarting"]);
    await answer(true); // the real answer, after the watchdog: ignored
    expect(alerts()).toEqual(["livekit_lost", "worker_restarting"]);
    expect(fireNext()).toBe(500);
    expect(workers).toHaveLength(2);
  });

  it("M2: a probe that returns a non-promise value is read as its truth value (false: an outage)", async () => {
    const { v } = make({ reach: (() => false) as unknown as () => Promise<boolean> });
    attach(v);
    last().exit(LOST);
    await flush();
    expect(alerts()).toEqual(["livekit_lost"]);
    expect(live().map((t) => t.ms)).toEqual([2000]); // the watchdog went with the answer
  });

  it("M2: the watchdog is cancelled by the answer, by end and by shutdown", async () => {
    const { v } = make();
    attach(v);
    last().exit(LOST);
    await flush();
    expect(live().map((t) => t.ms)).toEqual([WATCHDOG]);
    v.end(ID);
    expect(live()).toEqual([]);
  });

  it("M3: a log that throws while entering the outage still leaves a retry armed (voice is never stuck waiting with no timer)", async () => {
    const { v } = make({ log: (m) => { if (m.includes("does not answer")) throw new Error("log broke"); logs.push(m); } });
    attach(v);
    await outage();
    expect(live().map((t) => t.ms)).toEqual([2000]);
    await recover();
    expect(workers).toHaveLength(2);
  });

  it("M3: a log that throws while leaving the outage still starts the new worker", async () => {
    const { v } = make({ log: (m) => { if (m.includes("answers again")) throw new Error("log broke"); logs.push(m); } });
    attach(v);
    await outage();
    await recover();
    expect(workers).toHaveLength(2);
  });

  it("M3: a retry timer that cannot be armed leaves the outage to the budget (counted), never waiting with nothing scheduled", async () => {
    let refuse = false;
    const v = new VoiceHost({
      spawn, config: { ...config, ...AI_CONFIG }, parentEnv: { PATH: "/bin", STT_PROVIDER: "fake", SPEECH_INGEST: "livekit" }, log: (m) => logs.push(m),
      setTimer: (fn, ms) => { if (refuse && ms === 2000) { refuse = false; throw new Error("no timer"); } return setTimer(fn, ms); },
      toRuntime: (id, m) => { toRuntime.push({ id, m }); return true; }, tokens: withTokens(), livekitReachable: probe,
    });
    attach(v);
    refuse = true;
    last().exit(LOST);
    await answer(false);
    expect(alerts()).toEqual(["worker_restarting"]);
    expect(fireNext()).toBe(500);
    expect(workers).toHaveLength(2);
  });

  it("shutdown while the FIRST (exit) probe is in flight: no alert, no spawn, no timer, the late answer ignored", async () => {
    const { v } = make();
    attach(v);
    last().exit(LOST);
    await flush();
    const done = v.shutdown();
    expect(live()).toEqual([]);
    await answer(false);
    await done;
    expect(alerts()).toEqual([]);
    expect(workers).toHaveLength(1);
    expect(live()).toEqual([]);
  });

  it("a re-loss while mediaUnstable whose exit probe answers true counts exactly once (as any fault)", async () => {
    const { v } = make();
    attach(v);
    await outage();
    await recover(); // mediaUnstable now
    last().exit(LOST);
    await answer(true); // LiveKit answers: a plain fault, counted once (failures 1)
    expect(fireNext()).toBe(500);
    last().exit(1); // failures 2
    expect(fireNext()).toBe(1000);
  });

  it("a retry probe rejecting while mediaUnstable against a partly spent budget counts once more and keeps the remaining tries", async () => {
    const { v } = make();
    attach(v);
    for (let i = 0; i < 3; i++) { last().exit(1); fireNext(); } // failures 3
    await outage(); // free
    await recover(); // mediaUnstable
    await outage(); // a re-loss: failures 4, outage wait
    fireNext();
    await fail(); // the retry probe breaks: counted, failures 5 -> the last backoff
    expect(fireNext()).toBe(8000);
    last().exit(1); // failures 6: voice off
    expect(alerts().at(-1)).toBe("voice_off");
    expect(alerts().filter((c) => c === "voice_off")).toHaveLength(1);
  });
});

describe("VoiceHost.isLive during a LiveKit outage (US-0075, A2b-1b Task 6)", () => {
  it("is true while the probe is in flight and during mediaLost (no worker, the store lock is free), and false once voice goes off", async () => {
    const { v } = make();
    attach(v);
    ready(last());
    last().exit(LOST); // the probe is in flight
    expect(v.isLive(ID)).toBe(true);
    await answer(false); // mediaLost: waiting for LiveKit
    expect(alerts().at(-1)).toBe("livekit_lost");
    expect(v.isLive(ID)).toBe(true);
    v.end(ID);
    expect(v.isLive(ID)).toBe(false);
  });
});
