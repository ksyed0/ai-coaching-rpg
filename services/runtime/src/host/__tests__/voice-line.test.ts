import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
import { SessionHost, VoiceRefusedError } from "../session-host.js";
import { reissueRole, type ReissueDeps } from "../reissue.js";
import type { VoiceConfig } from "../voice-config.js";
import type { VoiceRefusal } from "../parent-channel.js";

// US-0070 (Task 6): voice lines through SessionHost.onVoiceUtterance (AC-0396, AC-0397). The runtime is the second of the two privacy
// gates: whatever the worker sends, a line is recorded only for the current human holder who chose voice, while the scene runs.
const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
const PID = (r: string) => `pid-SECRET-${r}`;
let scenario: Scenario;
beforeAll(async () => { scenario = await loadScenario(friday); });

function makeHost(o: { voice?: VoiceConfig; aiRoles?: string[] } = {}) {
  const clock = new FakeClock(10_000);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock });
  const aiRoles = AiRoleSet.empty();
  aiRoles.replace(o.aiRoles ?? [], PLAYERS);
  const seats: Seats = { credentials: PlayerCredentials.create(BIND), consent: new ConsentStore({ version: "v3", text: "notice" }), aiRoles, persist: () => {} };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Noted."]), gmProvider: new MockModelProvider(), clock, seats, voice: o.voice ?? { enabled: true, turnEndMs: 800 } });
  return { host, engine, seats };
}
type H = ReturnType<typeof makeHost>;
async function startAll(h: H, ai: string[] = []) {
  for (const r of PLAYERS) { h.host.join(r, PID(r)); if (!ai.includes(r)) h.host.giveConsent(r, PID(r), "v3"); }
  await h.host.start();
}
const events = (h: H): SessionEvent[] => { const r = h.engine.eventsAfter(0); return r.complete ? [...r.events] : []; };
async function refusal(p: Promise<unknown>): Promise<VoiceRefusal | string> {
  try { await p; return "accepted"; } catch (err) { return err instanceof VoiceRefusedError ? err.code : `other:${(err as Error).name}`; }
}
/** Asserts the refusal code AND that nothing was appended. */
async function refused(h: H, roleId: string, participantId: string, want: VoiceRefusal) {
  const before = h.engine.state.lastSeq;
  expect(await refusal(h.host.onVoiceUtterance(roleId, participantId, "We can ship in May.")), `${roleId}/${participantId}`).toBe(want);
  expect(h.engine.state.lastSeq).toBe(before);
}

describe("onVoiceUtterance records a voice line (US-0070, AC-0396)", () => {
  it("a holder who chose voice is recorded with channel voice and the returned seq equals the event's seq", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", PID("tech_lead"), "v3");
    const { seq } = await h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "We can ship in May.");
    const e = events(h).find((x) => x.seq === seq)!;
    expect(e).toMatchObject({ type: "utterance", roleId: "tech_lead", text: "We can ship in May.", channel: "voice", seq });
    // The log format is unchanged: a voice utterance has exactly the keys of a typed one (only the channel's value differs).
    await h.host.onPlayerUtterance("account_manager", "A typed line.");
    const typed = events(h).find((x) => x.type === "utterance" && x.roleId === "account_manager")!;
    expect(Object.keys(e).sort()).toEqual(Object.keys(typed).sort());
    expect((typed as { channel: string }).channel).toBe("text");
    expect(h.engine.state.transcript.find((u) => u.seq === seq)).toMatchObject({ roleId: "tech_lead", channel: "voice" });
    await h.host.idle();
  });

  it("a voice line's utterance reaches players exactly like a text line and no player frame carries segmentId or participantId", async () => {
    const h = makeHost();
    const frames: Record<string, string[]> = Object.fromEntries(PLAYERS.map((r) => [r, []]));
    h.host.subscribe((e) => { for (const r of PLAYERS) { const v = h.host.viewFor(r, e); if (v) frames[r]!.push(JSON.stringify(v)); } });
    await startAll(h);
    h.host.optInVoice("tech_lead", PID("tech_lead"), "v3");
    await h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "Voice words here.");
    await h.host.onPlayerUtterance("account_manager", "Typed words here.");
    await h.host.idle();
    for (const r of PLAYERS) {
      const voice = frames[r]!.map((f) => JSON.parse(f)).find((f) => f.type === "utterance" && f.text === "Voice words here.");
      const text = frames[r]!.map((f) => JSON.parse(f)).find((f) => f.type === "utterance" && f.text === "Typed words here.");
      expect(voice, r).toBeDefined();
      expect(Object.keys(voice).sort()).toEqual(Object.keys(text).sort());
      for (const f of frames[r]!) { expect(f).not.toContain("pid-SECRET"); expect(f).not.toContain("segmentId"); expect(f).not.toContain("participantId"); }
    }
  });
});

