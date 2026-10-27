import { initPlayerView } from "@acr/events";
import type { RuntimeConnection, SetTimer } from "./runtime-connection";
import type { ClientMessage, JoinedFrame, ServerMessage } from "./wire";

// Bridges one participant's runtime socket to one server-sent-events response. No Next imports: the route hands in an `out` writer.
// The hub never reconnects: on a drop it tells the browser, whose native EventSource reconnects with Last-Event-ID, and the next request
// rejoins by credential with that lastSeq. It holds only the open streams; identity comes from the sealed cookie on each request.

export type SessionCookie = { sessionId: string; roleId: string; participantId: string; credential: string; logIdentity: string; expiresAt: number };
/** `write` returns false when the consumer has not taken the chunk yet (backpressure) or is gone. */
export type SseOut = { write(chunk: string): boolean; end(): void };

/** No stream is open for this participant (the routes answer 409 `no_stream`). */
export class NoStreamError extends Error {
  readonly code = "no_stream";
  constructor() { super("no stream is open for this participant"); this.name = "NoStreamError"; }
}

/** The messages a player sends through `send`, and the runtime error codes each one can produce (ws-server.ts, session-host.ts, session-engine.ts). */
const SEND_ERRORS = {
  // giveConsent: refuseOnceStarting, holds, ConsentError; a failed seat write is `internal`. Facilitator sockets get `forbidden`.
  consent: ["consent_version", "already_started", "not_joined", "bad_message", "bad_json", "forbidden", "internal"],
  // withdrawConsent: refuseOnceStarting, holds.
  withdraw_consent: ["already_started", "not_joined", "bad_message", "bad_json", "forbidden", "internal"],
  // leave: refuseOnceStarting; anything else is a seat write failure.
  leave: ["already_started", "not_joined", "bad_message", "bad_json", "forbidden", "internal"],
  // onPlayerUtterance and engine.say. `log_failed` is left out: the runtime also sends it to everyone unasked, so it goes to the stream.
  say: ["not_started", "paused", "ended", "not_in_scene", "stale_scene", "unknown_role", "not_joined", "bad_message", "bad_json", "forbidden", "internal"],
} as const satisfies Record<string, readonly string[]>;
type SendType = keyof typeof SEND_ERRORS;
const isSendType = (t: string): t is SendType => Object.hasOwn(SEND_ERRORS, t);

const RETRY_MS = 3_000;
const HEARTBEAT_MS = 15_000;
const DEFAULT_SEND_WAIT_MS = 300;
const DEFAULT_MAX_PENDING_BYTES = 256 * 1024;
const CLOSE_SUPERSEDED = 4001;
/** Sent instead of the runtime's own text, so nothing the BFF did not choose reaches the page as a sentence. */
const ERROR_MESSAGE = "the server reported an error";

type Waiter = { accepts: readonly string[]; done: (m: ServerMessage | null) => void };
type Stream = {
  key: string; sessionId: string; address: string; expiresAt: number; conn: RuntimeConnection; out: SseOut; ended: boolean;
  /** Replayed event frames still to drop because a reset already covers them. */
  skip: number;
  /** Bytes written while the consumer signalled backpressure. */
  pendingBytes: number;
  cancelHeartbeat: () => void; detach: () => void;
  /** At most one `send` waits for its answer at a time; the next one is chained behind it. */
  waiter: Waiter | null;
  sendChain: Promise<unknown>;
};
type FinalEvent = "superseded" | "reconnecting" | "ended" | "expired";

