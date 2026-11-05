import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
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
import { SessionHost } from "../session-host.js";
import { startServer } from "../ws-server.js";
import { reissueRole } from "../reissue.js";
import { snapshotForPlayer } from "../player-copies.js";
// BUG-0023: a whisper is kept in the ADDRESSED player's join snapshot. Real sockets; the heart of the fix is that nobody else ever holds it.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const NOTICE = { version: "v2", text: "What we record and why." };
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
let server: Awaited<ReturnType<typeof startServer>> | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = [];
  await server?.close(); server = null;
});

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

async function setup() {
  const scenario = await loadScenario(friday);
  const clock = new FakeClock(7_000);
  const log = new MemoryEventLog("local");
  const engine = new SessionEngine({ scenario, log, clock });
  const aiRoles = AiRoleSet.fromRecord({ v: 1, ...BIND, roles: ["tech_lead"] }, { ...BIND, roleIds: PLAYERS });
  const seats: Seats = { credentials: PlayerCredentials.create(BIND), consent: new ConsentStore(NOTICE), aiRoles, persist: vi.fn() };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats });
  const { codes, plain } = JoinCodes.issue(PLAYERS, BIND);
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), joinCodes: new Map([["local", codes]]) });
  const srv = server;
  let current = codes;
  const deps = { host, seats, codes: () => current, setCodes: (c: typeof codes) => { current = c; srv.replaceCodes("local", c); }, writeCodes: () => {}, server: srv, sessionId: "local" };
  return { port: server.port, host, engine, seats, plain, log, scenario, clock, reissue: (role: string) => reissueRole(deps, role, "Kim") };
}

async function seat(port: number, roleId: string, code: string, participantId: string, displayName?: string) {
  const c = await open(port);
  c.send({ type: "join", sessionId: "local", roleId, participantId, joinCode: code, issueCredential: true, ...(displayName !== undefined ? { displayName } : {}) });
  return { c, j: await c.next((m) => m.type === "joined") };
}
/** Joins again with the reconnect token (what a page reload ends in), on a new socket. */
async function rejoin(port: number, roleId: string, participantId: string, reconnectToken: string, lastSeq?: number) {
  const c = await open(port);
  c.send({ type: "join", sessionId: "local", roleId, participantId, reconnectToken, ...(lastSeq !== undefined ? { lastSeq } : {}) });
  return { c, j: await c.next((m) => m.type === "joined" || m.type === "error") };
}
async function facilitator(port: number): Promise<Client> {
  const f = await open(port);
  f.send({ type: "join_facilitator", sessionId: "local" });
  await f.next((m) => m.type === "joined");
  return f;
}
async function consent(c: Client, seats: Seats, roleId: string, participantId: string) {
  c.send({ type: "consent", noticeVersion: "v2" });
  await vi.waitFor(() => expect(seats.consent.has(roleId, participantId)).toBe(true), { timeout: 30_000, interval: 5 });
}

// Control, escape and bidi characters in the text: it must come out of the snapshot exactly as the live event carries it (clients clean on render).
const NASTY = "PRIVATE-W-1 \u0007\u001b[31m‮reversed⁦x⁩";

async function started() {
  const s = await setup();
  const a = await seat(s.port, "account_manager", s.plain.account_manager!, "alice", "Alice");
  await consent(a.c, s.seats, "account_manager", "alice");
  const d = await seat(s.port, "delivery_lead", s.plain.delivery_lead!, "dana", "Dana");
  await consent(d.c, s.seats, "delivery_lead", "dana");
  const bot = await seat(s.port, "tech_lead", s.plain.tech_lead!, "bot1");
  const f = await facilitator(s.port);
  f.send({ type: "start" });
  await d.c.next((m) => m.type === "event" && m.event.type === "session.started");
  return { ...s, a, d, bot, f };
}

