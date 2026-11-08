import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { JoinCodes } from "../../engine/join-codes.js";
import { PlayerCredentials } from "../../engine/credentials.js";
import { ConsentStore } from "../../engine/consent.js";
import { AiRoleSet } from "../../engine/ai-roles.js";
import type { Seats } from "../../engine/seats.js";
import { VoiceChoices, readVoiceFile, voiceFileIO, writeVoiceFile, type VoiceFileIO } from "../../engine/voice-file.js";
import { HostError, SessionHost } from "../session-host.js";
import { reissueRole, type ReissueDeps } from "../reissue.js";
import type { VoiceConfig } from "../voice-config.js";

// US-0070 (EPIC-0003 voice A1a, Task 5): opting in and out, the seat state and never inheriting a choice (AC-0401).
const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
const ON: VoiceConfig = { enabled: true, turnEndMs: 800 };
let scenario: Scenario;
let parentTmp = "";
let savedTmp: string | undefined;
beforeAll(async () => {
  scenario = await loadScenario(friday);
  savedTmp = process.env.TMPDIR; parentTmp = await mkdtemp(path.join(os.tmpdir(), "acr-voicechoice-")); process.env.TMPDIR = parentTmp;
});
afterAll(async () => { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; await rm(parentTmp, { recursive: true, force: true }); });

/** A fake voice file: what the last write left, with switchable failures. */
function fakeVoiceIO(bind: { sessionId: string; logIdentity: string }) {
  const disk = { record: null as unknown, writes: 0, removes: 0, writeFails: false, removeFails: false };
  const io: VoiceFileIO = {
    read: () => (disk.record === null ? { choices: VoiceChoices.empty(bind) } : { choices: VoiceChoices.fromRecord(disk.record, bind) }),
    write: (c) => { disk.writes++; if (disk.writeFails) throw new Error("disk full"); disk.record = c.toRecord(); },
    remove: () => { disk.removes++; if (disk.removeFails) throw new Error("io"); disk.record = null; },
  };
  return { io, disk };
}

type Opts = { voice?: VoiceConfig; noticeVersion?: string; aiRoles?: string[]; credentials?: PlayerCredentials; io?: (bind: { sessionId: string; logIdentity: string }) => VoiceFileIO; disk?: ReturnType<typeof fakeVoiceIO> };
function makeHost(o: Opts = {}) {
  const clock = new FakeClock(5_000);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock });
  const aiRoles = AiRoleSet.empty();
  aiRoles.replace(o.aiRoles ?? [], PLAYERS);
  const credentials = o.credentials ?? PlayerCredentials.create(BIND);
  const vbind = { sessionId: "local", logIdentity: credentials.logIdentity };
  const fake = o.disk ?? fakeVoiceIO(vbind);
  const seats: Seats = {
    credentials, consent: new ConsentStore({ version: o.noticeVersion ?? "v3", text: "notice" }), aiRoles, persist: () => {},
    voiceFile: o.io ? o.io(vbind) : fake.io,
  };
  const logs: string[] = [];
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats, voice: o.voice ?? ON, log: (m) => logs.push(m) });
  return { host, engine, seats, clock, disk: fake.disk, logs };
}
const code = (fn: () => unknown): string | undefined => { try { fn(); return undefined; } catch (err) { return err instanceof HostError ? err.code : `other:${(err as Error).message}`; } };
/** Join and consent every human player role (p-<role>), then start. */
async function startAll(h: ReturnType<typeof makeHost>, ai: string[] = []) {
  for (const r of PLAYERS) { h.host.join(r, ai.includes(r) ? `bot-${r}` : `p-${r}`); if (!ai.includes(r)) h.host.giveConsent(r, `p-${r}`, h.seats.consent.notice.version); }
  await h.host.start();
}

