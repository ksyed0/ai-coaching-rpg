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
// Real-socket tests: a generous explicit limit (coverage and a loaded machine are slower). Nothing here measures elapsed time.
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

type Client = { inbox: any[]; closed: Promise<{ code: number; reason: string }>; send(m: unknown): void; next(pred: (m: any) => boolean): Promise<any> };
async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (c, why) => r({ code: c, reason: why.toString() })));
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  // Waits for the effect itself; the test's own timeout is the only guard against a hung server.
  const next = (pred: (m: any) => boolean) => new Promise<any>((resolve) => { const found = inbox.find(pred); if (found) return resolve(found); waiters.push({ pred, resolve }); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { inbox, closed, next, send: (m) => ws.send(JSON.stringify(m)) };
}

async function setup(o: { extraPlayers?: string[] } = {}) {
  const scenario = await loadScenario(fixture);
  for (const id of o.extraPlayers ?? []) scenario.roles[id] = { id, type: "player", brief: `You are ${id}.`, private_facts: [] } as (typeof scenario.roles)[string];
  const clock = new FakeClock(7_000);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock });
  const seats: Seats = { credentials: PlayerCredentials.create(BIND), consent: new ConsentStore(NOTICE), persist: vi.fn() };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats });
  const { codes, plain } = JoinCodes.issue(["host", ...(o.extraPlayers ?? [])], BIND);
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), joinCodes: new Map([["local", codes]]) });
  return { port: server.port, host, engine, seats, plain };
}

/** Joins a player role by code on the web (with a credential and a name) and returns the client and its joined message. */
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
/** Sends a consent and waits until the host has it (success sends nothing back). */
async function consent(c: Client, seats: Seats, roleId: string, participantId: string) {
  c.send({ type: "consent", noticeVersion: "v1" });
  await vi.waitFor(() => expect(seats.consent.has(roleId, participantId)).toBe(true), { timeout: 30_000, interval: 5 });
}

