import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { PlayerCredentials } from "../../engine/credentials.js";
import { ConsentStore } from "../../engine/consent.js";
import { AiRoleSet } from "../../engine/ai-roles.js";
import type { Seats } from "../../engine/seats.js";
import { VoiceChoices, type VoiceFileIO } from "../../engine/voice-file.js";
import { SessionHost } from "../session-host.js";
import type { VoiceConfig } from "../voice-config.js";
import { SPEAKING_BROADCAST_MS } from "../voice.js";

// US-0071 (EPIC-0003 voice A1b, review finding 5): the speaking indicator re-sent the whole facilitator roster on EVERY change of the
// speaking set, so a speaker whose edges flap gave several roster frames a second per facilitator socket. Speech-edge-driven changes
// are now coalesced to at most one per SPEAKING_BROADCAST_MS (trailing edge: the state at the end of the window is what is delivered);
// a change that does not come from a speech edge (mute, opt-out, release, pause, the end) is delivered at once and clears the window.
// The timer is injected: the test fires it (no real waiting).
const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
let scenario: Scenario;
beforeAll(async () => { scenario = await loadScenario(friday); });

async function setup(voice: VoiceConfig = { enabled: true, turnEndMs: 800 }) {
  const clock = new FakeClock(5_000);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock });
  const credentials = PlayerCredentials.create(BIND);
  const vbind = { sessionId: "local", logIdentity: credentials.logIdentity };
  let record: unknown = null;
  const voiceFile: VoiceFileIO = { read: () => ({ choices: record === null ? VoiceChoices.empty(vbind) : VoiceChoices.fromRecord(record, vbind) }), write: (c) => { record = c.toRecord(); }, remove: () => { record = null; } };
  const seats: Seats = { credentials, consent: new ConsentStore({ version: "v3", text: "notice" }), aiRoles: AiRoleSet.empty(), persist: () => {}, voiceFile };
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const setTimer = (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats, voice, setTimer });
  /** Each delivery to a speaking listener, as the speaking set it saw at that moment. */
  const delivered: string[][] = [];
  host.onSpeakingChanged(() => delivered.push([...host.speakingRoles()].sort()));
  const pending = () => timers.filter((t) => t.live && t.ms === SPEAKING_BROADCAST_MS).length;
  /** Fires the pending speaking window (only that timer: the voice-turn timers are left alone). */
  const fireWindow = () => { for (const t of timers) if (t.live && t.ms === SPEAKING_BROADCAST_MS) { t.live = false; t.fn(); } };
  for (const r of PLAYERS) { host.join(r, `p-${r}`); host.giveConsent(r, `p-${r}`, "v3"); }
  await host.start();
  if (voice.enabled) for (const r of ["tech_lead", "delivery_lead"]) host.optInVoice(r, `p-${r}`, "v3");
  return { host, delivered, pending, fireWindow };
}

describe("speaking changes are coalesced for the facilitator roster (US-0071, review finding 5)", () => {
  it("flapping edges within a window give ONE delivery, and it carries the final state", async () => {
    const t = await setup();
    t.host.onSpeechActivity("tech_lead", true);
    t.host.onSpeechActivity("tech_lead", false);
    t.host.onSpeechActivity("tech_lead", true);
    t.host.onSpeechActivity("delivery_lead", true);
    expect(t.delivered).toEqual([]); // nothing yet: the window is open
    expect(t.pending()).toBe(1); // one window, not one per edge
    t.fireWindow();
    expect(t.delivered).toEqual([["delivery_lead", "tech_lead"]]);
    // The next window: more flapping, again one delivery with the last state.
    t.host.onSpeechActivity("tech_lead", false);
    t.host.onSpeechActivity("tech_lead", true);
    t.host.onSpeechActivity("tech_lead", false);
    expect(t.pending()).toBe(1);
    t.fireWindow();
    expect(t.delivered).toEqual([["delivery_lead", "tech_lead"], ["delivery_lead"]]);
  });

  it("a window whose flapping ends where it started delivers nothing (the facilitator already has that state)", async () => {
    const t = await setup();
    t.host.onSpeechActivity("tech_lead", true);
    t.host.onSpeechActivity("tech_lead", false);
    t.fireWindow();
    expect(t.delivered).toEqual([]);
  });

  it("a mute (not a speech edge) is delivered at once and clears the pending window", async () => {
    const t = await setup();
    t.host.onSpeechActivity("tech_lead", true);
    t.fireWindow();
    t.host.onSpeechActivity("delivery_lead", true);
    expect(t.pending()).toBe(1);
    t.host.muteVoice("tech_lead", "p-tech_lead", true);
    expect(t.delivered).toEqual([["tech_lead"], ["delivery_lead"]]); // the mute's change, with the edge that was waiting folded in
    expect(t.pending()).toBe(0);
  });

  it("a release clears the pending window and delivers the state at once", async () => {
    const t = await setup();
    t.host.onSpeechActivity("tech_lead", true);
    expect(t.pending()).toBe(1);
    t.host.release("tech_lead", "p-tech_lead");
    expect(t.pending()).toBe(0);
    expect(t.delivered).toEqual([]); // the edge never reached the facilitator and the state is back to nobody: nothing to send
    t.host.onSpeechActivity("delivery_lead", true);
    t.fireWindow();
    t.host.onSpeechActivity("delivery_lead", false);
    expect(t.pending()).toBe(1);
    t.host.release("delivery_lead", "p-delivery_lead");
    expect(t.pending()).toBe(0);
    expect(t.delivered).toEqual([["delivery_lead"], []]);
  });

  it("the end clears the pending window (nothing fires after it) and delivers the empty set at once", async () => {
    const t = await setup();
    t.host.onSpeechActivity("tech_lead", true);
    t.fireWindow();
    t.host.onSpeechActivity("delivery_lead", true);
    expect(t.pending()).toBe(1);
    await t.host.endNow({});
    expect(t.pending()).toBe(0);
    expect(t.delivered).toEqual([["tech_lead"], []]);
  });

  it("with voice disabled nothing is armed and nothing is delivered", async () => {
    const t = await setup({ enabled: false });
    t.host.onSpeechActivity("tech_lead", true);
    t.host.onSpeechActivity("tech_lead", false);
    expect(t.pending()).toBe(0);
    t.fireWindow();
    expect(t.delivered).toEqual([]);
  });
});