describe("opting in and out (US-0070)", () => {
  it("opt-in by the holder records voice and voiceSeats shows recording true", () => {
    const h = makeHost();
    h.host.join("tech_lead", "p1");
    h.host.giveConsent("tech_lead", "p1", "v3");
    expect(h.host.voiceStateOf("tech_lead")).toBe("none");
    h.host.optInVoice("tech_lead", "p1", "v3");
    expect(h.host.voiceStateOf("tech_lead")).toBe("voice");
    expect(h.host.voiceSeats()).toEqual({ paused: false, ended: false, holders: [{ roleId: "tech_lead", participantId: "p1", recording: true }] });
    expect(h.disk.record).toEqual({ v: 1, sessionId: "local", logIdentity: h.seats.credentials.logIdentity, entries: { tech_lead: { participantId: "p1", choice: "voice", noticeVersion: "v3", at: 5_000 } } });
  });

  it("opt-in is refused voice_off when voice is disabled, and every seat is off", () => {
    const h = makeHost({ voice: { enabled: false } });
    h.host.join("tech_lead", "p1");
    h.host.giveConsent("tech_lead", "p1", "v3");
    expect(code(() => h.host.optInVoice("tech_lead", "p1", "v3"))).toBe("voice_off");
    expect(code(() => h.host.optOutVoice("tech_lead", "p1"))).toBe("voice_off");
    expect(h.host.voiceStateOf("tech_lead")).toBe("off");
    expect(h.disk.writes).toBe(0);
  });

  it("opt-in is refused forbidden for an AI seat, not_joined for a non-holder and consent_version for another notice version", () => {
    const h = makeHost({ aiRoles: ["delivery_lead"] });
    h.host.join("delivery_lead", "bot");
    expect(code(() => h.host.optInVoice("delivery_lead", "bot", "v3"))).toBe("forbidden");
    expect(h.host.voiceStateOf("delivery_lead")).toBe("off");
    h.host.join("tech_lead", "p1");
    h.host.giveConsent("tech_lead", "p1", "v3");
    expect(code(() => h.host.optInVoice("tech_lead", "p2", "v3"))).toBe("not_joined");
    expect(code(() => h.host.optInVoice("account_manager", "p1", "v3"))).toBe("not_joined");
    expect(code(() => h.host.optInVoice("tech_lead", "p1", "v4"))).toBe("consent_version");
    expect(code(() => h.host.optOutVoice("tech_lead", "p2"))).toBe("not_joined");
    expect(code(() => h.host.optOutVoice("delivery_lead", "bot"))).toBe("forbidden");
    expect(h.disk.writes).toBe(0);
  });

  it("opt-in is refused voice_notice_required without the participant's own consent", () => {
    const h = makeHost();
    h.host.join("tech_lead", "p1");
    expect(code(() => h.host.optInVoice("tech_lead", "p1", "v3"))).toBe("voice_notice_required");
  });

  it("opt-in is refused voice_notice_required when the participant consented to v2 (adopted after the start)", async () => {
    const h = makeHost();
    // A started session keeps consents of an older notice (R15): seed one as the restart does.
    h.seats.consent.adopt("tech_lead", "p1", "v2", 1);
    h.host.join("tech_lead", "p1");
    expect(code(() => h.host.optInVoice("tech_lead", "p1", "v3"))).toBe("voice_notice_required");
    expect(h.host.voiceStateOf("tech_lead")).toBe("none");
  });

  it("opt-out stops recording at once even when the file write fails", () => {
    const h = makeHost();
    h.host.join("tech_lead", "p1");
    h.host.giveConsent("tech_lead", "p1", "v3");
    h.host.optInVoice("tech_lead", "p1", "v3");
    h.disk.writeFails = true;
    expect(() => h.host.optOutVoice("tech_lead", "p1")).not.toThrow();
    expect(h.host.voiceSeats().holders[0]!.recording).toBe(false);
    expect(h.host.voiceStateOf("tech_lead")).toBe("text_only");
    expect(h.disk.record).toBeNull(); // the file is gone: a restart cannot find the old "voice"
  });

  it("opt-in whose write fails takes the entry back and throws (fail closed: not recording)", () => {
    const h = makeHost();
    h.host.join("tech_lead", "p1");
    h.host.giveConsent("tech_lead", "p1", "v3");
    h.disk.writeFails = true;
    expect(code(() => h.host.optInVoice("tech_lead", "p1", "v3"))).toMatch(/^other:/);
    expect(h.host.voiceStateOf("tech_lead")).toBe("none");
    expect(h.host.voiceSeats().holders[0]!.recording).toBe(false);
  });

  it("opt-out with write AND remove failing keeps the role off for this process and appends one facilitator alert", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.disk.writeFails = true; h.disk.removeFails = true;
    expect(() => h.host.optOutVoice("tech_lead", "p-tech_lead")).not.toThrow();
    expect(h.host.voiceStateOf("tech_lead")).toBe("off");
    expect(h.host.voiceSeats().holders.find((x) => x.roleId === "tech_lead")!.recording).toBe(false);
    const alerts = () => { const r = h.engine.eventsAfter(0); return r.complete ? [...r.events] : []; };
    const voiceAlerts = () => alerts().flatMap((e) => (e.type === "facilitator.alert" && e.message.includes("voice choice") ? [e.message] : []));
    await vi.waitFor(() => expect(voiceAlerts()).toHaveLength(1));
    expect(voiceAlerts()).toEqual(["voice choice could not be saved; voice is off for tech_lead until the session restarts"]);
    // Pinned off: a later opt-in is refused, even once the disk works again.
    h.disk.writeFails = false; h.disk.removeFails = false;
    expect(code(() => h.host.optInVoice("tech_lead", "p-tech_lead", "v3"))).toBe("voice_off");
  });

  it("a repeated opt-in or opt-out is accepted and leaves the same state", () => {
    const h = makeHost();
    h.host.join("tech_lead", "p1");
    h.host.giveConsent("tech_lead", "p1", "v3");
    h.host.optInVoice("tech_lead", "p1", "v3");
    h.host.optInVoice("tech_lead", "p1", "v3");
    expect(h.host.voiceStateOf("tech_lead")).toBe("voice");
    h.host.optOutVoice("tech_lead", "p1");
    h.host.optOutVoice("tech_lead", "p1");
    expect(h.host.voiceStateOf("tech_lead")).toBe("text_only");
    h.host.optInVoice("tech_lead", "p1", "v3");
    expect(h.host.voiceStateOf("tech_lead")).toBe("voice");
  });

  it("onVoiceChoice fires after a successful opt-in or opt-out write only", () => {
    const h = makeHost();
    const got: unknown[] = [];
    h.host.onVoiceChoice((c) => got.push(c));
    h.host.join("tech_lead", "p1");
    h.host.giveConsent("tech_lead", "p1", "v3");
    h.host.optInVoice("tech_lead", "p1", "v3");
    h.clock.advance(10);
    h.host.optOutVoice("tech_lead", "p1");
    h.disk.writeFails = true;
    h.host.optOutVoice("tech_lead", "p1");
    expect(got).toEqual([{ roleId: "tech_lead", participantId: "p1", choice: "voice", at: 5_000 }, { roleId: "tech_lead", participantId: "p1", choice: "text_only", at: 5_010 }]);
  });
});

