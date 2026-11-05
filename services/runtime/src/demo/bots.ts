import WebSocket from "ws";
import type { SessionEvent } from "@acr/events";
import type { ServerMessage } from "../host/protocol.js";

export type Inbound = ServerMessage | { type: "__unparseable" };
type Waiter = { from: number; pred: (m: Inbound) => boolean; resolve: (m: Inbound) => void; timer: NodeJS.Timeout; off: () => void; reject: (e: Error) => void };

export const DEFAULT_WAIT_MS = 5_000;
/** A server that sends more than this many frames, or any frame above MAX_FRAME_BYTES, is treated as flooding the client. */
export const MAX_INBOX = 5_000;
export const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * A scripted participant: one real WebSocket connection that records every server message. `waitFor` resolves on
 * arrival (no polling, no fixed sleeps); its timeout only guards against a hung server. A replacement connection for
 * the same participant can share the inbox (`opts.inbox`) so audits see everything that participant ever received.
 */
export class Bot {
  readonly inbox: Inbound[];
  /** Resolves with the close code when the socket closes. */
  readonly closed: Promise<number>;
  /** Set when the server exceeded MAX_INBOX frames (the connection is then terminated and waits fail). */
  flooded = false;
  /** Called synchronously for every message as it arrives (the showcase narrates the facilitator's stream with it). */
  onMessage: ((m: Inbound) => void) | undefined;
  private readonly waiters = new Set<Waiter>();
  private constructor(readonly label: string, readonly ws: WebSocket, inbox: Inbound[], private readonly signal: AbortSignal | undefined) {
    this.inbox = inbox;
    this.closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    ws.on("message", (data) => {
      if (this.flooded) return;
      if (this.inbox.length >= MAX_INBOX) {
        this.flooded = true;
        this.failWaiters(`${this.label}: the server flooded the client (more than ${MAX_INBOX} frames)`);
        ws.terminate();
        return;
      }
      let m: Inbound;
      try { m = JSON.parse(data.toString()) as Inbound; } catch { m = { type: "__unparseable" }; }
      const index = this.inbox.push(m) - 1;
      try { this.onMessage?.(m); } catch { /* a listener must never break the connection */ }
      // Only the new message is tested (never a rescan of the whole inbox), so a flood costs O(frames).
      for (const w of [...this.waiters]) {
        if (index >= w.from && w.pred(m)) { this.settle(w); w.resolve(m); }
      }
    });
    ws.on("close", () => this.failWaiters(`${this.label}: the connection closed`));
    ws.on("error", () => { /* surfaced through close / waitFor timeouts; never an unhandled error event */ });
  }

  static async connect(url: string, label: string, opts: { signal?: AbortSignal; autoPong?: boolean; inbox?: Inbound[]; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<Bot> {
    if (opts.signal?.aborted) throw new Error("run aborted");
    const ws = new WebSocket(url, { autoPong: opts.autoPong ?? true, handshakeTimeout: opts.timeoutMs ?? DEFAULT_WAIT_MS, maxPayload: MAX_FRAME_BYTES, headers: opts.headers });
    const bot = new Bot(label, ws, opts.inbox ?? [], opts.signal);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { ws.terminate(); reject(new Error("run aborted")); };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      ws.once("open", () => { opts.signal?.removeEventListener("abort", onAbort); resolve(); });
      ws.once("error", (err) => { opts.signal?.removeEventListener("abort", onAbort); reject(new Error(`${label}: cannot connect: ${err.message}`)); });
    });
    return bot;
  }

  private failWaiters(message: string): void {
    for (const w of [...this.waiters]) { this.settle(w); w.reject(new Error(message)); }
  }

  private settle(w: Waiter): void { clearTimeout(w.timer); w.off(); this.waiters.delete(w); }

  get isOpen(): boolean { return this.ws.readyState === WebSocket.OPEN; }
  /** Index to pass as `from` so a later wait only considers messages that arrive after now. */
  mark(): number { return this.inbox.length; }
  send(m: unknown): void { this.ws.send(JSON.stringify(m)); }
  sendRaw(data: string | Buffer): void { this.ws.send(data); }

  waitFor(pred: (m: Inbound) => boolean, o: { from?: number; timeoutMs?: number; what?: string } = {}): Promise<Inbound> {
    const from = o.from ?? 0;
    const hit = this.inbox.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    if (this.flooded) return Promise.reject(new Error(`${this.label}: the server flooded the client (more than ${MAX_INBOX} frames)`));
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.reject(new Error(`${this.label}: the connection closed`));
    return new Promise<Inbound>((resolve, reject) => {
      const onAbort = () => { this.settle(w); reject(new Error("run aborted")); };
      const w: Waiter = {
        from, pred, resolve, reject,
        timer: setTimeout(() => { this.settle(w); reject(new Error(`${this.label}: timed out waiting for ${o.what ?? "a server message"}`)); }, o.timeoutMs ?? DEFAULT_WAIT_MS),
        off: () => this.signal?.removeEventListener("abort", onAbort),
      };
      this.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(w);
    });
  }

  /** Sends a message and returns the first `error` or matching reply that arrives after it. */
  async call(m: unknown, ok: (m: Inbound) => boolean, o: { timeoutMs?: number; what?: string } = {}): Promise<Inbound> {
    const from = this.mark();
    this.send(m);
    return this.waitFor((x) => x.type === "error" || ok(x), { from, ...o });
  }

  /** Sends a message (a string is sent raw) that must be refused with the given error code. */
  async expectError(m: unknown, code: string): Promise<void> {
    const from = this.mark();
    if (typeof m === "string") this.sendRaw(m); else this.send(m);
    const e = await this.waitFor((x) => x.type === "error", { from, what: `error ${code}` });
    if (e.type !== "error" || e.code !== code) throw new Error(`${this.label}: expected error ${code}, got ${e.type === "error" ? e.code : e.type}`);
  }

  events(): SessionEvent[] { return this.inbox.flatMap((m) => (m.type === "event" ? [m.event] : [])); }
  close(): void { try { this.ws.close(); } catch { /* already closed */ } }
  terminate(): void {
    this.failWaiters(`${this.label}: connection closed`);
    try { this.ws.terminate(); } catch { /* already closed */ }
  }
}

export const isJoined = (m: Inbound): m is Extract<ServerMessage, { type: "joined" }> => m.type === "joined";
export const isEvent = <T extends SessionEvent["type"]>(type: T, pred: (e: Extract<SessionEvent, { type: T }>) => boolean = () => true) =>
  (m: Inbound): boolean => m.type === "event" && m.event.type === type && pred(m.event as Extract<SessionEvent, { type: T }>);
