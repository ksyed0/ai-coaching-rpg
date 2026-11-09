import { parseParticipantIdentity } from "@acr/adapters/livekit/identity";
import type { AudioIngest, FrameSink } from "./audio-ingest.js";
import { Reframer } from "./reframe.js";
import type { RoomConn, RoomPort, RoomTrack } from "./room-port.js";

/** The segmenter's frame: 20 ms of 16 kHz mono (R10). */
export const INGEST_FRAME_SAMPLES = 320;
/** The one sentence a failed LiveKit ingest rejects with (never a URL, a token, a room or an identity). */
export const LIVEKIT_INGEST_FAILED = "the LiveKit audio ingest stopped";

export type LiveKitStatus = "connected" | "failed" | "disconnected";
export type LiveKitJoinInfo = { url: string; token: string; room: string };
/** Returns a cancel function (the Supervisor's shape). */
export type SetTimer = (fn: () => void, ms: number) => () => void;

/** Batch 3 review F1: how long after a refused or unanswered join the seat room is joined again (while its role is still allowed). */
export const JOIN_RETRY_MS = 1_000;
/**
 * Batch 3 review F2: a track's stream that ends while the track is still published and its seat still records is subscribed again, at
 * most this many times in a row without a delivered frame; one more reports `failed`.
 */
export const MAX_TRACK_RESTARTS = 5;
/** Consecutive refused or unanswered joins of one seat room (while allowed) before the ingest reports `failed`. */
export const JOIN_ATTEMPTS = 3;
/** Control answered `livekit_join_refused` (paused, not recording, no seats yet, voice off, a minting failure). Fixed message. */
export class LiveKitJoinRefused extends Error {
  constructor() { super("the LiveKit join was refused"); this.name = "LiveKitJoinRefused"; }
}
/** Control did not answer the token request within the worker's wait. Fixed message. */
export class LiveKitJoinTimeout extends Error {
  constructor() { super("no LiveKit token in time"); this.name = "LiveKitJoinTimeout"; }
}
const realSetTimer: SetTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); };

/** One subscribed track: who it belongs to is fixed when it starts (from the identity) and never changes. */
type Sub = { trackSid: string; identity: string; roleId: string; generation: string; ended: boolean; iter?: AsyncIterator<Int16Array> };
type Room = {
  roleId: string; conn?: RoomConn; published: Map<string, RoomTrack>; subs: Map<string, Sub>; gone: boolean;
  /** trackSid -> restarts in a row without a delivered frame (MAX_TRACK_RESTARTS). */
  restarts: Map<string, number>;
};

/**
 * US-0071 (EPIC-0003 voice A1b, Task 7, R9, Review Focus 1 and 2): live audio from LiveKit, the worker's half of the privacy invariant at
 * the source.
 *  - **One connection per seat room.** A role that appears in the allowed set has its room joined (`join` asks control for a fresh
 *    worker token: never reused) and the connection is kept for the session; auto-subscribe is off (livekit-room.ts).
 *  - **Subscription.** A track is subscribed only when it is audio from a microphone, its identity parses as THIS room's role with the
 *    generation the allowed set names for it, and no other track of that identity is subscribed. Nothing else of a participant is read.
 *  - **Per-frame gate.** A track loop's role and generation are fixed when it starts; before EVERY frame it checks, synchronously, that
 *    the loop is still current and `allowed.get(role) === generation`, and ends (iterator `return`, then unsubscribe) the first time it
 *    is not. So a frame of an old identity that LiveKit still delivers after an unsubscribe is never attributed to the seat's new holder,
 *    and two tracks of one role never interleave.
 *  - `setAllowed` (called in the same synchronous step as the gate update, worker.ts) ends every loop no longer allowed at once,
 *    subscribes newly allowed tracks and joins newly allowed rooms. The worker passes an EMPTY set while paused or ended.
 *  - A track loop that ends by itself while the track is published and allowed subscribes it again (at most MAX_TRACK_RESTARTS in a
 *    row without a frame, then `failed`; batch 3 review F2).
 *  - A join control refused or did not answer (LiveKitJoinRefused, LiveKitJoinTimeout: a pause, a mute or a runtime restart while the
 *    join was pending) forgets the room quietly; while its role is allowed it is joined again after JOIN_RETRY_MS on the injected timer,
 *    and only JOIN_ATTEMPTS such joins in a row report `failed` (batch 3 review F1).
 *  - A failed open (or any other join failure), or an unexpected disconnect, of a room whose role is allowed reports `failed`/
 *    `disconnected` and rejects `start` with LIVEKIT_INGEST_FAILED (the worker then exits for a restart with fresh tokens); for a role
 *    no longer allowed the room is forgotten quietly and joined afresh when it is allowed again.
 * Never logs.
 */
