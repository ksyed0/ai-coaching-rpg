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
import type { Seats } from "../../engine/seats.js";
import { SessionHost } from "../session-host.js";
import { startServer } from "../ws-server.js";
// Real-socket tests: a generous explicit limit. Nothing here measures elapsed time; waits are on the effect itself.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const NOTICE = { version: "v1", text: "What we record and why." };
let server: Awaited<ReturnType<typeof startServer>> | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = [];
  await server?.close(); server = null;
});

type Client = { inbox: any[]; closed: Promise<{ code: number; reason: string }>; send(m: unknown): void; next(pred: (m: any) => boolean, from?: number): Promise<any>; rosters(): any[] };
async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; from: number; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (c, why) => r({ code: c, reason: why.toString() })));
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (inbox.length - 1 >= w.from && w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const next = (pred: (m: any) => boolean, from = 0) => new Promise<any>((resolve) => { const found = inbox.slice(from).find(pred); if (found) return resolve(found); waiters.push({ pred, from, resolve }); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { inbox, closed, next, send: (m) => ws.send(JSON.stringify(m)), rosters: () => inbox.filter((m) => m.type === "roster") };
}

async function setup(o: { extraPlayers?: string[] } = {}) {
  const scenario = await loadScenario(fixture);
  for (const id of o.extraPlayers ?? []) scenario.roles[id] = { id, type: "player", brief: `You are ${id}.`, private_facts: [] } as (typeof scenario.roles)[string];
  const clock = new FakeClock(7_000);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock });
  const seats: Seats = { credentials: PlayerCredentials.create(BIND), consent: new ConsentStore(NOTICE), persist: vi.fn() };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats });
  const { codes, plain } = JoinCodes.issue(["host", ...(o.extraPlayers ?? [])], BIND);
  const lines: string[] = [];
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), joinCodes: new Map([["local", codes]]), log: (m) => lines.push(m) });
  return { port: server.port, host, engine, seats, plain, lines };
}
async function player(port: number, roleId: string, code: string, participantId: string, displayName: string) {
  const c = await open(port);
  c.send({ type: "join", sessionId: "local", roleId, participantId, joinCode: code, issueCredential: true, displayName });
  return { c, j: await c.next((m) => m.type === "joined") };
}
async function facilitator(port: number): Promise<Client> {
  const f = await open(port);
  f.send({ type: "join_facilitator", sessionId: "local" });
  await f.next((m) => m.type === "joined");
  return f;
}
const latest = (c: Client, pred: (r: any) => boolean = () => true) => c.next((m) => m.type === "roster" && pred(m), 0);
const entry = (r: any, role: string) => r.entries.find((e: any) => e.roleId === role);