// JSON.stringify escapes CR and LF, so a data line can never break the SSE framing.
const sse = (event: string, data: unknown, id?: number) => `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const keyOf = (c: { sessionId: string; roleId: string; participantId: string }) => JSON.stringify([c.sessionId, c.roleId, c.participantId]);

/**
 * The joined fields a browser needs, picked one by one: the credential and the reconnect token never leave the BFF. The nested values
 * (state, scenes, consent) are forwarded as the runtime sent them: the runtime already projects them for this player.
 */
function playerJoined(j: JoinedFrame) {
  return { roleId: j.roleId, brief: j.brief, privateFacts: j.privateFacts, consent: j.consent, scenes: j.scenes, state: j.state, logIdentity: j.logIdentity, replay: j.replay };
}

export type StreamHubOptions = {
  maxStreams: number; maxStreamsPerSession: number; maxStreamsPerAddress: number; setTimer: SetTimer; now: () => number;
  /** How long `send` waits for an error frame before it reports success (the runtime acks nothing). */
  sendWaitMs?: number;
  /** A consumer this far behind is dropped with `reconnecting` (its EventSource comes back and resumes from Last-Event-ID). */
  maxPendingBytes?: number;
};

export class StreamHub {
  private readonly streams = new Map<string, Stream>();
  private readonly sendWaitMs: number;
  private readonly maxPendingBytes: number;

  constructor(private readonly o: StreamHubOptions) {
    this.sendWaitMs = o.sendWaitMs ?? DEFAULT_SEND_WAIT_MS;
    this.maxPendingBytes = o.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  }

  /** Whether `open` would currently accept this stream. Reserves nothing: lets the route refuse before it connects and joins. */
  hasCapacity(cookie: SessionCookie, address: string): boolean {
    const prev = this.streams.get(keyOf(cookie));
    // The participant's own older stream is about to be replaced, so it does not count against the caps.
    let total = 0; let perSession = 0; let perAddress = 0;
    for (const s of this.streams.values()) {
      if (s === prev) continue;
      total++;
      if (s.sessionId === cookie.sessionId) perSession++;
      if (s.address === address) perAddress++;
    }
    return total < this.o.maxStreams && perSession < this.o.maxStreamsPerSession && perAddress < this.o.maxStreamsPerAddress;
  }

  /**
   * Starts the stream. Takes ownership of `conn` in every case: on "capacity" (the authoritative check) it is already closed and `out`
   * ended with nothing written. `joined` must be the frame `conn`'s join resolved with; the replay frames after it are still queued in
   * `conn` and come out in order. Of two streams for one participant, the one whose runtime join resolved last wins (the runtime has
   * already kicked the other), whatever order the requests reach `open` in.
   */
  open(cookie: SessionCookie, address: string, conn: RuntimeConnection, joined: JoinedFrame, out: SseOut): { close(): void } | "capacity" {
    const key = keyOf(cookie);
    const prev = this.streams.get(key);
    const s: Stream = {
      key, sessionId: cookie.sessionId, address, expiresAt: cookie.expiresAt, conn, out, ended: false, skip: 0, pendingBytes: 0,
      cancelHeartbeat: () => {}, detach: () => {}, waiter: null, sendChain: Promise.resolve(),
    };
    const noop = { close: () => {} };
    // An older join than the live stream's: the runtime has kicked it (its 4001 may still be on the way); the live stream stays.
    if (prev && prev.conn.joinOrder > conn.joinOrder) { this.finish(s, "superseded"); return noop; }
    // Already closed before it could start: never touch the live stream. A socket still closing (code not known yet) goes on below and
    // its close arrives through onClose with the real code, so a 4001 is never mistaken for a drop that the browser would retry.
    if (conn.closeCode !== null) { this.finish(s, conn.closeCode === CLOSE_SUPERSEDED ? "superseded" : "reconnecting"); return noop; }
    if (!this.hasCapacity(cookie, address)) {
      conn.close();
      try { out.end(); } catch { /* the client is gone */ }
      return "capacity";
    }
    if (prev) this.finish(prev, "superseded");

    this.streams.set(key, s);
    this.write(s, `retry: ${RETRY_MS}\n\n`);
    this.write(s, sse("joined", playerJoined(joined)));
    // The browser's projection cannot be continued: an incomplete or missing replay (lastSeq too old or past the head), or another log.
    const reset = !joined.replay || !joined.replay.complete || joined.logIdentity !== cookie.logIdentity;
    if (reset) {
      // The id moves Last-Event-ID to the snapshot, so the next reconnect resumes from there. Replayed events are already in the snapshot.
      this.write(s, sse("reset", initPlayerView(joined.state), joined.state.lastSeq));
      s.skip = joined.replay?.events ?? 0;
    }
    if (s.ended) return noop;
    const beat = () => {
      s.cancelHeartbeat = this.o.setTimer(() => {
        // The cookie's lifetime bounds the stream too: an expired one ends it (the browser treats it like signed out).
        if (s.expiresAt <= this.o.now()) { this.finish(s, "expired"); return; }
        if (this.write(s, ": hb\n\n")) beat();
      }, HEARTBEAT_MS);
    };
    beat();
    // onFrame first: frames queued in the connection come out before a close that already happened.
    const offFrame = conn.onFrame((m) => this.onFrame(s, m));
    const offClose = conn.onClose((code) => this.finish(s, code === CLOSE_SUPERSEDED ? "superseded" : "reconnecting"));
    s.detach = () => { offFrame(); offClose(); };
    if (s.ended) s.detach(); // the close was reported during onClose, before detach existed
    return { close: () => this.finish(s, null) };
  }

  /**
   * Sends a player message (say, consent, withdraw_consent, leave; anything else is refused) over the participant's open stream
   * connection: a new connection would supersede the stream. The runtime acks nothing, so this resolves with the first error frame
   * this message type can produce within the bounded wait, else null. Sends on one stream run one at a time, so an answer is never
   * taken by a send that was handed over later. (An error that arrives after its own wait cannot be told apart from the next send's;
   * the runtime has no correlation ids.)
   */
  async send(cookie: SessionCookie, m: ClientMessage): Promise<ServerMessage | null> {
    if (!isSendType(m.type)) throw new Error("this message type cannot be sent through the stream");
    const s = this.streams.get(keyOf(cookie));
    if (!s || s.ended || !s.conn.isOpen) throw new NoStreamError();
    const accepts = SEND_ERRORS[m.type];
    const run = s.sendChain.then(() => this.sendOne(s, m, accepts));
    s.sendChain = run.catch(() => undefined);
    return run;
  }

  private sendOne(s: Stream, m: ClientMessage, accepts: readonly string[]): Promise<ServerMessage | null> {
    if (s.ended || !s.conn.isOpen) return Promise.reject(new NoStreamError());
    try { s.conn.send(m); } catch { return Promise.reject(new NoStreamError()); }
    return new Promise((resolve) => {
      let cancel = () => {};
      const w: Waiter = { accepts, done: (r) => { if (s.waiter === w) s.waiter = null; cancel(); resolve(r); } };
      s.waiter = w;
      cancel = this.o.setTimer(() => w.done(null), this.sendWaitMs);
    });
  }

  private onFrame(s: Stream, m: ServerMessage): void {
    if (s.ended) return;
    if (m.type === "event") {
      if (s.skip > 0) { s.skip--; return; }
      const seq = m.event.seq;
      if (!this.write(s, sse("event", m.event, Number.isSafeInteger(seq) ? seq : undefined))) return;
      if (m.event.type === "session.ended") this.finish(s, "ended");
    } else if (m.type === "roster") {
      this.write(s, sse("roster", { audience: m.audience, entries: m.entries }));
    } else if (m.type === "error") {
      // The answer to the waiting send, if its message can produce this code; anything else (log_failed, rate_limited) goes to the page.
      const w = s.waiter;
      if (w && w.accepts.includes(m.code)) { w.done(m); return; }
      this.write(s, sse("error", { code: m.code, message: ERROR_MESSAGE }));
    }
    // Anything else (another joined, an unknown type) is not forwarded: the browser gets only frames it knows.
  }

  /** False when the stream is over (or the write failed or the consumer stalled, which ends it). */
  private write(s: Stream, chunk: string): boolean {
    if (s.ended) return false;
    let taken: boolean;
    try { taken = s.out.write(chunk); }
    catch { this.finish(s, null); return false; }
    if (taken) { s.pendingBytes = 0; return true; }
    s.pendingBytes += Buffer.byteLength(chunk);
    if (s.pendingBytes > this.maxPendingBytes) { this.finish(s, "reconnecting"); return false; }
    return true;
  }

  /** The one exit: writes the final event (if any), ends `out` once, cancels the heartbeat, frees the slot and closes the socket. */
  private finish(s: Stream, event: FinalEvent | null): void {
    if (s.ended) return;
    s.ended = true;
    if (this.streams.get(s.key) === s) this.streams.delete(s.key);
    s.cancelHeartbeat();
    s.detach();
    s.waiter?.done(null);
    if (event) { try { s.out.write(sse(event, {})); } catch { /* the client is gone */ } }
    try { s.out.end(); } catch { /* already closed by the client */ }
    s.conn.close();
  }
}
