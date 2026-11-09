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

/** One subscribed track: who it belongs to is fixed when it starts (from the identity) and never changes. */
type Sub = { trackSid: string; identity: string; roleId: string; generation: string; ended: boolean; iter?: AsyncIterator<Int16Array> };
type Room = { roleId: string; conn?: RoomConn; published: Map<string, RoomTrack>; subs: Map<string, Sub>; gone: boolean };

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
 *  - A failed join or open, or an unexpected disconnect, of a room whose role is allowed reports `failed`/`disconnected` and rejects
 *    `start` with LIVEKIT_INGEST_FAILED (the worker then exits for a restart with fresh tokens); for a role no longer allowed the room is
 *    forgotten quietly and joined afresh when it is allowed again.
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

  constructor(private readonly o: { room: RoomPort; join: (roleId: string) => Promise<LiveKitJoinInfo>; onStatus: (s: LiveKitStatus) => void }) {
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
    for (const roleId of this.allowed.keys()) if (!this.rooms.has(roleId)) this.openRoom(roleId);
  }

  private openRoom(roleId: string): void {
    const room: Room = { roleId, published: new Map(), subs: new Map(), gone: false };
    this.rooms.set(roleId, room);
    void (async () => {
      let conn: RoomConn;
      try {
        const j = await this.o.join(roleId);
        if (this.stopped || room.gone) return;
        conn = await this.o.room.open(j.url, j.token);
      } catch {
        this.roomLost(room, "failed");
        return;
      }
      if (this.stopped || room.gone) { void conn.disconnect().catch(() => undefined); return; }
      room.conn = conn;
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
          this.sink?.(sub.roleId, sub.generation, frame);
        }
        if (stop) break;
      }
    } catch { /* the stream failed: the track is ended below */ }
    if (!sub.ended) this.endSub(room, sub);
  }

  /** Ends a subscription at once: its loop delivers nothing more (it checks `ended`), its stream is closed, the track unsubscribed. */
  private endSub(room: Room, sub: Sub): void {
    if (sub.ended) return;
    sub.ended = true;
    if (room.subs.get(sub.identity) === sub) room.subs.delete(sub.identity);
    try { void sub.iter?.return?.()?.catch?.(() => undefined); } catch { /* already closed */ }
    if (room.conn && !room.gone) { try { room.conn.unsubscribe(sub.trackSid); } catch { /* the connection is going away */ } }
  }

  private closeAll(): RoomConn[] {
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
