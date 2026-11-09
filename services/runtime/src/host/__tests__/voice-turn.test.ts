import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import { EngineError, SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { PlayerCredentials } from "../../engine/credentials.js";
import { ConsentStore } from "../../engine/consent.js";
import { AiRoleSet } from "../../engine/ai-roles.js";
import type { Seats } from "../../engine/seats.js";
import { SessionHost } from "../session-host.js";
import { VOICE_ACTIVITY_STALE_MS, VoiceTurnTracker, type SetTimer } from "../voice.js";
import { bootstrap, type Runtime } from "../../main.js";
import type { ChildMessage, ParentChannel, ParentMessage } from "../parent-channel.js";

// US-0070 (Task 7, AC-0400): one NPC round per voice turn. The host keeps ONE turn timer on an injected SetTimer: it arms when every
// recording track is silent, for TURN_END_MS minus the time already silent, and the round starts only after every voice line received
// so far is recorded (C3). A text line ends the turn at once; pause and end clear it. No real time anywhere: the timers fire by hand.

/** A manual SetTimer: records [fn, ms], fires on demand, and knows which timers were cancelled. */
function manualTimers() {
  type T = { fn: () => void; ms: number; cancelled: boolean; fired: boolean };
  const all: T[] = [];
  const setTimer: SetTimer = (fn, ms) => { const t: T = { fn, ms, cancelled: false, fired: false }; all.push(t); return () => { t.cancelled = true; }; };
  const live = () => all.filter((t) => !t.cancelled && !t.fired);
  return {
    setTimer, all, live,
    /** Fires the one live timer (there must be exactly one). */
    fire() { const l = live(); expect(l).toHaveLength(1); l[0]!.fired = true; l[0]!.fn(); },
    /** Fires the one live timer of `ms` (there must be exactly one). */
    fireMs(ms: number) { const l = live().filter((t) => t.ms === ms); expect(l).toHaveLength(1); l[0]!.fired = true; l[0]!.fn(); },
  };
}

describe("VoiceTurnTracker (US-0070, AC-0400)", () => {
  function make(turnEndMs = 800) {
    const t = manualTimers();
    const ends: number[] = [];
    const opens: boolean[] = [];
    const tracker = new VoiceTurnTracker({ turnEndMs, setTimer: t.setTimer, onTurnEnd: () => ends.push(1), onOpenChange: (o) => opens.push(o) });
    return { t, tracker, ends, opens };
  }

  it("a false edge with silentMs 500 arms 300 ms when turnEndMs is 800", () => {
    const { t, tracker, ends } = make();
    tracker.activity("a", true);
    tracker.activity("a", false, 500);
    expect(t.live().map((x) => x.ms)).toEqual([300]);
    expect(tracker.open).toBe(true);
    t.fire();
    expect(ends).toHaveLength(1);
    expect(tracker.open).toBe(false);
  });

  it("silentMs above turnEndMs arms 0", () => {
    const { t, tracker } = make();
    tracker.activity("a", false, 5000);
    expect(t.live().map((x) => x.ms)).toEqual([0]);
  });

  it("a false edge without silentMs arms the whole turnEndMs", () => {
    const { t, tracker } = make(1200);
    tracker.activity("a", false);
    expect(t.live().map((x) => x.ms)).toEqual([1200]);
  });

  it("new speech on any role cancels the timer", () => {
    const { t, tracker, ends } = make();
    tracker.activity("a", true);
    tracker.activity("a", false, 100);
    const armed = t.live()[0]!;
    tracker.activity("b", true);
    expect(armed.cancelled).toBe(true);
    expect(t.live()).toHaveLength(0);
    expect(tracker.open).toBe(true);
    armed.fn(); // a cancelled timer that fires anyway (a racing clock) does nothing
    expect(ends).toHaveLength(0);
  });

  it("two speakers: the timer arms only when both are silent", () => {
    const { t, tracker, ends } = make();
    tracker.activity("a", true);
    tracker.activity("b", true);
    tracker.activity("a", false, 200);
    expect(t.live()).toHaveLength(0);
    tracker.activity("b", false, 100);
    expect(t.live().map((x) => x.ms)).toEqual([700]);
    t.fire();
    expect(ends).toHaveLength(1);
  });

  it("a later false edge with no active role re-arms from its own silentMs", () => {
    const { t, tracker } = make();
    tracker.activity("a", false, 100);
    const first = t.live()[0]!;
    tracker.activity("b", false, 600);
    expect(first.cancelled).toBe(true);
    expect(t.live().map((x) => x.ms)).toEqual([200]);
  });

  it("textLine ends the turn at once and cancels the timer", () => {
    const { t, tracker, ends } = make();
    tracker.activity("a", false, 0);
    const armed = t.live()[0]!;
    tracker.textLine();
    expect(armed.cancelled).toBe(true);
    expect(ends).toHaveLength(1);
    expect(tracker.open).toBe(false);
  });

  it("textLine with no timer pending does nothing (a typed line schedules its own round)", () => {
    const { tracker, ends, opens } = make();
    tracker.textLine();
    tracker.activity("a", true);
    tracker.textLine(); // someone is still speaking: the turn stays open
    expect(ends).toHaveLength(0);
    expect(tracker.open).toBe(true);
    expect(opens).toEqual([true]);
  });

  it("clear closes without onTurnEnd", () => {
    const { t, tracker, ends, opens } = make();
    tracker.activity("a", true);
    tracker.activity("b", false, 0);
    tracker.activity("c", true);
    tracker.activity("c", false, 0);
    tracker.clear();
    expect(t.live()).toHaveLength(0);
    expect(tracker.open).toBe(false);
    expect(ends).toHaveLength(0);
    expect(opens).toEqual([true, false]);
    tracker.activity("c", false, 0); // a role forgotten by clear: a fresh false edge arms a fresh timer
    expect(t.live()).toHaveLength(1);
  });

  it("onOpenChange fires once per change", () => {
    const { t, tracker, opens } = make();
    tracker.activity("a", true);
    tracker.activity("b", true);
    tracker.activity("a", false, 0);
    tracker.activity("b", false, 0);
    tracker.activity("b", false, 0);
    expect(opens).toEqual([true]);
    t.fire();
    expect(opens).toEqual([true, false]);
    tracker.clear();
    expect(opens).toEqual([true, false]);
  });

  it("forget drops a role that may no longer record; the last active one arms the timer for the lines already recorded", () => {
    const { t, tracker } = make();
    tracker.activity("a", true);
    tracker.activity("b", true);
    tracker.forget("a");
    expect(t.live()).toHaveLength(0);
    tracker.forget("b");
    expect(t.live().map((x) => x.ms)).toEqual([800]);
    tracker.forget("nobody"); // not active: nothing changes
    expect(t.live()).toHaveLength(1);
  });

  // F2 (review fix wave): a worker that dies mid-speech sends no "speech stopped" edge; the turn must not stay open for the session.
  it("with staleMs, a speaking role with no news is forgotten after staleMs and the turn timer then arms", () => {
    const t = manualTimers();
    const ends: number[] = [];
    const tracker = new VoiceTurnTracker({ turnEndMs: 800, setTimer: t.setTimer, onTurnEnd: () => ends.push(1), onOpenChange: () => {}, staleMs: 12_000 });
    tracker.activity("a", true);
    expect(t.live().map((x) => x.ms)).toEqual([12_000]);
    t.fireMs(12_000);
    expect(tracker.isActive("a")).toBe(false);
    expect(t.live().map((x) => x.ms)).toEqual([800]);
    t.fire();
    expect(ends).toHaveLength(1);
    expect(tracker.open).toBe(false);
  });

  it("news restarts the backstop (touch, a new true edge); a false edge, forget and clear cancel it; a superseded fire does nothing", () => {
    const t = manualTimers();
    const tracker = new VoiceTurnTracker({ turnEndMs: 800, setTimer: t.setTimer, onTurnEnd: () => {}, onOpenChange: () => {}, staleMs: 12_000 });
    tracker.activity("a", true);
    const first = t.live()[0]!;
    tracker.touch("a");
    expect(first.cancelled).toBe(true);
    first.fn(); // a cancelled backstop that fires anyway forgets nobody
    expect(tracker.isActive("a")).toBe(true);
    expect(t.live().map((x) => x.ms)).toEqual([12_000]);
    tracker.activity("a", true);
    expect(t.live().map((x) => x.ms)).toEqual([12_000]);
    tracker.touch("nobody"); // not speaking: no backstop
    expect(t.live()).toHaveLength(1);
    tracker.activity("a", false, 0);
    expect(t.live().map((x) => x.ms)).toEqual([800]);
    tracker.activity("b", true);
    tracker.forget("b");
    expect(t.live().map((x) => x.ms)).toEqual([800]);
    tracker.activity("c", true);
    tracker.clear();
    expect(t.live()).toHaveLength(0);
  });

  it("without staleMs no backstop is armed", () => {
    const { t, tracker } = make();
    tracker.activity("a", true);
    expect(t.live()).toHaveLength(0);
  });

  it("dropAll ends an open turn at once (onTurnEnd once, closed, no timer left); with no open turn it does nothing", () => {
    const t = manualTimers();
    const ends: number[] = [];
    const opens: boolean[] = [];
    const tracker = new VoiceTurnTracker({ turnEndMs: 800, setTimer: t.setTimer, onTurnEnd: () => ends.push(1), onOpenChange: (o) => opens.push(o), staleMs: 12_000 });
    tracker.dropAll();
    expect(ends).toHaveLength(0);
    tracker.activity("a", true);
    tracker.activity("b", true);
    tracker.dropAll();
    expect(ends).toHaveLength(1);
    expect(tracker.open).toBe(false);
    expect(t.live()).toHaveLength(0);
    expect(opens).toEqual([true, false]);
    tracker.activity("a", false, 0); // only a timer pending: the turn still ends at once
    tracker.dropAll();
    expect(ends).toHaveLength(2);
    expect(t.live()).toHaveLength(0);
  });

  it("closedTurnEnds keeps rising boundaries only", () => {
    const { tracker } = make();
    tracker.recordTurnEnd(5);
    tracker.recordTurnEnd(5);
    tracker.recordTurnEnd(3);
    tracker.recordTurnEnd(9);
    tracker.recordTurnEnd(0);
    expect(tracker.closedTurnEnds).toEqual([5, 9]);
  });
});

// The host, over a real engine on a memory log.
const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
const PID = (r: string) => `p-${r}`;
let scenario: Scenario;

function makeHost() {
  const timers = manualTimers();
  const clock = new FakeClock(10_000);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock });
  const seats: Seats = { credentials: PlayerCredentials.create(BIND), consent: new ConsentStore({ version: "v3", text: "notice" }), aiRoles: AiRoleSet.empty(), persist: () => {} };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Noted."]), gmProvider: new MockModelProvider(), clock, seats, voice: { enabled: true, turnEndMs: 800 }, setTimer: timers.setTimer });
  // One NPC round = one reply-order computation (the round's first step once a scene is current).
  const rounds = vi.spyOn(host as unknown as { replyOrder: (p: string[]) => string[] }, "replyOrder");
  return { host, engine, timers, rounds };
}
type H = ReturnType<typeof makeHost>;
async function startVoice(h: H) {
  for (const r of PLAYERS) { h.host.join(r, PID(r)); h.host.giveConsent(r, PID(r), "v3"); }
  await h.host.start();
  h.host.optInVoice("tech_lead", PID("tech_lead"), "v3");
  h.host.optInVoice("delivery_lead", PID("delivery_lead"), "v3");
}
/** One turn of the event loop (no real time): lets queued promise callbacks run. */
const turn = () => new Promise<void>((r) => setImmediate(r));

