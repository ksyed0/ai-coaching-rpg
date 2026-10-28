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
import { HostError, SessionHost } from "../session-host.js";
import { CLOSE_SUPERSEDED, startServer } from "../ws-server.js";
import { AuthThrottle, type Limits } from "../security.js";
// Real-socket tests: a generous explicit limit (coverage and a loaded machine are slower). Nothing here measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

class CountingThrottle extends AuthThrottle {
  calls = 0;
  scopes: string[] = [];
  override fail(ip: string, scope = ""): void { this.calls++; this.scopes.push(scope); super.fail(ip, scope); }
}

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
let server: Awaited<ReturnType<typeof startServer>> | null = null;
let sockets: WebSocket[] = [];
let logs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sockets) s.terminate();
  sockets = []; logs = [];
  await server?.close(); server = null;
});

type Client = { ws: WebSocket; inbox: any[]; raw: string[]; closed: Promise<number>; send(m: unknown): void; next(pred: (m: any) => boolean): Promise<any> };
async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = []; const raw: string[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  ws.on("message", (d) => { raw.push(d.toString()); const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  // Waits for the effect itself; the test's own timeout is the only guard against a hung server.
  const next = (pred: (m: any) => boolean) => new Promise<any>((resolve) => { const found = inbox.find(pred); if (found) return resolve(found); waiters.push({ pred, resolve }); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { ws, inbox, raw, closed, next, send: (m) => ws.send(JSON.stringify(m)) };
}

/** Polls a condition the server reaches asynchronously (a close handler releasing a seat). */
async function until(cond: () => boolean): Promise<void> { while (!cond()) await new Promise((r) => setTimeout(r, 5)); }

async function setup(o: { limits?: Partial<Limits>; authThrottle?: AuthThrottle; extraPlayers?: string[]; persist?: () => void } = {}) {
  const scenario = await loadScenario(fixture);
  for (const id of o.extraPlayers ?? []) scenario.roles[id] = { id, type: "player", brief: `You are ${id}.`, private_facts: [] } as (typeof scenario.roles)[string];
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock: new FakeClock(0) });
  const persist = vi.fn(o.persist ?? (() => {}));
  const seats: Seats = { credentials: PlayerCredentials.create(BIND), consent: new ConsentStore({ version: "v1", text: "notice" }), persist };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock: new FakeClock(0), seats });
  const { codes, plain } = JoinCodes.issue(["host", ...(o.extraPlayers ?? [])], BIND);
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), log: (m) => logs.push(m), limits: o.limits, authThrottle: o.authThrottle, joinCodes: new Map([["local", codes]]) });
  return { port: server.port, host, engine, seats, persist, code: plain.host!, plain };
}

const join = (extra: Record<string, unknown> = {}) => ({ type: "join", sessionId: "local", roleId: "host", participantId: "alice", ...extra });
const UNAUTHORIZED = { type: "error", code: "unauthorized", message: "unauthorized" };

/** Joins `host` by code with issueCredential and returns the open client and its joined message. */
async function webJoin(port: number, code: string, extra: Record<string, unknown> = {}) {
  const c = await open(port);
  c.send(join({ joinCode: code, issueCredential: true, displayName: "Alice", ...extra }));
  return { c, j: await c.next((m) => m.type === "joined") };
}

