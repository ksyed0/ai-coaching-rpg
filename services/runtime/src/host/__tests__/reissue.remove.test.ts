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
import { ConsentStore, REBIND_PENDING } from "../../engine/consent.js";
import type { Seats } from "../../engine/seats.js";
import { HostError, SessionHost } from "../session-host.js";
import { CLOSE_REISSUED, CLOSE_REMOVED, startServer, type ServerHandle } from "../ws-server.js";
import { ClientMessageSchema } from "../protocol.js";
import { RemoveRefusedError, reissueRole, type ReissueDeps } from "../reissue.js";
// Real-socket tests: a generous explicit limit. Nothing here measures elapsed time; each step awaits the event it needs.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
let server: ServerHandle | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => { for (const s of sockets) s.terminate(); sockets = []; await server?.close(); server = null; });

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

/** A real host, real seats, a real server on port 0 and the same wiring main.ts uses. `persistFails` makes seats.persist throw while true. */
async function setup() {
  const scenario = await loadScenario(fixture);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock: new FakeClock(0) });
  const state = { persistFails: false, persists: 0 };
  const seats: Seats = {
    credentials: PlayerCredentials.create(BIND), consent: new ConsentStore({ version: "v1", text: "notice" }),
    persist: () => { state.persists++; if (state.persistFails) throw new Error("disk full"); },
  };
  const logs: string[] = [];
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock: new FakeClock(0), seats, log: (m) => logs.push(m) });
  const issued = JoinCodes.issue(["host"], BIND);
  const joinCodes = new Map<string, JoinCodes>([["local", issued.codes]]);
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), log: () => {}, joinCodes });
  let current = issued.codes;
  const written: JoinCodes[] = [];
  const file = { bytes: JSON.stringify(issued.codes.toRecord()) }; // the codes file as bytes
  const deps: ReissueDeps = {
    host, seats, sessionId: "local", server,
    codes: () => current,
    setCodes: (c) => { current = c; server!.replaceCodes("local", c); },
    writeCodes: (c) => { written.push(c); file.bytes = JSON.stringify(c.toRecord()); },
  };
  return { port: server.port, host, engine, seats, state, logs, deps, written, file, code: issued.plain.host!, current: () => current };
}
type Env = Awaited<ReturnType<typeof setup>>;

const webJoin = async (port: number, code: string, participantId: string) => {
  const c = await open(port);
  c.send({ type: "join", sessionId: "local", roleId: "host", participantId, joinCode: code, issueCredential: true, displayName: "Pat" });
  const r = await c.next((m) => m.type === "joined" || m.type === "error");
  return { c, r };
};
/** alice takes the seat by code, consents, and (optionally) the session starts. */
async function seated(e: Env, start: boolean) {
  const a = await webJoin(e.port, e.code, "alice");
  expect(a.r.type).toBe("joined");
  e.host.giveConsent("host", "alice", "v1");
  if (start) await e.host.start();
  return Object.assign(a.c, { credential: a.r.credential as string });
}

const allEvents = (e: Env) => { const r = e.engine.eventsAfter(0); if (!r.complete) throw new Error("window incomplete"); return [...r.events]; };
/** Everything a refused remove must leave exactly as it was. */
const stateOf = (e: Env) => JSON.stringify({
  file: e.file.bytes, cred: e.seats.credentials.snapshotRole("host"), consent: e.seats.consent.snapshot(), pending: e.seats.consent.isRebindPending("host"),
  persists: e.state.persists, events: allEvents(e).length,
});

describe("remove a participant before the start (US-0059)", () => {
  it("remove before the start closes the socket with 4003 \"removed\", revokes the credential, withdraws the consent, frees the seat and returns a new code", async () => {
    const e = await setup();
    const alice = await seated(e, false);
    const closeReason = new Promise<string>((r) => alice.ws.on("close", (_c, reason) => r(reason.toString())));
    const code = await reissueRole(e.deps, "host", "Kim", "removed");
    expect(await alice.closed).toBe(CLOSE_REMOVED);
    expect(CLOSE_REMOVED).toBe(4003);
    expect(await closeReason).toBe("removed");
    expect(e.seats.credentials.has("host")).toBe(false);
    expect(e.seats.consent.hasEntry("host")).toBe(false);
    expect(e.seats.consent.isRebindPending("host")).toBe(false);
    expect(e.host.assignments.host).toBeUndefined();
    expect(code).not.toBe(e.code);
    expect(e.current().verify("host", code)).toBe(true);
    expect(allEvents(e)).toEqual([]); // the lobby log stays empty
  });

  it("the old code is refused (unauthorized) and the new code joins", async () => {
    const e = await setup();
    await seated(e, false);
    const code = await reissueRole(e.deps, "host", undefined, "removed");
    const old = await webJoin(e.port, e.code, "bob");
    expect(old.r).toMatchObject({ type: "error", code: "unauthorized" });
    const bob = await webJoin(e.port, code, "bob");
    expect(bob.r.type).toBe("joined");
    expect(bob.r.consent.given).toBe(false);
  });

  it("remove after the start is refused and changes nothing (codes file bytes, credential, consent, socket open)", async () => {
    const e = await setup();
    const alice = await seated(e, true);
    const before = stateOf(e);
    const kick = vi.fn(); const set = vi.fn();
    const deps: ReissueDeps = { ...e.deps, server: { kickRole: kick }, setCodes: set };
    await expect(reissueRole(deps, "host", "Kim", "removed")).rejects.toBeInstanceOf(RemoveRefusedError);
    expect(stateOf(e)).toBe(before);
    expect(e.written).toHaveLength(0);
    expect(kick).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(alice.ws.readyState).toBe(alice.ws.OPEN);
    expect(e.seats.credentials.verify("host", alice.credential)).toBe(true);
    expect(e.seats.consent.has("host", "alice")).toBe(true);
    expect(e.current().verify("host", e.code)).toBe(true);
  });

  it("remove while the start is in flight is refused and changes nothing", async () => {
    const e = await setup();
    const alice = await seated(e, false);
    const log = (e.engine as unknown as { log: { append: (...a: unknown[]) => Promise<unknown> } }).log;
    const real = log.append.bind(log);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    log.append = async (...a: unknown[]) => { await gate; return real(...a); };
    const starting = e.host.start();
    await vi.waitFor(() => expect(e.host.isStarting).toBe(true));
    const before = stateOf(e);
    await expect(reissueRole(e.deps, "host", "Kim", "removed")).rejects.toBeInstanceOf(RemoveRefusedError);
    expect(stateOf(e)).toBe(before);
    expect(e.written).toHaveLength(0);
    expect(alice.ws.readyState).toBe(alice.ws.OPEN);
    release();
    await starting;
    expect(e.host.hasStarted).toBe(true);
    expect(e.seats.consent.has("host", "alice")).toBe(true);
  });

  it("a plain reissue still closes with 4002", async () => {
    const e = await setup();
    const alice = await seated(e, false);
    await reissueRole(e.deps, "host");
    expect(await alice.closed).toBe(CLOSE_REISSUED);
  });
});
