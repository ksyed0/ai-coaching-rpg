import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadScenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { SessionHost } from "../session-host.js";
import { startServer, MAX_PAYLOAD_BYTES } from "../ws-server.js";
import type { Limits } from "../security.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const TOKEN = "correct-horse-battery-staple-0123456789";
let server: Awaited<ReturnType<typeof startServer>> | null = null;
let sockets: WebSocket[] = [];
let logs: string[] = [];
afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = []; logs = [];
  await server?.close(); server = null;
});

type Client = { ws: WebSocket; inbox: any[]; closed: Promise<number>; send(m: unknown): void; next(pred: (m: any) => boolean, ms?: number): Promise<any> };
function open(port: number, headers: Record<string, string> = {}): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  const next = (pred: (m: any) => boolean, ms = 2000) => new Promise<any>((resolve, reject) => {
    const found = inbox.find(pred);
    if (found) return resolve(found);
    const w = { pred, resolve };
    waiters.push(w);
    setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error("timeout")); } }, ms);
  });
  return { ws, inbox, closed, next, send: (m) => ws.send(JSON.stringify(m)) };
}
const opened = (c: Client) => new Promise<void>((resolve, reject) => { c.ws.once("open", () => resolve()); c.ws.once("error", reject); });

/** Resolves with the HTTP status of a handshake: 101 when it upgrades, otherwise the refusal status. */
function handshake(port: number, headers: Record<string, string> = {}): Promise<{ status: number; ws?: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    sockets.push(ws);
    ws.on("error", () => {});
    ws.on("unexpected-response", (_req, res) => { resolve({ status: res.statusCode ?? 0 }); res.resume(); });
    ws.on("open", () => resolve({ status: 101, ws }));
  });
}

async function setup(o: { token?: string; limits?: Partial<Limits>; allowedOrigins?: string[]; trustProxy?: boolean; now?: () => number; host?: SessionHost } = {}) {
  const scenario = await loadScenario(fixture);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock: new FakeClock(0) });
  const host = o.host ?? new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock: new FakeClock(0) });
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), log: (m) => logs.push(m), facilitatorToken: o.token, limits: o.limits, allowedOrigins: o.allowedOrigins, trustProxy: o.trustProxy, now: o.now });
  return { port: server.port, host };
}

