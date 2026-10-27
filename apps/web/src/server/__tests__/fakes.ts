import type { IncomingMessage } from "node:http";
import net from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { SetTimer } from "../runtime-connection";

// Test doubles shared by the connection and hub tests: a scripted runtime on a real socket, manual timers and an SSE recorder.

/** A scripted runtime: `onMessage` answers each parsed client frame. Records handshake headers and every frame received. */
export async function fakeRuntime(onMessage: (ws: WebSocket, m: any) => void = () => {}, o: { status?: number } = {}) {
  const sockets: WebSocket[] = [];
  const received: any[] = [];
  const headers: IncomingMessage["headers"][] = [];
  const closes: number[] = [];
  const wss = new WebSocketServer({
    port: 0, host: "127.0.0.1",
    // A non-101 answer at the handshake, like the runtime's 429 / 503 refusals.
    verifyClient: o.status === undefined ? undefined : (_info, cb) => cb(false, o.status),
  });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (ws, req) => {
    sockets.push(ws); headers.push(req.headers);
    ws.on("message", (d) => { const m = JSON.parse(d.toString()); received.push(m); onMessage(ws, m); });
    ws.on("close", (code) => closes.push(code));
  });
  const port = (wss.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`, sockets, received, headers, closes,
    /** Resolves once the server has seen `n` socket closes. */
    closed: (n = 1) => until(() => closes.length >= n),
    stop: () => new Promise<void>((r) => { for (const s of wss.clients) s.terminate(); wss.close(() => r()); }),
  };
}

/** Resolves when `pred` holds, checking on each macrotask; the test timeout guards a hang. */
export async function until(pred: () => boolean): Promise<void> {
  while (!pred()) await new Promise((r) => setImmediate(r));
}

/** Manual timers: nothing fires until the test says so. */
export function manualTimers() {
  const pending: { fn: () => void; ms: number; live: boolean }[] = [];
  const setTimer: SetTimer = (fn, ms) => { const t = { fn, ms, live: true }; pending.push(t); return () => { t.live = false; }; };
  return {
    setTimer,
    live: () => pending.filter((t) => t.live),
    /** Fires every live timer of exactly `ms` that exists now. */
    fire(ms: number) { for (const t of pending.filter((p) => p.live && p.ms === ms)) { t.live = false; t.fn(); } },
  };
}

export type SseFrame = { id?: string; event?: string; data?: any; comment?: string };
/** Collects what a hub writes and parses it as an SSE stream. */
export function sseRecorder() {
  const chunks: string[] = [];
  let ends = 0;
  const out = { write: (c: string) => { if (ends > 0) throw new Error("write after end"); chunks.push(c); return true; }, end: () => { ends++; } };
  const frames = (): SseFrame[] => chunks.join("").split("\n\n").filter((b) => b !== "").map((block) => {
    const f: SseFrame = {};
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) f.comment = line.slice(1).trim();
      else if (line.startsWith("id: ")) f.id = line.slice(4);
      else if (line.startsWith("event: ")) f.event = line.slice(7);
      else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
      else if (line.startsWith("retry: ")) f.event = `retry:${line.slice(7)}`;
    }
    return f;
  });
  return { out, chunks, frames, ends: () => ends, events: () => frames().filter((f) => f.event === "event").map((f) => f.data) };
}

/**
 * A TCP proxy to `port` whose runtime-to-client direction can be held: while held, bytes (and the runtime's end of the connection)
 * are buffered, then delivered together on release. Simulates one socket's frames arriving late relative to another socket's.
 */
export async function holdingProxy(port: number) {
  let held = false;
  const pending: { sock: net.Socket; chunks: Buffer[]; ended: boolean }[] = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(port, "127.0.0.1");
    const p = { sock: client, chunks: [] as Buffer[], ended: false };
    pending.push(p);
    client.on("data", (d) => upstream.write(d));
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("error", () => {});
    upstream.on("data", (d) => { if (held) p.chunks.push(d); else client.write(d); });
    upstream.on("end", () => { if (held) p.ended = true; else client.end(); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    hold: () => { held = true; },
    /** Delivers everything held, in order, in one write per socket. */
    release: () => {
      held = false;
      for (const p of pending) { if (p.chunks.length) p.sock.write(Buffer.concat(p.chunks)); p.chunks = []; if (p.ended) p.sock.end(); }
    },
    stop: () => new Promise<void>((r) => { for (const p of pending) p.sock.destroy(); server.close(() => r()); }),
  };
}
