import { randomUUID } from "node:crypto";
import { consoleEvent, consoleRoster, consoleState } from "./facilitator-copies";
import type { FacilitatorJoin } from "./facilitator-socket";
import type { RuntimeConnection, SetTimer } from "./runtime-connection";
import { DEFAULT_MAX_PENDING_BYTES, heartbeat, replayIncomplete, RETRY_MS, sseFrame as sse, SseWriter, type SseOut } from "./sse";
import type { ServerMessage } from "./wire";
import type { SessionState } from "@acr/events";

// Bridges one facilitator runtime socket to one server-sent-events response. Unlike the player hub it holds no identity: the console
// cookie is checked by the route, and any number of tabs may watch one session. It never reconnects (the browser's EventSource does).
// Only constants are written as event names, and only copies from facilitator-copies.ts as data: the runtime's text never reaches a page.

export const MAX_FACILITATOR_STREAMS = 64;
/** The route writes `stopped` and `busy` itself. */
export type ConsoleStreamFinal = "reconnecting" | "ended" | "expired";
const ERROR_MESSAGE = "the server reported an error";

type Stream = { expiresAt: number; conn: RuntimeConnection; out: SseOut; writer: SseWriter; ended: boolean; skip: number; cancelHeartbeat: () => void; detach: () => void };

export type FacilitatorHubOptions = {
  setTimer: SetTimer; now: () => number; maxStreams?: number; maxPendingBytes?: number; newChannelId?: () => string;
};

export class FacilitatorHub {
  private readonly streams = new Set<Stream>();
  private readonly maxStreams: number;
  private readonly maxPendingBytes: number;
  private readonly newChannelId: () => string;

  constructor(private readonly o: FacilitatorHubOptions) {
    this.maxStreams = o.maxStreams ?? MAX_FACILITATOR_STREAMS;
    this.maxPendingBytes = o.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    this.newChannelId = o.newChannelId ?? randomUUID;
  }

  size(): number { return this.streams.size; }

  /** Takes ownership of `conn` in every case: on "capacity" it is already closed and `out` ended with nothing written. */
  open(a: { sessionId: string; expiresAt: number; conn: RuntimeConnection; joined: FacilitatorJoin; out: SseOut }): { channel: string; close(): void } | "capacity" {
    const { conn, out, joined } = a;
    if (this.streams.size >= this.maxStreams) {
      conn.close();
      try { out.end(); } catch { /* the client is gone */ }
      return "capacity";
    }
    const channel = this.newChannelId();
    const s: Stream = { expiresAt: a.expiresAt, conn, out, writer: new SseWriter(out, this.maxPendingBytes), ended: false, skip: 0, cancelHeartbeat: () => {}, detach: () => {} };
    this.streams.add(s);
    const frame = joined.frame;
    this.write(s, `retry: ${RETRY_MS}\n\n`);
    // Picked, never spread: `frame` is the runtime's whole object (hiddenFacts and notice included at runtime).
    this.write(s, sse("joined", { channel, scenes: (frame.scenes ?? []).map((c) => ({ id: c.id, title: c.title, goal: c.goal, timeBoxMinutes: c.timeBoxMinutes })) }));
    if (replayIncomplete(frame.replay)) {
      // The id moves Last-Event-ID to the snapshot; replayed events are already in it.
      this.write(s, sse("reset", { state: consoleState(frame.state as SessionState) }, frame.state.lastSeq));
      s.skip = frame.replay?.events ?? 0;
    }
    this.write(s, sse("roster", { entries: consoleRoster(joined.roster) }));
    if (s.ended) return { channel, close: () => {} };
    s.cancelHeartbeat = heartbeat(this.o.setTimer, () => {
      if (s.expiresAt <= this.o.now()) { this.finish(s, "expired"); return false; }
      return this.write(s, ": hb\n\n");
    });
    const offFrame = conn.onFrame((m) => this.onFrame(s, m));
    const offClose = conn.onClose(() => this.finish(s, "reconnecting"));
    s.detach = () => { offFrame(); offClose(); };
    if (s.ended) s.detach();
    return { channel, close: () => this.finish(s, null) };
  }

  private onFrame(s: Stream, m: ServerMessage): void {
    if (s.ended) return;
    if (m.type === "event") {
      if (s.skip > 0) { s.skip--; return; }
      const seq = m.event.seq;
      if (!this.write(s, sse("event", consoleEvent(m.event), Number.isSafeInteger(seq) ? seq : undefined))) return;
      if (m.event.type === "session.ended") this.finish(s, "ended");
    } else if (m.type === "roster") {
      if (m.audience === "facilitator") this.write(s, sse("roster", { entries: consoleRoster(m.entries) }));
    } else if (m.type === "error") {
      this.write(s, sse("error", { code: m.code, message: ERROR_MESSAGE }));
    }
    // Anything else (another joined, an unknown type) is not forwarded.
  }

  private write(s: Stream, chunk: string): boolean {
    if (s.ended) return false;
    const r = s.writer.write(chunk);
    if (r === "gone") { this.finish(s, null); return false; }
    if (r === "stalled") { this.finish(s, "reconnecting"); return false; }
    return true;
  }

  private finish(s: Stream, event: ConsoleStreamFinal | null): void {
    if (s.ended) return;
    s.ended = true;
    this.streams.delete(s);
    s.cancelHeartbeat();
    s.detach();
    if (event) { try { s.out.write(sse(event, {})); } catch { /* the client is gone */ } }
    try { s.out.end(); } catch { /* already closed by the client */ }
    s.conn.close();
  }
}