describe("onVoiceUtterance refuses (US-0070, AC-0397)", () => {
  it("voice_off when voice is disabled", async () => {
    const h = makeHost({ voice: { enabled: false } });
    await startAll(h);
    await refused(h, "tech_lead", PID("tech_lead"), "voice_off");
  });

  it("not_started before the start", async () => {
    const h = makeHost();
    h.host.join("tech_lead", PID("tech_lead"));
    h.host.giveConsent("tech_lead", PID("tech_lead"), "v3");
    h.host.optInVoice("tech_lead", PID("tech_lead"), "v3");
    await refused(h, "tech_lead", PID("tech_lead"), "not_started");
    expect(h.engine.state.lastSeq).toBe(0);
  });

  it("unknown_role for an unknown id, an inherited member name and an AI character (NPC)", async () => {
    const h = makeHost();
    await startAll(h);
    for (const r of ["nobody", "__proto__", "constructor", "toString", "client_sponsor", "facilitator"]) await refused(h, r, PID("tech_lead"), "unknown_role");
  });

  it("ai_role for a player role an AI plays", async () => {
    const h = makeHost({ aiRoles: ["delivery_lead"] });
    await startAll(h, ["delivery_lead"]);
    await refused(h, "delivery_lead", PID("delivery_lead"), "ai_role");
  });

  it("not_holder for another participant id, and for a seat nobody holds", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", PID("tech_lead"), "v3");
    await refused(h, "tech_lead", "someone-else", "not_holder");
    h.host.release("tech_lead", PID("tech_lead"));
    await refused(h, "tech_lead", PID("tech_lead"), "not_holder");
  });

  it("not_recording for a holder without a choice, a holder who chose text, and a seat whose choice belongs to another participant", async () => {
    const h = makeHost();
    await startAll(h);
    await refused(h, "tech_lead", PID("tech_lead"), "not_recording");
    h.host.optInVoice("tech_lead", PID("tech_lead"), "v3");
    h.host.optOutVoice("tech_lead", PID("tech_lead"));
    await refused(h, "tech_lead", PID("tech_lead"), "not_recording");
    // An entry for the old holder: a rebound seat's new holder is text_only.
    h.host.optInVoice("account_manager", PID("account_manager"), "v3");
    h.host.release("account_manager", PID("account_manager"));
    h.seats.credentials.revoke("account_manager");
    h.seats.consent.releaseForRebind("account_manager");
    h.host.join("account_manager", "p-new");
    await refused(h, "account_manager", "p-new", "not_recording");
  });

  it("paused while paused, and recorded again after resume", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", PID("tech_lead"), "v3");
    await h.host.command({ command: "pause" });
    await refused(h, "tech_lead", PID("tech_lead"), "paused");
    await h.host.command({ command: "resume" });
    expect(await refusal(h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "Back again."))).toBe("accepted");
    await h.host.idle();
  });

  it("not_in_scene for a role outside the current scene", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", PID("tech_lead"), "v3");
    await h.host.command({ command: "advance" });
    await h.host.idle();
    await h.engine.tick();
    expect(h.engine.currentScene()?.participants).not.toContain("tech_lead");
    await refused(h, "tech_lead", PID("tech_lead"), "not_in_scene");
  });

  it("ended after the end", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", PID("tech_lead"), "v3");
    await h.host.endNow({});
    await refused(h, "tech_lead", PID("tech_lead"), "ended");
  });

  it("a reissue between segment and line: the old participant's line is not_holder (Review Focus 3)", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", PID("tech_lead"), "v3");
    let current = JoinCodes.issue(PLAYERS, BIND).codes;
    const deps: ReissueDeps = {
      host: h.host, seats: h.seats, sessionId: "local", server: { kickRole: (_s: string, r: string) => { h.host.release(r, PID(r)); } },
      codes: () => current, setCodes: (c) => { current = c; }, writeCodes: () => {},
    };
    await reissueRole(deps, "tech_lead");
    await refused(h, "tech_lead", PID("tech_lead"), "not_holder");
    h.host.join("tech_lead", "p-next");
    await refused(h, "tech_lead", "p-next", "not_recording"); // the new holder has to opt in themselves
  });

  it("an engine failure other than the mapped ones is failed", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", PID("tech_lead"), "v3");
    vi.spyOn(h.engine, "say").mockRejectedValueOnce(new Error("disk"));
    await refused(h, "tech_lead", PID("tech_lead"), "failed");
  });

  it("a voice line waits for a start in flight", async () => {
    const h = makeHost();
    for (const r of PLAYERS) { h.host.join(r, PID(r)); h.host.giveConsent(r, PID(r), "v3"); }
    h.host.optInVoice("tech_lead", PID("tech_lead"), "v3");
    const start = h.host.start();
    const line = h.host.onVoiceUtterance("tech_lead", PID("tech_lead"), "Right at the start.");
    await start;
    expect(await refusal(line)).toBe("accepted");
    await h.host.idle();
  });
});
