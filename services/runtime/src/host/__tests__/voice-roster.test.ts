import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadScenario } from "@acr/script";
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
import { SessionHost } from "../session-host.js";
import { startServer, type ServerHandle } from "../ws-server.js";
import type { VoiceConfig } from "../voice-config.js";
import { SPEAKING_BROADCAST_MS, type SetTimer } from "../voice.js";

// US-0071 (EPIC-0003 voice A1b, Task 3, K6): the facilitator's roster carries each seat's voice state and who is speaking; the peers'
// roster never does (Open Question 1). Real sockets on port 0; waits are on the frames themselves.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
let server: ServerHandle | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => { for (const s of sockets) s.terminate(); sockets = []; await server?.close(); server = null; });

type Client = { inbox: any[]; send(m: unknown): void; next(pred: (m: any) => boolean, from?: number): Promise<any>; drop(): void };
async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; from: number; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (inbox.length - 1 >= w.from && w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const next = (pred: (m: any) => boolean, from = 0) => new Promise<any>((resolve) => { const found = inbox.slice(from).find(pred); if (found) return resolve(found); waiters.push({ pred, from, resolve }); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { inbox, next, send: (m) => ws.send(JSON.stringify(m)), drop: () => ws.terminate() };
}

async function setup(voice: VoiceConfig = { enabled: true, turnEndMs: 800 }, setTimer?: SetTimer) {
  const scenario = await loadScenario(friday);
  const clock = new FakeClock(1_000);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock });
  const credentials = PlayerCredentials.create(BIND);
  const vbind = { sessionId: "local", logIdentity: credentials.logIdentity };
  let record: unknown = null;
  const voiceFile: VoiceFileIO = { read: () => ({ choices: record === null ? VoiceChoices.empty(vbind) : VoiceChoices.fromRecord(record, vbind) }), write: (c) => { record = c.toRecord(); }, remove: () => { record = null; } };
  const seats: Seats = { credentials, consent: new ConsentStore({ version: "v3", text: "notice v3" }), aiRoles: AiRoleSet.empty(), persist: () => {}, voiceFile };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats, voice, ...(setTimer ? { setTimer } : {}) });
  const issued = JoinCodes.issue(PLAYERS, BIND);
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), log: () => {}, joinCodes: new Map([["local", issued.codes]]) });
  const players: Record<string, Client> = {};
  for (const r of PLAYERS) {
    const c = await open(server.port);
    c.send({ type: "join", sessionId: "local", roleId: r, participantId: `p-${r}`, joinCode: issued.plain[r] });
    await c.next((m) => m.type === "joined");
    c.send({ type: "consent", noticeVersion: "v3" });
    players[r] = c;
  }
  await vi.waitFor(() => { for (const r of PLAYERS) expect(host.consentGiven(r, `p-${r}`)).toBe(true); });
  const fac = await open(server.port);
  fac.send({ type: "join_facilitator", sessionId: "local" });
  await fac.next((m) => m.type === "joined");
  await host.start();
  return { host, engine, players, fac };
}
type E = Awaited<ReturnType<typeof setup>>;
const facRoster = (c: Client, pred: (entries: any[]) => boolean, from = 0) => c.next((m) => m.type === "roster" && m.audience === "facilitator" && pred(m.entries), from);
const entry = (entries: any[], role: string) => entries.find((x) => x.roleId === role);
/** Every frame sent to `c` before this call has arrived once the answer to a bad message is in. */
async function barrier(c: Client) {
  const n = c.inbox.filter((m) => m.type === "error").length;
  c.send({ type: "nope" });
  await vi.waitFor(() => expect(c.inbox.filter((m) => m.type === "error").length).toBe(n + 1));
}
async function optIn(e: E, role: string) {
  const c = e.players[role]!;
  const n = c.inbox.filter((m) => m.type === "voice").length;
  c.send({ type: "voice_opt_in", noticeVersion: "v3" });
  await vi.waitFor(() => expect(c.inbox.filter((m) => m.type === "voice").length).toBe(n + 1));
}

