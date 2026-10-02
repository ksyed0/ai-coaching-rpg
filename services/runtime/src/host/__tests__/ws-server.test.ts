import { describe, expect, it, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadScenario } from "@acr/script";
import { MockModelProvider, type ChatRequest, type ModelProvider } from "@acr/adapters";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { SessionHost } from "../session-host.js";
import { startServer } from "../ws-server.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
let server: Awaited<ReturnType<typeof startServer>> | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = [];
  await server?.close(); server = null;
});

function open(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const next = (pred: (m: any) => boolean, ms = 2000) => new Promise<any>((resolve, reject) => {
    const found = inbox.find(pred);
    if (found) return resolve(found);
    const w = { pred, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error("timeout")); }, ms) };
    waiters.push(w);
  });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  return { ws, inbox, next, closed, send: (m: unknown) => ws.send(JSON.stringify(m)), sendRaw: (m: string) => ws.send(m), ready: new Promise<void>((r) => ws.on("open", () => r())) };
}

const logWaiters: { re: RegExp; resolve: () => void }[] = [];
const serverLog = (m: string) => { for (const w of [...logWaiters]) if (w.re.test(m)) { logWaiters.splice(logWaiters.indexOf(w), 1); w.resolve(); } };
const waitLog = (re: RegExp) => new Promise<void>((resolve) => { logWaiters.push({ re, resolve }); });

async function setup(npcReplies: string[] = ["Hi!"], dir = fixture, npcProvider?: ModelProvider) {
  const scenario = await loadScenario(dir);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock: new FakeClock(0) });
  const npc = new MockModelProvider(npcReplies);
  const host = new SessionHost({ scenario, engine, npcProvider: npcProvider ?? npc, gmProvider: new MockModelProvider(), clock: new FakeClock(0) });
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), log: serverLog });
  return { engine, host, npc, port: server.port };
}

async function joinFac(port: number) {
  const fac = open(port); await fac.ready;
  fac.send({ type: "join_facilitator", sessionId: "local" });
  await fac.next((m) => m.type === "joined" && m.roleId === "facilitator");
  return fac;
}
async function joinPlayer(port: number, participantId = "p1", extra: Record<string, unknown> = {}, roleId = "host") {
  const p = open(port); await p.ready;
  p.send({ type: "join", sessionId: "local", roleId, participantId, ...extra });
  const joined = await p.next((m) => m.type === "joined" || m.type === "error");
  return { p, joined };
}