describe("roster frames over the socket (US-0055)", () => {
  it("a roster frame goes to every connection on join, consent, withdraw, leave and disconnect", async () => {
    const { port, seats, plain } = await setup({ extraPlayers: ["p2"] });
    const f = await facilitator(port);
    expect((await latest(f)).entries).toEqual([
      { roleId: "host", joined: false, consented: false, connected: false },
      { roleId: "p2", joined: false, consented: false, connected: false },
    ]);

    const { c: a } = await player(port, "host", plain.host!, "alice", "Alice");
    await f.next((m) => m.type === "roster" && entry(m, "host").joined && entry(m, "host").connected);
    expect((await a.next((m) => m.type === "roster")).audience).toBe("peers");

    const { c: b } = await player(port, "p2", plain.p2!, "bob", "Bob");
    const bFirst = await b.next((m) => m.type === "roster");
    expect(bFirst.entries.map((e: any) => [e.roleId, e.name, e.ready])).toEqual([["host", "Alice", false], ["p2", "Bob", false]]);
    await a.next((m) => m.type === "roster" && m.entries[1].name === "Bob");

    a.send({ type: "consent", noticeVersion: "v1" });
    await f.next((m) => m.type === "roster" && entry(m, "host").consented);
    await b.next((m) => m.type === "roster" && entry(m, "host").ready);

    // withdraw: seat freed, name gone (credential revoked), everyone told
    a.send({ type: "withdraw_consent" });
    await a.closed;
    await f.next((m) => m.type === "roster" && !entry(m, "host").joined && !entry(m, "host").consented);
    const afterWithdraw = await b.next((m) => m.type === "roster" && !entry(m, "host").ready && entry(m, "host").name === undefined);
    expect(afterWithdraw.audience).toBe("peers");

    // a plain disconnect frees the seat but keeps the credential (and so the name)
    const { c: b2, j } = await player(port, "host", plain.host!, "carol", "Carol");
    expect(j.roleId).toBe("host");
    await f.next((m) => m.type === "roster" && entry(m, "host").connected && entry(m, "host").joined);
    b2.send({ type: "leave" });
    await b2.closed;
    await f.next((m) => m.type === "roster" && !entry(m, "host").joined && !entry(m, "host").connected && m.entries !== undefined && !entry(m, "host").name);

    b.send({ type: "leave" });
    await b.closed;
    const end = await f.next((m) => m.type === "roster" && !entry(m, "p2").joined);
    expect(entry(end, "p2").connected).toBe(false);
    expect(seats.credentials.has("p2")).toBe(false);
  });

  it("a disconnect (not a leave) updates the facilitator and keeps the name", async () => {
    const { port, plain } = await setup();
    const f = await facilitator(port);
    const { c: a } = await player(port, "host", plain.host!, "alice", "Alice");
    await f.next((m) => m.type === "roster" && entry(m, "host").connected);
    const from = f.inbox.length;
    sockets[sockets.length - 1]!.terminate();
    const gone = await f.next((m) => m.type === "roster" && !entry(m, "host").connected, from);
    expect(entry(gone, "host")).toEqual({ roleId: "host", name: "Alice", joined: false, consented: false, connected: false });
  });

  it("a roster frame is never sent between joined and its replay events (it follows the subscription)", async () => {
    const { port, engine, plain } = await setup();
    const f0 = await facilitator(port);
    await f0.next((m) => m.type === "roster");
    await engine.start({ host: "p" });
    await engine.say("host", "one"); await engine.say("host", "two");
    const f = await open(port);
    f.send({ type: "join_facilitator", sessionId: "local", lastSeq: 1 });
    const joined = await f.next((m) => m.type === "joined");
    expect(joined.replay.events).toBeGreaterThan(0);
    const firstRoster = await f.next((m) => m.type === "roster");
    const iJoined = f.inbox.indexOf(joined), iRoster = f.inbox.indexOf(firstRoster);
    const replayed = f.inbox.slice(iJoined + 1, iJoined + 1 + joined.replay.events);
    expect(replayed.every((m) => m.type === "event")).toBe(true);
    expect(iRoster).toBe(iJoined + 1 + joined.replay.events);
  });

  it("a player never receives the facilitator roster, nor the facilitator a peers roster", async () => {
    const { port, plain } = await setup({ extraPlayers: ["p2"] });
    const f = await facilitator(port);
    const { c: a } = await player(port, "host", plain.host!, "alice", "Alice");
    const { c: b } = await player(port, "p2", plain.p2!, "bob", "Bob");
    a.send({ type: "consent", noticeVersion: "v1" });
    await b.next((m) => m.type === "roster" && entry(m, "host").ready);
    await f.next((m) => m.type === "roster" && entry(m, "host").consented);
    expect(a.rosters().every((r) => r.audience === "peers")).toBe(true);
    expect(b.rosters().every((r) => r.audience === "peers")).toBe(true);
    expect(f.rosters().every((r) => r.audience === "facilitator")).toBe(true);
    for (const r of [...a.rosters(), ...b.rosters()]) for (const e of r.entries) expect(Object.keys(e).sort()).toEqual(["name", "ready", "roleId"].filter((k) => k in e).sort());
    expect(JSON.stringify(a.rosters())).not.toContain("consented");
  });

  it("a superseded connection gets no roster frame after it is replaced, and the seat shows as connected once", async () => {
    const { port, plain } = await setup();
    const f = await facilitator(port);
    const first = await player(port, "host", plain.host!, "alice", "Alice");
    const cred = first.j.credential as string;
    await f.next((m) => m.type === "roster" && entry(m, "host").connected);
    const before = first.c.inbox.length;
    const c2 = await open(port);
    c2.send({ type: "join", sessionId: "local", roleId: "host", participantId: "alice", credential: cred });
    await c2.next((m) => m.type === "joined");
    expect((await first.c.closed).code).toBe(4001);
    await c2.next((m) => m.type === "roster");
    expect(first.c.inbox.slice(before).filter((m) => m.type === "roster")).toEqual([]);
    const last = f.rosters().at(-1);
    expect(entry(last, "host")).toMatchObject({ joined: true, connected: true, name: "Alice" });
  });

  it("names are never written to the server log, only role ids and states", async () => {
    const { port, plain, lines } = await setup({ extraPlayers: ["p2"] });
    const f = await facilitator(port);
    const { c: a } = await player(port, "host", plain.host!, "alice", "QZXNAME1");
    await player(port, "p2", plain.p2!, "bob", "QZXNAME2");
    a.send({ type: "consent", noticeVersion: "v1" });
    await f.next((m) => m.type === "roster" && entry(m, "host").consented);
    a.send({ type: "leave" });
    await a.closed;
    await f.next((m) => m.type === "roster" && !entry(m, "host").joined);
    const roster = lines.filter((l) => l.startsWith("roster: "));
    expect(roster).toEqual(expect.arrayContaining(["roster: host joined", "roster: host connected", "roster: host consented", "roster: p2 joined", "roster: host left"]));
    for (const l of roster) expect(l).toMatch(/^roster: \S+ (joined|consented|connected|left)$/);
    expect(lines.join("\n")).not.toContain("QZXNAME");
  });
});
