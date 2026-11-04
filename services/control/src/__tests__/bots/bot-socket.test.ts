import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { BOT_CLOSE_GRACE_MS, BOT_HANDSHAKE_RETRY_MS, BOT_HANDSHAKE_TIMEOUT_MS, BOT_MAX_PAYLOAD_BYTES, BotSocket } from "../../bots/bot-socket.js";
import type { BotFrame } from "../../bots/bot-frames.js";

type Timer = { fn: () => void; ms: number; cancelled: boolean };
let timers: Timer[];
let handshakeTimers: Timer[];
const setTimer = (fn: () => void, ms: number) => { const t: Timer = { fn, ms, cancelled: false }; (ms === BOT_HANDSHAKE_TIMEOUT_MS ? handshakeTimers : timers).push(t); return () => { t.cancelled = true; }; };
const until = async (what: string, fn: () => boolean) => { const end = Date.now() + 3_000; while (!fn()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 5)); } };

let server: http.Server;
let wss: WebSocketServer;
let port: number;
let upgradeHeaders: http.IncomingHttpHeaders[];
let received: unknown[];
let sockets: WebSocket[];
/**
 * Server-side connection counters. Each test gets its own object, captured by the handlers installed in beforeEach: a previous test's
 * sockets are terminated in afterEach but their server-side `close` events can still arrive after the next beforeEach, and must not
 * decrement (or otherwise touch) the next test's counters. Writing to shared `let` counters let that late close push `live` to -1, so the
 * next test's first connection brought it to 0 and `maxLive` read 0 (the flake in "a second open after close() never overlaps").
 */
let count: { live: number; maxLive: number; serverClosed: number };
/** What the upgrade handler does with the Nth attempt (0-based); default accept. */
let refuse: (n: number) => boolean;
let attempts: number;
let ignoreClose: boolean;

beforeEach(async () => {
  timers = []; handshakeTimers = []; upgradeHeaders = []; received = []; sockets = []; const mine = count = { live: 0, maxLive: 0, serverClosed: 0 }; attempts = 0; refuse = () => false; ignoreClose = false;
  server = http.createServer();
  wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    upgradeHeaders.push(req.headers);
    const n = attempts++;
    if (refuse(n)) { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws); mine.live++; mine.maxLive = Math.max(mine.maxLive, mine.live);
      ws.on("message", (d) => received.push(JSON.parse(d.toString())));
      ws.on("close", () => { mine.live--; mine.serverClosed++; });
      if (ignoreClose) {
        // Pinned to ws 8.22.0 internals (the receiver's `conclude` listener answers the close frame).
        if (typeof (ws as unknown as { _receiver?: { on?: unknown } })._receiver?.on !== "function") throw new Error("ws internals changed"); (ws as unknown as { _receiver: { removeAllListeners(e: string): void } })._receiver.removeAllListeners("conclude"); }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  for (const s of sockets) s.terminate();
  await new Promise<void>((r) => { wss.close(); server.closeAllConnections(); server.close(() => r()); });
});

const open = (extra: Partial<Parameters<typeof BotSocket.open>[0]> = {}) => BotSocket.open({
  port, sessionId: "s1", roleId: "tech_lead", participantId: "ai-0123456789abcdef", code: "CODE-1234-ABCD", onFrame: () => {}, onClose: () => {}, setTimer, ...extra,
});