describe("ws-server", () => {
  it("joins, speaks, and streams events to both the player and the facilitator", async () => {
    const { port } = await setup();
    const fac = await joinFac(port);
    const { p: player, joined } = await joinPlayer(port);
    expect(joined.brief).toMatch(/hosting/);

    fac.send({ type: "start" });
    await player.next((m) => m.type === "event" && m.event.type === "scene.entered");
    player.send({ type: "say", text: "Hello Sam" });
    const reply = await player.next((m) => m.type === "event" && m.event.type === "utterance" && m.event.roleId === "guest");
    expect(reply.event.text).toBe("Hi!");
    await fac.next((m) => m.type === "event" && m.event.type === "utterance" && m.event.roleId === "guest");

    const dup = open(port); await dup.ready;
    dup.send({ type: "join", sessionId: "local", roleId: "host", participantId: "p2" });
    const err = await dup.next((m) => m.type === "error");
    expect(err.code).toBe("role_taken");
  });

  it("exposes the ephemeral port", async () => {
    const { port } = await setup();
    expect(port).toBeGreaterThan(0);
  });

  it("R22a: takes the role from the connection binding, never from a message field", async () => {
    const { port, engine } = await setup();
    const fac = await joinFac(port);
    const { p } = await joinPlayer(port);
    fac.send({ type: "start" });
    await p.next((m) => m.type === "event" && m.event.type === "scene.entered");
    p.send({ type: "say", text: "I am host", roleId: "guest" });
    await p.next((m) => m.type === "event" && m.event.type === "utterance" && m.event.roleId === "host");
    expect(engine.state.transcript[0]).toMatchObject({ roleId: "host", text: "I am host" });
    expect(engine.state.transcript.filter((u) => u.text === "I am host")).toHaveLength(1);
  });

  it("R22b: only the facilitator may start or send commands", async () => {
    const { port, engine } = await setup();
    const { p } = await joinPlayer(port);
    p.send({ type: "start" });
    expect((await p.next((m) => m.type === "error")).code).toBe("forbidden");
    expect(engine.state.status).toBe("idle");
    const fac = await joinFac(port);
    fac.send({ type: "start" });
    await p.next((m) => m.type === "event" && m.event.type === "scene.entered");
    p.send({ type: "command", command: { command: "pause" } });
    await p.next((m) => m.type === "error" && m.code === "forbidden");
    expect(engine.state.paused).toBe(false);
  });

  it("R22b: a connection that has not joined cannot do anything", async () => {
    const { port, engine } = await setup();
    const c = open(port); await c.ready;
    c.send({ type: "start" });
    expect((await c.next((m) => m.type === "error")).code).toBe("not_joined");
    expect(engine.state.status).toBe("idle");
  });

  it("R22c: malformed JSON, wrong shapes, unknown types and long text give error messages and the server survives", async () => {
    const { port } = await setup();
    const c = open(port); await c.ready;
    c.sendRaw("{not json");
    expect((await c.next((m) => m.type === "error" && m.code === "bad_json")).message).not.toMatch(/at |\.ts/);
    c.send({ type: "nope" });
    c.send({ type: "say" });
    c.send(42);
    await c.next(() => c.inbox.filter((m) => m.code === "bad_message").length >= 3);
    const { p } = await joinPlayer(port);
    const fac = await joinFac(port);
    fac.send({ type: "start" });
    await p.next((m) => m.type === "event" && m.event.type === "scene.entered");
    p.send({ type: "say", text: "x".repeat(2001) });
    expect((await p.next((m) => m.type === "error")).code).toBe("bad_message");
    // still serving
    p.send({ type: "say", text: "still alive" });
    await p.next((m) => m.type === "event" && m.event.type === "utterance" && m.event.text === "still alive");
  });

  it("R22c: an oversize frame closes that connection without crashing the server", async () => {
    const { port } = await setup();
    const c = open(port); await c.ready;
    c.sendRaw("x".repeat(70 * 1024));
    expect(await c.closed).toBe(1009);
    const fac = await joinFac(port);
    expect(fac.inbox[0].type).toBe("joined");
  });

  it("R22d: after the holder closes the role is freed: same participant rejoins; a different one is refused until then", async () => {
    const { port, host } = await setup();
    const { p } = await joinPlayer(port, "p1");
    const { joined: other } = await joinPlayer(port, "p2");
    expect(other.code).toBe("role_taken");
    const released = waitLog(/released host/);
    p.ws.close(); await p.closed; await released;
    expect(host.assignments).toEqual({});
    const { joined: again } = await joinPlayer(port, "p1");
    expect(again.type).toBe("joined");
  });

  it("C1: a second socket with the same participantId while the first is OPEN is refused and the first keeps receiving events", async () => {
    const { port } = await setup();
    const fac = await joinFac(port);
    const { p: first, joined } = await joinPlayer(port, "p1");
    expect(joined.reconnectToken).toEqual(expect.any(String));
    const { p: thief, joined: refused } = await joinPlayer(port, "p1");
    expect(refused).toMatchObject({ type: "error", code: "role_taken" });
    fac.send({ type: "command", command: { command: "whisper", roleId: "host", text: "FOR-HOST-1" } });
    await first.next((m) => m.type === "event" && m.event.text === "FOR-HOST-1");
    expect(JSON.stringify(thief.inbox)).not.toMatch(/FOR-HOST-1|hosting/);
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("C1: a wrong reconnectToken is refused (role_taken)", async () => {
    const { port } = await setup();
    await joinPlayer(port, "p1");
    const { joined } = await joinPlayer(port, "p1", { reconnectToken: "not-the-token" });
    expect(joined).toMatchObject({ type: "error", code: "role_taken" });
  });

  it("C1: the right reconnectToken takes over: old socket closed, only the new one gets private events, and it gets a fresh token", async () => {
    const { port } = await setup();
    const fac = await joinFac(port);
    const { p: old, joined } = await joinPlayer(port, "p1");
    const { p: fresh, joined: rejoined } = await joinPlayer(port, "p1", { reconnectToken: joined.reconnectToken });
    expect(rejoined.type).toBe("joined");
    expect(rejoined.brief).toMatch(/hosting/);
    expect(rejoined.reconnectToken).not.toBe(joined.reconnectToken);
    await old.closed;
    fac.send({ type: "command", command: { command: "whisper", roleId: "host", text: "FOR-HOST-2" } });
    await fresh.next((m) => m.type === "event" && m.event.text === "FOR-HOST-2");
    expect(JSON.stringify(old.inbox)).not.toMatch(/FOR-HOST-2/);
    // the old token is dead now
    const { joined: replay } = await joinPlayer(port, "p1", { reconnectToken: joined.reconnectToken });
    expect(replay).toMatchObject({ type: "error", code: "role_taken" });
  });

  it("C1: the token only works with the matching participantId", async () => {
    const { port } = await setup();
    const { joined } = await joinPlayer(port, "p1");
    const { joined: other } = await joinPlayer(port, "p2", { reconnectToken: joined.reconnectToken });
    expect(other).toMatchObject({ type: "error", code: "role_taken" });
  });

  it("C2: a player's whole inbox never contains any participant id (own or another's)", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "acr-ws-"));
    try {
      const dir = path.join(tmp, "scn");
      await cp(fixture, dir, { recursive: true });
      await writeFile(path.join(dir, "roles", "analyst.yaml"), "id: analyst\ntype: player\nbrief: You analyse.\nprivate_facts:\n  - Numbers are shaky\n");
      const { port } = await setup(["Hi!"], dir);
      const fac = await joinFac(port);
      const { p: host, joined } = await joinPlayer(port, "Zelda-Quill");
      const { p: analyst } = await joinPlayer(port, "Mortimer-Vance", {}, "analyst");
      await analyst.next((m) => m.type === "joined");
      expect(joined.state.roles).toEqual({}); // not started yet: nothing to leak
      fac.send({ type: "start" });
      const started = await host.next((m) => m.type === "event" && m.event.type === "session.started");
      expect(started.event.roles.analyst).toEqual({ kind: "player" });
      const facStarted = await fac.next((m) => m.type === "event" && m.event.type === "session.started");
      expect(facStarted.event.roles.analyst.participantId).toBe("Mortimer-Vance"); // facilitator still sees everything
      expect(started.event.roles).toEqual({ host: { kind: "player" }, analyst: { kind: "player" }, guest: { kind: "npc" } });
      fac.send({ type: "command", command: { command: "whisper", roleId: "host", text: "sync-point" } });
      await host.next((m) => m.type === "event" && m.event.text === "sync-point");
      expect(JSON.stringify(host.inbox)).not.toMatch(/Mortimer-Vance|Zelda-Quill/);
      expect(JSON.stringify(analyst.inbox)).not.toMatch(/Mortimer-Vance|Zelda-Quill/);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });

  it("I2: a player say while the session is idle gets not_started and does not start it", async () => {
    const { port, engine } = await setup();
    const { p } = await joinPlayer(port);
    p.send({ type: "say", text: "anyone?" });
    expect((await p.next((m) => m.type === "error")).code).toBe("not_started");
    expect(engine.state.status).toBe("idle");
  });

  it("I3: a facilitator pause is applied while an NPC round is still in flight (not queued behind it)", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let inFlight!: () => void; const flying = new Promise<void>((r) => { inFlight = r; });
    const slow: ModelProvider = { name: "slow", async *stream(_r: ChatRequest) { inFlight(); await gate; yield "late"; } };
    const { port, engine } = await setup(["x"], fixture, slow);
    const fac = await joinFac(port);
    const { p } = await joinPlayer(port);
    fac.send({ type: "start" });
    await p.next((m) => m.type === "event" && m.event.type === "scene.entered");
    p.send({ type: "say", text: "Hello" });
    await flying;
    fac.send({ type: "command", command: { command: "advance" } });
    fac.send({ type: "command", command: { command: "pause" } });
    await p.next((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "pause");
    expect(engine.state.paused).toBe(true);
    release();
  });

  it("R22e: a dead or closing client never breaks broadcast to the others", async () => {
    const { port } = await setup();
    const fac = await joinFac(port);
    const { p: dead } = await joinPlayer(port, "p1");
    const fac2 = await joinFac(port);
    dead.ws.terminate();
    fac.send({ type: "start" });
    await fac.next((m) => m.type === "event" && m.event.type === "scene.entered");
    await fac2.next((m) => m.type === "event" && m.event.type === "scene.entered");
  });

  it("R22f: a player never receives another role's whisper, a private inject or NPC internals; joined carries only their own brief", async () => {
    const { port } = await setup();
    const fac = await joinFac(port);
    const { p, joined } = await joinPlayer(port);
    expect(joined.brief).toMatch(/hosting/);
    expect(joined.privateFacts).toEqual(["You have five minutes"]);
    expect(JSON.stringify(joined.state)).not.toMatch(/Be welcomed|check-in|leaving the company/);
    fac.send({ type: "start" });
    await p.next((m) => m.type === "event" && m.event.type === "scene.entered");
    fac.send({ type: "command", command: { command: "whisper", roleId: "guest", text: "PRIVATE-WHISPER" } });
    fac.send({ type: "command", command: { command: "fire_inject", injectId: "late_inject" } });
    fac.send({ type: "command", command: { command: "set_npc_stance", roleId: "guest", goals: ["SECRET-GOAL"] } });
    fac.send({ type: "command", command: { command: "whisper", roleId: "host", text: "FOR-HOST" } });
    await p.next((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "whisper" && m.event.text === "FOR-HOST");
    await fac.next((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "whisper" && m.event.text === "FOR-HOST");
    const seen = JSON.stringify(p.inbox);
    expect(seen).not.toMatch(/PRIVATE-WHISPER|urgent email|SECRET-GOAL|Leave early/);
    // the facilitator saw all of it
    const facSeen = JSON.stringify(fac.inbox);
    expect(facSeen).toMatch(/PRIVATE-WHISPER/);
    expect(facSeen).toMatch(/urgent email/);
  });

  it("surfaces EngineError paused to the sender as an error with code paused", async () => {
    const { port, npc } = await setup();
    const fac = await joinFac(port);
    const { p } = await joinPlayer(port);
    fac.send({ type: "start" });
    await p.next((m) => m.type === "event" && m.event.type === "scene.entered");
    fac.send({ type: "command", command: { command: "pause" } });
    await p.next((m) => m.type === "event" && m.event.type === "facilitator.command");
    p.send({ type: "say", text: "hello?" });
    expect((await p.next((m) => m.type === "error")).code).toBe("paused");
    expect(npc.calls).toHaveLength(0);
  });

  it("rejects an unknown session and a second join on the same connection", async () => {
    const { port } = await setup();
    const c = open(port); await c.ready;
    c.send({ type: "join_facilitator", sessionId: "nope" });
    expect((await c.next((m) => m.type === "error")).code).toBe("unknown_session");
    const { p } = await joinPlayer(port);
    p.send({ type: "join", sessionId: "local", roleId: "host", participantId: "p1" });
    expect((await p.next((m) => m.type === "error")).code).toBe("already_joined");
  });

  it("log_not_empty reaches the client as an error message without any filesystem path", async () => {
    const scenario = await loadScenario(fixture);
    const log = new MemoryEventLog("local");
    await log.append({ type: "facilitator.alert", level: "info", message: "old run" }, 0);
    const engine = new SessionEngine({ scenario, log, clock: new FakeClock(0) });
    const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(), gmProvider: new MockModelProvider(), clock: new FakeClock(0) });
    server = await startServer({ port: 0, hosts: new Map([["local", host]]), log: serverLog });
    const fac = await joinFac(server.port);
    fac.send({ type: "start" });
    const err = await fac.next((m) => m.type === "error");
    expect(err.code).toBe("log_not_empty");
    expect(err.message).not.toMatch(/[\\/]/);
    expect(err.message).not.toMatch(/\.jsonl/);
  });
});
