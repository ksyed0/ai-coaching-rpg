import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { ClientMessageSchema, type ServerMessage } from "./protocol.js";
import { HostError, type SessionHost } from "./session-host.js";
import { EngineError } from "../engine/session-engine.js";

export const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024; // a client this far behind is dropped rather than buffered forever

/** heartbeatMs: ping interval; a socket that has not answered the previous ping is terminated (frees half-open players). */
export async function startServer(opts: { port: number; hosts: Map<string, SessionHost>; log?: (m: string) => void; heartbeatMs?: number }): Promise<{ port: number; close(): Promise<void> }> {
  const log = opts.log ?? (() => {});
  const wss = new WebSocketServer({ port: opts.port, host: "0.0.0.0", maxPayload: MAX_PAYLOAD_BYTES });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  wss.on("error", (err) => log(`server error: ${err.message}`));
  const port = (wss.address() as { port: number }).port;
  log(`runtime listening on ws://0.0.0.0:${port}`);

  const tokenMatches = (a: string, b: string) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };

  // Liveness: ping every connection each period; one that never answered the previous ping is terminated, which
  // fires its close handler and frees its role (a laptop that slept would otherwise hold the role for minutes).
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const c of wss.clients) {
      if (!alive.has(c)) { c.terminate(); continue; }
      alive.delete(c);
      try { c.ping(); } catch (err) { log(`ping failed: ${(err as Error).message}`); }
    }
  }, opts.heartbeatMs ?? 15_000);
  heartbeat.unref();

  /** Which connection currently holds each player role, so a stale socket closing cannot free a rejoined role. */
  const holders = new Map<string, { ws: WebSocket; token: string }>();

  wss.on("connection", (ws: WebSocket) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
    let host: SessionHost | null = null;
    let who: string | "facilitator" | null = null;
    let participantId: string | null = null;
    let holderKey: string | null = null;
    let unsubscribe: (() => void) | null = null;

    const send = (m: ServerMessage) => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { ws.terminate(); return; }
        ws.send(JSON.stringify(m));
      } catch (err) { log(`send failed: ${(err as Error).message}`); }
    };
    const fail = (code: string, message: string) => send({ type: "error", code, message });

    async function handle(raw: string): Promise<void> {
      let json: unknown;
      try { json = JSON.parse(raw); } catch { return fail("bad_json", "message is not valid JSON"); }
      const parsed = ClientMessageSchema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return fail("bad_message", issue ? `${issue.path.join(".") || "message"}: ${issue.message}` : "invalid message");
      }
      const m = parsed.data;
      try {
        if (m.type === "join" || m.type === "join_facilitator") {
          if (host) return fail("already_joined", "this connection has already joined");
          const h = opts.hosts.get(m.sessionId);
          if (!h) return fail("unknown_session", "no such session");
          if (m.type === "join") {
            const key = `${m.sessionId}:${m.roleId}`;
            const prev = holders.get(key);
            const prevLive = !!prev && prev.ws !== ws && prev.ws.readyState === prev.ws.OPEN;
            // A role held by a live socket can only be taken over with that role's reconnect token (C1).
            if (prevLive && !(m.reconnectToken && tokenMatches(m.reconnectToken, prev.token))) return fail("role_taken", "role_taken");
            const { brief, privateFacts } = h.join(m.roleId, m.participantId);
            const token = randomUUID();
            holders.set(key, { ws, token });
            holderKey = key; participantId = m.participantId; who = m.roleId;
            if (prevLive) prev.ws.terminate();
            send({ type: "joined", roleId: m.roleId, brief, privateFacts, reconnectToken: token, state: h.snapshotFor(m.roleId) });
          } else {
            // KNOWN LIMITATION (slice 1, LAN only, ruling R22): there is no authentication. Any client that can
            // reach this port may join_facilitator (full event stream: whispers, NPC goals, GM reasoning, plus
            // start/command rights; the snapshot carries no role briefs) or claim any unclaimed player role and
            // read its brief. Follow-up: an optional FACILITATOR_TOKEN.
            who = "facilitator";
            send({ type: "joined", roleId: "facilitator", state: h.snapshotFor("facilitator") });
          }
          host = h;
          const viewer = who;
          unsubscribe = h.subscribe((e) => { const view = h.viewFor(viewer, e); if (view) send({ type: "event", event: view }); });
          return;
        }
        if (!host || !who) return fail("not_joined", "join first");
        if (m.type === "start") {
          if (who !== "facilitator") return fail("forbidden", "only the facilitator may start the session");
          await host.start();
        } else if (m.type === "say") {
          if (who === "facilitator") return fail("forbidden", "the facilitator cannot speak as a role");
          await host.onPlayerUtterance(who, m.text);
        } else if (m.type === "command") {
          if (who !== "facilitator") return fail("forbidden", "only the facilitator may send commands");
          if (host.engine.state.status === "idle") await host.start();
          await host.command(m.command);
        }
      } catch (err) {
        if (err instanceof HostError || err instanceof EngineError) return fail(err.code, err.message);
        log(`error: ${err instanceof Error ? err.stack : String(err)}`);
        fail("internal", "internal error");
      }
    }

    // Messages from one connection are handled in order.
    let chain: Promise<void> = Promise.resolve();
    ws.on("message", (raw) => {
      const text = raw.toString();
      chain = chain.then(() => handle(text)).catch((err) => log(`handler failed: ${(err as Error).message}`));
    });
    ws.on("error", (err) => log(`socket error: ${err.message}`)); // e.g. oversize frame; the ws library then closes it
    ws.on("close", () => {
      unsubscribe?.();
      if (holderKey && holders.get(holderKey)?.ws === ws) {
        holders.delete(holderKey);
        if (host && who && who !== "facilitator" && participantId) { host.release(who, participantId); log(`released ${who}`); }
      }
    });
  });

  return {
    port,
    close: () => new Promise<void>((resolve) => {
      clearInterval(heartbeat);
      for (const c of wss.clients) c.terminate();
      wss.close(() => resolve());
    }),
  };
}
