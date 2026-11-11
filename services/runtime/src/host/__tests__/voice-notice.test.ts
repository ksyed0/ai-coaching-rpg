import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { JoinCodes } from "../../engine/join-codes.js";
import { PlayerCredentials } from "../../engine/credentials.js";
import { ConsentStore } from "../../engine/consent.js";
import { AiRoleSet } from "../../engine/ai-roles.js";
import type { Seats } from "../../engine/seats.js";
import { ALERT_MIN_INTERVAL_MS, MAX_PENDING_VOICE_ALERTS, NOTICE_MIN_INTERVAL_MS, SessionHost } from "../session-host.js";
import * as hostModule from "../session-host.js";
import * as voiceModule from "../voice.js";
import { startServer, type ServerHandle } from "../ws-server.js";
import type { VoiceConfig } from "../voice-config.js";
import { VOICE_ALERT_LEVELS, VOICE_ALERT_SENTENCES, type VoiceNoticeCode } from "../voice.js";
import { VOICE_ALERT_CODES } from "../parent-channel.js";

// US-0070 (Task 10, AC-0399): a failed, empty or refused segment reaches the SPEAKER alone as a private, ephemeral voice_notice (never
// logged, never to anyone else), rate-limited per role and code; the facilitator gets a fixed-sentence voice alert, rate-limited per code.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
const PID = (r: string) => `pid-SECRET-${r}`;
let scenario: Scenario;
beforeAll(async () => { scenario = await loadScenario(friday); });

function makeHost(o: { voice?: VoiceConfig } = {}) {
  const clock = new FakeClock(10_000);
  const log = new MemoryEventLog("local");
  const engine = new SessionEngine({ scenario, log, clock });
  const seats: Seats = { credentials: PlayerCredentials.create(BIND), consent: new ConsentStore({ version: "v3", text: "notice" }), aiRoles: AiRoleSet.empty(), persist: () => {} };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Noted."]), gmProvider: new MockModelProvider(), clock, seats, voice: o.voice ?? { enabled: true, turnEndMs: 800 } });
  const notices: { roleId: string; code: VoiceNoticeCode }[] = [];
  host.onVoiceNotice((roleId, code) => notices.push({ roleId, code }));
  return { host, engine, clock, log, notices };
}
type H = ReturnType<typeof makeHost>;
async function startAll(h: H) {
  for (const r of PLAYERS) { h.host.join(r, PID(r)); h.host.giveConsent(r, PID(r), "v3"); }
  await h.host.start();
}
const alerts = async (h: H) => (await h.log.all()).filter((e): e is Extract<SessionEvent, { type: "facilitator.alert" }> => e.type === "facilitator.alert");

describe("voiceNotice (US-0070, AC-0399)", () => {
  it("goes to the listener for the seat's current holder only; a notice for a non-holder is dropped", async () => {
    const h = makeHost();
    h.host.join("tech_lead", PID("tech_lead"));
    h.host.voiceNotice("tech_lead", PID("tech_lead"), "stt_failed");
    h.host.voiceNotice("tech_lead", "someone-else", "empty");
    h.host.voiceNotice("account_manager", PID("account_manager"), "empty"); // nobody holds it
    h.host.voiceNotice("__proto__", PID("tech_lead"), "empty");
    expect(h.notices).toEqual([{ roleId: "tech_lead", code: "stt_failed" }]);
  });

  it("a second notice of the same code within 10 s is dropped, after 10 s it is sent; another code is not held back", async () => {
    const h = makeHost();
    h.host.join("tech_lead", PID("tech_lead"));
    h.host.voiceNotice("tech_lead", PID("tech_lead"), "empty");
    h.clock.advance(NOTICE_MIN_INTERVAL_MS - 1);
    h.host.voiceNotice("tech_lead", PID("tech_lead"), "empty");
    h.host.voiceNotice("tech_lead", PID("tech_lead"), "stt_failed");
    h.clock.advance(1);
    h.host.voiceNotice("tech_lead", PID("tech_lead"), "empty");
    expect(h.notices.map((n) => n.code)).toEqual(["empty", "stt_failed", "empty"]);
  });

  it("is never sent while voice is off", () => {
    const h = makeHost({ voice: { enabled: false } });
    h.host.join("tech_lead", PID("tech_lead"));
    h.host.voiceNotice("tech_lead", PID("tech_lead"), "stt_failed");
    expect(h.notices).toEqual([]);
  });

  it("the refusals a speaker should hear produce a notice (paused, not_in_scene, ended, not_recording); the others do not", async () => {
    const h = makeHost();
    await startAll(h);
    const say = (r: string, p = PID(r)) => h.host.onVoiceUtterance(r, p, "words").catch(() => undefined);
    await say("tech_lead"); // not_recording
    h.host.optInVoice("tech_lead", PID("tech_lead"), "v3");
    await say("tech_lead", "someone-else"); // not_holder: no notice
    await say("client_sponsor"); // unknown_role
    await h.host.command({ command: "pause" });
    await say("tech_lead"); // paused
    await h.host.command({ command: "resume" });
    await h.host.command({ command: "advance" });
    await h.host.idle();
    await h.engine.tick();
    await say("tech_lead"); // not_in_scene
    await h.host.endNow({});
    await say("tech_lead"); // ended
    expect(h.notices.map((n) => `${n.roleId}:${n.code}`)).toEqual(["tech_lead:not_recording", "tech_lead:paused", "tech_lead:not_in_scene", "tech_lead:ended"]);
    // Notices are never part of the log.
    for (const e of await h.log.all()) expect(JSON.stringify(e)).not.toContain("not_recording");
  });
});