describe("voice in the roster (US-0071, K6)", () => {
  it("the facilitator roster carries voice and speaking for recording holders", async () => {
    const e = await setup();
    await optIn(e, "tech_lead");
    e.players.account_manager!.send({ type: "voice_opt_out" });
    const r1 = await facRoster(e.fac, (en) => entry(en, "tech_lead").voice === "voice" && entry(en, "account_manager").voice === "text_only");
    expect(entry(r1.entries, "delivery_lead").voice).toBe("none");
    for (const x of r1.entries) expect(x).not.toHaveProperty("speaking");
    e.host.onSpeechActivity("tech_lead", true);
    const r2 = await facRoster(e.fac, (en) => entry(en, "tech_lead").speaking === true);
    expect(r2.entries.filter((x: any) => x.speaking === true).map((x: any) => x.roleId)).toEqual(["tech_lead"]);
    e.host.onSpeechActivity("tech_lead", false);
    await facRoster(e.fac, (en) => !("speaking" in entry(en, "tech_lead")), e.fac.inbox.indexOf(r2) + 1);
  });

  it("the peers roster never carries voice or speaking", async () => {
    const e = await setup();
    await optIn(e, "tech_lead");
    e.host.onSpeechActivity("tech_lead", true);
    await facRoster(e.fac, (en) => entry(en, "tech_lead").speaking === true);
    e.players.account_manager!.drop(); // a disconnect: a roster for everyone (a leave is refused once started)
    await facRoster(e.fac, (en) => !entry(en, "account_manager").joined);
    for (const r of ["delivery_lead", "tech_lead"]) await barrier(e.players[r]!);
    let peerFrames = 0;
    for (const c of Object.values(e.players)) for (const m of c.inbox) {
      if (m.type !== "roster") continue;
      expect(m.audience).toBe("peers");
      peerFrames++;
      for (const x of m.entries) { expect(x).not.toHaveProperty("voice"); expect(x).not.toHaveProperty("speaking"); }
    }
    expect(peerFrames).toBeGreaterThan(0);
  });

  it("a text-only session's facilitator roster has neither key", async () => {
    const e = await setup({ enabled: false });
    e.players.tech_lead!.drop();
    const r = await facRoster(e.fac, (en) => !entry(en, "tech_lead").joined);
    for (const m of e.fac.inbox.filter((x) => x.type === "roster")) for (const x of m.entries) { expect(x).not.toHaveProperty("voice"); expect(x).not.toHaveProperty("speaking"); }
    expect(Object.keys(entry(r.entries, "account_manager")).sort()).toEqual(["connected", "consented", "joined", "roleId"]);
  });

  it("a speaking edge sends a roster to the facilitator socket only", async () => {
    const e = await setup();
    await optIn(e, "tech_lead");
    for (const c of Object.values(e.players)) await barrier(c);
    const before = Object.fromEntries(Object.entries(e.players).map(([r, c]) => [r, c.inbox.filter((m) => m.type === "roster").length]));
    e.host.onSpeechActivity("tech_lead", true);
    await facRoster(e.fac, (en) => entry(en, "tech_lead").speaking === true);
    for (const c of Object.values(e.players)) await barrier(c);
    expect(Object.fromEntries(Object.entries(e.players).map(([r, c]) => [r, c.inbox.filter((m) => m.type === "roster").length]))).toEqual(before);
  });

  it("pause clears speaking", async () => {
    const e = await setup();
    await optIn(e, "tech_lead");
    e.host.onSpeechActivity("tech_lead", true);
    const r = await facRoster(e.fac, (en) => entry(en, "tech_lead").speaking === true);
    await e.host.command({ command: "pause" });
    await facRoster(e.fac, (en) => !("speaking" in entry(en, "tech_lead")), e.fac.inbox.indexOf(r) + 1);
    expect(e.host.speakingRoles().size).toBe(0);
  });

  it("mute clears speaking", async () => {
    const e = await setup();
    await optIn(e, "tech_lead");
    e.host.onSpeechActivity("tech_lead", true);
    const r = await facRoster(e.fac, (en) => entry(en, "tech_lead").speaking === true);
    e.players.tech_lead!.send({ type: "voice_mute", muted: true });
    const after = await facRoster(e.fac, (en) => !("speaking" in entry(en, "tech_lead")), e.fac.inbox.indexOf(r) + 1);
    expect(entry(after.entries, "tech_lead").voice).toBe("voice");
  });

  // Review finding 5: a flapping speaker costs one facilitator roster frame per SPEAKING_BROADCAST_MS window, with the final state.
  it("flapping speech edges send one facilitator roster per window, carrying the last state (injected timer)", async () => {
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const setTimer: SetTimer = (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; };
    const fireWindow = () => { for (const t of timers) if (t.live && t.ms === SPEAKING_BROADCAST_MS) { t.live = false; t.fn(); } };
    const e = await setup(undefined, setTimer);
    await optIn(e, "tech_lead");
    await optIn(e, "delivery_lead");
    await barrier(e.fac);
    const facRosters = () => e.fac.inbox.filter((m) => m.type === "roster" && m.audience === "facilitator");
    const before = facRosters().length;
    for (const a of [true, false, true, false, true]) e.host.onSpeechActivity("tech_lead", a);
    e.host.onSpeechActivity("delivery_lead", true);
    e.host.onSpeechActivity("delivery_lead", false);
    await barrier(e.fac);
    expect(facRosters().length).toBe(before); // the window is still open: nothing sent yet
    fireWindow();
    await barrier(e.fac);
    expect(facRosters().length).toBe(before + 1);
    const last = facRosters().at(-1)!;
    expect(entry(last.entries, "tech_lead").speaking).toBe(true);
    expect(entry(last.entries, "delivery_lead")).not.toHaveProperty("speaking");
  });
});
