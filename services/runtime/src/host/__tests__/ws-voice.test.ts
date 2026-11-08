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

// US-0070 (Task 5): voice_opt_in / voice_opt_out on the player socket, the `voice` answer and joined.voice. Real sockets on port 0.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
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

async function setup(voice: VoiceConfig = { enabled: true, turnEndMs: 800 }, aiRoles: string[] = []) {
  const scenario = await loadScenario(friday);
  const clock = new FakeClock(1_000);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock });
  const ai = AiRoleSet.empty();
  ai.replace(aiRoles, PLAYERS);
  const credentials = PlayerCredentials.create(BIND);
  const vbind = { sessionId: "local", logIdentity: credentials.logIdentity };
  let record: unknown = null;
  const voiceFile: VoiceFileIO = { read: () => ({ choices: record === null ? VoiceChoices.empty(vbind) : VoiceChoices.fromRecord(record, vbind) }), write: (c) => { record = c.toRecord(); }, remove: () => { record = null; } };
  const seats: Seats = { credentials, consent: new ConsentStore({ version: "v3", text: "notice v3" }), aiRoles: ai, persist: () => {}, voiceFile };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats, voice });
  const issued = JoinCodes.issue(PLAYERS, BIND);
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), log: () => {}, joinCodes: new Map([["local", issued.codes]]) });
  return { port: server.port, host, plain: issued.plain };
}
async function player(e: Awaited<ReturnType<typeof setup>>, roleId: string, participantId: string, consent = true) {
  const c = await open(e.port);
  c.send({ type: "join", sessionId: "local", roleId, participantId, joinCode: e.plain[roleId] });
  const joined = await c.next((m) => m.type === "joined" || m.type === "error");
  expect(joined.type).toBe("joined");
  if (consent) {
    c.send({ type: "consent", noticeVersion: "v3" });
    await vi.waitFor(() => expect(e.host.consentGiven(roleId, participantId)).toBe(true), { timeout: 30_000, interval: 5 });
  }
  return Object.assign(c, { joined });
}

describe("voice on the player socket (US-0070)", () => {
  it("a player's voice_opt_in answers {type: voice, state: voice} to that socket only; another player's socket receives no voice frame", async () => {
    const e = await setup();
    const pat = await player(e, "account_manager", "pat");
    const sam = await player(e, "tech_lead", "sam");
    pat.send({ type: "voice_opt_in", noticeVersion: "v3" });
    expect(await pat.next((m) => m.type === "voice" || m.type === "error")).toEqual({ type: "voice", state: "voice" });
    expect(e.host.voiceStateOf("account_manager")).toBe("voice");
    pat.send({ type: "voice_opt_out" });
    await vi.waitFor(() => expect(pat.inbox.filter((m) => m.type === "voice")).toHaveLength(2));
    expect(pat.inbox.filter((m) => m.type === "voice").at(-1)).toEqual({ type: "voice", state: "text_only" });
    // sam sends a message of his own and gets its answer, so every frame for him up to now has arrived.
    sam.send({ type: "voice_opt_out" });
    await sam.next((m) => m.type === "voice");
    expect(sam.inbox.filter((m) => m.type === "voice")).toEqual([{ type: "voice", state: "text_only" }]);
    for (const m of sam.inbox) expect(JSON.stringify(m)).not.toContain("pat");
  });

  it("joined.voice carries only the joining player's own state", async () => {
    const e = await setup();
    const pat = await player(e, "account_manager", "pat");
    pat.send({ type: "voice_opt_in", noticeVersion: "v3" });
    await pat.next((m) => m.type === "voice");
    const sam = await player(e, "tech_lead", "sam");
    expect(sam.joined.voice).toEqual({ state: "none" });
    expect(JSON.stringify(sam.joined)).not.toContain("\"voice\":{\"state\":\"voice\"}");
    // pat rejoins with another socket: his own state.
    const again = await open(e.port);
    again.send({ type: "join", sessionId: "local", roleId: "account_manager", participantId: "pat", reconnectToken: pat.joined.reconnectToken });
    const j = await again.next((m) => m.type === "joined" || m.type === "error");
    expect(j.type).toBe("joined");
    expect(j.voice).toEqual({ state: "voice" });
  });

  it("joined has no voice key when voice is disabled, and opt-in is refused voice_off", async () => {
    const e = await setup({ enabled: false });
    const pat = await player(e, "account_manager", "pat");
    expect("voice" in pat.joined).toBe(false);
    pat.send({ type: "voice_opt_in", noticeVersion: "v3" });
    expect(await pat.next((m) => m.type === "error")).toMatchObject({ type: "error", code: "voice_off" });
  });

  it("the facilitator's voice_opt_in is forbidden, an AI seat's too, and a player without a voice notice gets voice_notice_required", async () => {
    const e = await setup(undefined, ["delivery_lead"]);
    const f = await open(e.port);
    f.send({ type: "join_facilitator", sessionId: "local" });
    await f.next((m) => m.type === "joined");
    f.send({ type: "voice_opt_in", noticeVersion: "v3" });
    expect(await f.next((m) => m.type === "error")).toMatchObject({ code: "forbidden" });
    f.send({ type: "voice_opt_out" });
    await vi.waitFor(() => expect(f.inbox.filter((m) => m.type === "error")).toHaveLength(2));
    expect(f.inbox.filter((m) => m.type === "error")[1]).toMatchObject({ code: "forbidden" });
    const bot = await player(e, "delivery_lead", "bot-1", false);
    expect("voice" in bot.joined).toBe(false);
    bot.send({ type: "voice_opt_in", noticeVersion: "v3" });
    expect(await bot.next((m) => m.type === "error")).toMatchObject({ code: "forbidden" });
    const sam = await player(e, "tech_lead", "sam", false);
    sam.send({ type: "voice_opt_in", noticeVersion: "v3" });
    expect(await sam.next((m) => m.type === "error")).toMatchObject({ code: "voice_notice_required" });
  });

  it("voice_opt_in with an extra key, a missing or over-long version is bad_message; voice_opt_out with an extra key too", async () => {
    const e = await setup();
    const pat = await player(e, "account_manager", "pat");
    const bad = [{ type: "voice_opt_in", noticeVersion: "v3", extra: 1 }, { type: "voice_opt_in" }, { type: "voice_opt_in", noticeVersion: "" }, { type: "voice_opt_in", noticeVersion: "v".repeat(33) }, { type: "voice_opt_out", roleId: "tech_lead" }];
    for (const m of bad) pat.send(m);
    await vi.waitFor(() => expect(pat.inbox.filter((m) => m.type === "error")).toHaveLength(bad.length));
    for (const m of pat.inbox.filter((x) => x.type === "error")) expect(m.code).toBe("bad_message");
    expect(e.host.voiceStateOf("account_manager")).toBe("none");
  });

  it("a voice_opt_in before join is not_joined", async () => {
    const e = await setup();
    const c = await open(e.port);
    c.send({ type: "voice_opt_in", noticeVersion: "v3" });
    expect(await c.next((m) => m.type === "error")).toMatchObject({ code: "not_joined" });
  });
});
