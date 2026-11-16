import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import type { EventBody, SessionEvent } from "@acr/events";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { PlayerCredentials } from "../../engine/credentials.js";
import { ConsentStore } from "../../engine/consent.js";
import { AiRoleSet } from "../../engine/ai-roles.js";
import type { Seats } from "../../engine/seats.js";
import { VoiceChoices, type VoiceFileIO } from "../../engine/voice-file.js";
import { SessionHost, VoiceRefusedError } from "../session-host.js";
import type { VoiceConfig } from "../voice-config.js";
import type { VoiceSeats } from "../voice.js";

// A3A Task 2: the facilitator's `mute_seat` in the host: refusal order, mute on receipt with rollback, unmute after the append, the
// in-mutex recording guard, the union with the participant's own mute, the lifetime, and the pre-start hold.
const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
let scenario: Scenario;
beforeAll(async () => { scenario = await loadScenario(friday); });

/** A memory log whose appends can be held (gate) or made to fail once (failNext). */
class TestLog extends MemoryEventLog {
  gate: Promise<void> | null = null;
  failNext: ((body: EventBody) => boolean) | null = null;
  override async append(body: EventBody, ts: number): Promise<SessionEvent> {
    if (this.gate) await this.gate;
    if (this.failNext?.(body)) { this.failNext = null; throw new Error("disk full"); }
    return super.append(body, ts);
  }
}

function makeHost(o: { voice?: VoiceConfig; aiRoles?: string[]; log?: TestLog } = {}) {
  const clock = new FakeClock(5_000);
  const log = o.log ?? new TestLog("local");
  const engine = new SessionEngine({ scenario, log, clock });
  const aiRoles = AiRoleSet.empty();
  aiRoles.replace(o.aiRoles ?? [], PLAYERS);
  const credentials = PlayerCredentials.create(BIND);
  const vbind = { sessionId: "local", logIdentity: credentials.logIdentity };
  const disk = { record: null as unknown };
  const voiceFile: VoiceFileIO = {
    read: () => ({ choices: disk.record === null ? VoiceChoices.empty(vbind) : VoiceChoices.fromRecord(disk.record, vbind) }),
    write: (c) => { disk.record = c.toRecord(); },
    remove: () => { disk.record = null; },
  };
  const seats: Seats = { credentials, consent: new ConsentStore({ version: "v3", text: "notice" }), aiRoles, persist: () => {}, voiceFile };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats, voice: o.voice ?? { enabled: true, turnEndMs: 800 } });
  return { host, engine, log };
}
type H = ReturnType<typeof makeHost>;
async function joinAll(h: H, ai: string[] = []) {
  for (const r of PLAYERS) { h.host.join(r, ai.includes(r) ? `bot-${r}` : `p-${r}`); if (!ai.includes(r)) h.host.giveConsent(r, `p-${r}`, "v3"); }
}
async function startAll(h: H, ai: string[] = []) { await joinAll(h, ai); await h.host.start(); }
const recording = (h: H, roleId: string) => h.host.voiceSeats().holders.find((x) => x.roleId === roleId)?.recording;
const mute = (h: H, roleId: string, muted: boolean, by = "Facilitator Fay") => h.host.command({ command: "mute_seat", roleId, muted }, { by });
const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (e: unknown) => (e as { code?: string }).code ?? `other:${(e as Error).message}`);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const ticks = (h: H) => vi.spyOn((h.host as unknown as { gm: { tick: () => Promise<void> } }).gm, "tick");

