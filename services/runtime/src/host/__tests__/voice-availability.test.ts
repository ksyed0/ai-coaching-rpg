import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { VoiceChoices, type VoiceFileIO } from "../../engine/voice-file.js";
import { SessionHost, VoiceRefusedError } from "../session-host.js";
import { startServer, type ServerHandle } from "../ws-server.js";

// US-0071 (EPIC-0003 voice A1b, Task 3, K7): control's `voice_availability` sets the host's flag FIRST (no rate limit, also before the
// start); unavailable makes every seat's `recording` false, tells each voice holder once, and a holder who binds meanwhile too.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
let scenario: Scenario;
beforeAll(async () => { scenario = await loadScenario(friday); });

function makeHost() {
  const clock = new FakeClock(5_000);
  const log = new MemoryEventLog("local");
  const engine = new SessionEngine({ scenario, log, clock });
  const credentials = PlayerCredentials.create(BIND);
  const vbind = { sessionId: "local", logIdentity: credentials.logIdentity };
  let record: unknown = null;
  const voiceFile: VoiceFileIO = { read: () => ({ choices: record === null ? VoiceChoices.empty(vbind) : VoiceChoices.fromRecord(record, vbind) }), write: (c) => { record = c.toRecord(); }, remove: () => { record = null; } };
  const seats: Seats = { credentials, consent: new ConsentStore({ version: "v3", text: "notice" }), aiRoles: AiRoleSet.empty(), persist: () => {}, voiceFile };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats, voice: { enabled: true, turnEndMs: 800 } });
  const notices: string[] = [];
  host.onVoiceNotice((roleId, code) => notices.push(`${roleId}:${code}`));
  return { host, engine, clock, log, notices };
}
type H = ReturnType<typeof makeHost>;
function joinAll(h: H) { for (const r of PLAYERS) { h.host.join(r, `p-${r}`); h.host.giveConsent(r, `p-${r}`, "v3"); } }
async function startAll(h: H) { joinAll(h); await h.host.start(); }
const recordingRoles = (h: H) => h.host.voiceSeats().holders.filter((x) => x.recording).map((x) => x.roleId);

describe("voice availability (US-0071, K7)", () => {
  it("voice_availability available false sends voice_unavailable to every voice holder once and recording turns false", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.host.optInVoice("account_manager", "p-account_manager", "v3");
    expect(recordingRoles(h)).toEqual(["account_manager", "tech_lead"]);
    h.host.voiceAvailability(false, false);
    expect(recordingRoles(h)).toEqual([]);
    expect(h.notices).toEqual(["account_manager:voice_unavailable", "tech_lead:voice_unavailable"]);
    h.host.voiceAvailability(false, false); // no transition: nothing again
    h.host.voiceAvailability(false, true);
    expect(h.notices).toHaveLength(2);
  });

  it("it is applied before the start", async () => {
    const h = makeHost();
    joinAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.host.voiceAvailability(false, false);
    expect(h.notices).toEqual(["tech_lead:voice_unavailable"]); // the lobby page is told too
    await h.host.start();
    expect(recordingRoles(h)).toEqual([]);
    h.host.voiceAvailability(true, false);
    expect(recordingRoles(h)).toEqual(["tech_lead"]);
  });

  it("it is applied even right after a rate-limited alert", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    await h.host.voiceAlert("stt_unavailable");
    await h.host.voiceAlert("stt_unavailable"); // within 30 s: rate limited
    h.host.voiceAvailability(false, false);
    expect(recordingRoles(h)).toEqual([]);
    expect(h.notices).toEqual(["tech_lead:voice_unavailable"]);
  });

  it("available true restores recording", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.host.voiceAvailability(false, false);
    h.host.voiceAvailability(true, false);
    expect(recordingRoles(h)).toEqual(["tech_lead"]);
  });

  it("off true keeps recording false even with available true", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.host.voiceAvailability(true, true);
    expect(recordingRoles(h)).toEqual([]);
    expect(h.notices).toEqual(["tech_lead:voice_unavailable"]);
  });

  it("each transition to unavailable notifies again, without the 10 s notice limit", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.host.voiceAvailability(false, false);
    h.host.voiceAvailability(true, false);
    h.host.voiceAvailability(false, false);
    expect(h.notices).toEqual(["tech_lead:voice_unavailable", "tech_lead:voice_unavailable"]);
  });

  it("a transition notifies the worker's seats again", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    const got: boolean[] = [];
    h.host.onVoiceSeatsChanged((s) => got.push(s.holders.some((x) => x.recording)));
    h.host.voiceAvailability(false, false);
    await vi.waitFor(() => expect(got.at(-1)).toBe(false));
    h.host.voiceAvailability(true, false);
    await vi.waitFor(() => expect(got.at(-1)).toBe(true));
  });

  it("a line arriving while unavailable is refused not_recording", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.host.voiceAvailability(false, false);
    const err = await h.host.onVoiceUtterance("tech_lead", "p-tech_lead", "words").then(() => null, (e: unknown) => e);
    expect((err as VoiceRefusedError).code).toBe("not_recording");
    h.host.onSpeechActivity("tech_lead", true);
    expect(h.host.voiceTurnOpen).toBe(false);
  });

  it("unavailability clears who is speaking", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optInVoice("tech_lead", "p-tech_lead", "v3");
    h.host.onSpeechActivity("tech_lead", true);
    expect([...h.host.speakingRoles()]).toEqual(["tech_lead"]);
    h.host.voiceAvailability(false, false);
    expect([...h.host.speakingRoles()]).toEqual([]);
  });

  it("a text-only seat gets no notice", async () => {
    const h = makeHost();
    await startAll(h);
    h.host.optOutVoice("account_manager", "p-account_manager");
    h.host.voiceAvailability(false, false);
    expect(h.notices).toEqual([]);
    h.host.noteVoiceBound("account_manager", "p-account_manager");
    expect(h.notices).toEqual([]);
  });
});

