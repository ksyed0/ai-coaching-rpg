import type { RoomConn, RoomTrack } from "./room-port.js";

/**
 * US-0071 (EPIC-0003 voice A1b, Task 7): RtcConn, the RoomConn over an rtc-node Room. This file never names `@livekit/rtc-node`: it
 * works on the structural shapes below, and the library's values (event names, enums, AudioStream) come in as `RtcBindings` from
 * `livekit-room-native.ts`, the ONLY module that loads the native library (glibc builds only); only main.ts imports that, dynamically
 * and only with SPEECH_INGEST=livekit. The compiler checks the real Room against these shapes there. So RtcConn is unit-tested
 * against a stand-in Room and MEASURED by coverage (review finding 4); only the native wiring is excluded. Every privacy rule of the
 * ingest lives in LiveKitIngest and is tested against a fake.
 *  - auto-subscribe OFF (the native connect); a track is subscribed only when the ingest asks (`setSubscribed`).
 *  - audio is read with `AudioStream(track, { sampleRate: 16000, numChannels: 1, frameSizeMs: 20 })` (the ingest re-frames anyway).
 *  - nothing of a participant is read but its identity (set by the server from the token); never a name, metadata or attributes.
 *  - every room-event listener is guarded: a throw becomes a lost room (onDisconnected, once), never an uncaught exception (F5).
 *  - on Reconnected every subscription still wanted and not delivered is requested again (Task 18 live finding D59); a read whose
 *    subscription is not answered within SUBSCRIBE_WAIT_MS ends (D60), so the ingest's bounded re-subscribe takes over.
 */

/** What RtcConn reads of rtc-node's RemoteTrackPublication. */
export type RtcPublication = { readonly sid: string | undefined; readonly kind?: unknown; readonly source?: unknown; setSubscribed(subscribed: boolean): void };
/** What RtcConn reads of rtc-node's RemoteParticipant: its identity and publications, nothing else. */
export type RtcParticipant = { readonly identity: string; readonly trackPublications: ReadonlyMap<string, RtcPublication> };
/** rtc-node's RemoteTrack: opaque here, only handed back to `RtcBindings.audioStream`. */
export type RtcTrack = object;
/** What RtcConn uses of rtc-node's Room (the listener arguments are rtc-node's, per event; see the constructor). */
export type RtcRoom = {
  on(event: string, listener: (...args: never[]) => void): unknown;
  readonly remoteParticipants: ReadonlyMap<string, RtcParticipant>;
  disconnect(): Promise<void>;
};
type EventName = "TrackPublished" | "TrackUnpublished" | "ParticipantDisconnected" | "TrackSubscribed" | "TrackUnsubscribed"
  | "TrackSubscriptionFailed" | "Reconnected" | "Disconnected";
/** The rtc-node values RtcConn uses, injected so this module never loads the native library itself. */
export type RtcBindings = {
  RoomEvent: Record<EventName, string>;
  TrackKind: { KIND_AUDIO: unknown; KIND_VIDEO: unknown };
  TrackSource: { SOURCE_MICROPHONE: unknown };
  audioStream: (track: RtcTrack, o: { sampleRate: number; numChannels: number; frameSizeMs: number }) => AsyncIterable<{ sampleRate: number; channels: number; data: Int16Array }>;
};

/**
 * A1b Task 18 live finding D60: how long a read waits for its track after a subscribe. A subscription the server refuses is never
 * answered (LiveKit 1.13.11 sends neither TrackSubscribed nor TrackSubscriptionFailed); the read then ends, and the ingest subscribes
 * again, at most MAX_TRACK_RESTARTS times in a row, then reports `failed` (the worker exits for a restart with fresh tokens). Live, a
 * subscription came within about a second.
 */
export const SUBSCRIBE_WAIT_MS = 10_000;
/** Returns a cancel function (the Supervisor's shape). */
export type SetTimer = (fn: () => void, ms: number) => () => void;
export const realSetTimer: SetTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); };

