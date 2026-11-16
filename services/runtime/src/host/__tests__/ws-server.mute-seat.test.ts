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

// A3A Task 3: the facilitator's mute_seat as the players, the peers roster and the console see it. Real sockets on port 0.
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

async function setup(o: { start?: boolean; aiRoles?: string[] } = {}) {
  const scenario = await loadScenario(friday);
  const clock = new FakeClock(1_000);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock });
  const credentials = PlayerCredentials.create(BIND);
  const vbind = { sessionId: "local", logIdentity: credentials.logIdentity };
  let record: unknown = null;
  const voiceFile: VoiceFileIO = { read: () => ({ choices: record === null ? VoiceChoices.empty(vbind) : VoiceChoices.fromRecord(record, vbind) }), write: (c) => { record = c.toRecord(); }, remove: () => { record = null; } };
  const ai = AiRoleSet.empty();
  ai.replace(o.aiRoles ?? [], PLAYERS);
  const seats: Seats = { credentials, consent: new ConsentStore({ version: "v3", text: "notice v3" }), aiRoles: ai, persist: () => {}, voiceFile };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats, voice: { enabled: true, turnEndMs: 800 } });
  const issued = JoinCodes.issue(PLAYERS, BIND);
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), log: () => {}, joinCodes: new Map([["local", issued.codes]]) });
  const port = server.port;
  const join = async (roleId: string, extra: Record<string, unknown> = {}) => {
    const c = await open(port);
    c.send({ type: "join", sessionId: "local", roleId, participantId: `p-${roleId}`, joinCode: issued.plain[roleId], ...extra });
    const joined = await c.next((m) => m.type === "joined" || m.type === "error");
    return Object.assign(c, { joined });
  };
  const players: Record<string, Client & { joined: any }> = {};
  for (const r of PLAYERS.filter((x) => !(o.aiRoles ?? []).includes(x))) {
    players[r] = await join(r);
    players[r]!.send({ type: "consent", noticeVersion: "v3" });
  }
  await vi.waitFor(() => { for (const r of Object.keys(players)) expect(host.consentGiven(r, `p-${r}`)).toBe(true); });
  const fac = await open(port);
  fac.send({ type: "join_facilitator", sessionId: "local" });
  await fac.next((m) => m.type === "joined");
  if (o.start !== false) {
    for (const r of o.aiRoles ?? []) host.join(r, `bot-${r}`);
    await host.start();
  }
  return { host, engine, players, fac, join, issued };
}
type E = Awaited<ReturnType<typeof setup>>;
let refN = 0;
const mute = async (e: E, roleId: string, muted: boolean, extra: Record<string, unknown> = {}) => {
  const ref = `m${++refN}`;
  e.fac.send({ type: "command", command: { command: "mute_seat", roleId, muted }, by: "Alex", ref, ...extra });
  return e.fac.next((m) => (m.type === "ack" || m.type === "error") && m.ref === ref);
};
const voiceFrames = (c: Client) => c.inbox.filter((m) => m.type === "voice");
const peersRoster = (c: Client, pred: (entries: any[]) => boolean, from = 0) => c.next((m) => m.type === "roster" && m.audience === "peers" && pred(m.entries), from);
const facRoster = (c: Client, pred: (entries: any[]) => boolean, from = 0) => c.next((m) => m.type === "roster" && m.audience === "facilitator" && pred(m.entries), from);
const entry = (entries: any[], role: string) => entries.find((x) => x.roleId === role);
async function barrier(c: Client) {
  const n = c.inbox.filter((m) => m.type === "error").length;
  c.send({ type: "nope" });
  await vi.waitFor(() => expect(c.inbox.filter((m) => m.type === "error").length).toBe(n + 1));
}

