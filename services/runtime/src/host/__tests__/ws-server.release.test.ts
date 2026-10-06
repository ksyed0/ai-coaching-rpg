import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadScenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { SessionHost } from "../session-host.js";
import { startServer } from "../ws-server.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const FACT = "Sam is leaving the company next month";
const TOKEN = "correct-horse-battery-staple-0123456789";
let server: Awaited<ReturnType<typeof startServer>> | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = [];
  await server?.close(); server = null;
});

type Client = { inbox: any[]; next(pred: (m: any) => boolean, ms?: number): Promise<any>; send(m: unknown): void; text(): string };
async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  await new Promise<void>((r) => ws.once("open", () => r()));
  const next = (pred: (m: any) => boolean, ms = 2000) => new Promise<any>((resolve, reject) => {
    const found = inbox.find(pred);
    if (found) return resolve(found);
    const w = { pred, resolve };
    waiters.push(w);
    setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error("timeout")); } }, ms);
  });
  return { inbox, next, send: (m) => ws.send(JSON.stringify(m)), text: () => JSON.stringify(inbox) };
}

async function setup(facilitatorToken?: string) {
  const scenario = await loadScenario(fixture);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock: new FakeClock(0) });
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock: new FakeClock(0) });
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), log: () => {}, ...(facilitatorToken ? { facilitatorToken } : {}) });
  return { engine, host, port: server.port };
}
const joinFac = async (port: number, token?: string) => {
  const c = await open(port);
  c.send({ type: "join_facilitator", sessionId: "local", ...(token ? { token } : {}) });
  const joined = await c.next((m) => m.type === "joined" || m.type === "error");
  return { c, joined };
};
const joinPlayer = async (port: number) => {
  const c = await open(port);
  c.send({ type: "join", sessionId: "local", roleId: "host", participantId: "p1" });
  const joined = await c.next((m) => m.type === "joined" || m.type === "error");
  return { c, joined };
};

describe("release_hidden over the WebSocket server (US-0016)", () => {
  it("the facilitator's joined message lists the hidden facts, a player's never does", async () => {
    const { port } = await setup();
    const { joined: fj } = await joinFac(port);
    expect(fj.hiddenFacts).toEqual({ guest: [FACT] });
    const { c: player, joined: pj } = await joinPlayer(port);
    expect(pj.type).toBe("joined");
    expect(pj.hiddenFacts).toBeUndefined();
    expect(JSON.stringify(pj)).not.toContain(FACT);
    expect(player.text()).not.toContain(FACT);
  });

  it("a refused facilitator join (wrong token) gets no hidden facts", async () => {
    const { port } = await setup(TOKEN);
    const bad = await open(port);
    bad.send({ type: "join_facilitator", sessionId: "local", token: "wrong-wrong-wrong-wrong-wrong" });
    await bad.next((m) => m.type === "error");
    expect(bad.text()).not.toContain(FACT);
    expect(bad.text()).not.toContain("hiddenFacts");
    const { joined } = await joinFac(port, TOKEN);
    expect(joined.hiddenFacts).toEqual({ guest: [FACT] });
  });

  it("releases a fact: the facilitator sees the command and the text, the player sees neither, then and on rejoin", async () => {
    const { port, engine } = await setup();
    const { c: fac } = await joinFac(port);
    const { c: player } = await joinPlayer(port);
    fac.send({ type: "start" });
    await player.next((m) => m.type === "event" && m.event.type === "scene.entered");
    fac.send({ type: "command", command: { command: "release_hidden", roleId: "guest", fact: 1 } });
    const upd = await fac.next((m) => m.type === "event" && m.event.type === "npc.updated" && (m.event.released ?? []).length === 1);
    expect(upd.event.released).toEqual([FACT]);
    const cmd = fac.inbox.find((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "release_hidden");
    expect(cmd.event).toMatchObject({ roleId: "guest", fact: 1 });
    expect(JSON.stringify(cmd)).not.toContain(FACT);
    // the player gets a later event, so the stream has been delivered up to there
    player.send({ type: "say", text: "marker line" });
    await player.next((m) => m.type === "event" && m.event.type === "utterance" && m.event.text === "marker line");
    expect(player.text()).not.toContain(FACT);
    expect(player.text()).not.toContain("release_hidden");
    expect(engine.state.npcs.guest!.released).toEqual([FACT]);
    // a facilitator that reconnects sees the released state in its snapshot (a player snapshot never holds NPC state: see the viewFor test)
    const { joined: fj2 } = await joinFac(port);
    expect(fj2.state.npcs.guest.released).toEqual([FACT]);
  });

  it("a player may not release, and a bad or repeated release is refused without a change", async () => {
    const { port, engine } = await setup();
    const { c: fac } = await joinFac(port);
    const { c: player } = await joinPlayer(port);
    fac.send({ type: "start" });
    await player.next((m) => m.type === "event" && m.event.type === "scene.entered");
    player.send({ type: "command", command: { command: "release_hidden", roleId: "guest", fact: 1 } });
    expect((await player.next((m) => m.type === "error")).code).toBe("forbidden");
    expect(engine.state.npcs.guest!.released).toEqual([]);
    for (const [fact, code] of [[0, "bad_message"], [51, "bad_message"], ["1", "bad_message"], [1.5, "bad_message"], [2, "unknown_fact"]] as const) {
      fac.inbox.length = 0;
      fac.send({ type: "command", command: { command: "release_hidden", roleId: "guest", fact } });
      expect((await fac.next((m) => m.type === "error")).code).toBe(code);
    }
    fac.inbox.length = 0;
    fac.send({ type: "command", command: { command: "release_hidden", roleId: "host", fact: 1 } });
    expect((await fac.next((m) => m.type === "error")).code).toBe("npc_role");
    fac.inbox.length = 0;
    fac.send({ type: "command", command: { command: "release_hidden", roleId: "__proto__", fact: 1 } });
    expect((await fac.next((m) => m.type === "error")).code).toBe("unknown_role");
    fac.inbox.length = 0;
    fac.send({ type: "command", command: { command: "release_hidden", roleId: "guest", fact: 1 } });
    await fac.next((m) => m.type === "event" && m.event.type === "npc.updated" && (m.event.released ?? []).length === 1);
    fac.inbox.length = 0;
    fac.send({ type: "command", command: { command: "release_hidden", roleId: "guest", fact: 1 } });
    expect((await fac.next((m) => m.type === "error")).code).toBe("already_released");
    expect(engine.state.npcs.guest!.released).toEqual([FACT]);
  });

  it("viewFor denies a player both events of a release (default-deny)", async () => {
    const { host, engine } = await setup();
    await engine.start({ host: "p1" });
    const cmd = { seq: 99, ts: 0, sessionId: "s", type: "facilitator.command", command: "release_hidden", roleId: "guest", fact: 1 } as SessionEvent;
    const upd = { seq: 100, ts: 0, sessionId: "s", type: "npc.updated", roleId: "guest", goals: [], knowledge: [], released: [FACT] } as SessionEvent;
    expect(host.viewFor("host", cmd)).toBeNull();
    expect(host.viewFor("host", upd)).toBeNull();
    expect(host.viewFor("facilitator", cmd)).toBe(cmd);
    expect(host.viewFor("facilitator", upd)).toBe(upd);
    expect(host.filterFor("host")(upd)).toBe(false);
    await engine.command({ command: "release_hidden", roleId: "guest", fact: 1 });
    expect(JSON.stringify(host.snapshotFor("host"))).not.toContain(FACT);
    expect(JSON.stringify(host.snapshotFor("facilitator"))).toContain(FACT);
  });
});
