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
import { HostError, SessionHost, VoiceRefusedError } from "../session-host.js";
import type { VoiceConfig } from "../voice-config.js";
import type { VoiceNoticeCode } from "../voice.js";

// US-0071 (EPIC-0003 voice A1b, Task 3, K5): mute is in memory only, makes `recording` false at once, and the runtime's second gate
// refuses a line that arrives after it (mute is retroactive for lines still in flight).
const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
let scenario: Scenario;
beforeAll(async () => { scenario = await loadScenario(friday); });

function makeHost(o: { voice?: VoiceConfig; aiRoles?: string[] } = {}) {
  const clock = new FakeClock(5_000);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock });
  const aiRoles = AiRoleSet.empty();
  aiRoles.replace(o.aiRoles ?? [], PLAYERS);
  const credentials = PlayerCredentials.create(BIND);
  const vbind = { sessionId: "local", logIdentity: credentials.logIdentity };
  const disk = { record: null as unknown, writes: 0 };
  const voiceFile: VoiceFileIO = {
    read: () => ({ choices: disk.record === null ? VoiceChoices.empty(vbind) : VoiceChoices.fromRecord(disk.record, vbind) }),
    write: (c) => { disk.writes++; disk.record = c.toRecord(); },
    remove: () => { disk.record = null; },
  };
  const seats: Seats = { credentials, consent: new ConsentStore({ version: "v3", text: "notice" }), aiRoles, persist: () => {}, voiceFile };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats, voice: o.voice ?? { enabled: true, turnEndMs: 800 } });
  const notices: string[] = [];
  host.onVoiceNotice((roleId, code: VoiceNoticeCode) => notices.push(`${roleId}:${code}`));
  return { host, engine, disk, notices };
}
type H = ReturnType<typeof makeHost>;
const code = (fn: () => unknown): string | undefined => { try { fn(); return undefined; } catch (err) { return err instanceof HostError ? err.code : `other:${(err as Error).message}`; } };
async function startAll(h: H, ai: string[] = []) {
  for (const r of PLAYERS) { h.host.join(r, ai.includes(r) ? `bot-${r}` : `p-${r}`); if (!ai.includes(r)) h.host.giveConsent(r, `p-${r}`, "v3"); }
  await h.host.start();
}
const recording = (h: H, roleId: string) => h.host.voiceSeats().holders.find((x) => x.roleId === roleId)?.recording;

describe("voice mute (US-0071, K5)", () => {
  it("mute makes recording false at once and unmute restores it", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    expect(recording(h, "tech_lead")).toBe(true);
    h.host.muteVoice("tech_lead", "p-tech_lead", true);
    expect(recording(h, "tech_lead")).toBe(false);
    expect(h.host.voiceStateOf("tech_lead")).toBe("voice"); // the choice itself is unchanged
    h.host.muteVoice("tech_lead", "p-tech_lead", false);
    expect(recording(h, "tech_lead")).toBe(true);
  });

  it("mute is refused voice_off, forbidden for an AI seat, not_joined for a non-holder", async () => {
    const off = makeHost({ voice: { enabled: false } });
    off.host.join("tech_lead", "p1");
    expect(code(() => off.host.muteVoice("tech_lead", "p1", true))).toBe("voice_off");
    const h = makeHost({ aiRoles: ["delivery_lead"] });
    h.host.join("delivery_lead", "bot");
    expect(code(() => h.host.muteVoice("delivery_lead", "bot", true))).toBe("forbidden");
    h.host.join("tech_lead", "p1");
    expect(code(() => h.host.muteVoice("tech_lead", "p2", true))).toBe("not_joined");
    expect(code(() => h.host.muteVoice("account_manager", "p1", true))).toBe("not_joined");
    expect(code(() => h.host.muteVoice("__proto__", "p1", true))).toBe("not_joined");
    expect(code(() => h.host.muteVoice("client_sponsor", "p1", true))).toBe("not_joined"); // an AI character is no seat
    expect(code(() => h.host.muteVoice("tech_lead", "p1", true))).toBeUndefined();
  });

  it("a released holder comes back unmuted", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.host.muteVoice("tech_lead", "p-tech_lead", true);
    h.host.release("tech_lead", "p-tech_lead");
    h.host.join("tech_lead", "p-tech_lead");
    expect(recording(h, "tech_lead")).toBe(true);
  });

  it("a reissued seat forgets the mute", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.host.muteVoice("tech_lead", "p-tech_lead", true);
    h.host.forgetVoice("tech_lead");
    expect((h.host as unknown as { voiceMuted: Set<string> }).voiceMuted.has("tech_lead")).toBe(false);
  });

  it("mute is never written to the voice record", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    const before = { writes: h.disk.writes, record: JSON.stringify(h.disk.record) };
    h.host.muteVoice("tech_lead", "p-tech_lead", true);
    h.host.muteVoice("tech_lead", "p-tech_lead", false);
    h.host.muteVoice("tech_lead", "p-tech_lead", true);
    expect({ writes: h.disk.writes, record: JSON.stringify(h.disk.record) }).toEqual(before);
    expect(JSON.stringify(h.disk.record)).not.toContain("mute");
  });

  it("a line arriving after mute is refused not_recording", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.host.muteVoice("tech_lead", "p-tech_lead", true);
    const lastSeq = h.engine.state.lastSeq;
    const err = await h.host.onVoiceUtterance("tech_lead", "p-tech_lead", "We can ship in May.").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceRefusedError);
    expect((err as VoiceRefusedError).code).toBe("not_recording");
    expect(h.engine.state.lastSeq).toBe(lastSeq); // nothing appended
    expect(h.notices).toEqual(["tech_lead:not_recording"]); // the usual private notice
    h.host.muteVoice("tech_lead", "p-tech_lead", false);
    await expect(h.host.onVoiceUtterance("tech_lead", "p-tech_lead", "We can ship in May.")).resolves.toEqual({ seq: expect.any(Number) });
    await h.host.idle();
  });

  it("speech_activity of a muted seat is ignored", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.host.muteVoice("tech_lead", "p-tech_lead", true);
    h.host.onSpeechActivity("tech_lead", true);
    expect(h.host.voiceTurnOpen).toBe(false);
    h.host.muteVoice("tech_lead", "p-tech_lead", false);
    h.host.onSpeechActivity("tech_lead", true);
    expect(h.host.voiceTurnOpen).toBe(true);
  });

  it("mute while speaking stops that track holding the voice turn open", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.host.onSpeechActivity("tech_lead", true);
    expect(h.host.speakingRoles().has("tech_lead")).toBe(true);
    h.host.muteVoice("tech_lead", "p-tech_lead", true);
    expect(h.host.speakingRoles().has("tech_lead")).toBe(false);
  });
});