describe("join by durable credential (US-0053)", () => {
  it("first web join by code with issueCredential returns a credential and persists it before joined is sent", async () => {
    const order: string[] = [];
    const { port, seats, persist, code } = await setup({ persist: () => { order.push("persist"); } });
    const realSend = WebSocket.prototype.send;
    vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (this: WebSocket, data: any, ...rest: any[]) {
      if (typeof data === "string" && data.includes('"type":"joined"')) order.push("joined");
      return (realSend as any).call(this, data, ...rest);
    });
    const { c, j } = await webJoin(port, code);
    expect(j.credential).toMatch(/^[0-9a-f]{32}$/);
    expect(j.logIdentity).toBe(seats.credentials.logIdentity);
    expect(seats.credentials.verify("host", j.credential)).toBe(true);
    expect(seats.credentials.nameOf("host")).toBe("Alice");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["persist", "joined"]);
    // The plain credential appears exactly once on the wire and never in a log.
    expect(c.raw.filter((r) => r.includes(j.credential))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(j.credential);
    expect(logs.join("\n")).not.toContain("Alice");
  });

  it("a dropped connection frees the seat and the credential rejoins without the code", async () => {
    const { port, host, seats, code } = await setup();
    const { c, j } = await webJoin(port, code);
    c.ws.close(); await c.closed;
    await until(() => host.assignments.host === undefined);
    expect(seats.credentials.has("host")).toBe(true); // a disconnect never revokes
    const d = await open(port);
    d.send(join({ credential: j.credential }));
    const j2 = await d.next((m) => m.type === "joined");
    expect(j2.roleId).toBe("host");
    expect(j2.credential).toBeUndefined(); // only the issuing join carries it
    expect(j2.logIdentity).toBe(seats.credentials.logIdentity);
    expect(host.assignments.host).toBe("alice");
  });

  it("the join code is refused once a credential exists for the role", async () => {
    const { port, host, code } = await setup();
    const { c } = await webJoin(port, code);
    c.ws.close(); await c.closed;
    await until(() => host.assignments.host === undefined);
    for (const extra of [{}, { issueCredential: true }]) {
      const d = await open(port);
      d.send(join({ participantId: "mallory", joinCode: code, ...extra }));
      expect(await d.next((m) => m.type === "error")).toEqual(UNAUTHORIZED);
      expect(await d.closed).toBe(1008);
    }
    expect(host.assignments).toEqual({});
  });

  it("a second join with the credential closes the first socket with code 4001", async () => {
    const { port, host, seats, persist, code } = await setup();
    const { c: a, j } = await webJoin(port, code);
    const b = await open(port);
    b.send(join({ credential: j.credential }));
    expect((await b.next((m) => m.type === "joined")).roleId).toBe("host");
    expect(CLOSE_SUPERSEDED).toBe(4001);
    expect(await a.closed).toBe(4001);
    // The old socket's close does not free the seat the new one holds, and nothing was revoked or rewritten.
    await new Promise((r) => setTimeout(r, 50));
    expect(host.assignments.host).toBe("alice");
    expect(seats.credentials.has("host")).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("two simultaneous joins by code for one role: exactly one succeeds", async () => {
    const { port, host, persist, code } = await setup();
    const a = await open(port); const b = await open(port);
    a.send(join({ joinCode: code, issueCredential: true }));
    b.send(join({ participantId: "bob", joinCode: code, issueCredential: true }));
    const ra = await a.next((m) => m.type === "joined" || m.type === "error");
    const rb = await b.next((m) => m.type === "joined" || m.type === "error");
    const results = [ra, rb];
    expect(results.filter((m) => m.type === "joined")).toHaveLength(1);
    expect(results.filter((m) => m.type === "error")).toHaveLength(1);
    expect(persist).toHaveBeenCalledTimes(1);
    const winner = ra.type === "joined" ? "alice" : "bob";
    expect(host.assignments.host).toBe(winner);
  });

  it("a say or leave sent by the superseded socket after the kick is dropped", async () => {
    const { port, host, engine, seats, persist, code } = await setup();
    const { c: a, j } = await webJoin(port, code);
    // The old client stops reading, so it has not seen the close frame and can still send after the server kicked it.
    (a.ws as any)._socket.pause();
    const b = await open(port);
    b.send(join({ credential: j.credential }));
    await b.next((m) => m.type === "joined");
    a.send({ type: "say", text: "from the kicked socket" });
    a.send({ type: "leave" });
    await new Promise((r) => setTimeout(r, 100));
    expect(host.assignments.host).toBe("alice");
    expect(seats.credentials.has("host")).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(engine.state.transcript).toEqual([]);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    (a.ws as any)._socket.resume();
    await a.closed;
  });

  it("two simultaneous terminal joins by code for one role: exactly one succeeds and the other is role_taken", async () => {
    const { port, host, persist, code } = await setup();
    const a = await open(port); const b = await open(port);
    // The same participant id on both (two tabs), so SessionHost.join would accept both: only the live-seat check refuses the second.
    a.send(join({ joinCode: code }));
    b.send(join({ joinCode: code }));
    const ra = await a.next((m) => m.type === "joined" || m.type === "error");
    const rb = await b.next((m) => m.type === "joined" || m.type === "error");
    expect([ra, rb].filter((m) => m.type === "joined")).toHaveLength(1);
    expect([ra, rb].filter((m) => m.type === "error").map((m) => m.code)).toEqual(["role_taken"]);
    expect(persist).not.toHaveBeenCalled();
    expect(host.assignments.host).toBe("alice");
  });

  it("leave revokes the credential and frees the seat", async () => {
    const { port, host, seats, persist, code } = await setup();
    const { c, j } = await webJoin(port, code);
    seats.consent.give("host", "alice", "v1", 0);
    c.send({ type: "leave" });
    expect(await c.closed).toBe(1000);
    expect(host.assignments).toEqual({});
    expect(seats.credentials.has("host")).toBe(false);
    expect(seats.consent.has("host", "alice")).toBe(false);
    expect(persist).toHaveBeenCalledTimes(2);
    const d = await open(port);
    d.send(join({ credential: j.credential }));
    expect(await d.next((m) => m.type === "error")).toEqual(UNAUTHORIZED);
    const e = await open(port);
    e.send(join({ participantId: "bob", joinCode: code })); // the seat is free for the code again
    expect((await e.next((m) => m.type === "joined")).roleId).toBe("host");
  });

  it("a leave whose save fails answers internal and stays open; a retry writes the file and only then closes 1000", async () => {
    let failing = false;
    const records: unknown[] = [];
    const { port, host, seats, persist, code } = await setup({ persist: () => { if (failing) throw new Error("disk full"); records.push(seats.credentials.toRecord()); } });
    const { c } = await webJoin(port, code);
    failing = true;
    c.send({ type: "leave" });
    expect(await c.next((m) => m.type === "error")).toEqual({ type: "error", code: "internal", message: "internal error" });
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    expect((records.at(-1) as any).roles).toHaveProperty("host"); // the file still holds the credential
    failing = false;
    c.send({ type: "leave" });
    expect(await c.closed).toBe(1000);
    expect(persist).toHaveBeenCalledTimes(3);
    expect((records.at(-1) as any).roles).toEqual({});
    expect(host.assignments).toEqual({});
  });

  it("after the session ends, a join by code with issueCredential gets no credential and nothing is persisted", async () => {
    const { port, host, engine, seats, persist, code } = await setup();
    const t = await open(port);
    t.send(join({ joinCode: code }));
    await t.next((m) => m.type === "joined");
    host.giveConsent("host", "alice", "v1"); // US-0054: a seats host starts only once every player consented
    await host.start();
    await host.command({ command: "advance" }); await engine.tick();
    await host.command({ command: "advance" }); await engine.tick();
    expect(engine.state.status).toBe("ended");
    t.ws.close(); await t.closed;
    await until(() => host.assignments.host === undefined);
    const writes = persist.mock.calls.length;
    const c = await open(port);
    c.send(join({ joinCode: code, issueCredential: true }));
    const err = await c.next((m) => m.type === "error");
    expect(err.code).toBe("session_ended");
    expect(c.inbox.some((m) => m.type === "joined" || m.credential !== undefined)).toBe(false);
    expect(persist).toHaveBeenCalledTimes(writes);
    expect(seats.credentials.has("host")).toBe(false);
    expect(host.assignments).toEqual({});
  });

  it("a wrong credential is counted under cred:<role> only and does not block the code path of another role", async () => {
    let t = 0;
    const throttle = new CountingThrottle({ max: 2, windowMs: 60_000, blockMs: 60_000, now: () => t });
    const { port, plain, code } = await setup({ authThrottle: throttle, extraPlayers: ["p2"] });
    for (let i = 0; i < 4; i++) {
      const c = await open(port);
      c.send(join({ credential: "0".repeat(32) }));
      expect(await c.next((m) => m.type === "error")).toEqual(UNAUTHORIZED);
      await c.closed;
    }
    const unknown = await open(port);
    unknown.send(join({ roleId: "made_up", credential: "0".repeat(32) }));
    await unknown.closed;
    expect(throttle.scopes).toEqual(["cred:host", "cred:host", "cred:host", "cred:*"]); // the fourth host attempt was blocked and not charged
    const p2 = await open(port);
    p2.send(join({ roleId: "p2", participantId: "bob", joinCode: plain.p2! }));
    expect((await p2.next((m) => m.type === "joined")).roleId).toBe("p2");
    const h = await open(port); // the code path of the same role is a different scope
    h.send(join({ joinCode: code }));
    expect((await h.next((m) => m.type === "joined")).roleId).toBe("host");
  });

  it("a persist failure releases the seat and answers internal", async () => {
    let failing = true;
    const { port, host, seats, code } = await setup({ persist: () => { if (failing) throw new Error("disk full"); } });
    const c = await open(port);
    c.send(join({ joinCode: code, issueCredential: true }));
    expect(await c.next((m) => m.type === "error")).toEqual({ type: "error", code: "internal", message: "internal error" });
    expect(c.inbox.some((m) => m.type === "joined" || m.type === "event")).toBe(false);
    expect(host.assignments).toEqual({});
    expect(seats.credentials.has("host")).toBe(false); // an unsaved credential is not left behind to lock the code out
    failing = false;
    c.send(join({ joinCode: code, issueCredential: true })); // the same connection may try again
    const j = await c.next((m) => m.type === "joined");
    expect(j.credential).toMatch(/^[0-9a-f]{32}$/);
    expect(host.assignments.host).toBe("alice");
  });

  it("session.ended revokes every credential", async () => {
    const { port, host, engine, seats, persist, code } = await setup();
    const { c, j } = await webJoin(port, code);
    host.giveConsent("host", "alice", "v1"); // US-0054: a seats host starts only once every player consented
    await host.start();
    await host.command({ command: "advance" }); await engine.tick();
    await host.command({ command: "advance" }); await engine.tick();
    expect(engine.state.status).toBe("ended");
    expect(seats.credentials.has("host")).toBe(false);
    expect(persist).toHaveBeenCalledTimes(3); // the issue, the consent, the end-of-session revoke
    c.ws.close(); await c.closed;
    await until(() => host.assignments.host === undefined);
    const d = await open(port);
    d.send(join({ credential: j.credential }));
    expect(await d.next((m) => m.type === "error")).toEqual(UNAUTHORIZED);
  });

  it("a name with a right-to-left override is stored stripped; a name that is only spaces, only zero-width characters or contains a newline is refused as bad_message and is not charged to any throttle", async () => {
    const throttle = new CountingThrottle({ max: 1_000, windowMs: 60_000, blockMs: 60_000, now: Date.now });
    const { port, host, seats, code } = await setup({ authThrottle: throttle });
    const c = await open(port);
    for (const bad of ["   ", "​‌", "Ana\nBo"]) {
      c.inbox.length = 0;
      c.send(join({ joinCode: code, issueCredential: true, displayName: bad }));
      const err = await c.next((m) => m.type === "error");
      expect(err.code).toBe("bad_message");
      expect(err.message).toMatch(/^displayName: /);
    }
    expect(throttle.calls).toBe(0);
    expect(host.assignments).toEqual({});
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.send(join({ joinCode: code, issueCredential: true, displayName: "Ali‮ce" }));
    const j = await c.next((m) => m.type === "joined");
    expect(j.credential).toBeDefined();
    expect(seats.credentials.nameOf("host")).toBe("Alice");
  });

  it("a terminal join without issueCredential keeps working by code after a drop", async () => {
    // Regression guard: passes before and after the change.
    const { port, host, seats, code } = await setup();
    const c = await open(port);
    c.send(join({ joinCode: code }));
    const j = await c.next((m) => m.type === "joined");
    expect(j.credential).toBeUndefined();
    c.ws.close(); await c.closed;
    await until(() => host.assignments.host === undefined);
    const d = await open(port);
    d.send(join({ joinCode: code }));
    expect((await d.next((m) => m.type === "joined")).roleId).toBe("host");
    expect(seats.credentials.has("host")).toBe(false);
  });
});

describe("SessionHost seats (US-0053)", () => {
  it("leave acts only for the holder and endSeats is idempotent", async () => {
    const { host, seats, persist } = await setup();
    host.join("host", "alice");
    seats.credentials.issue("host", "Alice");
    host.leave("host", "mallory"); // not the holder: nothing changes
    expect(host.assignments.host).toBe("alice");
    expect(seats.credentials.has("host")).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    host.endSeats();
    host.endSeats();
    expect(seats.credentials.has("host")).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("an endSeats whose save fails throws, and a later call retries the write", async () => {
    let failing = true;
    const { host, seats, persist } = await setup({ persist: () => { if (failing) throw new Error("disk full"); } });
    seats.credentials.issue("host", "Alice");
    expect(() => host.endSeats()).toThrow(/disk full/);
    failing = false;
    host.endSeats(); // nothing new to revoke, but the file is still stale
    expect(persist).toHaveBeenCalledTimes(2);
    host.endSeats();
    expect(persist).toHaveBeenCalledTimes(2); // written: nothing more to do
  });

  it("HostError names the roles it is about", () => {
    expect(new HostError("role_taken").message).toBe("role_taken");
    expect(new HostError("already_started", ["host", "p2"]).message).toBe("already_started: host,p2");
    expect(new HostError("seats_not_ready").code).toBe("seats_not_ready");
  });
});