describe("BotSocket", () => {
  it("the upgrade carries X-Forwarded-For scenecoach-bot", async () => {
    const s = await open();
    await until("join", () => received.length === 1);
    expect(upgradeHeaders[0]!["x-forwarded-for"]).toBe("scenecoach-bot");
    await s.close();
  });

  it("the join message has exactly type, sessionId, roleId, participantId, joinCode (and reconnectToken when given)", async () => {
    const a = await open();
    await until("join", () => received.length === 1);
    expect(received[0]).toEqual({ type: "join", sessionId: "s1", roleId: "tech_lead", participantId: "ai-0123456789abcdef", joinCode: "CODE-1234-ABCD" });
    await a.close();
    const b = await open({ reconnectToken: "rt-1" });
    await until("join 2", () => received.length === 2);
    expect(received[1]).toEqual({ type: "join", sessionId: "s1", roleId: "tech_lead", participantId: "ai-0123456789abcdef", joinCode: "CODE-1234-ABCD", reconnectToken: "rt-1" });
    for (const m of received) for (const k of ["displayName", "issueCredential", "credential", "lastSeq"]) expect(m).not.toHaveProperty(k);
    await b.close();
  });

  it("say sends {type:'say', text, expectSceneId}", async () => {
    const s = await open();
    s.say("hello there", "scene-2");
    await until("say", () => received.length === 2);
    expect(received[1]).toEqual({ type: "say", text: "hello there", expectSceneId: "scene-2" });
    await s.close();
  });

  it("delivers parsed frames, and a throw inside onFrame does not kill the socket", async () => {
    const frames: BotFrame[] = []; const logs: string[] = [];
    let n = 0;
    const s = await open({ onFrame: (f) => { frames.push(f); if (n++ === 0) throw new TypeError("boom CODE-1234-ABCD"); }, log: (m) => logs.push(m) });
    await until("server socket", () => sockets.length === 1);
    sockets[0]!.send(JSON.stringify({ type: "error", code: "x", message: "m" }));
    sockets[0]!.send("garbage");
    sockets[0]!.send(JSON.stringify({ type: "error", code: "y", message: "m" }));
    await until("frames", () => frames.length === 3);
    expect(frames.map((f) => f.type)).toEqual(["error", "ignored", "error"]);
    expect(logs).toEqual(["bot frame handler failed: TypeError"]);
    s.say("still alive", "s");
    await until("say", () => received.length === 2);
    await s.close();
  });

  it("close() sends code 1000 and resolves only after the server saw the socket close", async () => {
    const concluded: number[] = [];
    const s = await open();
    await until("server socket", () => sockets.length === 1);
    // Pinned to ws 8.22.0 internals: this guard fails loudly if a ws upgrade removes the receiver.
    expect(typeof (sockets[0] as unknown as { _receiver?: { on?: unknown } })._receiver?.on).toBe("function");
    // The server's receiver emits `conclude` when the client's close frame arrives (before the server answers it).
    (sockets[0] as unknown as { _receiver: { on(e: string, f: (code: number) => void): void } })._receiver.on("conclude", (code) => concluded.push(code));
    await s.close();
    expect(concluded).toEqual([1000]);
    await expect(s.close()).resolves.toBeUndefined(); // already closed: immediately
    expect(timers.every((t) => t.cancelled || t.ms === BOT_CLOSE_GRACE_MS)).toBe(true);
  });

  it("reports the close code through onClose, byUs false for a server-initiated close", async () => {
    const closes: [number, boolean][] = [];
    await open({ onClose: (c, i) => closes.push([c, i.byUs]) });
    await until("server socket", () => sockets.length === 1);
    sockets[0]!.close(4001, "no");
    await until("onClose", () => closes.length === 1);
    expect(closes).toEqual([[4001, false]]);
  });

  it("a close started by close() reports byUs true", async () => {
    const closes: [number, boolean][] = [];
    const s = await open({ onClose: (c, i) => closes.push([c, i.byUs]) });
    await s.close();
    expect(closes).toEqual([[1000, true]]);
  });

  it("no onClose follows a refused handshake, a 503 retry in flight, or a connection error", async () => {
    const closes: number[] = [];
    const onClose = (c: number) => closes.push(c);
    server.removeAllListeners("upgrade");
    server.on("upgrade", (_req, socket) => { socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
    await expect(open({ onClose })).rejects.toThrow();
    // 503 then accepted: attempt 1 gives no onClose while open() is pending
    server.removeAllListeners("upgrade");
    let n = 0;
    server.on("upgrade", (req, socket, head) => {
      if (n++ === 0) { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
      wss.handleUpgrade(req, socket, head, (ws) => { sockets.push(ws); });
    });
    const p = open({ onClose });
    await until("retry timer", () => timers.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(closes).toEqual([]);
    timers[0]!.fn();
    const s = await p;
    await s.close();
    expect(closes).toEqual([1000]); // only the opened socket's own close
    closes.length = 0;
    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    await expect(open({ onClose })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(closes).toEqual([]);
    server = http.createServer(); await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  });

  it("drops a text frame longer than 4 MiB before parsing it", async () => {
    const frames: BotFrame[] = [];
    const s = await open({ onFrame: (f) => frames.push(f), ws: (url, o) => new WebSocket(url, { headers: o.headers, maxPayload: 16 * 1024 * 1024 }) });
    await until("server socket", () => sockets.length === 1);
    sockets[0]!.send(JSON.stringify({ type: "error", code: "x", message: "y".repeat(BOT_MAX_PAYLOAD_BYTES + 10) }));
    sockets[0]!.send(JSON.stringify({ type: "error", code: "ok", message: "m" }));
    await until("frame", () => frames.length >= 1);
    expect(frames).toEqual([{ type: "error", code: "ok", message: "m" }]);
    await s.close();
  });

  it("a peer that never answers the close is terminated after 2 s (fake timer) and close() then resolves", async () => {
    ignoreClose = true;
    const s = await open();
    await until("server socket", () => sockets.length === 1);
    let done = false;
    const p = s.close().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 100));
    expect(done).toBe(false);
    const grace = timers.find((t) => t.ms === BOT_CLOSE_GRACE_MS && !t.cancelled);
    expect(grace).toBeDefined();
    expect(BOT_CLOSE_GRACE_MS).toBe(2_000);
    grace!.fn();
    await p;
    expect(done).toBe(true);
  });

  it("a second open after close() never overlaps (the server counts at most one socket)", async () => {
    const a = await open();
    await until("a", () => sockets.length === 1);
    await a.close();
    const b = await open();
    await until("b", () => sockets.length === 2);
    await b.close();
    expect(count.maxLive).toBe(1);
  });

  it("a 503 handshake is retried once after 1 s and a second 503 rejects", async () => {
    refuse = () => true;
    let outcome: "pending" | "rejected" | "resolved" = "pending";
    let error: Error | undefined;
    const p = open().then(() => { outcome = "resolved"; }, (e: Error) => { outcome = "rejected"; error = e; });
    await until("retry timer", () => timers.length === 1);
    expect(timers[0]!.ms).toBe(BOT_HANDSHAKE_RETRY_MS);
    expect(attempts).toBe(1);
    timers[0]!.fn();
    await p;
    expect(attempts).toBe(2);
    expect(outcome).toBe("rejected");
    expect(error!.message).not.toContain("CODE-1234-ABCD");
    expect(timers).toHaveLength(1); // no third attempt
  });

  it("a 503 followed by an accepted handshake resolves", async () => {
    refuse = (n) => n === 0;
    const p = open();
    await until("retry timer", () => timers.length === 1);
    timers[0]!.fn();
    const s = await p;
    await until("join", () => received.length === 1);
    expect(attempts).toBe(2);
    await s.close();
  });

  it("a refusal other than 503 rejects at once without a retry, and no secret is in the message", async () => {
    server.removeAllListeners("upgrade");
    server.on("upgrade", (_req, socket) => { attempts++; socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
    const err = await open({ reconnectToken: "rt-secret" }).then(() => undefined, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(attempts).toBe(1);
    expect(timers).toHaveLength(0);
    expect(err!.message).not.toMatch(/CODE-1234|rt-secret/);
  });

  it("rejects when nothing listens, with no secret in the message", async () => {
    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    const err = await open().then(() => undefined, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toMatch(/CODE-1234/);
    server = http.createServer(); await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  });

  it("an injected factory receives the url, the forward header, the 4 MiB payload limit and the handshake timeout", async () => {
    const seen: { url: string; headers: Record<string, string>; maxPayload: number; handshakeTimeout: number }[] = [];
    const s = await open({ ws: (url, o) => { seen.push({ url, ...o }); return new WebSocket(url, o); } });
    expect(seen).toEqual([{ url: `ws://127.0.0.1:${port}`, headers: { "X-Forwarded-For": "scenecoach-bot" }, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 10_000 }]);
    await s.close();
  });

  it("a server that accepts the TCP connection and never answers the upgrade makes open() reject at the handshake timeout, with no secret", async () => {
    server.removeAllListeners("upgrade");
    server.on("upgrade", () => { /* never answered */ });
    let error: Error | undefined;
    const p = open().then(() => undefined, (e: Error) => { error = e; });
    await until("handshake timer", () => handshakeTimers.length === 1);
    expect(handshakeTimers[0]!.ms).toBe(10_000);
    handshakeTimers[0]!.fn();
    await p;
    expect(error!.message).toBe("bot handshake timed out");
    expect(error!.message).not.toContain("CODE-1234");
  });

  it("an abort during the 503 wait cancels the retry: no second attempt, no join", async () => {
    refuse = () => true;
    const ac = new AbortController();
    const p = open({ signal: ac.signal }).then(() => "resolved", (e: Error) => e.message);
    await until("retry timer", () => timers.length === 1);
    ac.abort();
    expect(await p).toBe("bot open aborted");
    expect(timers[0]!.cancelled).toBe(true);
    expect(attempts).toBe(1);
    expect(received).toEqual([]);
  });

  it("an already aborted signal opens nothing", async () => {
    const ac = new AbortController(); ac.abort();
    await expect(open({ signal: ac.signal })).rejects.toThrow("bot open aborted");
    expect(attempts).toBe(0);
  });
});
