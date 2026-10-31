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
import { CLOSE_REISSUED, startServer, type ServerHandle } from "../ws-server.js";
import { ClientMessageSchema } from "../protocol.js";
import { reissueActor, reissueRole, type ReissueDeps } from "../reissue.js";
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
  const deps: ReissueDeps = {
    host, seats, sessionId: "local", server,
    codes: () => current,
    setCodes: (c) => { current = c; server!.replaceCodes("local", c); },
    writeCodes: (c) => { written.push(c); },
  };
  return { port: server.port, host, engine, seats, state, logs, deps, written, code: issued.plain.host!, current: () => current };
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
const alerts = (e: Env) => allEvents(e).filter((x) => x.type === "facilitator.alert").map((x) => (x as { message: string }).message);

describe("code reissue (US-0058)", () => {
  it("host.join after a post-start reissue admits the new participant with no consent step and appends the alert", async () => {
    const e = await setup();
    const alice = await seated(e, true);
    const code = await reissueRole(e.deps, "host", "Kim");
    expect(await alice.closed).toBe(CLOSE_REISSUED);
    expect(e.seats.consent.isRebindPending("host")).toBe(true);
    expect(e.seats.credentials.has("host")).toBe(false);
    expect(alerts(e)).toEqual(["consent for host will be rebound after a code reissue by Kim"]);
    // The old code is gone; the new one opens the seat for a participant nobody has seen, and consent already stands.
    const old = await webJoin(e.port, e.code, "bob");
    expect(old.r).toMatchObject({ type: "error", code: "unauthorized" });
    const bob = await webJoin(e.port, code, "bob");
    expect(bob.r.type).toBe("joined");
    expect(bob.r.consent.given).toBe(true);
    expect(e.seats.consent.has("host", "bob")).toBe(true);
    expect(e.seats.consent.has("host", "alice")).toBe(false);
    expect(e.seats.consent.snapshot().host).toEqual({ noticeVersion: "v1", at: 0 });
    expect(alerts(e)).toEqual(["consent for host will be rebound after a code reissue by Kim", "consent for host rebound after a code reissue"]);
    // Nobody else can take it afterwards: the seat is held and the consent is bob's.
    const carol = await webJoin(e.port, code, "carol");
    expect(carol.r.type).toBe("error");
  });

  it("a start interrupted after session.started keeps the seats frozen, and a retry finishes it (BUG-0015)", async () => {
    const e = await setup();
    await seated(e, false);
    const log = (e.engine as unknown as { log: { append: (...a: unknown[]) => Promise<unknown> } }).log;
    const real = log.append.bind(log);
    let calls = 0;
    log.append = (...a: unknown[]) => (++calls === 2 ? Promise.reject(Object.assign(new Error("closed"), { code: "closed" })) : real(...a));
    await expect(e.host.start()).rejects.toMatchObject({ code: "closed" });
    expect(e.host.hasStarted).toBe(false);
    expect(e.host.isStarting).toBe(true);
    // Between the attempts the consents are the ones session.started recorded: no reissue, no leave, no withdrawal.
    await expect(reissueRole(e.deps, "host")).rejects.toThrow("the session is starting");
    expect(() => e.host.giveConsent("host", "alice", "v1")).toThrow(HostError);
    await e.host.start();
    expect(e.host.hasStarted).toBe(true);
    expect(e.host.isStarting).toBe(false);
    expect(allEvents(e).filter((x) => x.type === "session.started")).toHaveLength(1);
    expect(e.engine.state.currentScene).not.toBeNull();
  });

  it("reissue before the start clears consent so the person must consent again", async () => {
    const e = await setup();
    const alice = await seated(e, false);
    const code = await reissueRole(e.deps, "host");
    expect(await alice.closed).toBe(CLOSE_REISSUED);
    expect(e.seats.consent.hasEntry("host")).toBe(false);
    expect(e.seats.consent.isRebindPending("host")).toBe(false);
    expect(alerts(e)).toEqual([]); // the lobby log stays empty: engine.start refuses a log with events
    const bob = await webJoin(e.port, code, "bob");
    expect(bob.r.type).toBe("joined");
    expect(bob.r.consent.given).toBe(false);
    await expect(e.host.start()).rejects.toMatchObject({ code: "seats_not_ready" });
    e.host.giveConsent("host", "bob", "v1");
    await e.host.start();
  });

  it("reissue order: credential revoked and persisted before the socket is kicked, before the new code opens", async () => {
    const e = await setup();
    await seated(e, true);
    const steps: string[] = [];
    const deps: ReissueDeps = {
      ...e.deps,
      seats: { ...e.seats, persist: () => { steps.push(`persist(credential=${e.seats.credentials.has("host")},pending=${e.seats.consent.isRebindPending("host")})`); } },
      server: { kickRole: (_s, r, c) => { steps.push(`kick(${r},${c})`); } },
      writeCodes: (c) => { steps.push("write"); e.deps.writeCodes(c); },
      setCodes: (c) => { steps.push("set"); e.deps.setCodes(c); },
    };
    const code = await reissueRole(deps, "host");
    expect(steps).toEqual(["write", "persist(credential=false,pending=true)", `kick(host,${CLOSE_REISSUED})`, "set"]);
    expect(e.current().verify("host", code)).toBe(true);
  });

  it("a kick that throws is reported and the caller still gets the new, working code", async () => {
    const e = await setup();
    await seated(e, true);
    const reports: string[] = [];
    const deps: ReissueDeps = { ...e.deps, server: { kickRole: () => { throw new Error("socket gone"); } }, report: (what) => reports.push(what) };
    const code = await reissueRole(deps, "host");
    expect(reports).toEqual(["kicking the socket of a reissued role"]);
    expect(e.current().verify("host", code)).toBe(true);
  });

  it("a failed codes write leaves the old code working and the seat untouched", async () => {
    const e = await setup();
    const alice = await seated(e, true);
    const kick = vi.fn();
    const set = vi.fn();
    const deps: ReissueDeps = { ...e.deps, server: { kickRole: kick }, setCodes: set, writeCodes: () => { throw new Error("EIO"); } };
    await expect(reissueRole(deps, "host")).rejects.toThrow("EIO");
    expect(kick).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(e.seats.credentials.has("host")).toBe(true);
    expect(e.seats.consent.has("host", "alice")).toBe(true);
    expect(e.current().verify("host", e.code)).toBe(true);
    expect(alerts(e)).toEqual([]);
    // alice is still connected and her seat still works: reconnect with her credential-less old connection state is untouched.
    expect(alice.ws.readyState).toBe(alice.ws.OPEN);
  });

  it("a failed seat write puts the old codes file back, keeps the old code in memory and never kicks", async () => {
    const e = await setup();
    const alice = await seated(e, true);
    const kick = vi.fn();
    const set = vi.fn();
    const writes: JoinCodes[] = [];
    const old = e.current();
    e.state.persistFails = true;
    const deps: ReissueDeps = { ...e.deps, server: { kickRole: kick }, setCodes: set, writeCodes: (c) => { writes.push(c); } };
    await expect(reissueRole(deps, "host")).rejects.toThrow("disk full");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(old); // the file was put back
    expect(kick).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(e.current()).toBe(old);
    // The seat is exactly as it was: alice's credential and consent stand, so neither code can take her seat.
    expect(e.seats.credentials.verify("host", alice.credential)).toBe(true);
    expect(e.seats.consent.has("host", "alice")).toBe(true);
    expect(e.seats.consent.isRebindPending("host")).toBe(false);
    expect(old.verify("host", e.code)).toBe(true);
    expect(e.seats.credentials.has("host")).toBe(true); // byCode needs !has(role): the old code is refused while it stands
    expect(writes[0]!.verify("host", e.code)).toBe(false);
  });

  it("a failed credential write after claimRebind leaves the rebind pending", async () => {
    const e = await setup();
    await seated(e, true);
    const code = await reissueRole(e.deps, "host");
    e.state.persistFails = true;
    const bad = await webJoin(e.port, code, "bob");
    expect(bad.r).toMatchObject({ type: "error", code: "internal" });
    expect(e.seats.consent.isRebindPending("host")).toBe(true);
    expect(e.seats.credentials.has("host")).toBe(false);
    expect(e.host.assignments.host).toBeUndefined();
    expect(alerts(e).at(-1)).toMatch(/undone/);
    e.state.persistFails = false;
    const good = await webJoin(e.port, code, "dave");
    expect(good.r.type).toBe("joined");
    expect(e.seats.consent.has("host", "dave")).toBe(true);
  });

  it("the facilitator name appears in a facilitator-only alert and in no player view", async () => {
    const e = await setup();
    await seated(e, true);
    const messy = "  Kim\u202E\u0000 \u200BO'Neil  ";
    await reissueRole(e.deps, "host", messy);
    const events = allEvents(e);
    const alert = events.find((x) => x.type === "facilitator.alert") as { message: string };
    expect(alert.message).toBe("consent for host will be rebound after a code reissue by Kim O'Neil");
    expect(e.host.viewFor("facilitator", events.find((x) => x.type === "facilitator.alert")!)).not.toBeNull();
    for (const ev of events) {
      for (const who of ["host", "someone-else"]) {
        const view = e.host.viewFor(who, ev);
        expect(JSON.stringify(view ?? null)).not.toContain("O'Neil");
      }
    }
    expect(JSON.stringify(e.host.snapshotFor("host"))).not.toContain("O'Neil");
    const replay = e.host.replayFor("host", 0);
    expect(replay.complete).toBe(true);
    expect(JSON.stringify(replay.events)).not.toContain("O'Neil");
  });

  it("reissueActor cleans and bounds the name", () => {
    expect(reissueActor(undefined)).toBe("the facilitator");
    expect(reissueActor("")).toBe("the facilitator");
    expect(reissueActor("a\nb\tc")).toBe("a b c");
    expect(reissueActor("x".repeat(500))).toBe("x".repeat(60));
    expect([...reissueActor("😀".repeat(100))]).toHaveLength(60);
    expect(reissueActor("‮\u0000")).toBe("the facilitator");
  });

  it("an unknown or non-player role, or an ended session, is refused and nothing changes", async () => {
    const e = await setup();
    await seated(e, true);
    const set = vi.fn();
    const deps: ReissueDeps = { ...e.deps, setCodes: set, writeCodes: () => { throw new Error("must not write"); } };
    for (const bad of ["nobody", "", "__proto__", "constructor", "facilitator", "npc_one"]) await expect(reissueRole(deps, bad), bad).rejects.toThrow(/not a player role/);
    expect(set).not.toHaveBeenCalled();
    expect(e.seats.consent.has("host", "alice")).toBe(true);
    await e.engine.command({ command: "advance" }); await e.engine.tick();
    await e.engine.command({ command: "advance" }); await e.engine.tick();
    expect(e.engine.state.status).toBe("ended");
    await expect(reissueRole(e.deps, "host")).rejects.toThrow(/ended/);
  });

  it("join: a pending seat is not claimable while a credential still holds the role, and the placeholder is never a participant", async () => {
    const e = await setup();
    await seated(e, true);
    e.seats.consent.releaseForRebind("host"); // pending, but alice's credential still stands
    const code = (() => { try { e.host.join("host", "bob"); return undefined; } catch (err) { return (err as HostError).code; } })();
    expect(code).toBe("consent_required");
    expect(e.seats.consent.isRebindPending("host")).toBe(true);
    expect(REBIND_PENDING).toBe("rebind-pending");
  });

  it("nothing is claimable before the start: a marker found in the lobby is dropped, consent is required, and no alert is appended", async () => {
    const e = await setup();
    const alice = await seated(e, false);
    alice.ws.terminate(); await alice.closed;
    await vi.waitFor(() => { if (e.host.assignments.host) throw new Error("seat not yet released"); }, { timeout: 30_000, interval: 5 });
    e.seats.credentials.revoke("host");
    e.seats.consent.releaseForRebind("host"); // a stray marker in an idle lobby
    const bob = await webJoin(e.port, e.code, "bob");
    expect(bob.r.type).toBe("joined");
    expect(bob.r.consent.given).toBe(false);
    expect(e.seats.consent.hasEntry("host")).toBe(false);
    e.host.undoRebind("host"); // also silent before the start
    expect(allEvents(e)).toEqual([]);
    e.host.giveConsent("host", "bob", "v1");
    await e.host.start(); // the log was still empty
  });

  it("a reissue while the start is in flight is refused and leaves the seat alone", async () => {
    const e = await setup();
    await seated(e, false);
    const starting = e.host.start(); // `starting` is set synchronously
    await expect(reissueRole(e.deps, "host")).rejects.toThrow(/starting/);
    await starting;
    expect(e.seats.consent.has("host", "alice")).toBe(true);
    expect(e.seats.credentials.has("host")).toBe(true);
    expect(e.written).toHaveLength(0);
  });

  it("the placeholder participant id is refused at the protocol, at give() and at adopt()", async () => {
    const msg = { type: "join", sessionId: "local", roleId: "host", participantId: REBIND_PENDING, joinCode: "x" };
    expect(ClientMessageSchema.safeParse(msg).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...msg, participantId: "alice" }).success).toBe(true);
    const e = await setup();
    const c = await open(e.port);
    c.send(msg);
    expect(await c.next((m) => m.type === "error")).toMatchObject({ type: "error", code: "bad_message" });
    const store = new ConsentStore({ version: "v1", text: "n" });
    expect(() => store.give("host", REBIND_PENDING, "v1", 1)).toThrow();
    expect(() => store.adopt("host", REBIND_PENDING, "v1", 1)).toThrow();
    expect(store.hasEntry("host")).toBe(false);
    // A refused injection leaves the lobby startable.
    await seated(e, true);
  });
});