/** The worker gets it through `createRtcRoomPort` (livekit-room-native.ts); its tests use a stand-in Room. */
export class RtcConn implements RoomConn {
  private readonly pubs = new Map<string, RtcPublication>();
  private readonly tracks = new Map<string, RtcTrack>();
  /** Track sids the ingest subscribed and has not unsubscribed (nor seen gone): re-requested on Reconnected while no track came (D59). */
  private readonly wanted = new Set<string>();
  /** Readers waiting for a subscribed track; resolved with null when it will not come (unsubscribed, gone, disconnected). */
  private readonly waiting = new Map<string, ((t: RtcTrack | null) => void)[]>();
  private readonly trackFns: ((t: RoomTrack) => void)[] = [];
  private readonly goneFns: ((t: { identity: string; trackSid: string }) => void)[] = [];
  private readonly discFns: (() => void)[] = [];
  private closing = false;
  private faulted = false;

  private readonly setTimer: SetTimer;

  constructor(private readonly room: RtcRoom, private readonly rtc: RtcBindings, o: { setTimer?: SetTimer } = {}) {
    this.setTimer = o.setTimer ?? realSetTimer;
    const { RoomEvent } = rtc;
    // Batch 3 review F5: every listener body runs guarded. rtc-node dispatches most of these events outside any try (its FFI event
    // handler), so a throw would escape as an uncaught exception and kill the worker; a fault is routed to onDisconnected instead.
    room.on(RoomEvent.TrackPublished, (pub: RtcPublication, p: RtcParticipant | undefined) => this.guard(() => { if (p) this.published(pub, p); }));
    room.on(RoomEvent.TrackUnpublished, (pub: RtcPublication, p: RtcParticipant) => this.guard(() => this.gone(pub.sid, p.identity)));
    room.on(RoomEvent.ParticipantDisconnected, (p: RtcParticipant) => this.guard(() => { for (const pub of p.trackPublications.values()) this.gone(pub.sid, p.identity); }));
    room.on(RoomEvent.TrackSubscribed, (track: RtcTrack, pub: RtcPublication) => this.guard(() => {
      const sid = pub.sid;
      if (sid === undefined) return;
      this.tracks.set(sid, track);
      this.release(sid, track);
    }));
    room.on(RoomEvent.TrackUnsubscribed, (_track: RtcTrack, pub: RtcPublication) => this.guard(() => { if (pub.sid !== undefined) { this.tracks.delete(pub.sid); this.release(pub.sid, null); } }));
    // Batch 3 review F2: a failed subscription ends the waiting read (the ingest re-subscribes, bounded) instead of hanging it.
    room.on(RoomEvent.TrackSubscriptionFailed, (sid: string) => this.guard(() => { this.release(sid, null); }));
    // A1b Task 18 live finding D59: after a full reconnect a subscription requested while the room was reconnecting never arrives
    // (observed against LiveKit 1.13.11: no TrackSubscribed, no TrackSubscriptionFailed). A plain setSubscribed(true) after
    // Reconnected brings it, so every wanted track that has no subscribed track yet is asked for again.
    room.on(RoomEvent.Reconnected, () => this.guard(() => {
      for (const sid of this.wanted) if (!this.tracks.has(sid)) this.pubs.get(sid)?.setSubscribed(true);
    }));
    room.on(RoomEvent.Disconnected, () => this.guard(() => {
      for (const sid of [...this.waiting.keys()]) this.release(sid, null);
      this.lost();
    }));
  }

  onTrack(fn: (t: RoomTrack) => void): void {
    this.trackFns.push(fn);
    for (const p of this.room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) this.published(pub, p, fn);
  }
  onTrackGone(fn: (t: { identity: string; trackSid: string }) => void): void { this.goneFns.push(fn); }
  onDisconnected(fn: () => void): void { this.discFns.push(fn); }

