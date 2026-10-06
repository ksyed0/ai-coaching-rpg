import { randomUUID } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { ClientMessageSchema, type ServerMessage } from "./protocol.js";
import { HostError, type SessionHost } from "./session-host.js";
import { EngineError } from "../engine/session-engine.js";
import { AuthThrottle, DEFAULT_LIMITS, OPEN_SERVER_NOTICE, TokenBucket, WindowCounter, clientIp, ipKey, isValidToken, normalizeOrigin, secretsMatch, type Limits } from "./security.js";

/** A 2,000 character utterance is at most about 8 KiB of JSON, so 16 KiB leaves room and bounds what one frame can cost. */
export const MAX_PAYLOAD_BYTES = 16 * 1024;
const CLOSE_POLICY = 1008;
const MAX_BUFFERED_BYTES = 1024 * 1024; // a client this far behind is dropped rather than buffered forever

const DEFAULT_HEARTBEAT_MS = 15_000;
const MAX_TIMER_MS = 2_147_483_647; // the largest delay setInterval accepts

/** heartbeatMs: ping interval; a socket that has not answered the previous ping is terminated (frees half-open players). */
export type ServerOptions = {
  port: number; hosts: Map<string, SessionHost>; log?: (m: string) => void; heartbeatMs?: number;
  /** US-0017: when set, join_facilitator must present it. Unset keeps the server open (bootstrap prints a warning). Never logged. */
  facilitatorToken?: string;
  limits?: Partial<Limits>;
  /** Interface to bind (default 0.0.0.0). */
  host?: string;
  /** Origins a browser may connect from; a handshake that carries any other Origin is refused. Clients that send none are unaffected. */
  allowedOrigins?: string[];
  /** Read the per-address limits from the last X-Forwarded-For entry (only behind a proxy you control). */
  trustProxy?: boolean;
  /** Clock for the limiters (tests). */
  now?: () => number;
  /** The failed-login throttle (tests inject one to observe its counters). */
  authThrottle?: AuthThrottle;
};