describe("never inherited (US-0070, AC-0401)", () => {
  it("after a reissue the old entry is deleted and the next participant has no choice (not recording)", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    const issued = JoinCodes.issue(PLAYERS, BIND);
    let current = issued.codes;
    const deps: ReissueDeps = {
      host: h.host, seats: h.seats, sessionId: "local",
      server: { kickRole: (_s: string, r: string) => { h.host.release(r, "p-tech_lead"); } },
      codes: () => current, setCodes: (c) => { current = c; }, writeCodes: () => {},
    };
    await reissueRole(deps, "tech_lead");
    expect(h.seats.credentials.has("tech_lead")).toBe(false);
    expect((h.disk.record as { entries: Record<string, unknown> }).entries).toEqual({});
    // The next participant claims the rebound consent; their voice state is their own (none), never the old holder's.
    h.host.join("tech_lead", "p-new");
    expect(h.host.voiceStateOf("tech_lead")).toBe("none");
    expect(h.host.voiceSeats().holders.find((x) => x.roleId === "tech_lead")).toEqual({ roleId: "tech_lead", participantId: "p-new", recording: false });
  });

  it("after a rebind (claimRebind) the new holder is text_only while the old entry stands", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.host.release("tech_lead", "p-tech_lead");
    h.seats.credentials.revoke("tech_lead");
    h.seats.consent.releaseForRebind("tech_lead");
    const { rebound } = h.host.join("tech_lead", "p-new");
    expect(rebound).toBe(true);
    expect(h.host.voiceStateOf("tech_lead")).toBe("text_only");
    expect(h.host.voiceSeats().holders.find((x) => x.roleId === "tech_lead")!.recording).toBe(false);
  });

  it("a forgetVoice whose write fails is reported by name and the seat still does not record for anyone else", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.disk.writeFails = true;
    expect(() => h.host.forgetVoice("tech_lead")).not.toThrow();
    expect(h.logs.some((l) => l.startsWith("forgetting the voice choice of a reissued seat: Error"))).toBe(true);
    h.host.release("tech_lead", "p-tech_lead");
    h.host.join("tech_lead", "p-tech_lead"); // the old holder again: nothing in memory any more
    expect(h.host.voiceStateOf("tech_lead")).toBe("none");
  });

  it("after a restart the record still applies to the same participant and only to them", () => {
    const credentials = PlayerCredentials.create(BIND);
    const vbind = { sessionId: "local", logIdentity: credentials.logIdentity };
    const disk = fakeVoiceIO(vbind);
    const first = makeHost({ credentials, disk });
    first.host.join("tech_lead", "p1");
    first.host.giveConsent("tech_lead", "p1", "v3");
    first.host.optInVoice("tech_lead", "p1", "v3");
    // A second host over the same files (a restart): the voice record is read back.
    const second = makeHost({ credentials, disk });
    second.seats.consent.adopt("tech_lead", "p1", "v3", 1);
    second.host.join("tech_lead", "p1");
    expect(second.host.voiceStateOf("tech_lead")).toBe("voice");
    second.host.release("tech_lead", "p1");
    second.host.join("tech_lead", "p2");
    expect(second.host.voiceStateOf("tech_lead")).toBe("text_only");
  });

  it("a record whose logIdentity differs (fresh start on an old id) is ignored and removed", async () => {
    const dir = await mkdtemp(path.join(parentTmp, "fresh-"));
    const old = VoiceChoices.empty({ sessionId: "local", logIdentity: "f".repeat(32) });
    old.set("tech_lead", { participantId: "p1", choice: "voice", noticeVersion: "v3", at: 1 });
    writeVoiceFile(dir, { sessionId: "local", logIdentity: "f".repeat(32) }, old);
    const h = makeHost({ io: (b) => voiceFileIO(dir, b) });
    expect(h.logs).toContain("the voice choices on file belong to another session log: they are ignored and removed (every seat starts with no voice choice)");
    expect(await readdir(dir)).toEqual([]);
    h.host.join("tech_lead", "p1");
    expect(h.host.voiceStateOf("tech_lead")).toBe("none");
  });

  it("a malformed record is ignored, reported by a fixed sentence and removed", async () => {
    const dir = await mkdtemp(path.join(parentTmp, "bad-"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "local.voice.json"), "{SECRET", { mode: 0o600 });
    const h = makeHost({ io: (b) => voiceFileIO(dir, b) });
    expect(h.logs).toContain("the voice choices on file could not be read: they are ignored and removed (every seat starts with no voice choice)");
    expect(h.logs.join("\n")).not.toContain("SECRET");
    expect(await readdir(dir)).toEqual([]);
  });

  it("with voice disabled the voice file is never read or written", () => {
    let reads = 0;
    const h = makeHost({ voice: { enabled: false }, io: () => ({ read: () => { reads++; throw new Error("no"); }, write: () => { throw new Error("no"); }, remove: () => { throw new Error("no"); } }) });
    h.host.join("tech_lead", "p1");
    expect(reads).toBe(0);
    expect(h.host.voiceSeats().holders).toEqual([{ roleId: "tech_lead", participantId: "p1", recording: false }]);
  });

  it("R14 seeding of consent never creates a voice entry", () => {
    const h = makeHost();
    h.host.resumeFrom({ events: 1, lastTs: 0, format: 3, partialTailBytes: 0, sceneId: null, repairs: [], lastGmSeq: null, pendingLine: false, wasPaused: true,
      startedConsents: { tech_lead: { participantId: "p1", noticeVersion: "v3", at: 7 } } } as never);
    expect(h.seats.consent.has("tech_lead", "p1")).toBe(true);
    h.host.join("tech_lead", "p1");
    expect(h.host.voiceStateOf("tech_lead")).toBe("none");
    expect(h.disk.writes).toBe(0);
  });

  it("the real file round-trips through voiceFileIO (0600, bound to the log identity)", async () => {
    const dir = await mkdtemp(path.join(parentTmp, "real-"));
    const h = makeHost({ io: (b) => voiceFileIO(dir, b) });
    h.host.join("tech_lead", "p1");
    h.host.giveConsent("tech_lead", "p1", "v3");
    h.host.optInVoice("tech_lead", "p1", "v3");
    const back = readVoiceFile(dir, { sessionId: "local", logIdentity: h.seats.credentials.logIdentity });
    expect(back.problem).toBeUndefined();
    expect(back.choices.choiceFor("tech_lead", "p1")).toBe("voice");
  });
});

