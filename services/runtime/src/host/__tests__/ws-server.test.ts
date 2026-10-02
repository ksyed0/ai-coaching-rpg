import { describe, expect, it, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadScenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
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
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  const next = (pred: (m: any) => boolean, ms = 2000) => new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    const check = () => { const m = inbox.find(pred); if (m) { clearTimeout(t); resolve(m); } else setTimeout(check, 10); };
    check();
  });
  return { ws, inbox, next, send: (m: unknown) => ws.send(JSON.stringify(m)), sendRaw: (m: string) => ws.send(m), ready: new Promise<void>((r) => ws.on("open", () => r())) };
}

async function setup(npcReplies: string[] = ["Hi!"]) {
  const scenario = await loadScenario(fixture);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock: new FakeClock(0) });
  const npc = new MockModelProvider(npcReplies);
  const host = new SessionHost({ scenario, engine, npcProvider: npc, gmProvider: new MockModelProvider(), clock: new FakeClock(0) });
  server = await startServer({ port: 0, hosts: new Map([["local", host]]) });
  return { engine, host, npc, port: server.port };
}

async function joinFac(port: number) {
  const fac = open(port); await fac.ready;
  fac.send({ type: "join_facilitator", sessionId: "local" });
  await fac.next((m) => m.type === "joined" && m.roleId === "facilitator");
  return fac;
}
async function joinPlayer(port: number, participantId = "p1") {
  const p = open(port); await p.ready;
  p.send({ type: "join", sessionId: "local", roleId: "host", participantId });
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
    const closed = new Promise<number>((r) => c.ws.on("close", (code) => r(code)));
    c.sendRaw("x".repeat(70 * 1024));
    expect(await closed).toBe(1009);
    const fac = await joinFac(port);
    expect(fac.inbox[0].type).toBe("joined");
  });

  it("R22d: closing a player connection frees the role for the same participant, a different one gets role_taken until then", async () => {
    const { port, host } = await setup();
    const { p } = await joinPlayer(port, "p1");
    const { joined: other } = await joinPlayer(port, "p2");
    expect(other.code).toBe("role_taken");
    const closed = new Promise<void>((r) => p.ws.on("close", () => r()));
    p.ws.close(); await closed;
    for (let i = 0; i < 100 && host.assignments.host; i++) await new Promise((r) => setTimeout(r, 10));
    expect(host.assignments).toEqual({});
    const { joined: again } = await joinPlayer(port, "p1");
    expect(again.type).toBe("joined");
  });

  it("R22d: a stale connection closing after a rejoin does not free the new connection's role", async () => {
    const { port, host } = await setup();
    const { p: old } = await joinPlayer(port, "p1");
    const { p: fresh } = await joinPlayer(port, "p1");
    expect(fresh.inbox[0].type).toBe("joined");
    old.ws.terminate();
    await new Promise((r) => setTimeout(r, 50));
    expect(host.assignments).toEqual({ host: "p1" });
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
});
