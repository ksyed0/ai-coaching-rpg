import { randomUUID } from "node:crypto";
import { consoleEvent, consoleRoster, consoleState } from "./facilitator-copies";
import type { FacilitatorJoin } from "./facilitator-socket";
import type { RuntimeConnection, SetTimer } from "./runtime-connection";
import { DEFAULT_MAX_PENDING_BYTES, heartbeat, replayIncomplete, RETRY_MS, sseFrame as sse, SseWriter, type SseOut } from "./sse";
import type { CommandMessage, ServerMessage } from "./wire";
import type { SessionState } from "@acr/events";

// Bridges one facilitator runtime socket to one server-sent-events response. Unlike the player hub it holds no identity: the console
// cookie is checked by the route, and any number of tabs may watch one session. It never reconnects (the browser's EventSource does).
// Only constants are written as event names, and only copies from facilitator-copies.ts as data. Utterances, Game Master reasoning and
// whispers do reach the page, by design (the facilitator sees them); NPC secrets, participant ids and runtime error text do not.

export const MAX_FACILITATOR_STREAMS = 64;
/** How long a command waits for the runtime's answer before it is reported unconfirmed. */
export const COMMAND_TIMEOUT_MS = 10_000;
/** The result of one command sent over a tab's own runtime socket. */
export type CommandOutcome = { kind: "ok" } | { kind: "refused"; code: string } | { kind: "unconfirmed" } | { kind: "no_channel" } | { kind: "pending" };
/** Refusals the runtime sends without a ref (before it has parsed one); while a command is pending they answer it. */
const REFLESS_ANSWERS = new Set(["rate_limited", "bad_json", "bad_message"]);
/** The route writes `stopped` and `busy` itself. */
export type ConsoleStreamFinal = "reconnecting" | "ended" | "expired";
/** The runtime's error codes are short snake_case words; anything else is not forwarded as a code. */
const CODE_SHAPE = /^[a-z_]{1,40}$/;
const ERROR_MESSAGE = "the server reported an error";

type Pending = { ref: string; type: CommandMessage["type"]; resolve: (o: CommandOutcome) => void; cancelTimer: () => void };
type Stream = { channel: string; sessionId: string; pending: Pending | null; expiresAt: number; conn: RuntimeConnection; out: SseOut; writer: SseWriter; ended: boolean; skip: number; cancelHeartbeat: () => void; detach: () => void };

export type FacilitatorHubOptions = {
  setTimer: SetTimer; now: () => number; maxStreams?: number; maxPendingBytes?: number; newChannelId?: () => string;
  commandTimeoutMs?: number; newRef?: () => string;
};

export class FacilitatorHub {
  private readonly streams = new Map<string, Stream>();
  private readonly maxStreams: number;
  private readonly maxPendingBytes: number;
  private readonly newChannelId: () => string;
  private readonly commandTimeoutMs: number;
  private readonly newRef: () => string;