describe("voiceAlert (US-0070, AC-0399)", () => {
  it("appends one facilitator.alert with the fixed sentence and none within 30 s; after 30 s again", async () => {
    const h = makeHost();
    await startAll(h);
    await h.host.voiceAlert("stt_failed");
    await h.host.voiceAlert("stt_failed");
    h.clock.advance(ALERT_MIN_INTERVAL_MS - 1);
    await h.host.voiceAlert("stt_failed");
    await h.host.voiceAlert("worker_down");
    h.clock.advance(1);
    await h.host.voiceAlert("stt_failed");
    await h.host.voiceAlert("stt_unavailable");
    expect((await alerts(h)).map((a) => a.message)).toEqual([VOICE_ALERT_SENTENCES.stt_failed, VOICE_ALERT_SENTENCES.worker_down, VOICE_ALERT_SENTENCES.stt_failed, VOICE_ALERT_SENTENCES.stt_unavailable]);
    expect(VOICE_ALERT_SENTENCES.worker_down).toBe("Voice input stopped: the speech worker is not running. Participants can continue by text.");
  });

  it("nothing is logged before the start, after the end, or while voice is off; never a throw", async () => {
    const h = makeHost();
    await h.host.voiceAlert("worker_down");
    expect(h.engine.state.lastSeq).toBe(0);
    await startAll(h);
    await h.host.endNow({});
    const before = (await alerts(h)).length;
    await h.host.voiceAlert("worker_down");
    expect((await alerts(h)).length).toBe(before);
    const off = makeHost({ voice: { enabled: false } });
    await startAll(off);
    await off.host.voiceAlert("worker_down");
    expect((await alerts(off)).some((a) => a.message === VOICE_ALERT_SENTENCES.worker_down)).toBe(false);
    const h2 = makeHost();
    await startAll(h2);
    vi.spyOn(h2.engine, "alert").mockRejectedValueOnce(new Error("disk"));
    await expect(h2.host.voiceAlert("stt_failed")).resolves.toBeUndefined();
  });

  // F10 (review fix wave): a worker that dies in the lobby (bad SPEECH_INGEST_DIR or STT_URL) or a whisper-server down at warm-up must
  // still reach the facilitator: alerts raised before the start are kept (deduped by code, bounded, the latest last) and logged at the start.
  it("an alert raised before the start is delivered at the start, exactly once", async () => {
    const h = makeHost();
    await h.host.voiceAlert("worker_down");
    expect(await alerts(h)).toEqual([]);
    await startAll(h);
    await vi.waitFor(async () => expect((await alerts(h)).map((a) => a.message)).toEqual([VOICE_ALERT_SENTENCES.worker_down]));
    await h.host.voiceAlert("stt_unavailable"); // after the start: at once, as before
    await h.host.idle();
    await h.host.start(); // a second start call changes nothing
    expect((await alerts(h)).map((a) => a.message)).toEqual([VOICE_ALERT_SENTENCES.worker_down, VOICE_ALERT_SENTENCES.stt_unavailable]);
  });

  it("pre-start alerts are deduped by code and bounded, the latest raised last", async () => {
    const h = makeHost();
    for (let i = 0; i < 50; i++) for (const c of ["stt_failed", "worker_down", "stt_unavailable"] as const) await h.host.voiceAlert(c);
    await h.host.voiceAlert("stt_failed"); // raised again: now the latest
    const pending = (h.host as unknown as { pendingAlerts: Set<string> }).pendingAlerts;
    expect(pending.size).toBeLessThanOrEqual(MAX_PENDING_VOICE_ALERTS);
    expect([...pending]).toEqual(["worker_down", "stt_unavailable", "stt_failed"]);
    await startAll(h);
    await vi.waitFor(async () => expect((await alerts(h)).map((a) => a.message)).toEqual([VOICE_ALERT_SENTENCES.worker_down, VOICE_ALERT_SENTENCES.stt_unavailable, VOICE_ALERT_SENTENCES.stt_failed]));
    expect(pending.size).toBe(0);
  });

  it("pre-start write_error and disk_low are not evicted by every other code (the bound is one per code)", async () => {
    const h = makeHost();
    await h.host.voiceAlert("write_error");
    await h.host.voiceAlert("disk_low");
    for (const c of VOICE_ALERT_CODES) if (c !== "write_error" && c !== "disk_low") await h.host.voiceAlert(c);
    const pending = (h.host as unknown as { pendingAlerts: Set<string> }).pendingAlerts;
    expect(MAX_PENDING_VOICE_ALERTS).toBe(VOICE_ALERT_CODES.length);
    expect(pending.has("write_error")).toBe(true);
    expect(pending.has("disk_low")).toBe(true);
    expect(pending.size).toBe(VOICE_ALERT_CODES.length);
  });

  it("no pre-start alert is kept while voice is off", async () => {
    const off = makeHost({ voice: { enabled: false } });
    await off.host.voiceAlert("worker_down");
    await startAll(off);
    await off.host.idle();
    expect((await alerts(off)).some((a) => a.message === VOICE_ALERT_SENTENCES.worker_down)).toBe(false);
  });

  it("a player never receives a facilitator.alert (regression guard)", async () => {
    const h = makeHost();
    await startAll(h);
    await h.host.voiceAlert("stt_unavailable");
    const alert = (await alerts(h)).find((a) => a.message === VOICE_ALERT_SENTENCES.stt_unavailable)!;
    for (const r of PLAYERS) expect(h.host.viewFor(r, alert)).toBeNull();
    expect(h.host.viewFor("facilitator", alert)).toEqual(alert);
  });
});

