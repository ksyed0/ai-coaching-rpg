import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadScenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { PlayerCredentials } from "../../engine/credentials.js";
import { ConsentStore } from "../../engine/consent.js";
import { JoinCodes } from "../../engine/join-codes.js";
import type { Seats } from "../../engine/seats.js";
import { SessionHost } from "../session-host.js";
import { startServer } from "../ws-server.js";
// Real sockets: a generous explicit limit. Nothing here measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const NOTICE = { version: "v1", text: "What we record and why." };
let server: Awaited<ReturnType<typeof startServer>> | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sockets) s.terminate();
  sockets = [];
  await server?.close(); server = null;
});

type Client = { inbox: any[]; next(pred: (m: any) => boolean): Promise<any>; send(m: unknown): void; text(): string };
async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  await new Promise<void>((r) => ws.once("open", () => r()));
  const next = (pred: (m: any) => boolean) => new Promise<any>((resolve) => {
    const found = inbox.find(pred);
    if (found) return resolve(found);
    waiters.push({ pred, resolve });
  });
  return { inbox, next, send: (m) => ws.send(JSON.stringify(m)), text: () => JSON.stringify(inbox) };
}

async function setup(log = new MemoryEventLog("local")) {
  const scenario = await loadScenario(fixture);
  const engine = new SessionEngine({ scenario, log, clock: new FakeClock(0) });
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock: new FakeClock(0) });
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), log: () => {} });
  return { engine, host, log, port: server.port };
}
const joinFac = async (port: number) => {
  const c = await open(port);
  c.send({ type: "join_facilitator", sessionId: "local" });
  await c.next((m) => m.type === "joined" || m.type === "error");
  return c;
};
const joinPlayer = async (port: number, pid = "p1") => {
  const c = await open(port);
  c.send({ type: "join", sessionId: "local", roleId: "host", participantId: pid });
  await c.next((m) => m.type === "joined" || m.type === "error");
  return c;
};
const started = async (port: number) => {
  const fac = await joinFac(port);
  fac.send({ type: "start" });
  await fac.next((m) => m.type === "event" && m.event.type === "scene.entered");
  return fac;
};
const isAck = (ref: string) => (m: any) => m.type === "ack" && m.ref === ref;
const isErr = (m: any) => m.type === "error";
const idx = (c: Client, pred: (m: any) => boolean) => c.inbox.findIndex(pred);
const evIdx = (c: Client, type: string) => idx(c, (m) => m.type === "event" && m.event.type === type);

