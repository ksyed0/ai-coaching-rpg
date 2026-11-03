import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { BOT_CLOSE_GRACE_MS, BOT_HANDSHAKE_RETRY_MS, BotSocket } from "../../bots/bot-socket.js";
import type { BotFrame } from "../../bots/bot-frames.js";

type Timer = { fn: () => void; ms: number; cancelled: boolean };
let timers: Timer[];
const setTimer = (fn: () => void, ms: number) => { const t: Timer = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
const until = async (what: string, fn: () => boolean) => { const end = Date.now() + 10_000; while (!fn()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 5)); } };

let server: http.Server;
let wss: WebSocketServer;
let port: number;
let upgradeHeaders: http.IncomingHttpHeaders[];
let received: unknown[];
let sockets: WebSocket[];
let live: number;
let maxLive: number;
let serverClosed: number;
/** What the upgrade handler does with the Nth attempt (0-based); default accept. */
let refuse: (n: number) => boolean;
let attempts: number;
let ignoreClose: boolean;

beforeEach(async () => {
  timers = []; upgradeHeaders = []; received = []; sockets = []; live = 0; maxLive = 0; serverClosed = 0; attempts = 0; refuse = () => false; ignoreClose = false;
  server = http.createServer();
  wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    upgradeHeaders.push(req.headers);
    const n = attempts++;
    if (refuse(n)) { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws); live++; maxLive = Math.max(maxLive, live);
      ws.on("message", (d) => received.push(JSON.parse(d.toString())));
      ws.on("close", () => { live--; serverClosed++; });
      if (ignoreClose) { (ws as unknown as { _receiver: { removeAllListeners(e: string): void } })._receiver.removeAllListeners("conclude"); }
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
    // The server's receiver emits `conclude` when the client's close frame arrives (before the server answers it).
    (sockets[0] as unknown as { _receiver: { on(e: string, f: (code: number) => void): void } })._receiver.on("conclude", (code) => concluded.push(code));
    await s.close();
    expect(concluded).toEqual([1000]);
    await expect(s.close()).resolves.toBeUndefined(); // already closed: immediately
    expect(timers.every((t) => t.cancelled || t.ms === BOT_CLOSE_GRACE_MS)).toBe(true);
  });

  it("reports the close code through onClose", async () => {
    const codes: number[] = [];
    await open({ onClose: (c) => codes.push(c) });
    await until("server socket", () => sockets.length === 1);
    sockets[0]!.close(4001, "no");
    await until("onClose", () => codes.length === 1);
    expect(codes).toEqual([4001]);
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
    expect(maxLive).toBe(1);
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

  it("an injected factory receives the url and the forward header", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const s = await open({ ws: (url, headers) => { seen.push({ url, headers }); return new WebSocket(url, { headers }); } });
    expect(seen).toEqual([{ url: `ws://127.0.0.1:${port}`, headers: { "X-Forwarded-For": "scenecoach-bot" } }]);
    await s.close();
  });
});