describe("the US-0071 alert codes (Task 3, K8)", () => {
  it("stt_recovered appends one info alert", async () => {
    const h = makeHost();
    await startAll(h);
    await h.host.voiceAlert("stt_recovered");
    await h.host.voiceAlert("stt_recovered"); // rate limited like the others
    const got = (await alerts(h)).filter((a) => a.message === VOICE_ALERT_SENTENCES.stt_recovered);
    expect(got.map((a) => a.level)).toEqual(["info"]);
    await h.host.voiceAlert("worker_restarting");
    await h.host.voiceAlert("voice_off");
    const levels = Object.fromEntries((await alerts(h)).map((a) => [a.message, a.level]));
    expect(levels[VOICE_ALERT_SENTENCES.worker_restarting]).toBe("warning");
    expect(levels[VOICE_ALERT_SENTENCES.voice_off]).toBe("warning");
  });

  it("the new alert sentences are fixed and contain no code or id", () => {
    expect(VOICE_ALERT_SENTENCES.worker_restarting).toBe("Voice input is restarting after a fault.");
    expect(VOICE_ALERT_SENTENCES.voice_off).toBe("Voice input is off for this session after repeated faults. Participants can continue by text.");
    expect(VOICE_ALERT_SENTENCES.stt_recovered).toBe("Voice input is available again.");
    for (const [code, sentence] of Object.entries(VOICE_ALERT_SENTENCES)) {
      expect(sentence).not.toContain(code);
      expect(sentence).not.toMatch(/[_0-9]/);
    }
    expect(VOICE_ALERT_LEVELS).toEqual({ worker_down: "warning", stt_unavailable: "warning", stt_failed: "warning", worker_restarting: "warning", voice_off: "warning", stt_recovered: "info", livekit_lost: "warning", livekit_recovered: "info", disk_low: "warning", write_error: "warning" });
  });

  it("US-0072 (A1c Task 10): the two LiveKit outage sentences are fixed and livekit_recovered is info", () => {
    expect(VOICE_ALERT_SENTENCES.livekit_lost).toBe("Voice input lost the LiveKit media server. It reconnects when the server answers; participants can continue by text.");
    // Revision 2 (K15): the pages do not rejoin by themselves; the sentence tells the facilitator so.
    expect(VOICE_ALERT_SENTENCES.livekit_recovered).toBe("The LiveKit media server answers again; voice input is restarting. Participants who lost voice press Join with voice again.");
    expect(VOICE_ALERT_LEVELS.livekit_lost).toBe("warning");
    expect(VOICE_ALERT_LEVELS.livekit_recovered).toBe("info");
  });

  it("VOICE_ALERT_SENTENCES is exported from host/voice.ts", () => {
    expect(Object.keys(voiceModule.VOICE_ALERT_SENTENCES).sort()).toEqual(["disk_low", "livekit_lost", "livekit_recovered", "stt_failed", "stt_recovered", "stt_unavailable", "voice_off", "worker_down", "worker_restarting", "write_error"]);
    expect("VOICE_ALERT_SENTENCES" in hostModule).toBe(false); // one source: a web test may import voice.ts, never session-host.ts
  });
});

