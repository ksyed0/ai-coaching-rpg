import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadScenario } from "@acr/script";
import { MockModelProvider, type ChatRequest, type ModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { SessionHost } from "../session-host.js";
import { startServer } from "../ws-server.js";
// Real sockets: a generous explicit limit. Nothing here measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
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

async function setup(npc: ModelProvider = new MockModelProvider(["Hi!"]), log = new MemoryEventLog("local")) {
  const scenario = await loadScenario(fixture);
  const engine = new SessionEngine({ scenario, log, clock: new FakeClock(0) });
  const host = new SessionHost({ scenario, engine, npcProvider: npc, gmProvider: new MockModelProvider(), clock: new FakeClock(0) });
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
const evTypes = (c: Client): string[] => c.inbox.filter((m) => m.type === "event").map((m) => m.event.type);
const errorOf = (c: Client) => c.next((m) => m.type === "error");

describe("end_now over the WebSocket server (US-0059)", () => {
  it("in the lobby end_now is not_started, nothing is appended and the session does not start", async () => {
    const { port, engine, log } = await setup();
    const fac = await joinFac(port);
    fac.send({ type: "end_now", message: "bye" });
    expect((await errorOf(fac)).code).toBe("not_started");
    expect(engine.state.status).toBe("idle");
    expect(await log.all()).toHaveLength(0);
  });

  it("a player's end_now is forbidden", async () => {
    const { port, engine } = await setup();
    const fac = await joinFac(port);
    const p = await joinPlayer(port);
    fac.send({ type: "start" });
    await p.next((m) => m.type === "event" && m.event.type === "scene.entered");
    p.send({ type: "end_now" });
    expect((await errorOf(p)).code).toBe("forbidden");
    expect(engine.state.status).toBe("running");
  });

  it("during an interrupted start end_now is starting and nothing is appended", async () => {
    const log = new MemoryEventLog("local");
    const real = log.append.bind(log);
    let n = 0;
    log.append = (body, ts) => { n++; return n === 2 ? Promise.reject(Object.assign(new Error("closed"), { code: "closed" })) : real(body, ts); };
    const { port, engine } = await setup(undefined, log);
    const fac = await joinFac(port);
    fac.send({ type: "start" });
    await errorOf(fac);
    expect(engine.startIncomplete).toBe(true);
    const before = (await log.all()).length;
    fac.send({ type: "end_now" });
    await vi.waitFor(() => expect(fac.inbox.filter((m) => m.type === "error").map((m) => m.code)).toContain("starting"));
    expect(await log.all()).toHaveLength(before);
  });

  it('running: end_now with by "Sam" and message "Thanks, <b>all</b>" shows players session.ended with that exact message and no alert or name; the facilitator gets scene.exited, the alert naming Sam, then session.ended', async () => {
    const { port } = await setup();
    const fac = await joinFac(port);
    const p = await joinPlayer(port);
    fac.send({ type: "start" });
    await p.next((m) => m.type === "event" && m.event.type === "scene.entered");
    fac.send({ type: "end_now", by: "Sam", message: "Thanks, <b>all</b>" });
    const pEnded = await p.next((m) => m.type === "event" && m.event.type === "session.ended");
    await fac.next((m) => m.type === "event" && m.event.type === "session.ended");
    expect(pEnded.event.message).toBe("Thanks, <b>all</b>");
    expect(pEnded.event.reason).toBe("facilitator_end");
    expect(Object.keys(pEnded.event).sort()).toEqual(["message", "reason", "seq", "sessionId", "ts", "type"]);
    expect(evTypes(p).at(-1)).toBe("session.ended");
    expect(p.inbox.some((m) => m.type === "event" && (m.event.type === "facilitator.alert" || m.event.type === "facilitator.command"))).toBe(false);
    expect(p.text()).not.toContain("Sam");
    const tail = evTypes(fac).slice(-3);
    expect(tail).toEqual(["scene.exited", "facilitator.alert", "session.ended"]);
    const alert = fac.inbox.filter((m) => m.type === "event" && m.event.type === "facilitator.alert").at(-1);
    expect(alert.event.message).toContain("Sam");
  });

  it("a second end_now is ended", async () => {
    const { port, log } = await setup();
    const fac = await joinFac(port);
    fac.send({ type: "start" });
    await fac.next((m) => m.type === "event" && m.event.type === "scene.entered");
    fac.send({ type: "end_now" });
    await fac.next((m) => m.type === "event" && m.event.type === "session.ended");
    fac.send({ type: "end_now" });
    expect((await errorOf(fac)).code).toBe("ended");
    expect((await log.all()).filter((e) => e.type === "session.ended")).toHaveLength(1);
  });

  it("a 301-code-point message is bad_message and nothing is appended; 300 code points is accepted", async () => {
    const { port, engine, log } = await setup();
    const fac = await joinFac(port);
    fac.send({ type: "start" });
    await fac.next((m) => m.type === "event" && m.event.type === "scene.entered");
    const before = (await log.all()).length;
    fac.send({ type: "end_now", message: "\u{1F600}".repeat(301) });
    expect((await errorOf(fac)).code).toBe("bad_message");
    expect(await log.all()).toHaveLength(before);
    expect(engine.state.status).toBe("running");
    fac.send({ type: "end_now", message: "x".repeat(300) });
    const ended = await fac.next((m) => m.type === "event" && m.event.type === "session.ended");
    expect(ended.event.message).toBe("x".repeat(300));
  });

  it("bidirectional and control characters inside a closing message are stripped before players see it", async () => {
    const { port } = await setup();
    const fac = await joinFac(port);
    const p = await joinPlayer(port);
    fac.send({ type: "start" });
    await p.next((m) => m.type === "event" && m.event.type === "scene.entered");
    fac.send({ type: "end_now", message: "Thanks\u202E\u0007 all" });
    const e = await p.next((m) => m.type === "event" && m.event.type === "session.ended");
    expect(e.event.message).toBe("Thanks all");
  });

  it("a whitespace-only message gives session.ended without message", async () => {
    const { port } = await setup();
    const fac = await joinFac(port);
    const p = await joinPlayer(port);
    fac.send({ type: "start" });
    await p.next((m) => m.type === "event" && m.event.type === "scene.entered");
    fac.send({ type: "end_now", message: "  \n\t " });
    const e = await p.next((m) => m.type === "event" && m.event.type === "session.ended");
    expect(Object.hasOwn(e.event, "message")).toBe(false);
  });

  it("an NPC reply in flight when end_now lands appends nothing after session.ended", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let inFlight!: () => void; const flying = new Promise<void>((r) => { inFlight = r; });
    const slow: ModelProvider = { name: "slow", async *stream(_r: ChatRequest) { inFlight(); await gate; yield "late reply"; } };
    const { port, host, log } = await setup(slow);
    const fac = await joinFac(port);
    const p = await joinPlayer(port);
    fac.send({ type: "start" });
    await p.next((m) => m.type === "event" && m.event.type === "scene.entered");
    p.send({ type: "say", text: "Hello" });
    await flying;
    fac.send({ type: "end_now" });
    await fac.next((m) => m.type === "event" && m.event.type === "session.ended");
    release();
    await host.idle();
    const all = await log.all();
    expect(all.at(-1)!.type).toBe("session.ended");
    expect(all.filter((e) => e.type === "session.ended")).toHaveLength(1);
    expect(JSON.stringify(all)).not.toContain("late reply");
  });

  it("the ticker is stopped after end_now", async () => {
    const { port, host } = await setup();
    const fac = await joinFac(port);
    fac.send({ type: "start" });
    await fac.next((m) => m.type === "event" && m.event.type === "scene.entered");
    host.startTicker(3_600_000);
    expect((host as unknown as { ticker: unknown }).ticker).not.toBeNull();
    fac.send({ type: "end_now" });
    await fac.next((m) => m.type === "event" && m.event.type === "session.ended");
    await vi.waitFor(() => expect((host as unknown as { ticker: unknown }).ticker).toBeNull());
  });

  it("end_now with a start still running is starting and appends nothing; the start then finishes", async () => {
    const log = new MemoryEventLog("local");
    const real = log.append.bind(log);
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void; const holding = new Promise<void>((r) => { held = r; });
    let n = 0;
    log.append = async (body, ts) => { n++; if (n === 2) { held(); await gate; } return real(body, ts); };
    const { port, engine } = await setup(undefined, log);
    const fac = await joinFac(port);
    const fac2 = await joinFac(port); // a second connection: one connection handles its messages in order
    fac.send({ type: "start" });
    await holding;
    const before = (await log.all()).length;
    fac2.send({ type: "end_now" });
    expect((await errorOf(fac2)).code).toBe("starting");
    expect(await log.all()).toHaveLength(before);
    release();
    await vi.waitFor(() => expect(engine.state.status).toBe("running"));
    await fac.next((m) => m.type === "event" && m.event.type === "scene.entered");
    expect((await log.all()).some((e) => e.type === "session.ended")).toBe(false);
  });

  const wire: [string, Record<string, unknown>][] = [
    ["by of 201 units", { by: "b".repeat(201) }],
    ["message of 1201 units", { message: "m".repeat(1201) }],
    ["message: 5", { message: 5 }],
    ["by: null", { by: null }],
  ];
  for (const [label, extra] of wire) {
    it(`end_now with ${label} is bad_message and nothing is appended`, async () => {
      const { port, engine, log } = await setup();
      const fac = await joinFac(port);
      fac.send({ type: "start" });
      await fac.next((m) => m.type === "event" && m.event.type === "scene.entered");
      const before = (await log.all()).length;
      fac.send({ type: "end_now", ...extra });
      expect((await errorOf(fac)).code).toBe("bad_message");
      expect(await log.all()).toHaveLength(before);
      expect(engine.state.status).toBe("running");
    });
  }
});