describe("voiceSeats and its notifications (US-0070)", () => {
  it("voiceSeats lists holders in scenario player order and never an AI seat or an NPC", () => {
    const h = makeHost({ aiRoles: ["delivery_lead"] });
    h.host.join("tech_lead", "p3");
    h.host.join("delivery_lead", "bot");
    h.host.join("account_manager", "p1");
    expect(h.host.voiceSeats().holders.map((x) => x.roleId)).toEqual(["account_manager", "tech_lead"]);
    expect(h.host.voiceStateOf("client_sponsor")).toBe("off"); // an AI character (NPC) is never a voice seat
  });

  it("voice_seats changes are coalesced into one notification per turn", async () => {
    const h = makeHost();
    const got: ReturnType<SessionHost["voiceSeats"]>[] = [];
    h.host.onVoiceSeatsChanged((s) => got.push(s));
    h.host.join("tech_lead", "p1");
    h.host.giveConsent("tech_lead", "p1", "v3");
    h.host.optInVoice("tech_lead", "p1", "v3");
    h.host.join("account_manager", "p2");
    expect(got).toHaveLength(0); // nothing synchronous
    await Promise.resolve();
    expect(got).toEqual([{ paused: false, ended: false, holders: [{ roleId: "account_manager", participantId: "p2", recording: false }, { roleId: "tech_lead", participantId: "p1", recording: true }] }]);
    h.host.release("tech_lead", "p1");
    await Promise.resolve();
    expect(got).toHaveLength(2);
    expect(got[1]!.holders).toEqual([{ roleId: "account_manager", participantId: "p2", recording: false }]);
  });

  it("pause, resume and the end are notified, with paused and ended", async () => {
    const h = makeHost();
    await startAll(h);
    const got: ReturnType<SessionHost["voiceSeats"]>[] = [];
    const off = h.host.onVoiceSeatsChanged((s) => got.push(s));
    await h.host.command({ command: "pause" });
    await vi.waitFor(() => expect(got.at(-1)?.paused).toBe(true));
    await h.host.command({ command: "resume" });
    await vi.waitFor(() => expect(got.at(-1)?.paused).toBe(false));
    await h.host.endNow({});
    await vi.waitFor(() => expect(got.at(-1)?.ended).toBe(true));
    const n = got.length;
    off();
    h.host.release("tech_lead", "p-tech_lead");
    await Promise.resolve();
    expect(got).toHaveLength(n);
  });

  it("a listener that throws does not stop the others", async () => {
    const h = makeHost();
    const got: unknown[] = [];
    h.host.onVoiceSeatsChanged(() => { throw new Error("boom"); });
    h.host.onVoiceSeatsChanged((s) => got.push(s));
    h.host.join("tech_lead", "p1");
    await Promise.resolve();
    expect(got).toHaveLength(1);
  });

  it("with voice disabled nothing is notified", async () => {
    const h = makeHost({ voice: { enabled: false } });
    const got: unknown[] = [];
    h.host.onVoiceSeatsChanged((s) => got.push(s));
    h.host.join("tech_lead", "p1");
    await Promise.resolve();
    expect(got).toEqual([]);
  });
});