export async function startServer(opts: ServerOptions): Promise<{ port: number; close(): Promise<void> }> {
  const log = opts.log ?? (() => {});
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  // BUG-0001: setInterval treats 0, negative, NaN and anything above 2^31-1 ms as 1 ms, which would terminate every socket almost at once.
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs > MAX_TIMER_MS) {
    throw new Error(`heartbeatMs must be a finite number of milliseconds greater than 0 and at most ${MAX_TIMER_MS}`);
  }
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const bindHost = opts.host ?? "0.0.0.0";
  const token = opts.facilitatorToken;
  if (token !== undefined && !isValidToken(token)) throw new Error("facilitatorToken is not a valid token (16 to 256 printable ASCII characters, no spaces)"); // the value is never shown
  const allowedOrigins = new Set((opts.allowedOrigins ?? []).map((o) => normalizeOrigin(o)).filter((o): o is string => o !== null));
  const trustProxy = opts.trustProxy === true;
  const authThrottle = opts.authThrottle ?? new AuthThrottle({ max: limits.maxAuthFailures, windowMs: limits.authWindowMs, blockMs: limits.authBlockMs, now });
  const perIp = new Map<string, number>(); // keyed by ipKey(ip)

  // The HTTP server only exists to run the upgrade checks (limits, Origin) before a WebSocket is allocated.
  const httpServer = http.createServer({ connectionsCheckingInterval: 1_000 }, (_req, res) => { res.writeHead(426, { "Content-Type": "text/plain", Connection: "close" }).end("Upgrade Required"); });
  httpServer.maxConnections = limits.maxConnections * 2 + 16; // raw sockets that never finish the handshake are bounded too
  httpServer.headersTimeout = Math.min(limits.joinTimeoutMs, 10_000); // an upgrade request is tiny: a client that has not finished it by now is dropped
  httpServer.requestTimeout = Math.min(limits.joinTimeoutMs, 10_000);
  // Raw sockets per address (idle or half-open ones included). Not applied behind a trusted proxy, where every client shares the proxy's address.
  const rawPerIp = new Map<string, number>();
  const rawCap = limits.maxConnectionsPerIp * 2;
  httpServer.on("connection", (sock) => {
    if (trustProxy) return;
    const key = ipKey(sock.remoteAddress ?? "unknown");
    const n = (rawPerIp.get(key) ?? 0) + 1;
    if (n > rawCap) {
      try { sock.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => sock.destroy()); } catch { /* the peer is gone */ }
      setTimeout(() => sock.destroy(), 200).unref(); // the guarantee when the peer never reads
      return;
    }
    rawPerIp.set(key, n);
    sock.once("close", () => { const left = (rawPerIp.get(key) ?? 1) - 1; if (left <= 0) rawPerIp.delete(key); else rawPerIp.set(key, left); });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const refuse = (socket: Duplex, status: number, reason: string, extra: Record<string, string> = {}) => {
    const lines = [`HTTP/1.1 ${status} ${reason}`, "Connection: close", "Content-Type: text/plain", "Content-Length: 0", ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)];
    try { socket.end(lines.join("\r\n") + "\r\n\r\n"); } catch { /* the peer is gone */ } finally { socket.destroy(); }
  };
  httpServer.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const ip = clientIp(req, trustProxy);
    const ipk = ipKey(ip);
    const blocked = authThrottle.blockedForMs(ip);
    if (blocked > 0) return refuse(socket, 429, "Too Many Requests", { "Retry-After": String(Math.ceil(blocked / 1000)) });
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(normalizeOrigin(origin) ?? "\u0000")) return refuse(socket, 403, "Forbidden");
    if (wss.clients.size >= limits.maxConnections || (perIp.get(ipk) ?? 0) >= limits.maxConnectionsPerIp) return refuse(socket, 503, "Service Unavailable");
    wss.handleUpgrade(req, socket, head, (ws) => {
      perIp.set(ipk, (perIp.get(ipk) ?? 0) + 1);
      ws.once("close", () => { const n = (perIp.get(ipk) ?? 1) - 1; if (n <= 0) perIp.delete(ipk); else perIp.set(ipk, n); });
      wss.emit("connection", ws, req);
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
    httpServer.listen(opts.port, bindHost);
  });
  httpServer.on("error", (err) => log(`server error: ${err.message}`));
  const port = (httpServer.address() as { port: number }).port;
  // Never log the configured host string (it comes from the environment): only the port and a word derived by comparison.
  const reach = /^(127(\.\d{1,3}){3}|::1|localhost)$/i.test(bindHost) ? "loopback only" : /^(0\.0\.0\.0|::)$/.test(bindHost) ? "all interfaces" : "one specific address";
  log(`runtime listening on port ${port} (bound to ${reach})`);

  // Liveness: ping every connection each period; one that never answered the previous ping is terminated, which
  // fires its close handler and frees its role (a laptop that slept would otherwise hold the role for minutes).
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const c of wss.clients) {
      if (!alive.has(c)) { c.terminate(); continue; }
      alive.delete(c);
      try { c.ping(); } catch (err) { log(`ping failed: ${(err as Error).message}`); }
    }
  }, heartbeatMs);
  heartbeat.unref();

  /** Which connection currently holds each player role, so a stale socket closing cannot free a rejoined role. */
  const holders = new Map<string, { ws: WebSocket; token: string }>();

  wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
    const ip = clientIp(req, trustProxy);
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
    let host: SessionHost | null = null;
    let who: string | "facilitator" | null = null;
    let participantId: string | null = null;
    let holderKey: string | null = null;
    let unsubscribe: (() => void) | null = null;
    const bucket = new TokenBucket(limits.msgRate, limits.msgBurst, now);
    const drops = new WindowCounter(limits.dropWindowMs, now);
    let queued = 0;
    let isFacilitator = false;
    // Once a connection is being closed (refused token, rate limit, queue cap) nothing already queued or still arriving may run.
    let closing = false;
    let authFailed = false;
    let killTimer: NodeJS.Timeout | null = null;
    const shut = (code: number, reason: string) => {
      if (closing) return;
      closing = true;
      ws.close(code, reason);
      killTimer = setTimeout(() => ws.terminate(), 250); // a CLOSING socket would otherwise keep emitting frames
      killTimer.unref();
    };
    /** A frame that arrives (or was queued) after a refusal: dropped, but a refused-token connection still counts each one against its address. */
    // At most ONE extra failure per connection, however many frames follow (so a flood costs O(1) here), and only for a real join_facilitator.
    let dropCounted = false; let dropParses = 0;
    const dropAfterClose = (raw?: string) => {
      if (dropCounted) return;
      if (authFailed) { dropCounted = true; authThrottle.fail(ip); return; }
      if (token === undefined || raw === undefined || dropParses >= 3 || !raw.includes("join_facilitator")) return;
      dropParses++;
      try { if ((JSON.parse(raw) as { type?: unknown } | null)?.type === "join_facilitator") { dropCounted = true; authThrottle.fail(ip); } } catch { /* not JSON: not a login attempt */ }
    };
    // Slowloris and idle sockets: a connection that has not joined in time is closed.
    const joinTimer = setTimeout(() => { if (!host) shut(CLOSE_POLICY, "join timeout"); }, limits.joinTimeoutMs);
    joinTimer.unref();

    const send = (m: ServerMessage) => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { ws.terminate(); return; }
        ws.send(JSON.stringify(m));
      } catch (err) { log(`send failed: ${(err as Error).message}`); }
    };
    const fail = (code: string, message: string) => send({ type: "error", code, message });

    async function handle(raw: string): Promise<void> {
      if (closing || ws.readyState !== ws.OPEN) return dropAfterClose(raw);
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
          if (m.type === "join_facilitator" && token !== undefined) {
            // One attempt per connection. The answer is generic (it does not say whether the token or the session was wrong) and
            // the token is compared as two SHA-256 digests in constant time. It is never logged or echoed.
            if (!secretsMatch(m.token ?? "", token)) {
              authFailed = true;
              authThrottle.fail(ip);
              log("facilitator join refused: unauthorized");
              fail("unauthorized", "unauthorized");
              shut(CLOSE_POLICY, "unauthorized");
              return;
            }
          }
          const h = opts.hosts.get(m.sessionId);
          if (!h) return fail("unknown_session", "no such session");
          if (m.type === "join") {
            if (m.roleId === "facilitator") return fail("unknown_role", "unknown_role"); // reserved: never a player role
            const key = `${m.sessionId}:${m.roleId}`;
            const prev = holders.get(key);
            const prevLive = !!prev && prev.ws !== ws && prev.ws.readyState === prev.ws.OPEN;
            // A role held by a live socket can only be taken over with that role's reconnect token (C1).
            if (prevLive && !(m.reconnectToken && secretsMatch(m.reconnectToken, prev.token))) return fail("role_taken", "role_taken");
            const { brief, privateFacts } = h.join(m.roleId, m.participantId);
            const token = randomUUID();
            holders.set(key, { ws, token });
            holderKey = key; participantId = m.participantId; who = m.roleId;
            if (prevLive) prev.ws.terminate();
            send({ type: "joined", roleId: m.roleId, brief, privateFacts, reconnectToken: token, state: h.snapshotFor(m.roleId) });
          } else {
            // With FACILITATOR_TOKEN set the token was checked above. Without it this branch is open to anyone who can reach
            // the port (bootstrap prints a warning at startup); see docs/THREAT_MODEL.md. Player roles are not token-protected.
            who = "facilitator"; isFacilitator = true;
            // Facilitator-only reminder when the server is open (never sent to players).
            send({ type: "joined", roleId: "facilitator", state: h.snapshotFor("facilitator"), hiddenFacts: h.hiddenFacts(), ...(token === undefined ? { notice: OPEN_SERVER_NOTICE } : {}) });
          }
          host = h;
          const viewer = who;
          unsubscribe = h.subscribe((e) => { const view = h.viewFor(viewer, e); if (view) send({ type: "event", event: view }); });
          return;
        }
        if (!host || !who) return fail("not_joined", "join first");
        if (m.type === "start") {
          if (!isFacilitator) return fail("forbidden", "only the facilitator may start the session");
          await host.start();
        } else if (m.type === "say") {
          if (isFacilitator) return fail("forbidden", "the facilitator cannot speak as a role");
          await host.onPlayerUtterance(who, m.text, { expectSceneId: m.expectSceneId });
        } else if (m.type === "command") {
          if (!isFacilitator) return fail("forbidden", "only the facilitator may send commands");
          if (host.engine.state.status === "idle") await host.start();
          await host.command(m.command, { expectSceneId: m.expectSceneId });
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
      if (closing || ws.readyState !== ws.OPEN) return dropAfterClose(raw.toString());
      if (!bucket.take()) {
        // Over the rate: drop the message. A client that keeps doing it is closed; other connections have their own buckets.
        if (drops.hit() >= limits.maxDrops) { fail("rate_limited", "too many messages: closing"); shut(CLOSE_POLICY, "rate limit"); return; }
        return fail("rate_limited", "too many messages: slow down");
      }
      if (queued >= limits.maxQueue) { shut(CLOSE_POLICY, "too many queued messages"); return; }
      queued++;
      const text = raw.toString();
      chain = chain.then(() => handle(text)).catch((err) => log(`handler failed: ${(err as Error).message}`)).finally(() => { queued--; });
    });
    ws.on("error", (err) => log(`socket error: ${err.message}`)); // e.g. oversize frame; the ws library then closes it
    ws.on("close", () => {
      clearTimeout(joinTimer);
      if (killTimer) clearTimeout(killTimer);
      closing = true;
      unsubscribe?.();
      if (holderKey && holders.get(holderKey)?.ws === ws) {
        holders.delete(holderKey);
        if (host && who && !isFacilitator && participantId) { host.release(who, participantId); log(`released ${who}`); }
      }
    });
  });

  return {
    port,
    close: () => new Promise<void>((resolve) => {
      clearInterval(heartbeat);
      for (const c of wss.clients) c.terminate();
      wss.close();
      httpServer.close(() => resolve());
      httpServer.closeAllConnections();
    }),
  };
}