  constructor(private readonly o: FacilitatorHubOptions) {
    this.maxStreams = o.maxStreams ?? MAX_FACILITATOR_STREAMS;
    this.maxPendingBytes = o.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    this.newChannelId = o.newChannelId ?? randomUUID;
    this.commandTimeoutMs = o.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.newRef = o.newRef ?? randomUUID;
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
    const s: Stream = { channel, sessionId: a.sessionId, pending: null, expiresAt: a.expiresAt, conn, out, writer: new SseWriter(out, this.maxPendingBytes), ended: false, skip: 0, cancelHeartbeat: () => {}, detach: () => {} };
    this.streams.set(channel, s);
    s.writer.beginOpening();
    try {
      const frame = joined.frame;
      this.write(s, `retry: ${RETRY_MS}\n\n`);
      // Picked, never spread: `frame` is the runtime's whole object (hiddenFacts and notice included at runtime).
      this.write(s, sse("joined", { channel, scenes: (frame.scenes ?? []).map((c) => ({ id: c.id, title: c.title, goal: c.goal, timeBoxMinutes: c.timeBoxMinutes })) }));
      if (replayIncomplete(frame.replay)) {
        // The id moves Last-Event-ID to the snapshot; replayed events are already in it.
        const at = frame.state.lastSeq;
        this.write(s, sse("reset", { state: consoleState(frame.state as SessionState) }, Number.isSafeInteger(at) ? at : undefined));
        s.skip = frame.replay?.events ?? 0;
      }
      this.write(s, sse("roster", { entries: consoleRoster(joined.roster) }));
    } catch {
      // A copy that throws must not leak the slot or the connection.
      this.finish(s, "reconnecting");
    }
    s.writer.endOpening();
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

  /**
   * Sends one command over the tab's own runtime socket and resolves with the runtime's answer. One command per channel at a time; never
   * retried. A channel that is unknown, belongs to another session or has finished is `no_channel`.
   */
  send(a: { sessionId: string; channel: string; message: CommandMessage }): Promise<CommandOutcome> {
    const s = this.streams.get(a.channel);
    if (!s || s.ended || s.sessionId !== a.sessionId) return Promise.resolve({ kind: "no_channel" });
    if (s.pending) return Promise.resolve({ kind: "pending" });
    const ref = this.newRef();
    return new Promise<CommandOutcome>((resolve) => {
      const p: Pending = { ref, type: a.message.type, resolve, cancelTimer: () => {} };
      s.pending = p;
      p.cancelTimer = this.o.setTimer(() => this.settle(s, p, { kind: "unconfirmed" }), this.commandTimeoutMs);
      try { s.conn.send({ ...a.message, ref }); } catch { this.settle(s, p, { kind: "unconfirmed" }); }
    });
  }

  private settle(s: Stream, p: Pending, outcome: CommandOutcome): void {
    if (s.pending !== p) return;
    s.pending = null;
    p.cancelTimer();
    p.resolve(outcome);
  }

  private onFrame(s: Stream, m: ServerMessage): void {
    try { this.forward(s, m); } catch { this.finish(s, "reconnecting"); }
  }

  private forward(s: Stream, m: ServerMessage): void {
    if (s.ended) return;
    if (m.type === "ack") { // never forwarded; answers the pending command only when the ref is its own
      if (s.pending && s.pending.ref === m.ref) this.settle(s, s.pending, { kind: "ok" });
      return;
    }
    if (m.type === "error" && m.ref !== undefined) {
      if (s.pending && s.pending.ref === m.ref) this.settle(s, s.pending, { kind: "refused", code: CODE_SHAPE.test(m.code) ? m.code : "error" });
      return;
    }
    if (m.type === "error" && s.pending && REFLESS_ANSWERS.has(m.code)) {
      this.settle(s, s.pending, { kind: "refused", code: m.code });
      return;
    }
    if (m.type === "event") {
      if (s.skip > 0) { s.skip--; return; }
      const seq = m.event.seq;
      if (!this.write(s, sse("event", consoleEvent(m.event), Number.isSafeInteger(seq) ? seq : undefined))) return;
      if (m.event.type === "session.ended") {
        // end_now emits session.ended before its ack, and the stream ends here: the ended event is the confirmation.
        if (s.pending?.type === "end_now") this.settle(s, s.pending, { kind: "ok" });
        this.finish(s, "ended");
      }
    } else if (m.type === "roster") {
      if (m.audience === "facilitator") this.write(s, sse("roster", { entries: consoleRoster(m.entries) }));
    } else if (m.type === "error") {
      this.write(s, sse("error", { code: CODE_SHAPE.test(m.code) ? m.code : "error", message: ERROR_MESSAGE }));
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
    if (this.streams.get(s.channel) === s) this.streams.delete(s.channel);
    if (s.pending) this.settle(s, s.pending, { kind: "unconfirmed" });
    s.cancelHeartbeat();
    s.detach();
    if (event) { try { s.out.write(sse(event, {})); } catch { /* the client is gone */ } }
    try { s.out.end(); } catch { /* already closed by the client */ }
    s.conn.close();
  }
}