describe("mute_seat reaches the holder and the room (A3A)", () => {
  it("pushes a voice frame to the holder: mutedBy facilitator on mute, muted false without mutedBy on unmute; others get none", async () => {
    const e = await setup();
    const pat = e.players.tech_lead!;
    pat.send({ type: "voice_opt_in", noticeVersion: "v3" });
    await pat.next((m) => m.type === "voice");
    const before = voiceFrames(pat).length;
    expect((await mute(e, "tech_lead", true)).type).toBe("ack");
    const on = await pat.next((m) => m.type === "voice" && m.muted === true && m.mutedBy === "facilitator");
    expect(on).toEqual({ type: "voice", state: "voice", muted: true, mutedBy: "facilitator" });
    expect((await mute(e, "tech_lead", false)).type).toBe("ack");
    const off = await pat.next((m) => m.type === "voice" && m.muted === false, before);
    expect(off).toEqual({ type: "voice", state: "voice", muted: false });
    await barrier(pat);
    expect(voiceFrames(pat).length).toBe(before + 2); // one per change, no duplicates
    await barrier(e.players.account_manager!);
    expect(voiceFrames(e.players.account_manager!)).toHaveLength(0);
    expect(voiceFrames(e.fac)).toHaveLength(0);
  });

  it("other players get the role-label event and nobody gets `by` or the facilitator's name", async () => {
    const e = await setup();
    await mute(e, "tech_lead", true);
    const sam = e.players.account_manager!;
    const ev = await sam.next((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "mute_seat");
    expect(ev.event).toMatchObject({ command: "mute_seat", roleId: "tech_lead", muted: true });
    expect(Object.keys(ev.event).sort()).toEqual(["command", "muted", "roleId", "seq", "sessionId", "ts", "type"]);
    await barrier(sam); await barrier(e.players.tech_lead!);
    for (const c of Object.values(e.players)) expect(JSON.stringify(c.inbox)).not.toContain("Alex");
    // the facilitator's own copy keeps `by`
    const own = await e.fac.next((m) => m.type === "event" && m.event.command === "mute_seat");
    expect(own.event.by).toBe("Alex");
  });

  it("the holder's voice_mute false is refused muted_by_facilitator and true is accepted; the own mute then outlives the facilitator's", async () => {
    const e = await setup();
    const pat = e.players.tech_lead!;
    await mute(e, "tech_lead", true);
    await pat.next((m) => m.type === "voice" && m.mutedBy === "facilitator");
    pat.send({ type: "voice_mute", muted: false });
    const refused = await pat.next((m) => m.type === "error" && m.code === "muted_by_facilitator");
    expect(refused.code).toBe("muted_by_facilitator");
    expect(e.host.facilitatorMutedOf("tech_lead")).toBe(true);
    const n = voiceFrames(pat).length;
    pat.send({ type: "voice_mute", muted: true });
    const ok = await pat.next((m) => m.type === "voice" && m.muted === true, n);
    expect(ok).toEqual({ type: "voice", state: "none", muted: true, mutedBy: "facilitator" });
    await mute(e, "tech_lead", false);
    const after = await pat.next((m) => m.type === "voice" && !("mutedBy" in m), n + 1);
    expect(after).toEqual({ type: "voice", state: "none", muted: true }); // the holder's own mute remains
    pat.send({ type: "voice_mute", muted: false });
    expect((await pat.next((m) => m.type === "voice" && m.muted === false, n + 2)).muted).toBe(false);
  });

  it("an AI seat cannot be muted and nobody gets a frame", async () => {
    const e = await setup({ aiRoles: ["delivery_lead"] });
    const r = await mute(e, "delivery_lead", true);
    expect(r).toMatchObject({ type: "error", code: "forbidden" });
    await barrier(e.players.tech_lead!);
    for (const c of Object.values(e.players)) expect(voiceFrames(c)).toHaveLength(0);
  });

  it("the console roster has facilitatorMuted per seat; the peers roster too, still without voice or speaking", async () => {
    const e = await setup();
    await mute(e, "tech_lead", true);
    const f = await facRoster(e.fac, (en) => entry(en, "tech_lead").facilitatorMuted === true);
    expect(entry(f.entries, "account_manager").facilitatorMuted).toBe(false);
    const p = await peersRoster(e.players.account_manager!, (en) => entry(en, "tech_lead").facilitatorMuted === true);
    expect(entry(p.entries, "delivery_lead").facilitatorMuted).toBe(false);
    for (const x of p.entries) { expect(x).not.toHaveProperty("voice"); expect(x).not.toHaveProperty("speaking"); }
    await mute(e, "tech_lead", false);
    await facRoster(e.fac, (en) => entry(en, "tech_lead").facilitatorMuted === false, e.fac.inbox.indexOf(f) + 1);
  });

  it("a stale expectSceneId never refuses a mute (R6)", async () => {
    const e = await setup();
    const r = await mute(e, "tech_lead", true, { expectSceneId: "no-such-scene" });
    expect(r.type).toBe("ack");
    expect(e.host.facilitatorMutedOf("tech_lead")).toBe(true);
    await expect(e.host.command({ command: "mute_seat", roleId: "tech_lead", muted: false }, { expectSceneId: "stale" })).resolves.toBeUndefined();
    expect(e.host.facilitatorMutedOf("tech_lead")).toBe(false);
  });
});

describe("a join sees the current facilitator mute (Review Focus 3)", () => {
  it("a fresh join without lastSeq sees it in the snapshot and the peers roster, and joined.voice carries mutedBy", async () => {
    const e = await setup();
    await mute(e, "tech_lead", true);
    e.players.tech_lead!.drop();
    e.players.account_manager!.drop();
    const again = await e.join("tech_lead");
    expect(again.joined.voice).toEqual({ state: "none", muted: true, mutedBy: "facilitator" });
    expect(again.joined.state.facilitatorMutedSeats).toEqual(["tech_lead"]);
    const sam = await e.join("account_manager");
    expect(sam.joined.state.facilitatorMutedSeats).toEqual(["tech_lead"]);
    expect(sam.joined.voice).toEqual({ state: "none", muted: false });
    const p = await peersRoster(sam, () => true);
    expect(entry(p.entries, "tech_lead").facilitatorMuted).toBe(true);
    expect(JSON.stringify(sam.joined)).not.toContain("Alex");
  });

  it("a reconnect with lastSeq receives only the later mute events", async () => {
    const e = await setup();
    await mute(e, "tech_lead", true);
    const seenSeq = e.engine.state.lastSeq;
    e.players.account_manager!.drop();
    await mute(e, "tech_lead", false);
    await mute(e, "delivery_lead", true);
    const sam = await e.join("account_manager", { lastSeq: seenSeq });
    expect(sam.joined.replay).toMatchObject({ afterSeq: seenSeq, complete: true, events: 2 });
    await sam.next((m) => m.type === "roster");
    const muteEvents = sam.inbox.filter((m) => m.type === "event" && m.event.command === "mute_seat");
    expect(muteEvents.map((m) => [m.event.roleId, m.event.muted])).toEqual([["tech_lead", false], ["delivery_lead", true]]);
    expect(muteEvents.every((m) => m.event.seq > seenSeq)).toBe(true);
    expect(sam.joined.state.facilitatorMutedSeats).toEqual(["delivery_lead"]);
  });
});

describe("a mute before the start (R4)", () => {
  it("is accepted without starting and without not_started, shows in the roster, and holds after the start", async () => {
    const e = await setup({ start: false });
    const r = await mute(e, "tech_lead", true);
    expect(r.type).toBe("ack");
    expect(e.host.hasStarted).toBe(false);
    expect(e.engine.state.status).toBe("idle");
    await facRoster(e.fac, (en) => entry(en, "tech_lead").facilitatorMuted === true);
    await peersRoster(e.players.account_manager!, (en) => entry(en, "tech_lead").facilitatorMuted === true);
    await e.players.tech_lead!.next((m) => m.type === "voice" && m.muted === true && m.mutedBy === "facilitator");
    // a command that is not a mute still needs the start
    e.fac.send({ type: "command", command: { command: "pause" }, ref: "p1" });
    expect(await e.fac.next((m) => m.ref === "p1")).toMatchObject({ type: "error", code: "not_started" });
    // an unmute before the start clears it, a second mute holds
    expect((await mute(e, "tech_lead", false)).type).toBe("ack");
    await facRoster(e.fac, (en) => entry(en, "tech_lead").facilitatorMuted === false);
    expect((await mute(e, "tech_lead", true)).type).toBe("ack");
    await e.host.start();
    expect(e.engine.state.facilitatorMutedSeats).toEqual(["tech_lead"]);
    expect(e.host.facilitatorMutedOf("tech_lead")).toBe(true);
    const sam = e.players.account_manager!;
    const ev = await sam.next((m) => m.type === "event" && m.event.command === "mute_seat");
    expect(ev.event).toMatchObject({ roleId: "tech_lead", muted: true });
    expect(JSON.stringify(sam.inbox)).not.toContain("Alex");
    await facRoster(e.fac, (en) => entry(en, "tech_lead").facilitatorMuted === true);
  });

  it("a ref-less pre-start mute does not auto-start the session", async () => {
    const e = await setup({ start: false });
    e.fac.send({ type: "command", command: { command: "mute_seat", roleId: "tech_lead", muted: true } });
    await vi.waitFor(() => expect(e.host.facilitatorMutedOf("tech_lead")).toBe(true));
    await barrier(e.fac);
    expect(e.host.hasStarted).toBe(false);
    expect(e.engine.state.status).toBe("idle");
  });
});
