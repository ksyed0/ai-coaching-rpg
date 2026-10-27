import { initPlayerView } from "@acr/events";
import type { RuntimeConnection, SetTimer } from "./runtime-connection";
import type { ClientMessage, JoinedFrame, ServerMessage } from "./wire";

// Bridges one participant's runtime socket to one server-sent-events response. No Next imports: the route hands in an `out` writer.
// The hub never reconnects: on a drop it tells the browser, whose native EventSource reconnects with Last-Event-ID, and the next request
// rejoins by credential with that lastSeq. It holds only the open streams; identity comes from the sealed cookie on each request.

export type SessionCookie = { sessionId: string; roleId: string; participantId: string; credential: string; logIdentity: string; expiresAt: number };
export type SseOut = { write(chunk: string): void; end(): void };

/** No stream is open for this participant (the routes answer 409 `no_stream`). */
export class NoStreamError extends Error {
  readonly code = "no_stream";
  constructor() { super("no stream is open for this participant"); this.name = "NoStreamError"; }
}

const RETRY_MS = 3_000;
const HEARTBEAT_MS = 15_000;
const DEFAULT_SEND_WAIT_MS = 300;
const CLOSE_SUPERSEDED = 4001;

type Stream = {
  key: string; sessionId: string; address: string; conn: RuntimeConnection; out: SseOut; ended: boolean;
  /** Replayed event frames still to drop because a reset already covers them. */
  skip: number;
  cancelHeartbeat: () => void; detach: () => void;
  /** Pending `send` calls waiting for an error frame. */
  waiters: Set<(m: ServerMessage | null) => void>;
};

// JSON.stringify escapes CR and LF, so a data line can never break the SSE framing.
const sse = (event: string, data: unknown, id?: number) => `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const keyOf = (c: { sessionId: string; roleId: string; participantId: string }) => JSON.stringify([c.sessionId, c.roleId, c.participantId]);

/** The joined fields a browser needs, picked one by one: the credential and the reconnect token never leave the BFF. */
function playerJoined(j: JoinedFrame) {
  return { roleId: j.roleId, brief: j.brief, privateFacts: j.privateFacts, consent: j.consent, scenes: j.scenes, state: j.state, logIdentity: j.logIdentity, replay: j.replay };
}

export class StreamHub {
  private readonly streams = new Map<string, Stream>();
  private readonly sendWaitMs: number;

  constructor(private readonly o: { maxStreams: number; maxStreamsPerSession: number; maxStreamsPerAddress: number; setTimer: SetTimer; now: () => number; sendWaitMs?: number }) {
    this.sendWaitMs = o.sendWaitMs ?? DEFAULT_SEND_WAIT_MS;
  }

  /**
   * Starts the stream. Takes ownership of `conn` in every case: on "capacity" it is closed and `out` ended with nothing written.
   * `joined` must be the frame `conn`'s join resolved with; the replay frames after it are still queued in `conn` and come out in order.
   */
  open(cookie: SessionCookie, address: string, conn: RuntimeConnection, joined: JoinedFrame, out: SseOut): { close(): void } | "capacity" {
    const key = keyOf(cookie);
    const prev = this.streams.get(key);
    // The participant's own older stream is about to be replaced, so it does not count against the caps.
    let total = 0; let perSession = 0; let perAddress = 0;
    for (const s of this.streams.values()) {
      if (s === prev) continue;
      total++;
      if (s.sessionId === cookie.sessionId) perSession++;
      if (s.address === address) perAddress++;
    }
    if (total >= this.o.maxStreams || perSession >= this.o.maxStreamsPerSession || perAddress >= this.o.maxStreamsPerAddress) {
      conn.close();
      try { out.end(); } catch { /* the client is gone */ }
      return "capacity";
    }
    if (prev) this.finish(prev, "superseded");

    const s: Stream = { key, sessionId: cookie.sessionId, address, conn, out, ended: false, skip: 0, cancelHeartbeat: () => {}, detach: () => {}, waiters: new Set() };
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
    if (s.ended) return { close: () => {} };
    const beat = () => { s.cancelHeartbeat = this.o.setTimer(() => { if (this.write(s, ": hb\n\n")) beat(); }, HEARTBEAT_MS); };
    beat();
    // onFrame first: frames queued in the connection come out before a close that already happened.
    const offFrame = conn.onFrame((m) => this.onFrame(s, m));
    const offClose = conn.onClose((code) => this.finish(s, code === CLOSE_SUPERSEDED ? "superseded" : "reconnecting"));
    s.detach = () => { offFrame(); offClose(); };
    if (s.ended) s.detach(); // the close was reported during onClose, before detach existed
    return { close: () => this.finish(s, null) };
  }

  /**
   * Sends over the participant's open stream connection (a new connection would supersede the stream). The runtime acks nothing
   * (consent, say): resolves with the first error frame within the bounded wait, else null.
   */
  async send(cookie: SessionCookie, m: ClientMessage): Promise<ServerMessage | null> {
    const s = this.streams.get(keyOf(cookie));
    if (!s || s.ended || !s.conn.isOpen) throw new NoStreamError();
    try { s.conn.send(m); } catch { throw new NoStreamError(); }
    return new Promise((resolve) => {
      let cancel = () => {};
      const done = (r: ServerMessage | null) => { s.waiters.delete(done); cancel(); resolve(r); };
      s.waiters.add(done);
      cancel = this.o.setTimer(() => done(null), this.sendWaitMs);
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
      // An error is the answer to a pending send; one nobody waits for (say the runtime's log failure notice) goes to the browser.
      if (s.waiters.size > 0) { for (const w of [...s.waiters]) w(m); return; }
      this.write(s, sse("error", { code: m.code, message: m.message }));
    }
    // Anything else (another joined, an unknown type) is not forwarded: the browser gets only frames it knows.
  }

  /** False when the stream is over (or the write failed, which ends it). */
  private write(s: Stream, chunk: string): boolean {
    if (s.ended) return false;
    try { s.out.write(chunk); return true; }
    catch { this.finish(s, null); return false; }
  }

  /** The one exit: writes the final event (if any), ends `out` once, cancels the heartbeat, frees the slot and closes the socket. */
  private finish(s: Stream, event: "superseded" | "reconnecting" | "ended" | null): void {
    if (s.ended) return;
    s.ended = true;
    if (this.streams.get(s.key) === s) this.streams.delete(s.key);
    s.cancelHeartbeat();
    s.detach();
    for (const w of [...s.waiters]) w(null);
    if (event) { try { s.out.write(sse(event, {})); } catch { /* the client is gone */ } }
    try { s.out.end(); } catch { /* already closed by the client */ }
    s.conn.close();
  }
}
