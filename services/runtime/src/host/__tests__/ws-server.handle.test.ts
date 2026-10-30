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
import { SessionHost } from "../session-host.js";
import { CLOSE_REISSUED, CLOSE_SUPERSEDED, startServer, type ServerHandle } from "../ws-server.js";
// Real-socket tests: a generous explicit limit. Nothing here measures elapsed time; each step awaits the event it needs.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
let server: ServerHandle | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = [];
  await server?.close(); server = null;
});

type Client = { ws: WebSocket; inbox: any[]; closed: Promise<number>; send(m: unknown): void; next(pred: (m: any) => boolean): Promise<any> };
async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  const next = (pred: (m: any) => boolean) => new Promise<any>((resolve) => { const found = inbox.find(pred); if (found) return resolve(found); waiters.push({ pred, resolve }); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { ws, inbox, closed, next, send: (m) => ws.send(JSON.stringify(m)) };
}

async function setup(o: { codes?: boolean } = {}) {
  const scenario = await loadScenario(fixture);
  scenario.roles.second = { id: "second", type: "player", brief: "You are second.", private_facts: [] } as (typeof scenario.roles)[string];
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock: new FakeClock(0) });
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock: new FakeClock(0) });
  const first = JoinCodes.issue(["host", "second"], BIND);
  const joinCodes = new Map<string, JoinCodes>([["local", first.codes]]);
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), log: () => {}, ...(o.codes === false ? {} : { joinCodes }) });
  return { port: server.port, handle: server, host, joinCodes, first: first.plain };
}
const joinPlayer = async (port: number, roleId: string, joinCode: string, participantId: string) => {
  const c = await open(port);
  c.send({ type: "join", sessionId: "local", roleId, participantId, joinCode });
  const joined = await c.next((m) => m.type === "joined" || m.type === "error");
  return { c, joined };
};
const joinFac = async (port: number) => {
  const c = await open(port);
  c.send({ type: "join_facilitator", sessionId: "local" });
  await c.next((m) => m.type === "joined");
  return c;
};

