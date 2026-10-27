import WebSocket from "ws";
import type { ClientMessage, JoinedFrame, ServerMessage } from "./wire";

// One participant's WebSocket to the runtime, opened by the BFF. Plain `ws`, no Next imports. Never logs anything: the join code, the
// credential and the client address must not reach a log or an error message, so errors carry a code word only.

/** Runs `fn` once after `ms`; returns a cancel function. Injected so tests drive time by hand. */
export type SetTimer = (fn: () => void, ms: number) => () => void;
export const realTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref(); // a pending deadline must not keep the process alive
  return () => clearTimeout(t);
};

/** A refused or failed connect or join. `code` is a fixed word (or the runtime's own error code); the message repeats only that. */
export class RuntimeError extends Error {
  constructor(readonly code: string) { super(`runtime: ${code}`); this.name = "RuntimeError"; }
}

/** The runtime's close codes (services/runtime/src/host/ws-server.ts). */
const CLOSE_POLICY = 1008;
export const CLOSE_SUPERSEDED = 4001;
const DEFAULT_TIMEOUT_MS = 10_000;
// The runtime's answer to a lastSeq past its last event starts with this (ws-server.ts BEYOND_HEAD); zod's lastSeq issues do too.
const LAST_SEQ_REFUSAL = /^lastSeq\b/;

/** Bounds on the frames held before anyone listens (a replay is at most 1,000 events and 256 KiB on the runtime side). */
export const MAX_QUEUED_FRAMES = 2_000;
export const MAX_QUEUED_CHARS = 1024 * 1024;

// A 1008 means a refused login only with the reason "unauthorized" (which the runtime sends after an `unauthorized` error frame). A bare
// 1008 comes from the runtime's join timeout or queue cap, under load: the credential is fine, so it must not be reported as unauthorized.
const classifyClose = (code: number, reason: string): string =>
  code === CLOSE_POLICY && reason === "unauthorized" ? "unauthorized" : code === CLOSE_SUPERSEDED ? "superseded" : "unavailable";

/** Order in which joins resolved, process-wide: the hub keeps the stream whose runtime join is newest (the runtime's current holder). */
let joinCounter = 0;

type PendingJoin = { resolve: (j: JoinedFrame) => void; reject: (e: RuntimeError) => void; cancel: () => void; retry: (() => void) | null };

export class RuntimeConnection {
  private readonly frameFns = new Set<(m: ServerMessage) => void>();
  private readonly closeFns = new Set<(code: number) => void>();
  /** Frames that arrived while nobody listened (the replay right after `joined`, before the hub subscribes): delivered in order later. */
  private readonly queue: ServerMessage[] = [];
  private queuedChars = 0;
  private pending: PendingJoin | null = null;
  private joinAttempted = false;
  private closedCode: number | null = null;
  private closedReason = "";
  private joinedOrder = 0;

  private constructor(private readonly ws: WebSocket, private readonly setTimer: SetTimer, private readonly timeoutMs: number) {
    ws.on("message", (d) => this.onMessage(d.toString()));
    ws.on("close", (code, reason) => this.onSocketClose(code, reason.toString()));
  }

