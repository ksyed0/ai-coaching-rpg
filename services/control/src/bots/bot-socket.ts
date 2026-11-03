import WebSocket from "ws";
import { parseBotFrame, type BotFrame } from "./bot-frames.js";
import type { SetTimer } from "../supervisor.js";

/**
 * US-0060: one loopback WebSocket of one live AI player to its session's runtime. The join carries exactly what the runtime needs to seat
 * the role by its code (no display name, no durable credential, no replay request). Nothing secret (the code, the reconnect token) is
 * ever put in an Error message or a log line.
 */
export const BOT_FORWARD_KEY = "scenecoach-bot";
export const BOT_AUTH_BACKOFF_MS = 65_000;
export const BOT_CLOSE_GRACE_MS = 2_000;
export const BOT_HANDSHAKE_RETRY_MS = 1_000;
const MAX_PAYLOAD_BYTES = 1024 * 1024;

/** The factory must pass `headers` and `maxPayload` on to the socket. */
export type WsFactory = (url: string, opts: { headers: Record<string, string>; maxPayload: number }) => WebSocket;
const defaultWs: WsFactory = (url, opts) => new WebSocket(url, opts);
const dataLength = (d: WebSocket.RawData): number => (Array.isArray(d) ? d.reduce((n, b) => n + b.length, 0) : d.byteLength);
const defaultSetTimer: SetTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); };

export type BotSocketOptions = {
  port: number; sessionId: string; roleId: string; participantId: string; code: string; reconnectToken?: string;
  onFrame: (f: BotFrame) => void;
  /** `info.byUs` is true when close() was called before the socket closed. Never called for a socket that did not open. */
  onClose: (code: number, info: { byUs: boolean }) => void; ws?: WsFactory; setTimer?: SetTimer;
  /** Receives short, secret-free diagnostics (an error name only). */
  log?: (m: string) => void;
};

class HandshakeRefused extends Error {
  constructor(readonly status: number) { super(`bot handshake refused (HTTP ${status})`); this.name = "HandshakeRefused"; }
}

export class BotSocket {
  private closing: Promise<void> | null = null;
  private closedByUs = false;

  private constructor(private readonly ws: WebSocket, private readonly setTimer: SetTimer) {}

  /** Connects and sends the join. A handshake answered by HTTP 503 (the per-key connection cap) is retried once after 1 s, then rejects. */
  static async open(o: BotSocketOptions): Promise<BotSocket> {
    const setTimer = o.setTimer ?? defaultSetTimer;
    try {
      return await BotSocket.attempt(o, setTimer);
    } catch (err) {
      if (!(err instanceof HandshakeRefused) || err.status !== 503) throw err;
    }
    await new Promise<void>((resolve) => { setTimer(resolve, BOT_HANDSHAKE_RETRY_MS); });
    return BotSocket.attempt(o, setTimer);
  }

  private static attempt(o: BotSocketOptions, setTimer: SetTimer): Promise<BotSocket> {
    return new Promise<BotSocket>((resolve, reject) => {
      const ws = (o.ws ?? defaultWs)(`ws://127.0.0.1:${o.port}`, { headers: { "X-Forwarded-For": BOT_FORWARD_KEY }, maxPayload: MAX_PAYLOAD_BYTES });
      const sock = new BotSocket(ws, setTimer);
      let settled = false;
      let opened = false;
      const fail = (err: Error) => { if (settled) return; settled = true; try { ws.terminate(); } catch { /* already gone */ } reject(err); };
      ws.on("unexpected-response", (_req, res) => { res.resume(); fail(new HandshakeRefused(res.statusCode ?? 0)); });
      ws.on("error", (err) => { if (!settled) fail(new Error(`bot socket could not connect (${(err as NodeJS.ErrnoException).code ?? err.name})`)); });
      ws.on("message", (data, isBinary) => {
        if (isBinary || dataLength(data) > MAX_PAYLOAD_BYTES) return;
        try { o.onFrame(parseBotFrame(data.toString())); } catch (err) { o.log?.(`bot frame handler failed: ${err instanceof Error ? err.name : "error"}`); }
      });
      ws.on("close", (code) => {
        if (!opened) { fail(new Error("bot socket closed before it opened")); return; }
        try { o.onClose(code, { byUs: sock.closedByUs }); } catch (err) { o.log?.(`bot close handler failed: ${err instanceof Error ? err.name : "error"}`); }
      });
      ws.on("open", () => {
        if (settled) return;
        settled = true; opened = true;
        const join: Record<string, unknown> = { type: "join", sessionId: o.sessionId, roleId: o.roleId, participantId: o.participantId, joinCode: o.code };
        if (o.reconnectToken !== undefined) join.reconnectToken = o.reconnectToken;
        ws.send(JSON.stringify(join));
        resolve(sock);
      });
    });
  }

  /** Speaks as the bot's role, only into the scene it decided in. A closed socket drops the line. */
  say(text: string, expectSceneId: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "say", text, expectSceneId }));
  }

  /** close(1000), resolving on the socket's `close` event; terminate() after 2 s if the peer never answers. Resolves at once when already closed. */
  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closedByUs = true;
    this.closing = new Promise<void>((resolve) => {
      const cancel = this.setTimer(() => { if (this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate(); }, BOT_CLOSE_GRACE_MS);
      this.ws.once("close", () => { cancel(); resolve(); });
      try { this.ws.close(1000); } catch { this.ws.terminate(); }
    });
    return this.closing;
  }
}