// The socket: a holder who joins or reconnects while voice is unavailable is told after `joined`.
let server: ServerHandle | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => { for (const s of sockets) s.terminate(); sockets = []; await server?.close(); server = null; });
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

describe("voice_unavailable on bind (US-0071, K7)", () => {
  it("a holder who joins while unavailable gets voice_unavailable after joined", async () => {
    const h = makeHost();
    const issued = JoinCodes.issue(PLAYERS, BIND);
    server = await startServer({ port: 0, hosts: new Map([["local", h.host]]), log: () => {}, joinCodes: new Map([["local", issued.codes]]) });
    const pat = await open(server.port);
    pat.send({ type: "join", sessionId: "local", roleId: "tech_lead", participantId: "pat", joinCode: issued.plain.tech_lead });
    const joined = await pat.next((m) => m.type === "joined");
    pat.send({ type: "consent", noticeVersion: "v3" });
    pat.send({ type: "voice_opt_in", noticeVersion: "v3" });
    await pat.next((m) => m.type === "voice");
    expect(pat.inbox.some((m) => m.type === "voice_notice")).toBe(false);
    h.host.voiceAvailability(false, false);
    expect(await pat.next((m) => m.type === "voice_notice")).toEqual({ type: "voice_notice", code: "voice_unavailable" });
    // A reconnect on a new socket while it is still set: told again, after its joined.
    const again = await open(server.port);
    again.send({ type: "join", sessionId: "local", roleId: "tech_lead", participantId: "pat", reconnectToken: joined.reconnectToken });
    await again.next((m) => m.type === "voice_notice");
    const kinds = again.inbox.map((m) => m.type);
    expect(kinds.indexOf("joined")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("voice_notice")).toBeGreaterThan(kinds.indexOf("joined"));
    expect(again.inbox.filter((m) => m.type === "voice_notice")).toEqual([{ type: "voice_notice", code: "voice_unavailable" }]);
    // A seat with no voice choice that joins meanwhile is not told.
    const sam = await open(server.port);
    sam.send({ type: "join", sessionId: "local", roleId: "account_manager", participantId: "sam", joinCode: issued.plain.account_manager });
    await sam.next((m) => m.type === "joined");
    sam.send({ type: "voice_opt_out" });
    await sam.next((m) => m.type === "voice" || m.type === "error");
    expect(sam.inbox.some((m) => m.type === "voice_notice")).toBe(false);
  });

  it("a holder who opts in while unavailable gets exactly one voice_unavailable after the voice answer (F3)", async () => {
    const h = makeHost();
    const issued = JoinCodes.issue(PLAYERS, BIND);
    server = await startServer({ port: 0, hosts: new Map([["local", h.host]]), log: () => {}, joinCodes: new Map([["local", issued.codes]]) });
    h.host.voiceAvailability(false, false); // before anyone chose voice: nobody to tell yet
    const pat = await open(server.port);
    pat.send({ type: "join", sessionId: "local", roleId: "tech_lead", participantId: "pat", joinCode: issued.plain.tech_lead });
    await pat.next((m) => m.type === "joined");
    pat.send({ type: "consent", noticeVersion: "v3" });
    pat.send({ type: "voice_opt_in", noticeVersion: "v3" });
    // A later answer on the same socket: every frame of the opt-in has arrived before it (so a missing notice fails fast).
    pat.send({ type: "voice_mute", muted: false });
    await pat.next((m) => m.type === "voice" && m.muted === false);
    const kinds = pat.inbox.map((m) => m.type);
    expect(kinds.indexOf("voice_notice")).toBeGreaterThan(kinds.indexOf("voice"));
    expect(pat.inbox.filter((m) => m.type === "voice_notice")).toEqual([{ type: "voice_notice", code: "voice_unavailable" }]);
  });
});