// The socket: a voice_notice reaches only the speaker's live socket.
let server: ServerHandle | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const s of sockets) s.terminate(); sockets = []; await server?.close(); server = null; });
type Client = { inbox: any[]; send(m: unknown): void; next(pred: (m: any) => boolean): Promise<any> };
async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const next = (pred: (m: any) => boolean) => new Promise<any>((resolve) => { const found = inbox.find(pred); if (found) return resolve(found); waiters.push({ pred, resolve }); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { inbox, next, send: (m) => ws.send(JSON.stringify(m)) };
}

describe("voice_notice on the socket (US-0070, AC-0399)", () => {
  it("a voice_notice reaches only the speaker's socket; it is not in the log, not in another player's frames, not in the facilitator's", async () => {
    const h = makeHost();
    const issued = JoinCodes.issue(PLAYERS, BIND);
    server = await startServer({ port: 0, hosts: new Map([["local", h.host]]), log: () => {}, joinCodes: new Map([["local", issued.codes]]) });
    const join = async (roleId: string, participantId: string) => {
      const c = await open(server!.port);
      c.send({ type: "join", sessionId: "local", roleId, participantId, joinCode: issued.plain[roleId] });
      expect((await c.next((m) => m.type === "joined" || m.type === "error")).type).toBe("joined");
      return c;
    };
    const pat = await join("tech_lead", "pat");
    const sam = await join("account_manager", "sam");
    const fac = await open(server.port);
    fac.send({ type: "join_facilitator", sessionId: "local" });
    await fac.next((m) => m.type === "joined");
    h.host.voiceNotice("tech_lead", "pat", "stt_failed");
    h.host.voiceNotice("account_manager", "not-sam", "empty"); // not the holder: dropped
    expect(await pat.next((m) => m.type === "voice_notice")).toEqual({ type: "voice_notice", code: "stt_failed" });
    // Barriers: each other socket gets the answer to a message of its own, so every frame sent to it before has arrived.
    sam.send({ type: "voice_opt_out" });
    await sam.next((m) => m.type === "voice" || m.type === "error");
    fac.send({ type: "voice_opt_out" });
    await fac.next((m) => m.type === "error");
    for (const c of [sam, fac]) for (const m of c.inbox) { expect(m.type).not.toBe("voice_notice"); expect(JSON.stringify(m)).not.toContain("stt_failed"); }
    for (const e of await h.log.all()) expect(JSON.stringify(e)).not.toContain("stt_failed");
    expect(pat.inbox.filter((m) => m.type === "voice_notice")).toHaveLength(1);
  });
});

describe("US-0073 (A2a Task 8): the audio store's stop alerts", () => {
  it("disk_low and write_error are fixed warning sentences that say the transcript continues", () => {
    expect(VOICE_ALERT_SENTENCES.disk_low).toBe("Recording stopped: the disk is nearly full. The transcript continues.");
    expect(VOICE_ALERT_SENTENCES.write_error).toBe("Recording stopped: audio could not be saved. The transcript continues.");
    expect(VOICE_ALERT_LEVELS.disk_low).toBe("warning");
    expect(VOICE_ALERT_LEVELS.write_error).toBe("warning");
  });
});