describe("a whisper in the join snapshot (BUG-0023)", () => {
  it("the addressed player's rejoin snapshot holds it (seq, sceneId, text only); no other player's rejoin, the AI seat's rejoin or any roster frame carries it", async () => {
    const { port, a, d, bot, f } = await started();
    f.send({ type: "command", command: { command: "whisper", roleId: "delivery_lead", text: NASTY }, by: "FAC-NAME-LEAK", ref: "REF-LEAK-1" });
    f.send({ type: "command", command: { command: "whisper", roleId: "account_manager", text: "FOR-ALICE-ONLY" }, by: "FAC-NAME-LEAK", ref: "REF-LEAK-2" });
    const live = await d.c.next((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "whisper");
    await a.c.next((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "whisper");
    await f.next((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.text === "FOR-ALICE-ONLY");
    expect(live.event.text).toBe(NASTY);

    // (a) the addressed player, rejoining as a reloaded page does, gets it in the snapshot
    const d2 = await rejoin(port, "delivery_lead", "dana", d.j.reconnectToken);
    expect(d2.j.type).toBe("joined");
    expect(d2.j.state.whispers).toEqual([{ seq: live.event.seq, sceneId: expect.any(String), text: NASTY }]);
    expect(Object.keys(d2.j.state.whispers[0]).sort()).toEqual(["sceneId", "seq", "text"]);
    // (c) no sender, ref or ack anywhere in the join, and not the other role's text
    const dJoin = JSON.stringify(d2.j);
    expect(dJoin).not.toMatch(/FAC-NAME-LEAK|REF-LEAK|FOR-ALICE-ONLY|"by"|"ref"|"ack"/);

    // (b) another player's rejoin, the AI seat's rejoin and a fresh rejoin after a leave carry only their own
    const a2 = await rejoin(port, "account_manager", "alice", a.j.reconnectToken);
    expect(a2.j.state.whispers.map((w: any) => w.text)).toEqual(["FOR-ALICE-ONLY"]);
    expect(JSON.stringify(a2.j)).not.toContain("PRIVATE-W-1");
    const bot2 = await rejoin(port, "tech_lead", "bot1", bot.j.reconnectToken);
    expect(bot2.j.state.whispers).toEqual([]);
    expect(JSON.stringify(bot2.j)).not.toMatch(/PRIVATE-W-1|FOR-ALICE-ONLY/);

    // every inbox that is not the addressee's, in full (events, joined frames, rosters): no trace of the other role's text, the sender or a ref
    const everyoneElse: [string, Client][] = [["bot", bot.c], ["bot2", bot2.c], ["alice2", a2.c]];
    for (const [name, c] of everyoneElse) {
      const raw = JSON.stringify(c.inbox);
      expect(raw, name).not.toMatch(/FAC-NAME-LEAK|REF-LEAK|"by"/);
      if (name !== "alice2") expect(raw, name).not.toContain("FOR-ALICE-ONLY");
      expect(raw, name).not.toContain("PRIVATE-W-1");
    }
    // the first alice socket got her own whisper live and never the other one
    const aliceRaw = JSON.stringify(a.c.inbox);
    expect(aliceRaw).toContain("FOR-ALICE-ONLY");
    expect(aliceRaw).not.toContain("PRIVATE-W-1");
    expect(aliceRaw).not.toMatch(/FAC-NAME-LEAK|REF-LEAK/);
    // the roster frames players receive never carry a whisper
    for (const c of [a.c, d.c, bot.c, d2.c, a2.c, bot2.c]) {
      const rosters = JSON.stringify(c.inbox.filter((m) => m.type === "roster"));
      expect(rosters).not.toMatch(/PRIVATE-W-1|FOR-ALICE-ONLY|whisper/);
    }
    // the facilitator sees both whispers by design
    expect(JSON.stringify(f.inbox)).toMatch(/PRIVATE-W-1/);
  });

  it("a rejoin with a complete replay keeps the whisper once: the snapshot holds it and the replay does not repeat it in the snapshot's range", async () => {
    const { port, d, f } = await started();
    f.send({ type: "command", command: { command: "whisper", roleId: "delivery_lead", text: "ONCE-ONLY" } });
    const live = await d.c.next((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "whisper");
    const d2 = await rejoin(port, "delivery_lead", "dana", d.j.reconnectToken, live.event.seq - 1);
    expect(d2.j.replay).toMatchObject({ complete: true, afterSeq: live.event.seq - 1 });
    expect(d2.j.state.whispers.filter((w: any) => w.text === "ONCE-ONLY")).toHaveLength(1);
    // the replayed event frame carries the same seq as the snapshot entry, so a seq-based client (applyPlayerEvent) shows it once
    const replayed = d2.c.inbox.filter((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "whisper");
    for (const r of replayed) expect(r.event.seq).toBe(live.event.seq);
  });

  it("a replacement participant (post-start reissue) does not inherit the old holder's whispers; the same person rejoining keeps them; a whisper after the replacement joined is delivered live and kept", async () => {
    const { port, d, f, reissue, log, scenario, clock, engine, seats } = await started();
    f.send({ type: "command", command: { command: "whisper", roleId: "delivery_lead", text: "OLD-HOLDER-ONLY" } });
    const live = await d.c.next((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "whisper");
    // the same participant reloading (reconnect token, no reissue) keeps it
    const same = await rejoin(port, "delivery_lead", "dana", d.j.reconnectToken);
    expect(same.j.state.whispers.map((w: any) => w.text)).toEqual(["OLD-HOLDER-ONLY"]);
    // the facilitator reissues the seat to a new person
    const code = await reissue("delivery_lead");
    const fresh = await seat(port, "delivery_lead", code, "erin", "Erin");
    expect(fresh.j.type).toBe("joined");
    expect(fresh.j.state.whispers).toEqual([]);
    expect(JSON.stringify(fresh.c.inbox)).not.toContain("OLD-HOLDER-ONLY");
    // a restart (the state rebuilt from the log alone) gives the same answer
    const again = new SessionEngine({ scenario, log, clock: new FakeClock(7_000) });
    await again.restore();
    expect(snapshotForPlayer(again.state, "delivery_lead").whispers).toEqual([]);
    expect(engine.state.whispers.delivery_lead).toHaveLength(1); // the facilitator's record keeps it
    void seats;
    // a whisper to the replacement: live, and in a later snapshot, with the old one still absent
    f.send({ type: "command", command: { command: "whisper", roleId: "delivery_lead", text: "FOR-ERIN" } });
    const got = await fresh.c.next((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.text === "FOR-ERIN");
    expect(got.event.seq).toBeGreaterThan(live.event.seq);
    const reload = await rejoin(port, "delivery_lead", "erin", fresh.j.reconnectToken);
    expect(reload.j.state.whispers.map((w: any) => w.text)).toEqual(["FOR-ERIN"]);
    expect(snapshotForPlayer(engine.state, "delivery_lead").whispers.map((w) => w.text)).toEqual(["FOR-ERIN"]);
    const again2 = new SessionEngine({ scenario, log, clock: new FakeClock(7_000) });
    await again2.restore();
    expect(snapshotForPlayer(again2.state, "delivery_lead").whispers.map((w) => w.text)).toEqual(["FOR-ERIN"]);
  });

  it("a player who comes back late, after whispers to others were sent, holds none of them", async () => {
    const { port, a, f } = await started();
    f.send({ type: "command", command: { command: "whisper", roleId: "delivery_lead", text: "NOT-FOR-LATE" } });
    await f.next((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.text === "NOT-FOR-LATE");
    a.c.send({ type: "leave" });
    const late = await rejoin(port, "account_manager", "alice", a.j.reconnectToken);
    expect(late.j.type).toBe("joined");
    expect(late.j.state.whispers).toEqual([]);
    expect(JSON.stringify(late.c.inbox)).not.toContain("NOT-FOR-LATE");
  });
});
