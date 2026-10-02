import { WebSocketServer, type WebSocket } from "ws";
import { ClientMessageSchema, type ServerMessage } from "./protocol.js";
import { HostError, type SessionHost } from "./session-host.js";
import { EngineError } from "../engine/session-engine.js";

export const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024; // a client this far behind is dropped rather than buffered forever

export async function startServer(opts: { port: number; hosts: Map<string, SessionHost>; log?: (m: string) => void }): Promise<{ port: number; close(): Promise<void> }> {
  const log = opts.log ?? (() => {});
  const wss = new WebSocketServer({ port: opts.port, host: "0.0.0.0", maxPayload: MAX_PAYLOAD_BYTES });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  wss.on("error", (err) => log(`server error: ${err.message}`));
  const port = (wss.address() as { port: number }).port;
  log(`runtime listening on ws://0.0.0.0:${port}`);

  /** Which connection currently holds each player role, so a stale socket closing cannot free a rejoined role. */
  const holders = new Map<string, WebSocket>();

  wss.on("connection", (ws: WebSocket) => {
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
            const { brief, privateFacts } = h.join(m.roleId, m.participantId);
            const key = `${m.sessionId}:${m.roleId}`;
            const prev = holders.get(key);
            holders.set(key, ws);
            holderKey = key; participantId = m.participantId; who = m.roleId;
            if (prev && prev !== ws) prev.terminate();
            send({ type: "joined", roleId: m.roleId, brief, privateFacts, state: h.snapshotFor(m.roleId) });
          } else {
            who = "facilitator";
            send({ type: "joined", roleId: "facilitator", state: h.snapshotFor("facilitator") });
          }
          host = h;
          const filter = h.filterFor(who);
          unsubscribe = h.subscribe((e) => { if (filter(e)) send({ type: "event", event: e }); });
          return;
        }
        if (!host || !who) return fail("not_joined", "join first");
        if (m.type === "start") {
          if (who !== "facilitator") return fail("forbidden", "only the facilitator may start the session");
          await host.start();
        } else if (m.type === "say") {
          if (who === "facilitator") return fail("forbidden", "the facilitator cannot speak as a role");
          if (host.engine.state.status === "idle") await host.start();
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
      if (holderKey && holders.get(holderKey) === ws) {
        holders.delete(holderKey);
        if (host && who && who !== "facilitator" && participantId) host.release(who, participantId);
      }
    });
  });

  return {
    port,
    close: () => new Promise<void>((resolve) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => resolve());
    }),
  };
}