describe("startServer handle (US-0058)", () => {
  it("replaceCodes: the old code is refused and the new code joins a role that has no credential", async () => {
    const { port, handle, first } = await setup();
    const next = JoinCodes.issue(["host", "second"], BIND);
    handle.replaceCodes("local", next.codes);
    const old = await joinPlayer(port, "host", first.host!, "p1");
    expect(old.joined).toMatchObject({ type: "error", code: "unauthorized" });
    const fresh = await joinPlayer(port, "host", next.plain.host!, "p1");
    expect(fresh.joined.type).toBe("joined");
  });

  it("replaceCodes also adds an entry for a session that had none, and throws when the server has no join codes", async () => {
    const { handle, joinCodes } = await setup();
    const other = JoinCodes.issue(["host"], { sessionId: "other", scenarioSha256: "e".repeat(64) });
    handle.replaceCodes("other", other.codes);
    expect(joinCodes.get("other")).toBe(other.codes);
    await server!.close(); server = null;
    const open1 = await setup({ codes: false });
    expect(() => open1.handle.replaceCodes("local", other.codes)).toThrow(/without join codes/);
  });

  it("kickRole closes only that role's socket with 4002 and frees the seat", async () => {
    const { port, handle, host, first } = await setup();
    const a = await joinPlayer(port, "host", first.host!, "p1");
    const b = await joinPlayer(port, "second", first.second!, "p2");
    expect(host.assignments).toEqual({ host: "p1", second: "p2" });
    handle.kickRole("local", "host", CLOSE_REISSUED);
    expect(host.assignments).toEqual({ second: "p2" }); // synchronous: no await between the call and this check
    expect(await a.c.closed).toBe(CLOSE_REISSUED);
    expect(b.c.ws.readyState).toBe(WebSocket.OPEN);
    expect(host.assignments).toEqual({ second: "p2" });
  });

  it("a join with the new code immediately after kickRole succeeds (no role_taken)", async () => {
    const { port, handle, host, first } = await setup();
    const a = await joinPlayer(port, "host", first.host!, "p1");
    const next = JoinCodes.issue(["host", "second"], BIND);
    handle.kickRole("local", "host", CLOSE_REISSUED);
    handle.replaceCodes("local", next.codes);
    const b = await joinPlayer(port, "host", next.plain.host!, "p9");
    expect(b.joined.type).toBe("joined");
    expect(host.assignments.host).toBe("p9");
    await a.c.closed;
  });

  it("a stale close of the kicked socket does not release the seat now held by the new participant", async () => {
    const { port, handle, host, first } = await setup();
    const fac = await joinFac(port);
    const a = await joinPlayer(port, "host", first.host!, "p1");
    const next = JoinCodes.issue(["host", "second"], BIND);
    handle.kickRole("local", "host", CLOSE_REISSUED);
    handle.replaceCodes("local", next.codes);
    const b = await joinPlayer(port, "host", next.plain.host!, "p9");
    expect(b.joined.type).toBe("joined");
    expect(await a.c.closed).toBe(CLOSE_REISSUED); // the old socket's close handler has run (the server closes before the client sees it)
    // a round trip through the server after that close: the facilitator's next roster still shows the new holder connected
    const settle = await joinFac(port);
    const roster = await settle.next((m) => m.type === "roster");
    const host_ = roster.entries.find((e: any) => e.roleId === "host");
    expect(host.assignments.host).toBe("p9");
    expect(host_).toMatchObject({ connected: true });
    expect(b.c.ws.readyState).toBe(WebSocket.OPEN);
    void fac;
  });

  it("kickRole broadcasts the roster to the facilitator and peers", async () => {
    const { port, handle, first } = await setup();
    const fac = await joinFac(port);
    const a = await joinPlayer(port, "host", first.host!, "p1");
    const b = await joinPlayer(port, "second", first.second!, "p2");
    const full = await fac.next((m) => m.type === "roster" && m.entries.every((e: any) => e.connected));
    const facAfter = fac.inbox.indexOf(full) + 1;
    const bAfter = b.c.inbox.length; // b has seen its own join; the kick's roster comes after
    handle.kickRole("local", "host", CLOSE_REISSUED);
    const facRoster = await fac.next((m) => m.type === "roster" && fac.inbox.indexOf(m) >= facAfter);
    expect(facRoster.audience).toBe("facilitator");
    expect(facRoster.entries.find((e: any) => e.roleId === "host")).toMatchObject({ joined: false, connected: false });
    expect(facRoster.entries.find((e: any) => e.roleId === "second")).toMatchObject({ joined: true, connected: true });
    const peerRoster = await b.c.next((m) => m.type === "roster" && m.audience === "peers" && b.c.inbox.indexOf(m) >= bAfter);
    expect(peerRoster.entries.find((e: any) => e.roleId === "host")).toMatchObject({ ready: false });
    expect(peerRoster.audience).toBe("peers");
    await a.c.closed;
    // its own join and b's join gave it two rosters; the kick's broadcast must not add a third to the socket being closed
    expect(a.c.inbox.filter((m) => m.type === "roster")).toHaveLength(2);
  });

  it("kickRole on an unknown session or role is a no-op", async () => {
    const { port, handle, host, first } = await setup();
    const a = await joinPlayer(port, "host", first.host!, "p1");
    handle.kickRole("nope", "host", CLOSE_REISSUED);
    handle.kickRole("local", "nobody", CLOSE_REISSUED);
    handle.kickRole("local", "constructor", CLOSE_REISSUED);
    expect(host.assignments).toEqual({ host: "p1" });
    expect(a.c.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("kickRole with the supersede code still closes with 4001", async () => {
    const { port, handle, first } = await setup();
    const a = await joinPlayer(port, "host", first.host!, "p1");
    handle.kickRole("local", "host", CLOSE_SUPERSEDED);
    expect(await a.c.closed).toBe(CLOSE_SUPERSEDED);
  });

  it("existing startServer callers are unaffected", async () => {
    const scenario = await loadScenario(fixture);
    const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock: new FakeClock(0) });
    const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock: new FakeClock(0) });
    const { port, close } = await startServer({ port: 0, hosts: new Map([["local", host]]), log: () => {} });
    const c = await open(port);
    c.send({ type: "join", sessionId: "local", roleId: "host", participantId: "p1" });
    expect((await c.next((m) => m.type === "joined" || m.type === "error")).type).toBe("joined");
    // superseding by a second join still closes the first with 4001
    const c2 = await open(port);
    c2.send({ type: "join", sessionId: "local", roleId: "host", participantId: "p1", reconnectToken: (await c.next((m) => m.type === "joined")).reconnectToken });
    await c2.next((m) => m.type === "joined");
    expect(await c.closed).toBe(CLOSE_SUPERSEDED);
    for (const s of sockets) s.terminate();
    await close();
  });
});