describe("consent messages and the start gate over the socket (US-0054)", () => {
  it("start is refused with seats_not_ready naming the roles that are missing a join or a consent", async () => {
    const { port, engine, seats, plain } = await setup({ extraPlayers: ["p2", "p3"] });
    const { c: a } = await player(port, "host", plain.host!, "alice", "Alice");
    await consent(a, seats, "host", "alice");
    await player(port, "p2", plain.p2!, "bob", "Bob"); // joined, no consent; p3 never joins
    const f = await facilitator(port);
    f.send({ type: "start" });
    expect(await f.next((m) => m.type === "error")).toEqual({ type: "error", code: "seats_not_ready", message: "seats_not_ready: p2,p3" });
    expect(engine.state.status).toBe("idle");
  });

  it("the auto-start inside a facilitator command is refused the same way", async () => {
    const { port, engine, plain } = await setup();
    await player(port, "host", plain.host!, "alice", "Alice"); // joined, no consent
    const f = await facilitator(port);
    f.send({ type: "command", command: { command: "pause" } });
    expect(await f.next((m) => m.type === "error")).toEqual({ type: "error", code: "seats_not_ready", message: "seats_not_ready: host" });
    expect(engine.state.status).toBe("idle");
  });

  it("start succeeds once every player role has joined and consented and writes the consents and names into session.started", async () => {
    const { port, engine, seats, plain } = await setup();
    const { c: a } = await player(port, "host", plain.host!, "alice", "Alice");
    await consent(a, seats, "host", "alice");
    const f = await facilitator(port);
    f.send({ type: "start" });
    const started = (await f.next((m) => m.type === "event" && m.event.type === "session.started")).event;
    expect(started.consents).toEqual({ host: { noticeVersion: "v1", at: 7_000 } });
    expect(started.names).toEqual({ host: "Alice" });
    expect(started.logIdentity).toBe(seats.credentials.logIdentity);
    expect(engine.state.status).toBe("running");
    // The player's copy carries only their own consent, never names or the log identity.
    const mine = (await a.next((m) => m.type === "event" && m.event.type === "session.started")).event;
    expect(mine.consents).toEqual({ host: { noticeVersion: "v1", at: 7_000 } });
    expect(mine).not.toHaveProperty("names");
    expect(mine).not.toHaveProperty("logIdentity");
  });

  it("consent with another version is refused as consent_version", async () => {
    const { port, seats, plain } = await setup();
    const { c: a } = await player(port, "host", plain.host!, "alice", "Alice");
    a.send({ type: "consent", noticeVersion: "v2" });
    expect(await a.next((m) => m.type === "error")).toEqual({ type: "error", code: "consent_version", message: "consent_version" });
    expect(seats.consent.has("host", "alice")).toBe(false);
  });

  it("consent and withdraw_consent are for a joined player only", async () => {
    const { port, seats, plain } = await setup();
    const u = await open(port);
    u.send({ type: "consent", noticeVersion: "v1" });
    expect(await u.next((m) => m.type === "error")).toMatchObject({ code: "not_joined" });
    const f = await facilitator(port);
    f.send({ type: "consent", noticeVersion: "v1" });
    f.send({ type: "withdraw_consent" });
    await f.next((m) => m.type === "error" && f.inbox.filter((x) => x.type === "error").length === 2);
    expect(f.inbox.filter((m) => m.type === "error").map((m) => m.code)).toEqual(["forbidden", "forbidden"]);
  });

  it("withdraw_consent over the socket frees the role at once and closes the connection with 1000", async () => {
    const { port, host, seats, plain } = await setup();
    const { c: a } = await player(port, "host", plain.host!, "alice", "Alice");
    await consent(a, seats, "host", "alice");
    a.send({ type: "withdraw_consent" });
    expect(await a.closed).toEqual({ code: 1000, reason: "withdrew" });
    expect(seats.consent.has("host", "alice")).toBe(false);
    expect(seats.credentials.has("host")).toBe(false);
    // The role is free for the next person with the code, who must consent afresh.
    const { j } = await player(port, "host", plain.host!, "bob", "Bob");
    expect(j.roleId).toBe("host");
    expect(j.consent.given).toBe(false);
    expect(host.assignments.host).toBe("bob");
  });

  it("a consent from a connection that no longer holds its role gets an error frame", async () => {
    const { port, host, seats, plain } = await setup();
    const { c: a } = await player(port, "host", plain.host!, "alice", "Alice");
    host.release("host", "alice"); // the seat was freed under this connection
    a.send({ type: "consent", noticeVersion: "v1" });
    expect(await a.next((m) => m.type === "error")).toEqual({ type: "error", code: "not_joined", message: "not_joined" });
    expect(seats.consent.has("host", "alice")).toBe(false);
  });

  it("a player sees only their own consent in joined", async () => {
    const { port, seats, plain } = await setup({ extraPlayers: ["p2"] });
    const { c: a, j: ja } = await player(port, "host", plain.host!, "alice", "Alice");
    expect(ja.consent).toEqual({ noticeVersion: "v1", notice: NOTICE.text, given: false });
    await consent(a, seats, "host", "alice");
    // Bob joins another role after Alice consented: his joined says nothing about Alice's consent.
    const { j: jb } = await player(port, "p2", plain.p2!, "bob", "Bob");
    expect(jb.consent).toEqual({ noticeVersion: "v1", notice: NOTICE.text, given: false });
    expect(JSON.stringify(jb)).not.toContain("alice");
    // Alice's own rejoin with her credential reports her consent as given.
    const again = await open(port);
    again.send({ type: "join", sessionId: "local", roleId: "host", participantId: "alice", credential: ja.credential });
    expect((await again.next((m) => m.type === "joined")).consent).toEqual({ noticeVersion: "v1", notice: NOTICE.text, given: true });
    const f = await open(port);
    f.send({ type: "join_facilitator", sessionId: "local" });
    expect(await f.next((m) => m.type === "joined")).not.toHaveProperty("consent");
  });
});