describe("SessionHost voice turns (US-0070, AC-0400)", () => {
  beforeAll(async () => { scenario = await loadScenario(friday); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("two voice lines then a false edge run ONE round after the timer", async () => {
    const h = makeHost();
    await startVoice(h);
    h.host.onSpeechActivity("tech_lead", true);
    expect(h.host.voiceTurnOpen).toBe(true);
    await h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "First part of the thought.");
    await h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "And the second part.");
    await h.host.idle(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(0);
    h.host.onSpeechActivity("tech_lead", false, 500);
    expect(h.timers.live().map((t) => t.ms)).toEqual([300]);
    h.timers.fire();
    await vi.waitFor(() => expect(h.rounds).toHaveBeenCalledTimes(1));
    await h.host.idle(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(1);
    expect(h.host.voiceTurnOpen).toBe(false);
  });

  it("the round waits for a voice line still being recorded (C3)", async () => {
    const h = makeHost();
    await startVoice(h);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const say = h.engine.say.bind(h.engine);
    vi.spyOn(h.engine, "say").mockImplementationOnce(async (...a: Parameters<SessionEngine["say"]>) => { await gate; return say(...a); });
    h.host.onSpeechActivity("tech_lead", true);
    const line = h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "Still being written.");
    h.host.onSpeechActivity("tech_lead", false, 800);
    h.timers.fire();
    await h.host.idle(); await turn(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(0);
    release();
    const { seq } = await line;
    await vi.waitFor(() => expect(h.rounds).toHaveBeenCalledTimes(1));
    await h.host.idle(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(1);
    expect(h.host.voiceTurnEnds).toEqual([seq]);
  });

  it("a voice line arriving with no speech active and no timer schedules a round at once", async () => {
    const h = makeHost();
    await startVoice(h);
    const { seq } = await h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "Out of the blue.");
    await vi.waitFor(() => expect(h.rounds).toHaveBeenCalledTimes(1));
    expect(h.timers.all).toHaveLength(0);
    expect(h.host.voiceTurnEnds).toEqual([seq]);
    await h.host.idle();
  });

  it("a text line during an open voice turn runs a round at once and the later timer adds at most one more (R25)", async () => {
    const h = makeHost();
    await startVoice(h);
    h.host.onSpeechActivity("tech_lead", true);
    await h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "I think we should wait.");
    await h.host.onPlayerUtterance("account_manager", "Typed while they talk.");
    await vi.waitFor(() => expect(h.rounds).toHaveBeenCalledTimes(1));
    await h.host.idle();
    h.host.onSpeechActivity("tech_lead", false, 0);
    h.timers.fire();
    await vi.waitFor(() => expect(h.rounds).toHaveBeenCalledTimes(2));
    await h.host.idle(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(2);
  });

  it("a text line cancels a pending timer: one round, and the cancelled timer adds none", async () => {
    const h = makeHost();
    await startVoice(h);
    h.host.onSpeechActivity("tech_lead", true);
    await h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "Let me finish.");
    h.host.onSpeechActivity("tech_lead", false, 0);
    const armed = h.timers.live()[0]!;
    await h.host.onPlayerUtterance("account_manager", "Typed reply.");
    expect(armed.cancelled).toBe(true);
    await vi.waitFor(() => expect(h.rounds).toHaveBeenCalledTimes(1));
    await h.host.idle(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(1);
  });

  it("pause clears the timer and no round runs; resume does not start one", async () => {
    const h = makeHost();
    await startVoice(h);
    h.host.onSpeechActivity("tech_lead", true);
    await h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "Before the pause.");
    h.host.onSpeechActivity("tech_lead", false, 0);
    const armed = h.timers.live()[0]!;
    await h.host.command({ command: "pause" });
    expect(armed.cancelled).toBe(true);
    expect(h.host.voiceTurnOpen).toBe(false);
    h.host.onSpeechActivity("tech_lead", true); // ignored while paused
    expect(h.host.voiceTurnOpen).toBe(false);
    await h.host.command({ command: "resume" });
    await h.host.idle(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(0);
    expect(h.timers.live()).toHaveLength(0);
  });

  it("a timer that already fired before the pause starts no round after it", async () => {
    const h = makeHost();
    await startVoice(h);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const say = h.engine.say.bind(h.engine);
    vi.spyOn(h.engine, "say").mockImplementationOnce(async (...a: Parameters<SessionEngine["say"]>) => { await gate; return say(...a); });
    h.host.onSpeechActivity("tech_lead", true);
    const line = h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "Slow to record.");
    h.host.onSpeechActivity("tech_lead", false, 800);
    h.timers.fire(); // the turn ended; its round waits for the line
    const paused = h.host.command({ command: "pause" });
    release();
    await line.catch(() => undefined);
    await paused;
    await h.host.idle(); await turn(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(0);
  });

  it("end clears it", async () => {
    const h = makeHost();
    await startVoice(h);
    h.host.onSpeechActivity("tech_lead", false, 0);
    const armed = h.timers.live()[0]!;
    await h.host.endNow({});
    expect(armed.cancelled).toBe(true);
    expect(h.host.voiceTurnOpen).toBe(false);
    h.host.onSpeechActivity("tech_lead", false, 0);
    expect(h.timers.live()).toHaveLength(0);
  });

  it("speech_activity for a non-recording role is ignored (no choice, an AI character, an unknown id, before the start)", async () => {
    const h = makeHost();
    h.host.join("tech_lead", PID("tech_lead"));
    h.host.giveConsent("tech_lead", PID("tech_lead"), "v3");
    h.host.optInVoice("tech_lead", PID("tech_lead"), "v3");
    h.host.onSpeechActivity("tech_lead", true); // not started yet
    expect(h.host.voiceTurnOpen).toBe(false);
    for (const r of ["account_manager", "delivery_lead"]) { h.host.join(r, PID(r)); h.host.giveConsent(r, PID(r), "v3"); }
    await h.host.start();
    for (const r of ["account_manager", "client_sponsor", "__proto__", "nobody"]) { h.host.onSpeechActivity(r, true); h.host.onSpeechActivity(r, false, 0); }
    expect(h.host.voiceTurnOpen).toBe(false);
    expect(h.timers.all).toHaveLength(0);
  });

  it("a speaker who opts out mid-speech no longer holds the turn open; the timer answers the lines already recorded", async () => {
    const h = makeHost();
    await startVoice(h);
    h.host.onSpeechActivity("tech_lead", true);
    await h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "Half a thought.");
    h.host.optOutVoice("tech_lead", PID("tech_lead"));
    await turn();
    expect(h.timers.live().map((t) => t.ms)).toEqual([800]);
    h.timers.fire();
    await vi.waitFor(() => expect(h.rounds).toHaveBeenCalledTimes(1));
    await h.host.idle();
  });

  it("a running round is not interrupted by new speech", async () => {
    const h = makeHost();
    await startVoice(h);
    // The opening scene has no AI character, so the round's last step (the Game Master tick) shows it ran to its end.
    const gmTicks = vi.spyOn((h.host as unknown as { gm: { tick: () => Promise<void> } }).gm, "tick");
    await h.host.onPlayerUtterance("account_manager", "Typed first.");
    h.host.onSpeechActivity("tech_lead", true);
    await h.host.idle();
    expect(h.rounds).toHaveBeenCalledTimes(1);
    expect(gmTicks).toHaveBeenCalledTimes(1);
    expect(h.host.voiceTurnOpen).toBe(true);
  });

  // F1 (review fix wave): a turn that recorded no line (a cough under 300 ms, an empty or failed segment, a refused line) must not make
  // an AI character speak unprompted: no round runs for it, and no boundary is recorded.
  it("a turn whose only segment was dropped (no line at all) runs no round", async () => {
    const h = makeHost();
    await startVoice(h);
    h.host.onSpeechActivity("tech_lead", true);
    h.host.onSpeechActivity("tech_lead", false, 0);
    h.timers.fire();
    await h.host.idle(); await turn(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(0);
    expect(h.host.voiceTurnEnds).toEqual([]);
  });

  it("a turn whose only line was refused runs no round (not_holder, and an engine refusal)", async () => {
    const h = makeHost();
    await startVoice(h);
    h.host.onSpeechActivity("tech_lead", true);
    await expect(h.host.onVoiceUtterance("tech_lead", "someone-else", "Not mine.")).rejects.toMatchObject({ code: "not_holder" });
    vi.spyOn(h.engine, "say").mockRejectedValueOnce(new EngineError("not_in_scene"));
    await expect(h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "Between scenes.")).rejects.toMatchObject({ code: "not_in_scene" });
    h.host.onSpeechActivity("tech_lead", false, 0);
    h.timers.fire();
    await h.host.idle(); await turn(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(0);
  });

  it("after an answered turn, an empty turn runs no second round; the next turn with a line runs exactly one", async () => {
    const h = makeHost();
    await startVoice(h);
    h.host.onSpeechActivity("tech_lead", true);
    await h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "A real line.");
    h.host.onSpeechActivity("tech_lead", false, 0);
    h.timers.fire();
    await vi.waitFor(() => expect(h.rounds).toHaveBeenCalledTimes(1));
    await h.host.idle();
    h.host.onSpeechActivity("delivery_lead", true); // a cough
    h.host.onSpeechActivity("delivery_lead", false, 0);
    h.timers.fire();
    await h.host.idle(); await turn(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(1);
    h.host.onSpeechActivity("delivery_lead", true);
    await h.host.onVoiceUtterance("delivery_lead", PID("delivery_lead"), "Now a real answer.");
    h.host.onSpeechActivity("delivery_lead", false, 0);
    h.timers.fire();
    await vi.waitFor(() => expect(h.rounds).toHaveBeenCalledTimes(2));
    await h.host.idle(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(2);
  });

  it("the worker going down mid-speech closes the turn at once: closed, the Game Master no longer held, one round for its line", async () => {
    const h = makeHost();
    const seen: boolean[] = [];
    h.host.onVoiceTurn((o) => seen.push(o));
    await startVoice(h);
    const gm = (h.host as unknown as { gm: { hold: () => boolean } }).gm;
    h.host.onSpeechActivity("tech_lead", true);
    await h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "Cut off mid-sentence.");
    expect(h.host.voiceTurnOpen).toBe(true);
    h.host.voiceWorkerDown();
    expect(h.host.voiceTurnOpen).toBe(false);
    expect(seen).toEqual([true, false]);
    expect(h.timers.live()).toHaveLength(0);
    expect(gm.hold()).toBe(false);
    await vi.waitFor(() => expect(h.rounds).toHaveBeenCalledTimes(1));
    await h.host.idle(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(1);
    h.host.voiceWorkerDown(); // again: nothing open, nothing happens
    await h.host.idle(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(1);
  });

  it("the worker going down mid-speech with no line recorded closes the turn and runs no round", async () => {
    const h = makeHost();
    await startVoice(h);
    h.host.onSpeechActivity("tech_lead", true);
    h.host.voiceWorkerDown();
    expect(h.host.voiceTurnOpen).toBe(false);
    await h.host.idle(); await turn(); await turn();
    expect(h.rounds).toHaveBeenCalledTimes(0);
  });

  it("the backstop: a speaking track with no news for VOICE_ACTIVITY_STALE_MS is forgotten and the turn closes", async () => {
    const h = makeHost();
    await startVoice(h);
    h.host.onSpeechActivity("tech_lead", true);
    expect(h.timers.live().map((t) => t.ms)).toEqual([VOICE_ACTIVITY_STALE_MS]);
    await h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "A line is news.");
    expect(h.timers.live().map((t) => t.ms)).toEqual([VOICE_ACTIVITY_STALE_MS]); // restarted, still one
    expect(h.timers.all.filter((t) => t.ms === VOICE_ACTIVITY_STALE_MS)).toHaveLength(2);
    h.timers.fireMs(VOICE_ACTIVITY_STALE_MS);
    expect(h.timers.live().map((t) => t.ms)).toEqual([800]);
    h.timers.fire();
    expect(h.host.voiceTurnOpen).toBe(false);
    await vi.waitFor(() => expect(h.rounds).toHaveBeenCalledTimes(1));
    await h.host.idle();
  });

  it("onVoiceTurn reports each open and close, in order", async () => {
    const h = makeHost();
    const seen: boolean[] = [];
    h.host.onVoiceTurn((o) => seen.push(o));
    await startVoice(h);
    h.host.onSpeechActivity("tech_lead", true);
    h.host.onSpeechActivity("tech_lead", false, 0);
    h.timers.fire();
    h.host.onSpeechActivity("delivery_lead", true);
    await h.host.command({ command: "pause" });
    expect(seen).toEqual([true, false, true, false]);
    await h.host.idle();
  });
});

// main: voice_turn on the parent channel, and speech_activity routed to the host.
const here = path.dirname(fileURLToPath(import.meta.url));
let parentTmp = "";
let savedTmp: string | undefined;
const runtimes: Runtime[] = [];
describe("main and voice_turn (US-0070)", () => {
  vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
  beforeAll(async () => { savedTmp = process.env.TMPDIR; parentTmp = await mkdtemp(path.join(os.tmpdir(), "acr-voiceturn-")); process.env.TMPDIR = parentTmp; });
  afterAll(async () => { for (const r of runtimes.splice(0)) await r.stop(); if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; await rm(parentTmp, { recursive: true, force: true }); });

  it("voice_turn open/close is sent in order", async () => {
    const sent: ChildMessage[] = [];
    let handler: ((m: ParentMessage) => void) | undefined;
    const parent: ParentChannel = { send(m) { sent.push(m); return true; }, onMessage(fn) { handler = fn; }, onDisconnect() {} };
    const tmp = await mkdtemp(path.join(parentTmp, "run-"));
    const r = await bootstrap({
      env: { SCENARIO_DIR: friday, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: "vt", MODEL_PROVIDER: "mock", CONTROL_MANAGED: "1", CONSENT_NOTICE_VERSION: "v3", VOICE_ENABLED: "1", SESSION_DATA_DIR: path.join(tmp, "sessions") },
      root: tmp, consentDir: path.join(here, "../../../../../consent"), tickMs: 60_000, log: () => {}, warn: () => {}, parent,
    });
    if (!r.ok) throw new Error(r.errors.join("; "));
    runtimes.push(r.runtime);
    const host = r.runtime.host;
    for (const role of PLAYERS) { host.join(role, PID(role)); host.giveConsent(role, PID(role), "v3"); }
    await host.start();
    host.optInVoice("tech_lead", PID("tech_lead"), "v3");
    handler!({ type: "speech_activity", roleId: "tech_lead", active: true });
    expect(sent.filter((m) => m.type === "voice_turn")).toEqual([{ type: "voice_turn", open: true }]);
    // silentMs above TURN_END_MS arms a zero timer: the close follows without waiting for real time to pass.
    handler!({ type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 60_000 });
    await vi.waitFor(() => expect(sent.filter((m) => m.type === "voice_turn")).toEqual([{ type: "voice_turn", open: true }, { type: "voice_turn", open: false }]));
    await host.idle();
    // F2: voice_alert worker_down closes a turn left open by a worker that died mid-speech.
    handler!({ type: "speech_activity", roleId: "tech_lead", active: true });
    expect(host.voiceTurnOpen).toBe(true);
    handler!({ type: "voice_alert", code: "worker_down" });
    expect(host.voiceTurnOpen).toBe(false);
    expect(sent.filter((m) => m.type === "voice_turn").at(-1)).toEqual({ type: "voice_turn", open: false });
    await host.idle();
  });
});