describe("mute_seat refusals (A3A, spec order)", () => {
  it("voice_off comes first, even for an unknown or AI seat", async () => {
    const h = makeHost({ voice: { enabled: false } });
    await startAll(h);
    expect(await codeOf(mute(h, "tech_lead", true))).toBe("voice_off");
    expect(await codeOf(mute(h, "nobody", true))).toBe("voice_off");
    expect(await codeOf(mute(h, "client_sponsor", true))).toBe("voice_off");
  });

  it("unknown_role for an id that is not a role of this session (own properties only)", async () => {
    const h = makeHost();
    await startAll(h);
    const seq = h.engine.state.lastSeq;
    expect(await codeOf(mute(h, "nobody", true))).toBe("unknown_role");
    expect(await codeOf(mute(h, "__proto__", true))).toBe("unknown_role");
    expect(h.engine.state.lastSeq).toBe(seq);
  });

  it("forbidden for an AI character and for an AI player seat", async () => {
    const h = makeHost({ aiRoles: ["delivery_lead"] });
    await startAll(h, ["delivery_lead"]);
    const seq = h.engine.state.lastSeq;
    expect(await codeOf(mute(h, "client_sponsor", true))).toBe("forbidden");
    expect(await codeOf(mute(h, "delivery_lead", true))).toBe("forbidden");
    expect(h.engine.state.lastSeq).toBe(seq);
    expect(h.host.facilitatorMutedOf("delivery_lead")).toBe(false);
  });

  it("ended after the end, but unknown_role and forbidden still come before it", async () => {
    const h = makeHost();
    await startAll(h);
    await h.host.endNow({ by: "Fay" });
    expect(await codeOf(mute(h, "tech_lead", true))).toBe("ended");
    expect(await codeOf(mute(h, "nobody", true))).toBe("unknown_role");
    expect(await codeOf(mute(h, "client_sponsor", true))).toBe("forbidden");
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(false);
  });

  it("is allowed while paused", async () => {
    const h = makeHost();
    await startAll(h);
    await h.host.command({ command: "pause" });
    await expect(mute(h, "tech_lead", true)).resolves.toBeUndefined();
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(true);
  });

  it("is accepted for a seat with no holder and for a text-only holder", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.release("tech_lead", "p-tech_lead");
    await expect(mute(h, "tech_lead", true)).resolves.toBeUndefined();
    h.host.optOutVoice("account_manager", "p-account_manager");
    await expect(mute(h, "account_manager", true)).resolves.toBeUndefined();
    expect(h.engine.state.facilitatorMutedSeats).toEqual(["account_manager", "tech_lead"]);
  });
});