describe("console commands carry a ref and are acknowledged (US-0059)", () => {
  it("a command with ref is answered by an ack with that ref after its facilitator.command event", async () => {
    const { port } = await setup();
    const fac = await started(port);
    fac.send({ type: "command", ref: "r-1", command: { command: "pause" } });
    const ack = await fac.next(isAck("r-1"));
    expect(ack).toEqual({ type: "ack", ref: "r-1" });
    expect(evIdx(fac, "facilitator.command")).toBeGreaterThan(-1);
    expect(evIdx(fac, "facilitator.command")).toBeLessThan(idx(fac, isAck("r-1")));
  });

  it("a refused command with ref (stale_scene, unknown_fact) gets an error carrying the ref and no ack", async () => {
    const { port } = await setup();
    const fac = await started(port);
    fac.send({ type: "command", ref: "r-stale", expectSceneId: "not_the_scene", command: { command: "advance" } });
    expect(await fac.next((m) => isErr(m) && m.ref === "r-stale")).toMatchObject({ code: "stale_scene", ref: "r-stale" });
    fac.send({ type: "command", ref: "r-fact", command: { command: "release_hidden", roleId: "guest", fact: 9 } });
    expect(await fac.next((m) => isErr(m) && m.ref === "r-fact")).toMatchObject({ code: "unknown_fact", ref: "r-fact" });
    expect(fac.inbox.some((m) => m.type === "ack")).toBe(false);
  });

  it("end_now with ref is acked after session.ended; before the start it is not_started with the ref", async () => {
    const { port } = await setup();
    const early = await joinFac(port);
    early.send({ type: "end_now", ref: "r-early" });
    expect(await early.next(isErr)).toMatchObject({ code: "not_started", ref: "r-early" });
    const fac = await started(port);
    fac.send({ type: "end_now", ref: "r-end" });
    await fac.next(isAck("r-end"));
    expect(evIdx(fac, "session.ended")).toBeGreaterThan(-1);
    expect(evIdx(fac, "session.ended")).toBeLessThan(idx(fac, isAck("r-end")));
  });

  it("a command with ref in a lobby whose seats are all ready is not_started, appends nothing and the status stays idle", async () => {
    const scenario = await loadScenario(fixture);
    const log = new MemoryEventLog("local");
    const clock = new FakeClock(7_000);
    const engine = new SessionEngine({ scenario, log, clock });
    const seats: Seats = { credentials: PlayerCredentials.create(BIND), consent: new ConsentStore(NOTICE), persist: vi.fn() };
    const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats });
    const { codes, plain } = JoinCodes.issue(["host"], BIND);
    server = await startServer({ port: 0, hosts: new Map([["local", host]]), joinCodes: new Map([["local", codes]]), log: () => {} });
    const p = await open(server.port);
    p.send({ type: "join", sessionId: "local", roleId: "host", participantId: "alice", joinCode: plain.host!, issueCredential: true, displayName: "Alice" });
    await p.next((m) => m.type === "joined");
    p.send({ type: "consent", noticeVersion: "v1" });
    await vi.waitFor(() => expect(seats.consent.has("host", "alice")).toBe(true), { timeout: 30_000, interval: 5 });
    const fac = await joinFac(server.port);
    fac.send({ type: "command", ref: "r-lobby", command: { command: "pause" } });
    expect(await fac.next(isErr)).toMatchObject({ code: "not_started", ref: "r-lobby" });
    expect(engine.state.status).toBe("idle");
    expect(await log.all()).toHaveLength(0);
  });

  it("a command with ref during an interrupted start is starting", async () => {
    const log = new MemoryEventLog("local");
    const real = log.append.bind(log);
    let n = 0;
    log.append = (body, ts) => { n++; return n === 2 ? Promise.reject(Object.assign(new Error("closed"), { code: "closed" })) : real(body, ts); };
    const { port, engine } = await setup(log);
    const fac = await joinFac(port);
    fac.send({ type: "start" });
    await fac.next(isErr);
    expect(engine.startIncomplete).toBe(true);
    const before = (await log.all()).length;
    fac.send({ type: "command", ref: "r-int", command: { command: "pause" } });
    await vi.waitFor(() => expect(fac.inbox.filter((m) => isErr(m) && m.ref === "r-int").map((m) => m.code)).toEqual(["starting"]));
    expect(await log.all()).toHaveLength(before);
  });

  it("a command without ref still auto-starts and gets no ack (terminal unchanged)", async () => {
    const { port, engine } = await setup();
    const fac = await joinFac(port);
    fac.send({ type: "command", command: { command: "pause" } });
    await fac.next((m) => m.type === "event" && m.event.type === "facilitator.command");
    expect(engine.state.status).not.toBe("idle");
    expect(fac.inbox.some((m) => m.type === "ack")).toBe(false);
  });

  it("a ref of 65 characters or with a space is bad_message (no ref on it: the message never parsed)", async () => {
    const { port, log } = await setup();
    const fac = await started(port);
    const before = (await log.all()).length;
    for (const ref of ["a".repeat(65), "has space", "", "a.b"]) {
      const seen = fac.inbox.length;
      fac.send({ type: "command", ref, command: { command: "pause" } });
      const err = await fac.next((m) => isErr(m) && fac.inbox.indexOf(m) >= seen);
      expect(err.code).toBe("bad_message");
      expect(Object.hasOwn(err, "ref")).toBe(false);
    }
    fac.send({ type: "end_now", ref: "a b" });
    await vi.waitFor(() => expect(fac.inbox.filter((m) => isErr(m) && m.code === "bad_message")).toHaveLength(5));
    expect(await log.all()).toHaveLength(before);
    expect(fac.inbox.some((m) => m.type === "ack")).toBe(false);
  });

  it("a host whose command throws a plain Error yields internal carrying the ref", async () => {
    const { port, host } = await setup();
    const fac = await started(port);
    vi.spyOn(host, "command").mockRejectedValue(new Error("boom"));
    fac.send({ type: "command", ref: "r-boom", command: { command: "pause" } });
    expect(await fac.next(isErr)).toMatchObject({ code: "internal", ref: "r-boom" });
    expect(fac.inbox.some((m) => m.type === "ack")).toBe(false);
  });

  it("a command with a ref on a socket that has not joined is not_joined with that ref", async () => {
    const { port } = await setup();
    const c = await open(port);
    c.send({ type: "command", ref: "r-nj", command: { command: "pause" } });
    expect(await c.next(isErr)).toMatchObject({ code: "not_joined", ref: "r-nj" });
  });

  it("the ack goes only to the sending facilitator connection, the event to both", async () => {
    const { port } = await setup();
    const a = await started(port);
    const b = await joinFac(port);
    a.send({ type: "command", ref: "from-a", command: { command: "pause" } });
    await a.next(isAck("from-a"));
    await b.next((m) => m.type === "event" && m.event.type === "facilitator.command");
    b.send({ type: "command", ref: "from-b", command: { command: "resume" } });
    await b.next(isAck("from-b"));
    expect(a.inbox.filter((m) => m.type === "ack").map((m) => m.ref)).toEqual(["from-a"]);
    expect(b.inbox.filter((m) => m.type === "ack").map((m) => m.ref)).toEqual(["from-b"]);
  });

  it("while a facilitator's ref'd commands run, a connected player receives no ack and no ref", async () => {
    const { port } = await setup();
    const p = await joinPlayer(port);
    const fac = await started(port);
    fac.send({ type: "command", ref: "secret-ref", command: { command: "pause" } });
    await fac.next(isAck("secret-ref"));
    fac.send({ type: "command", ref: "secret-ref-3", command: { command: "resume" } }); // a paused session refuses the player's marker line
    await fac.next(isAck("secret-ref-3"));
    fac.send({ type: "command", ref: "secret-ref-2", expectSceneId: "nope", command: { command: "advance" } });
    await fac.next((m) => isErr(m) && m.ref === "secret-ref-2");
    p.send({ type: "say", text: "marker line" });
    await p.next((m) => m.type === "event" && m.event.type === "utterance" && m.event.text === "marker line");
    expect(p.inbox.some((m) => m.type === "ack")).toBe(false);
    expect(p.text()).not.toContain("secret-ref");
  });

  it("a player's command with a ref is forbidden (only its own ref comes back)", async () => {
    const { port, engine } = await setup();
    const p = await joinPlayer(port);
    const fac = await started(port);
    p.send({ type: "command", ref: "mine", command: { command: "pause" } });
    expect(await p.next(isErr)).toMatchObject({ code: "forbidden", ref: "mine" });
    p.send({ type: "end_now", ref: "mine-2" });
    expect(await p.next((m) => isErr(m) && m.ref === "mine-2")).toMatchObject({ code: "forbidden" });
    expect(engine.state.status).toBe("running");
    expect(fac.inbox.some((m) => m.type === "event" && m.event.type === "facilitator.command")).toBe(false);
  });

  it("end_now with ref: scene.exited, the alert and session.ended reach the sender before the ack", async () => {
    const { port } = await setup();
    const fac = await started(port);
    fac.send({ type: "end_now", ref: "r-last", by: "Sam" });
    await fac.next(isAck("r-last"));
    const ack = idx(fac, isAck("r-last"));
    const exited = evIdx(fac, "scene.exited");
    const alert = evIdx(fac, "facilitator.alert");
    const ended = evIdx(fac, "session.ended");
    expect(exited).toBeGreaterThan(-1);
    expect(exited).toBeLessThan(alert);
    expect(alert).toBeLessThan(ended);
    expect(ended).toBeLessThan(ack);
  });
});