  /** Throws a fixed sentence when rtc-node refuses (the ingest retries, bounded); never called from inside a room event. */
  subscribe(trackSid: string): void {
    try { this.pubs.get(trackSid)?.setSubscribed(true); }
    catch { throw new Error("the LiveKit track could not be subscribed"); }
    this.wanted.add(trackSid);
  }
  unsubscribe(trackSid: string): void {
    // Batch 3 review F2: forget the subscribed track at once, so the next read waits for a FRESH TrackSubscribed. Otherwise a resume
    // faster than rtc-node's TrackUnsubscribed builds an AudioStream on the old track, which that event then closes.
    this.tracks.delete(trackSid);
    this.wanted.delete(trackSid);
    this.release(trackSid, null);
    try { this.pubs.get(trackSid)?.setSubscribed(false); } catch { /* the publication is already gone */ }
  }

  frames(trackSid: string, sampleRate: 16000, channels: 1): AsyncIterable<Int16Array> {
    const self = this;
    return (async function* () {
      const track = self.tracks.get(trackSid) ?? await self.waitFor(trackSid);
      if (track === null) return;
      const stream = self.rtc.audioStream(track, { sampleRate, numChannels: channels, frameSizeMs: 20 });
      for await (const f of stream) {
        if (f.sampleRate !== sampleRate || f.channels !== channels) continue; // never another format
        yield f.data;
      }
    })();
  }

  /** Waits for the subscribed track; null when it will not come (unsubscribed, gone, disconnected, or not within SUBSCRIBE_WAIT_MS). */
  private waitFor(trackSid: string): Promise<RtcTrack | null> {
    return new Promise<RtcTrack | null>((resolve) => {
      let cancel = (): void => {};
      const r = (t: RtcTrack | null): void => { cancel(); resolve(t); };
      const l = this.waiting.get(trackSid) ?? [];
      l.push(r);
      this.waiting.set(trackSid, l);
      // D60: only THIS waiter is ended by its own timer, never a later read of the same track.
      cancel = this.setTimer(() => {
        const list = this.waiting.get(trackSid);
        const i = list?.indexOf(r) ?? -1;
        if (!list || i < 0) return;
        list.splice(i, 1);
        if (list.length === 0) this.waiting.delete(trackSid);
        resolve(null);
      }, SUBSCRIBE_WAIT_MS);
    });
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    for (const sid of [...this.waiting.keys()]) this.release(sid, null);
    await this.room.disconnect();
  }

  private published(pub: RtcPublication, p: RtcParticipant, only?: (t: RoomTrack) => void): void {
    const sid = pub.sid;
    if (sid === undefined) return;
    this.pubs.set(sid, pub);
    const { TrackKind, TrackSource } = this.rtc;
    const kind: RoomTrack["kind"] = pub.kind === TrackKind.KIND_AUDIO ? "audio" : pub.kind === TrackKind.KIND_VIDEO ? "video" : "unknown";
    const t: RoomTrack = { identity: p.identity, trackSid: sid, kind, source: pub.source === TrackSource.SOURCE_MICROPHONE ? "microphone" : "other" };
    for (const fn of only ? [only] : this.trackFns) fn(t);
  }

  private gone(sid: string | undefined, identity: string): void {
    if (sid === undefined) return;
    this.pubs.delete(sid);
    this.tracks.delete(sid);
    this.wanted.delete(sid);
    this.release(sid, null);
    for (const fn of this.goneFns) fn({ identity, trackSid: sid });
  }

  private guard(body: () => void): void {
    try { body(); } catch { this.fault(); }
  }

  /** A listener failed: our view of the room cannot be trusted any more, so the room counts as lost (once). */
  private fault(): void {
    if (this.faulted) return;
    this.faulted = true;
    for (const sid of [...this.waiting.keys()]) { try { this.release(sid, null); } catch { /* a reader's own failure */ } }
    this.lost();
  }

  private lostOnce = false;
  private lost(): void {
    if (this.closing || this.lostOnce) return;
    this.lostOnce = true;
    for (const fn of this.discFns) { try { fn(); } catch { /* the ingest handles its own failures; nothing may escape here */ } }
  }

  private release(sid: string, t: RtcTrack | null): void {
    const l = this.waiting.get(sid);
    if (!l) return;
    this.waiting.delete(sid);
    for (const r of l) r(t);
  }
}