describe("mute_seat effects", () => {
  it("appends facilitator.command with by, stops recording, re-sends voice_state and refuses the seat's lines not_recording", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    expect(recording(h, "tech_lead")).toBe(true);
    const sent: VoiceSeats[] = [];
    h.host.onVoiceSeatsChanged((s) => sent.push(s));
    await mute(h, "tech_lead", true);
    const last = (await h.log.all()).at(-1)!;
    expect(last).toMatchObject({ type: "facilitator.command", command: "mute_seat", roleId: "tech_lead", muted: true, by: "Facilitator Fay" });
    expect(recording(h, "tech_lead")).toBe(false);
    await flush();
    expect(sent.at(-1)!.holders.find((x) => x.roleId === "tech_lead")!.recording).toBe(false);
    const seq = h.engine.state.lastSeq;
    const err = await h.host.onVoiceUtterance("tech_lead", "p-tech_lead", "We can ship in May.").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceRefusedError);
    expect((err as VoiceRefusedError).code).toBe("not_recording");
    expect(h.engine.state.lastSeq).toBe(seq);
    await mute(h, "tech_lead", false);
    expect(recording(h, "tech_lead")).toBe(true);
    await expect(h.host.onVoiceUtterance("tech_lead", "p-tech_lead", "We can ship in May.")).resolves.toEqual({ seq: expect.any(Number) });
    await h.host.idle();
  });

  it("a mute takes effect on receipt, before its append is on disk", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    let open!: () => void;
    h.log.gate = new Promise<void>((r) => { open = r; });
    const p = mute(h, "tech_lead", true);
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(true);
    expect(recording(h, "tech_lead")).toBe(false);
    h.log.gate = null; open();
    await p;
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(true);
  });

  it("Review Focus 1: a line that passed the recording check before the mute is refused inside the engine mutex, never appended after it", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    let open!: () => void;
    h.log.gate = new Promise<void>((r) => { open = r; });
    const busy = h.engine.alert("holding the mutex", "info"); // the mutex is busy until the gate opens
    const line = h.host.onVoiceUtterance("tech_lead", "p-tech_lead", "Side conversation.").then(() => null, (e: unknown) => e);
    await Promise.resolve(); // the line passed the host's outer check and waits for the mutex
    const muted = mute(h, "tech_lead", true);
    h.log.gate = null; open();
    await busy; await muted;
    const err = await line;
    expect(err).toBeInstanceOf(VoiceRefusedError);
    expect((err as VoiceRefusedError).code).toBe("not_recording");
    const events = await h.log.all();
    expect(events.some((e) => e.type === "utterance" && e.text === "Side conversation.")).toBe(false);
    await h.host.idle();
  });

  it("Review Focus 2: a mute whose append fails is rolled back and the command fails", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    const sent: VoiceSeats[] = [];
    h.host.onVoiceSeatsChanged((s) => sent.push(s));
    h.log.failNext = (b) => b.type === "facilitator.command";
    await expect(mute(h, "tech_lead", true)).rejects.toThrow("disk full");
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(false);
    expect(h.host.voiceMutedOf("tech_lead")).toBe(false);
    expect(recording(h, "tech_lead")).toBe(true);
    await flush();
    expect(sent.at(-1)!.holders.find((x) => x.roleId === "tech_lead")!.recording).toBe(true); // the rollback is re-sent too
  });

  it("Review Focus 2: an unmute applies only after its append; a failing append leaves the seat muted", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    await mute(h, "tech_lead", true);
    let open!: () => void;
    h.log.gate = new Promise<void>((r) => { open = r; });
    const p = mute(h, "tech_lead", false);
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(true); // not yet: the unmute is not on disk
    h.log.gate = null; open();
    await p;
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(false);
    await mute(h, "tech_lead", true);
    h.log.failNext = (b) => b.type === "facilitator.command";
    await expect(mute(h, "tech_lead", false)).rejects.toThrow("disk full");
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(true);
    expect(recording(h, "tech_lead")).toBe(false);
  });

  it("schedules no Game Master tick (C9), unlike other commands", async () => {
    const h = makeHost();
    await startAll(h);
    await h.host.idle();
    const spy = ticks(h);
    await mute(h, "tech_lead", true);
    await mute(h, "tech_lead", false);
    await h.host.idle();
    expect(spy).not.toHaveBeenCalled();
    await h.host.command({ command: "pause" });
    await h.host.idle();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("mute_seat lifetime and the union with the participant's own mute", () => {
  it("release, forgetVoice (reissue), pause, resume and a rejoin do not clear it", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    await mute(h, "tech_lead", true);
    h.host.release("tech_lead", "p-tech_lead");
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(true);
    h.host.join("tech_lead", "p-tech_lead");
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(true);
    expect(recording(h, "tech_lead")).toBe(false);
    h.host.forgetVoice("tech_lead");
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(true);
    await h.host.command({ command: "pause" });
    await h.host.command({ command: "resume" });
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(true);
    expect(h.host.voiceMutedByOf("tech_lead")).toBe("facilitator");
    await h.host.idle();
  });

  it("the participant's own mute and the facilitator set are independent; the union feeds isRecordingHolder, voice seats and voiceMutedOf", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    // facilitator only
    await mute(h, "tech_lead", true);
    expect(h.host.voiceMutedOf("tech_lead")).toBe(true);
    expect(h.host.voiceMutedByOf("tech_lead")).toBe("facilitator");
    expect(recording(h, "tech_lead")).toBe(false);
    h.host.onSpeechActivity("tech_lead", true); // isRecordingHolder: ignored
    expect(h.host.voiceTurnOpen).toBe(false);
    // both
    h.host.muteVoice("tech_lead", "p-tech_lead", true);
    await mute(h, "tech_lead", false);
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(false);
    expect(h.host.voiceMutedOf("tech_lead")).toBe(true); // the participant's own mute still holds
    expect(h.host.voiceMutedByOf("tech_lead")).toBeUndefined();
    expect(recording(h, "tech_lead")).toBe(false);
    // A3A Task 3: the participant cannot lift the facilitator's mute (muted_by_facilitator), and the refusal changes nothing
    await mute(h, "tech_lead", true);
    expect(() => h.host.muteVoice("tech_lead", "p-tech_lead", false)).toThrow(expect.objectContaining({ code: "muted_by_facilitator" }));
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(true);
    expect(h.host.voiceMutedOf("tech_lead")).toBe(true);
    h.host.muteVoice("tech_lead", "p-tech_lead", true); // a participant mute is still accepted
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(true); // the participant's own mute must not clear the facilitator's
    // neither: the facilitator lifts theirs, then the participant their own
    await mute(h, "tech_lead", false);
    h.host.muteVoice("tech_lead", "p-tech_lead", false);
    expect(h.host.voiceMutedOf("tech_lead")).toBe(false);
    expect(recording(h, "tech_lead")).toBe(true);
    h.host.onSpeechActivity("tech_lead", true);
    expect(h.host.voiceTurnOpen).toBe(true);
  });

  it("a mute while speaking stops that track holding the voice turn open", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.host.onSpeechActivity("tech_lead", true);
    expect(h.host.speakingRoles().has("tech_lead")).toBe(true);
    await mute(h, "tech_lead", true);
    expect(h.host.speakingRoles().has("tech_lead")).toBe(false);
  });
});