  /** Opens the socket. `clientAddress` goes only into X-Forwarded-For (the runtime runs with TRUST_PROXY=1). */
  static connect(url: string, clientAddress: string, o: { setTimer?: SetTimer; timeoutMs?: number } = {}): Promise<RuntimeConnection> {
    const setTimer = o.setTimer ?? realTimer;
    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(url, { headers: { "X-Forwarded-For": clientAddress } }); }
      catch { reject(new RuntimeError("unavailable")); return; }
      // Always listened to: an 'error' without a listener would throw; a close follows every error anyway.
      ws.on("error", () => {});
      let settled = false;
      const done = (err: RuntimeError | null) => {
        if (settled) return;
        settled = true;
        cancel();
        if (err) { ws.terminate(); reject(err); return; }
        resolve(new RuntimeConnection(ws, setTimer, timeoutMs));
      };
      const cancel = setTimer(() => done(new RuntimeError("unavailable")), timeoutMs);
      ws.once("open", () => done(null));
      // The runtime refuses at the handshake with 429 (address blocked after failed logins) or 503 (connection caps).
      ws.once("unexpected-response", (_req, res) => done(new RuntimeError(res.statusCode === 429 ? "rate_limited" : "unavailable")));
      ws.once("close", () => done(new RuntimeError("unavailable")));
      ws.on("error", () => done(new RuntimeError("unavailable")));
    });
  }

  get isOpen(): boolean { return this.closedCode === null && this.ws.readyState === WebSocket.OPEN; }
  /** The runtime's close code once the socket has closed, else null. */
  get closeCode(): number | null { return this.closedCode; }
  /** When this connection's join resolved, relative to every other connection in the process (0: not joined). Larger is newer. */
  get joinOrder(): number { return this.joinedOrder; }

  /** First join by code. The code goes through exactly as typed: the runtime normalises case, spaces and hyphens itself. */
  joinWithCode(a: { sessionId: string; roleId: string; participantId: string; joinCode: string; displayName: string }): Promise<JoinedFrame> {
    return this.join({ type: "join", sessionId: a.sessionId, roleId: a.roleId, participantId: a.participantId, joinCode: a.joinCode, displayName: a.displayName, issueCredential: true, lastSeq: 0 });
  }

  /**
   * Rejoin with the durable credential. With `lastSeq` the runtime replays what the player missed. A lastSeq past the runtime's head
   * (a restarted log, a stale tab) is retried once without it: the caller then gets a plain snapshot (no `replay`) and must reset.
   */
  joinWithCredential(a: { sessionId: string; roleId: string; participantId: string; credential: string; lastSeq?: number }): Promise<JoinedFrame> {
    const base = { type: "join" as const, sessionId: a.sessionId, roleId: a.roleId, participantId: a.participantId, credential: a.credential };
    return this.join(a.lastSeq === undefined ? base : { ...base, lastSeq: a.lastSeq }, a.lastSeq === undefined ? null : base);
  }

  private join(msg: ClientMessage, fallback: ClientMessage | null = null): Promise<JoinedFrame> {
    if (this.joinAttempted) return Promise.reject(new RuntimeError("already_joined"));
    if (!this.isOpen) return Promise.reject(new RuntimeError(this.closedCode === null ? "unavailable" : classifyClose(this.closedCode, this.closedReason)));
    this.joinAttempted = true;
    return new Promise((resolve, reject) => {
      const arm = () => this.setTimer(() => this.failJoin(new RuntimeError("unavailable")), this.timeoutMs);
      const pending: PendingJoin = { resolve, reject, cancel: arm(), retry: null };
      if (fallback) pending.retry = () => { pending.cancel(); pending.cancel = arm(); this.ws.send(JSON.stringify(fallback)); };
      this.pending = pending;
      this.ws.send(JSON.stringify(msg));
    });
  }

  private failJoin(err: RuntimeError): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.cancel();
    p.reject(err);
    // A socket whose join failed is useless to the BFF; the runtime closes most of them itself.
    this.ws.terminate();
  }

  private onMessage(text: string): void {
    let m: unknown;
    try { m = JSON.parse(text); } catch { return; }
    if (typeof m !== "object" || m === null || typeof (m as { type?: unknown }).type !== "string") return;
    const frame = m as ServerMessage;
    const p = this.pending;
    if (p) {
      if (frame.type === "joined") { this.pending = null; p.cancel(); this.joinedOrder = ++joinCounter; p.resolve(frame); return; }
      if (frame.type === "error") {
        if (p.retry && frame.code === "bad_message" && LAST_SEQ_REFUSAL.test(frame.message)) { const retry = p.retry; p.retry = null; retry(); return; }
        this.failJoin(new RuntimeError(frame.code));
      }
      return; // nothing else is sent before joined
    }
    // Strict order: while older frames wait in the queue, a new one queues behind them.
    if (this.frameFns.size === 0 || this.queue.length > 0) {
      this.queue.push(frame);
      this.queuedChars += text.length;
      // Nobody is reading (the stream never opened): drop the socket rather than buffer without end. The hub then sees it closed.
      if (this.queue.length > MAX_QUEUED_FRAMES || this.queuedChars > MAX_QUEUED_CHARS) { this.queue.length = 0; this.queuedChars = 0; this.ws.terminate(); return; }
      this.flush();
      return;
    }
    for (const fn of [...this.frameFns]) fn(frame);
  }

  private flush(): void {
    while (this.queue.length > 0 && this.frameFns.size > 0) {
      const frame = this.queue.shift()!;
      if (this.queue.length === 0) this.queuedChars = 0;
      for (const fn of [...this.frameFns]) fn(frame);
    }
  }

  private onSocketClose(code: number, reason: string): void {
    this.closedCode = code;
    this.closedReason = reason;
    this.failJoin(new RuntimeError(classifyClose(code, reason)));
    for (const fn of [...this.closeFns]) fn(code);
  }

  /** Throws RuntimeError("closed") when the socket is not open, so a caller never believes a message was handed over when it was not. */
  send(m: ClientMessage): void {
    if (!this.isOpen) throw new RuntimeError("closed");
    this.ws.send(JSON.stringify(m));
  }

  /** Frames after `joined`. The first listener also receives, at once and in order, the frames that arrived before it (the replay). */
  onFrame(fn: (m: ServerMessage) => void): () => void {
    this.frameFns.add(fn);
    this.flush();
    return () => { this.frameFns.delete(fn); };
  }

  /** The runtime's close code. A listener added after the close is called at once (register onFrame first, so queued frames come before). */
  onClose(fn: (code: number) => void): () => void {
    if (this.closedCode !== null) { fn(this.closedCode); return () => {}; }
    this.closeFns.add(fn);
    return () => { this.closeFns.delete(fn); };
  }

  close(): void {
    this.queue.length = 0;
    this.queuedChars = 0;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, "closed");
    else if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
  }
}
