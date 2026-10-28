import type { IncomingMessage } from "node:http";
import net from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { RuntimeConnection, SetTimer } from "../runtime-connection";
import type { ClientMessage, ServerMessage } from "../wire";

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

/**
 * Resolves when `pred` holds, checking on each macrotask. Gives up after `limitMs` (default 45 s, under the files' 60 to 90 s test
 * limits) with a message naming what it waited for. A hang guard only: nothing asserts how long anything took.
 */
export async function until(pred: () => boolean, o: { what?: string; limitMs?: number } = {}): Promise<void> {
  const giveUpAt = Date.now() + (o.limitMs ?? 45_000); // hygiene-ok: a hang guard, not an elapsed-time assertion
  while (!pred()) {
    if (Date.now() > giveUpAt) throw new Error(`until: gave up waiting for ${o.what ?? "the condition"}`); // hygiene-ok: hang guard
    await new Promise((r) => setImmediate(r));
  }
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
/** Parses SSE text into frames (a `retry:` line reads as the event `retry:<ms>`). */
export function parseSse(text: string): SseFrame[] {
  return text.split("\n\n").filter((b) => b !== "").map((block) => {
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
}
/** Collects what a hub writes and parses it as an SSE stream. */
export function sseRecorder() {
  const chunks: string[] = [];
  let ends = 0;
  const out = { write: (c: string) => { if (ends > 0) throw new Error("write after end"); chunks.push(c); return true; }, end: () => { ends++; } };
  const frames = (): SseFrame[] => parseSse(chunks.join(""));
  return { out, chunks, frames, ends: () => ends, events: () => frames().filter((f) => f.event === "event").map((f) => f.data) };
}

/** Reads a streaming Response body as it arrives (an EventSource in a test). `cancel` is the browser going away. */
export function sseReader(res: Response) {
  let text = "";
  let done = false;
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const pump = (async () => {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try { r = await reader.read(); } catch { done = true; return; }
      if (r.done) { done = true; return; }
      text += dec.decode(r.value, { stream: true });
    }
  })();
  return {
    text: () => text, done: () => done, frames: () => parseSse(text), finished: pump,
    events: () => parseSse(text).filter((f) => f.event === "event").map((f) => f.data),
    cancel: () => reader.cancel(),
  };
}

/** A scripted runtime connection: the test pushes frames and closes; what the hub sends is recorded. */
let fakeJoins = 0;
export class FakeConn {
  /** Like RuntimeConnection.joinOrder: each fake "joined" after the previous one. */
  joinOrder = ++fakeJoins;
  sent: ClientMessage[] = [];
  closed = 0;
  private frameFns = new Set<(m: ServerMessage) => void>();
  private closeFns = new Set<(code: number) => void>();
  private code: number | null = null;
  /** Answers each sent message (an error frame, say), like the runtime would, after the send returns. */
  answer: ((m: ClientMessage) => ServerMessage | null) | null = null;
  /** Like a socket that received the runtime's close frame but has not emitted 'close' yet. */
  closing = false;
  get isOpen() { return this.code === null && this.closed === 0 && !this.closing; }
  get closeCode() { return this.code; }
  send(m: ClientMessage) { if (!this.isOpen) throw new Error("closed"); this.sent.push(m); const a = this.answer?.(m); if (a) queueMicrotask(() => this.emit(a)); }
  onFrame(fn: (m: ServerMessage) => void) { this.frameFns.add(fn); return () => { this.frameFns.delete(fn); }; }
  onClose(fn: (code: number) => void) { if (this.code !== null) { fn(this.code); return () => {}; } this.closeFns.add(fn); return () => { this.closeFns.delete(fn); }; }
  close() { this.closed++; }
  emit(m: ServerMessage) { for (const fn of [...this.frameFns]) fn(m); }
  drop(code: number) { this.code = code; for (const fn of [...this.closeFns]) fn(code); }
  listeners() { return this.frameFns.size + this.closeFns.size; }
}
export const asConn = (c: FakeConn) => c as unknown as RuntimeConnection;

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
