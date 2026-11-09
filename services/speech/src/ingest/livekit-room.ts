import { createRequire } from "node:module";
import path from "node:path";
import {
  AudioStream, Room, RoomEvent, TrackKind, TrackSource, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication,
} from "@livekit/rtc-node";
import type { RoomConn, RoomPort, RoomTrack } from "./room-port.js";

/**
 * US-0071 (EPIC-0003 voice A1b, Task 7): the ONLY module that loads `@livekit/rtc-node` (a native library: glibc builds only), and only
 * main.ts imports it, dynamically and only with SPEECH_INGEST=livekit. A thin wrapper behind RoomPort: every privacy rule lives in
 * LiveKitIngest and is tested against a fake; this file is covered by the opt-in live checks (Task 18) and excluded from coverage.
 *  - auto-subscribe OFF; a track is subscribed only when the ingest asks (`RemoteTrackPublication.setSubscribed`).
 *  - audio is read with `AudioStream(track, { sampleRate: 16000, numChannels: 1, frameSizeMs: 20 })` (the ingest re-frames anyway).
 *  - nothing of a participant is read but its identity (set by the server from the token); never a name, metadata or attributes.
 *  - rtc-node's logger is set to silent first (R26, see `silenceRtcLogger`).
 *  - every room-event listener is guarded: a throw becomes a lost room (onDisconnected, once), never an uncaught exception (F5).
 *  - on Reconnected every subscription still wanted and not delivered is requested again (Task 18 live finding D59).
 */

/** rtc-node 1.2.1's logger: `dist/log.cjs` exports `log`, a pino logger named "lk-rtc" at level debug unless NODE_ENV=production. */
type PinoLike = { level: string };

/**
 * R26: rtc-node logs through its own pino logger to stdout, which is the worker's log file, and several of its warnings quote a
 * participant identity. The logger is not exported (the package exports only "."), so it is reached by its file next to the package's
 * resolved CommonJS entry: the same module instance the library itself uses (its ESM entry re-exports the CommonJS build). Set to
 * silent. Throws (and the worker then never opens a room) if the module is not where 1.2.1 has it.
 */
export function silenceRtcLogger(): void {
  const req = createRequire(import.meta.url);
  const entry = req.resolve("@livekit/rtc-node");
  const mod = req(path.join(path.dirname(entry), "log.cjs")) as { log?: PinoLike };
  if (!mod.log || typeof mod.log.level !== "string") throw new Error("the LiveKit client logger was not found");
  mod.log.level = "silent";
  if (mod.log.level !== "silent") throw new Error("the LiveKit client logger could not be silenced");
}

const kindOf = (k: TrackKind | undefined): RoomTrack["kind"] => (k === TrackKind.KIND_AUDIO ? "audio" : k === TrackKind.KIND_VIDEO ? "video" : "unknown");
const sourceOf = (s: TrackSource | undefined): RoomTrack["source"] => (s === TrackSource.SOURCE_MICROPHONE ? "microphone" : "other");

/** Exported for its tests only (a stand-in Room); the worker gets it through `createRtcRoomPort`. */
export class RtcConn implements RoomConn {
  private readonly pubs = new Map<string, RemoteTrackPublication>();
  private readonly tracks = new Map<string, RemoteTrack>();
  /** Track sids the ingest subscribed and has not unsubscribed (nor seen gone): re-requested on Reconnected while no track came (D59). */
  private readonly wanted = new Set<string>();
  /** Readers waiting for a subscribed track; resolved with null when it will not come (unsubscribed, gone, disconnected). */
  private readonly waiting = new Map<string, ((t: RemoteTrack | null) => void)[]>();
  private readonly trackFns: ((t: RoomTrack) => void)[] = [];
  private readonly goneFns: ((t: { identity: string; trackSid: string }) => void)[] = [];
  private readonly discFns: (() => void)[] = [];
  private closing = false;
  private faulted = false;

  constructor(private readonly room: Room) {
    // Batch 3 review F5: every listener body runs guarded. rtc-node dispatches most of these events outside any try (its FFI event
    // handler), so a throw would escape as an uncaught exception and kill the worker; a fault is routed to onDisconnected instead.
    room.on(RoomEvent.TrackPublished, (pub, p) => this.guard(() => { if (p) this.published(pub, p); }));
    room.on(RoomEvent.TrackUnpublished, (pub, p) => this.guard(() => this.gone(pub.sid, p.identity)));
    room.on(RoomEvent.ParticipantDisconnected, (p) => this.guard(() => { for (const pub of p.trackPublications.values()) this.gone(pub.sid, p.identity); }));
    room.on(RoomEvent.TrackSubscribed, (track, pub) => this.guard(() => {
      const sid = pub.sid;
      if (sid === undefined) return;
      this.tracks.set(sid, track);
      this.release(sid, track);
    }));
    room.on(RoomEvent.TrackUnsubscribed, (_track, pub) => this.guard(() => { if (pub.sid !== undefined) { this.tracks.delete(pub.sid); this.release(pub.sid, null); } }));
    // Batch 3 review F2: a failed subscription ends the waiting read (the ingest re-subscribes, bounded) instead of hanging it.
    room.on(RoomEvent.TrackSubscriptionFailed, (sid) => this.guard(() => { this.release(sid, null); }));
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
      const track = self.tracks.get(trackSid) ?? await new Promise<RemoteTrack | null>((r) => { const l = self.waiting.get(trackSid) ?? []; l.push(r); self.waiting.set(trackSid, l); });
      if (track === null) return;
      const stream = new AudioStream(track, { sampleRate, numChannels: channels, frameSizeMs: 20 });
      for await (const f of stream) {
        if (f.sampleRate !== sampleRate || f.channels !== channels) continue; // never another format
        yield f.data;
      }
    })();
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    for (const sid of [...this.waiting.keys()]) this.release(sid, null);
    await this.room.disconnect();
  }

  private published(pub: RemoteTrackPublication, p: RemoteParticipant, only?: (t: RoomTrack) => void): void {
    const sid = pub.sid;
    if (sid === undefined) return;
    this.pubs.set(sid, pub);
    const t: RoomTrack = { identity: p.identity, trackSid: sid, kind: kindOf(pub.kind), source: sourceOf(pub.source) };
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

  private release(sid: string, t: RemoteTrack | null): void {
    const l = this.waiting.get(sid);
    if (!l) return;
    this.waiting.delete(sid);
    for (const r of l) r(t);
  }
}

/** The real RoomPort. Silences rtc-node's logger before anything else; a failed connect rejects with a fixed sentence. */
export function createRtcRoomPort(): RoomPort {
  silenceRtcLogger();
  return {
    async open(url, token) {
      const room = new Room();
      try {
        await room.connect(url, token, { autoSubscribe: false, dynacast: false });
      } catch {
        await room.disconnect().catch(() => undefined);
        throw new Error("the LiveKit room could not be joined");
      }
      return new RtcConn(room);
    },
  };
}