export class LiveKitIngest implements AudioIngest {
  private allowed: ReadonlyMap<string, string> = new Map();
  private readonly rooms = new Map<string, Room>();
  private sink: FrameSink | null = null;
  private stopped = false;
  private settled = false;
  private resolveDone!: () => void;
  private rejectDone!: (e: Error) => void;
  private readonly done: Promise<void>;
  private readonly setTimer: SetTimer;
  /** Roles whose next join waits for JOIN_RETRY_MS (the timer's cancel); reconcile does not join them before. */
  private readonly retries = new Map<string, () => void>();
  /** Consecutive refused or unanswered joins per role while allowed; cleared by a connect. */
  private readonly joinMisses = new Map<string, number>();

  constructor(private readonly o: {
    room: RoomPort; join: (roleId: string) => Promise<LiveKitJoinInfo>; onStatus: (s: LiveKitStatus) => void; setTimer?: SetTimer;
  }) {
    this.setTimer = o.setTimer ?? realSetTimer;
    this.done = new Promise<void>((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
    this.done.catch(() => undefined); // the caller may attach its handler later
  }

  start(onFrame: FrameSink): Promise<void> {
    if (this.sink === null && !this.stopped) { this.sink = onFrame; this.reconcile(); }
    return this.done;
  }

  setAllowed(allowed: ReadonlyMap<string, string>): void {
    this.allowed = new Map(allowed);
    if (this.sink !== null && !this.stopped) this.reconcile();
  }

  async stop(): Promise<void> {
    if (this.stopped) { await this.done.catch(() => undefined); return; }
    this.stopped = true;
    const conns = this.closeAll();
    await Promise.all(conns.map((c) => c.disconnect().catch(() => undefined)));
    this.settle();
  }

  private reconcile(): void {
    for (const room of this.rooms.values()) this.reconcileRoom(room);
    for (const roleId of this.allowed.keys()) if (!this.rooms.has(roleId) && !this.retries.has(roleId)) this.openRoom(roleId);
  }

  private openRoom(roleId: string): void {
    const room: Room = { roleId, published: new Map(), subs: new Map(), gone: false, restarts: new Map() };
    this.rooms.set(roleId, room);
    void (async () => {
      let conn: RoomConn;
      let j: LiveKitJoinInfo;
      try { j = await this.o.join(roleId); }
      catch (err) {
        if (err instanceof LiveKitJoinRefused || err instanceof LiveKitJoinTimeout) this.joinMissed(room);
        else this.roomLost(room, "failed");
        return;
      }
      if (this.stopped || room.gone) return;
      try { conn = await this.o.room.open(j.url, j.token); }
      catch {
        this.roomLost(room, "failed");
        return;
      }
      if (this.stopped || room.gone) { void conn.disconnect().catch(() => undefined); return; }
      room.conn = conn;
      this.joinMisses.delete(roleId);
      this.o.onStatus("connected");
      conn.onTrack((t) => { if (!room.gone) { room.published.set(t.trackSid, t); this.reconcileRoom(room); } });
      conn.onTrackGone((t) => {
        if (room.gone) return;
        room.published.delete(t.trackSid);
        for (const sub of room.subs.values()) if (sub.trackSid === t.trackSid) this.endSub(room, sub);
        this.reconcileRoom(room); // another microphone track of the identity may take its place
      });
      conn.onDisconnected(() => this.roomLost(room, "disconnected"));
    })();
  }

  /**
   * Batch 3 review F1: control refused the join or did not answer. Never fatal at once: the room is forgotten; while its role is allowed
   * it is joined again after JOIN_RETRY_MS, and only the JOIN_ATTEMPTS-th miss in a row reports `failed`.
   */
  private joinMissed(room: Room): void {
    if (this.stopped || room.gone || this.rooms.get(room.roleId) !== room) return;
    room.gone = true;
    this.rooms.delete(room.roleId);
    const roleId = room.roleId;
    if (!this.allowed.has(roleId)) { this.joinMisses.delete(roleId); return; } // joined afresh when it is allowed again
    const misses = (this.joinMisses.get(roleId) ?? 0) + 1;
    this.joinMisses.set(roleId, misses);
    if (misses >= JOIN_ATTEMPTS) { this.o.onStatus("failed"); this.fail(); return; }
    const cancel = this.setTimer(() => {
      if (this.retries.get(roleId) !== cancel) return;
      this.retries.delete(roleId);
      if (this.stopped || this.rooms.has(roleId)) return;
      if (this.allowed.has(roleId)) this.openRoom(roleId); else this.joinMisses.delete(roleId);
    }, JOIN_RETRY_MS);
    this.retries.set(roleId, cancel);
  }

  /** The room could not be joined or dropped. Fatal only while its role is allowed; otherwise it is forgotten (joined afresh later). */
  private roomLost(room: Room, why: "failed" | "disconnected"): void {
    if (this.stopped || room.gone || this.rooms.get(room.roleId) !== room) return;
    room.gone = true;
    for (const sub of [...room.subs.values()]) this.endSub(room, sub);
    this.rooms.delete(room.roleId);
    if (!this.allowed.has(room.roleId)) return;
    this.o.onStatus(why);
    this.fail();
  }

  private reconcileRoom(room: Room): void {
    if (!room.conn || room.gone || this.stopped) return;
    const generation = this.allowed.get(room.roleId);
    for (const sub of [...room.subs.values()]) if (sub.generation !== generation || !room.published.has(sub.trackSid)) this.endSub(room, sub);
    if (generation === undefined) return;
    for (const t of room.published.values()) {
      if (t.kind !== "audio" || t.source !== "microphone") continue;
      const who = parseParticipantIdentity(t.identity);
      if (who === null || who.roleId !== room.roleId || who.generation !== generation) continue;
      if (room.subs.has(t.identity)) continue; // at most one track per identity (hence per role)
      this.startSub(room, room.conn, t, generation);
    }
  }

  private startSub(room: Room, conn: RoomConn, t: RoomTrack, generation: string): void {
    const sub: Sub = { trackSid: t.trackSid, identity: t.identity, roleId: room.roleId, generation, ended: false };
    room.subs.set(t.identity, sub);
    conn.subscribe(t.trackSid);
    let iter: AsyncIterator<Int16Array>;
    try { iter = conn.frames(t.trackSid, 16000, 1)[Symbol.asyncIterator](); }
    catch { this.endSub(room, sub); return; }
    sub.iter = iter;
    void this.loop(room, sub, iter);
  }

  /** Still allowed to deliver a frame of this loop: checked before every single frame. */
  private current(sub: Sub): boolean {
    return !this.stopped && !sub.ended && this.allowed.get(sub.roleId) === sub.generation;
  }

  private async loop(room: Room, sub: Sub, iter: AsyncIterator<Int16Array>): Promise<void> {
    const reframer = new Reframer(INGEST_FRAME_SAMPLES);
    try {
      for (;;) {
        if (!this.current(sub)) break;
        const r = await iter.next();
        if (r.done) break;
        let stop = false;
        for (const frame of reframer.push(r.value)) {
          if (!this.current(sub)) { stop = true; break; }
          room.restarts.delete(sub.trackSid);
          this.sink?.(sub.roleId, sub.generation, frame);
        }
        if (stop) break;
      }
    } catch { /* the stream failed: the track is ended below */ }
    if (sub.ended) return;
    // Batch 3 review F2: the stream ended by itself (a server-side unsubscribe, a failed subscription, or rtc-node closing a stream of a
    // track re-subscribed too fast) while the track is still published and the seat still records: nothing else would ever subscribe it
    // again (no publish or unpublish event comes), so it is subscribed again here, bounded.
    const again = this.current(sub) && !room.gone && room.published.has(sub.trackSid);
    this.endSub(room, sub, !again); // no unsubscribe before a re-subscribe: that would be a fast toggle of its own
    if (again) this.restartTrack(room, sub.trackSid);
  }

  private restartTrack(room: Room, trackSid: string): void {
    const n = (room.restarts.get(trackSid) ?? 0) + 1;
    room.restarts.set(trackSid, n);
    if (n > MAX_TRACK_RESTARTS) { this.o.onStatus("failed"); this.fail(); return; }
    this.reconcileRoom(room);
  }

  /** Ends a subscription at once: its loop delivers nothing more (it checks `ended`), its stream is closed, the track unsubscribed. */
  private endSub(room: Room, sub: Sub, unsubscribe = true): void {
    if (sub.ended) return;
    sub.ended = true;
    if (room.subs.get(sub.identity) === sub) room.subs.delete(sub.identity);
    try { void sub.iter?.return?.()?.catch?.(() => undefined); } catch { /* already closed */ }
    if (unsubscribe && room.conn && !room.gone) { try { room.conn.unsubscribe(sub.trackSid); } catch { /* the connection is going away */ } }
  }

  private closeAll(): RoomConn[] {
    for (const cancel of this.retries.values()) cancel();
    this.retries.clear();
    const conns: RoomConn[] = [];
    for (const room of this.rooms.values()) {
      for (const sub of [...room.subs.values()]) this.endSub(room, sub);
      room.gone = true;
      if (room.conn) conns.push(room.conn);
    }
    this.rooms.clear();
    return conns;
  }

  private fail(): void {
    if (this.settled) return;
    this.stopped = true;
    for (const c of this.closeAll()) void c.disconnect().catch(() => undefined);
    this.settled = true;
    this.rejectDone(new Error(LIVEKIT_INGEST_FAILED));
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveDone();
  }
}