describe("facilitator token (AC-0053)", () => {
  it("without a token configured the server stays open, as before", async () => {
    const { port } = await setup();
    const c = open(port); await opened(c);
    c.send({ type: "join_facilitator", sessionId: "local" });
    expect((await c.next((m) => m.type === "joined")).roleId).toBe("facilitator");
  });

  it("a configured token is required: missing, empty, wrong and nearly-right tokens get a generic unauthorized error and a closed connection", async () => {
    const { port } = await setup({ token: TOKEN });
    for (const attempt of [{}, { token: "" }, { token: "wrong-token-0123456789" }, { token: TOKEN.slice(0, -1) }, { token: TOKEN + "x" }, { token: TOKEN.toUpperCase() }]) {
      const c = open(port); await opened(c);
      c.send({ type: "join_facilitator", sessionId: "local", ...attempt });
      const err = await c.next((m) => m.type === "error");
      expect(err.code).toBe("unauthorized");
      expect(await c.closed).toBe(1008);
      expect(c.inbox.some((m) => m.type === "joined" || m.type === "event")).toBe(false);
    }
  });

  it("the right token joins and receives the facilitator stream; players need no token", async () => {
    const { port } = await setup({ token: TOKEN });
    const fac = open(port); await opened(fac);
    fac.send({ type: "join_facilitator", sessionId: "local", token: TOKEN });
    expect((await fac.next((m) => m.type === "joined")).roleId).toBe("facilitator");
    const p = open(port); await opened(p);
    p.send({ type: "join", sessionId: "local", roleId: "host", participantId: "p1" });
    expect((await p.next((m) => m.type === "joined" || m.type === "error")).type).toBe("joined");
  });

  it("an unauthorized attempt cannot tell whether the session exists", async () => {
    const { port } = await setup({ token: TOKEN });
    const c = open(port); await opened(c);
    c.send({ type: "join_facilitator", sessionId: "no-such-session", token: "nope-nope-nope-nope-nope" });
    expect((await c.next((m) => m.type === "error")).code).toBe("unauthorized");
  });

  it("a token over 256 characters is refused as a bad message without joining; a frame over the payload cap closes with 1009", async () => {
    const { port } = await setup({ token: TOKEN });
    const c = open(port); await opened(c);
    c.send({ type: "join_facilitator", sessionId: "local", token: "a".repeat(300) });
    const err = await c.next((m) => m.type === "error");
    expect(err.code).toBe("bad_message");
    expect(JSON.stringify(c.inbox)).not.toContain("aaaaaaaa");
    expect(c.inbox.some((m) => m.type === "joined")).toBe(false);
    const big = open(port); await opened(big);
    big.send({ type: "join_facilitator", sessionId: "local", token: "a".repeat(MAX_PAYLOAD_BYTES + 10) });
    expect(await big.closed).toBe(1009);
  });

  it("the token never appears in a log line, an error or any message sent to any client", async () => {
    const { port } = await setup({ token: TOKEN });
    const wrong = open(port); await opened(wrong);
    wrong.send({ type: "join_facilitator", sessionId: "local", token: TOKEN.slice(0, -1) + "!" });
    await wrong.closed;
    const fac = open(port); await opened(fac);
    fac.send({ type: "join_facilitator", sessionId: "local", token: TOKEN });
    await fac.next((m) => m.type === "joined");
    fac.send({ type: "command", command: { command: "pause" } });
    await fac.next((m) => m.type === "event");
    const everything = JSON.stringify([wrong.inbox, fac.inbox, logs]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(TOKEN.slice(0, 20));
  });

  it("a second facilitator connection also needs the token", async () => {
    const { port } = await setup({ token: TOKEN });
    const a = open(port); await opened(a);
    a.send({ type: "join_facilitator", sessionId: "local", token: TOKEN });
    await a.next((m) => m.type === "joined");
    const b = open(port); await opened(b);
    b.send({ type: "join_facilitator", sessionId: "local" });
    expect((await b.next((m) => m.type === "error")).code).toBe("unauthorized");
  });
});

describe("failed-authentication throttle", () => {
  it("more than 5 failures from one address block its next handshakes (429) without affecting another address", async () => {
    let t = 1_000;
    const { port } = await setup({ token: TOKEN, trustProxy: true, now: () => t });
    const bad = async (ip: string) => { const c = open(port, { "x-forwarded-for": ip }); await opened(c); c.send({ type: "join_facilitator", sessionId: "local", token: "wrong-wrong-wrong-wrong" }); await c.closed; };
    for (let i = 0; i < 6; i++) await bad("203.0.113.5");
    expect((await handshake(port, { "x-forwarded-for": "203.0.113.5" })).status).toBe(429);
    expect((await handshake(port, { "x-forwarded-for": "203.0.113.6" })).status).toBe(101);
    t += 61_000;
    expect((await handshake(port, { "x-forwarded-for": "203.0.113.5" })).status).toBe(101);
  });

  it("a right token is never throttled by someone else's failures when the address differs", async () => {
    const { port } = await setup({ token: TOKEN, trustProxy: true });
    for (let i = 0; i < 6; i++) { const c = open(port, { "x-forwarded-for": "198.51.100.1" }); await opened(c); c.send({ type: "join_facilitator", sessionId: "local" }); await c.closed; }
    const ok = open(port, { "x-forwarded-for": "198.51.100.2" }); await opened(ok);
    ok.send({ type: "join_facilitator", sessionId: "local", token: TOKEN });
    expect((await ok.next((m) => m.type === "joined")).roleId).toBe("facilitator");
  });
});

describe("connection caps and Origin (AC-0054)", () => {
  it("the per-address cap refuses the next handshake with 503 and frees the slot on close", async () => {
    const { port } = await setup({ limits: { maxConnectionsPerIp: 2 } });
    const a = await handshake(port); const b = await handshake(port);
    expect([a.status, b.status]).toEqual([101, 101]);
    expect((await handshake(port)).status).toBe(503);
    const closed = new Promise((r) => a.ws!.on("close", r));
    a.ws!.close(); await closed;
    await new Promise((r) => setTimeout(r, 20));
    expect((await handshake(port)).status).toBe(101);
  });

  it("the total cap holds against many addresses (trusted proxy header)", async () => {
    const { port } = await setup({ limits: { maxConnections: 3, maxConnectionsPerIp: 3 }, trustProxy: true });
    const s = await Promise.all([1, 2, 3].map((i) => handshake(port, { "x-forwarded-for": `192.0.2.${i}` })));
    expect(s.map((x) => x.status)).toEqual([101, 101, 101]);
    expect((await handshake(port, { "x-forwarded-for": "192.0.2.99" })).status).toBe(503);
  });

  it("without TRUST_PROXY the forwarded header is ignored for the per-address cap", async () => {
    const { port } = await setup({ limits: { maxConnectionsPerIp: 1 } });
    expect((await handshake(port, { "x-forwarded-for": "192.0.2.1" })).status).toBe(101);
    expect((await handshake(port, { "x-forwarded-for": "192.0.2.2" })).status).toBe(503);
  });

  it("a handshake that carries an Origin is refused (403) unless it is on the allow list; none is fine", async () => {
    const { port } = await setup({ allowedOrigins: ["https://play.example.com"] });
    expect((await handshake(port, { origin: "https://evil.example" })).status).toBe(403);
    expect((await handshake(port, { origin: "null" })).status).toBe(403);
    expect((await handshake(port, { origin: "https://play.example.com" })).status).toBe(101);
    expect((await handshake(port)).status).toBe(101);
  });

  it("with no allow list every browser Origin is refused", async () => {
    const { port } = await setup();
    expect((await handshake(port, { origin: "http://localhost:3000" })).status).toBe(403);
  });

  it("a plain HTTP request is answered with 426 and nothing else", async () => {
    const { port } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(426);
  });

  it("a flood of connections is bounded: the extra ones are refused and the server stays responsive", async () => {
    const { port } = await setup({ limits: { maxConnections: 5, maxConnectionsPerIp: 5 } });
    const results = await Promise.all(Array.from({ length: 40 }, () => handshake(port)));
    expect(results.filter((r) => r.status === 101).length).toBe(5);
    expect(results.filter((r) => r.status === 503).length).toBe(35);
  });
});

describe("per-connection limits (AC-0054)", () => {
  it("a flooding client gets rate_limited, then is closed with 1008; another client is unaffected", async () => {
    const { port } = await setup({ limits: { msgRate: 1, msgBurst: 5 } });
    const good = open(port); await opened(good);
    good.send({ type: "join", sessionId: "local", roleId: "host", participantId: "good" });
    await good.next((m) => m.type === "joined");
    const bad = open(port); await opened(bad);
    for (let i = 0; i < 60; i++) bad.ws.send(JSON.stringify({ type: "say", text: "spam" }));
    expect(await bad.closed).toBe(1008);
    expect(bad.inbox.some((m) => m.type === "error" && m.code === "rate_limited")).toBe(true);
    good.send({ type: "say", text: "still here" });
    expect((await good.next((m) => m.type === "error" || m.type === "event")).type).toBeDefined();
    expect(good.inbox.some((m) => m.type === "error" && m.code === "rate_limited")).toBe(false);
    expect(good.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("a polite client within the burst is never limited", async () => {
    const { port } = await setup({ limits: { msgRate: 1, msgBurst: 5 } });
    const c = open(port); await opened(c);
    for (let i = 0; i < 5; i++) c.send({ type: "say", text: "hi" });
    await c.next(() => false, 150).catch(() => {});
    expect(c.inbox.filter((m) => m.code === "rate_limited").length).toBe(0);
    expect(c.inbox.filter((m) => m.code === "not_joined").length).toBe(5);
  });

  it("refills over time (injected clock)", async () => {
    let t = 0;
    const { port } = await setup({ limits: { msgRate: 1, msgBurst: 1, maxDrops: 100 }, now: () => t });
    const c = open(port); await opened(c);
    c.send({ type: "say", text: "a" });
    await c.next((m) => m.code === "not_joined");
    c.send({ type: "say", text: "b" });
    await c.next((m) => m.code === "rate_limited");
    t += 1_000;
    c.send({ type: "say", text: "c" });
    await c.next((m) => m.code === "not_joined" && c.inbox.filter((x) => x.code === "not_joined").length === 2);
  });

  it("a connection that never joins is closed after the join timeout; one that joined stays", async () => {
    const { port } = await setup({ limits: { joinTimeoutMs: 150 } });
    const idle = open(port); await opened(idle);
    const player = open(port); await opened(player);
    player.send({ type: "join", sessionId: "local", roleId: "host", participantId: "p" });
    await player.next((m) => m.type === "joined");
    expect(await idle.closed).toBe(1008);
    await new Promise((r) => setTimeout(r, 200));
    expect(player.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("a slow-drip connection that sends garbage but never joins is still closed by the join timeout", async () => {
    const { port } = await setup({ limits: { joinTimeoutMs: 200 } });
    const c = open(port); await opened(c);
    const drip = setInterval(() => { try { c.ws.send("{"); } catch { /* closed */ } }, 50);
    expect(await c.closed).toBe(1008);
    clearInterval(drip);
  });

  it("more queued messages than the cap closes the connection", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const stub = {
      join: () => ({ brief: "b", privateFacts: [] }), snapshotFor: () => ({ status: "idle" }), subscribe: () => () => {},
      release: () => {}, onPlayerUtterance: () => gate,
    } as unknown as SessionHost;
    const { port } = await setup({ host: stub, limits: { maxQueue: 5, msgRate: 1_000, msgBurst: 1_000 } });
    const c = open(port); await opened(c);
    c.send({ type: "join", sessionId: "local", roleId: "host", participantId: "p" });
    await c.next((m) => m.type === "joined");
    for (let i = 0; i < 40; i++) c.send({ type: "say", text: "x" });
    expect(await c.closed).toBe(1008);
    release();
  });

  it("the payload cap is 16 KiB", () => { expect(MAX_PAYLOAD_BYTES).toBe(16 * 1024); });

  it("an oversized frame closes only that connection", async () => {
    const { port } = await setup();
    const other = open(port); await opened(other);
    const big = open(port); await opened(big);
    big.ws.send("x".repeat(MAX_PAYLOAD_BYTES + 1));
    expect(await big.closed).toBe(1009);
    expect(other.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("bind address", () => {
  it("binds the host it is given", async () => {
    const scenario = await loadScenario(fixture);
    const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock: new FakeClock(0) });
    const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(), gmProvider: new MockModelProvider(), clock: new FakeClock(0) });
    server = await startServer({ port: 0, hosts: new Map([["local", host]]), log: (m) => logs.push(m), host: "127.0.0.1" });
    expect(logs.join("\n")).toContain("ws://127.0.0.1:");
  });
});