describe("mute_seat before the start (C6)", () => {
  it("is held in memory, then written after session.started with the same by, and holds from the first turn", async () => {
    const h = makeHost();
    await joinAll(h);
    await mute(h, "tech_lead", true, "Fay");
    expect(await h.log.all()).toEqual([]); // nothing may be logged before session.started
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(true);
    expect(h.host.voiceMutedOf("tech_lead")).toBe(true);
    await h.host.start();
    const events = await h.log.all();
    expect(events[0]!.type).toBe("session.started");
    expect(events[1]).toMatchObject({ type: "facilitator.command", command: "mute_seat", roleId: "tech_lead", muted: true, by: "Fay" });
    expect(h.engine.state.facilitatorMutedSeats).toEqual(["tech_lead"]);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    expect(recording(h, "tech_lead")).toBe(false);
  });

  it("a pre-start unmute takes the hold back (nothing is written); refusals apply before the start too", async () => {
    const h = makeHost({ aiRoles: ["delivery_lead"] });
    await joinAll(h, ["delivery_lead"]);
    expect(await codeOf(mute(h, "nobody", true))).toBe("unknown_role");
    expect(await codeOf(mute(h, "client_sponsor", true))).toBe("forbidden");
    expect(await codeOf(mute(h, "delivery_lead", true))).toBe("forbidden");
    await mute(h, "tech_lead", true);
    await mute(h, "tech_lead", false);
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(false);
    await h.host.start();
    expect((await h.log.all()).some((e) => e.type === "facilitator.command")).toBe(false);
  });

  it("schedules no Game Master tick before the start either", async () => {
    const h = makeHost();
    await joinAll(h);
    const spy = ticks(h);
    await mute(h, "tech_lead", true);
    await h.host.idle();
    expect(spy).not.toHaveBeenCalled();
  });

  it("residual: a restart before the start keeps nothing (the facilitator re-mutes)", async () => {
    const log = new TestLog("local");
    const first = makeHost({ log });
    await joinAll(first);
    await mute(first, "tech_lead", true);
    expect(first.host.facilitatorMutedOf("tech_lead")).toBe(true);
    // the process stops before the start: a new host over the same (empty) log
    const second = makeHost({ log });
    expect(await second.engine.restore()).toEqual({ kind: "empty" });
    expect(second.host.facilitatorMutedOf("tech_lead")).toBe(false);
    await startAll(second);
    expect(second.engine.state.facilitatorMutedSeats).toEqual([]);
  });

  it("a mute sent while the start is in flight is written after the start", async () => {
    const h = makeHost();
    await joinAll(h);
    let open!: () => void;
    h.log.gate = new Promise<void>((r) => { open = r; });
    const started = h.host.start();
    const p = mute(h, "tech_lead", true, "Fay");
    expect(h.host.facilitatorMutedOf("tech_lead")).toBe(true); // on receipt
    h.log.gate = null; open();
    await started; await p;
    expect(h.engine.state.facilitatorMutedSeats).toEqual(["tech_lead"]);
    expect((await h.log.all()).filter((e) => e.type === "facilitator.command")).toEqual([expect.objectContaining({ command: "mute_seat", roleId: "tech_lead", muted: true, by: "Fay" })]);
  });
});
