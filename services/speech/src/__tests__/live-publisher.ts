import {
  AudioFrame, AudioSource, LocalAudioTrack, Room, RoomEvent, TrackPublishOptions, TrackSource, type DisconnectReason,
} from "@livekit/rtc-node";

/**
 * US-0071 (EPIC-0003 voice A1b, Task 18): a TEST-ONLY LiveKit publisher for the opt-in live checks (`livekit.live.test.ts`). It stands
 * in for a participant's browser: it joins a seat room with a participant token and publishes a 16 kHz mono "microphone" track fed with
 * a tone, in real time (the AudioSource's queue paces `captureFrame`). It lives in services/speech because `lint:sdk` allows
 * `@livekit/rtc-node` only here; it is never imported by product code. It logs nothing (the rtc-node logger is silenced by the live
 * test before any room opens) and keeps no token.
 */
export const PUBLISH_RATE = 16_000;
/** 10 ms per pushed frame: a size the native core takes as is. */
const PUSH_SAMPLES = 160;

export type Publisher = {
  room: Room;
  /** Publishes one microphone track (`source` overrides the source, for the grant checks); resolves with its track sid. */
  publish(source?: TrackSource): Promise<string>;
  /** Unpublishes the current track (stopping it). */
  unpublish(): Promise<void>;
  /** Tone on (true), digital silence (false), or bursts of `onMs` tone and `offMs` silence; the track sends frames either way. */
  setTone(on: boolean | { onMs: number; offMs: number }): void;
  /** How many times a remote participant subscribed to one of this publisher's tracks (RoomEvent.LocalTrackSubscribed). */
  subscribedCount(): number;
  /** Resolves with the reason when the room disconnects without `disconnect` being called. */
  disconnected: Promise<DisconnectReason | undefined>;
  reconnecting(): number;
  reconnected(): number;
  disconnect(): Promise<void>;
};

/** A 440 Hz tone at about -12 dBFS (loud enough for the segmenter's noise gate after Opus). */
function toneFrame(offset: number, on: boolean): Int16Array {
  const out = new Int16Array(PUSH_SAMPLES);
  if (!on) return out;
  const amp = Math.round(32767 * 10 ** (-12 / 20));
  for (let i = 0; i < PUSH_SAMPLES; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * 440 * (offset + i)) / PUBLISH_RATE));
  return out;
}

export async function connectPublisher(url: string, token: string, o: { autoSubscribe?: boolean } = {}): Promise<Publisher> {
  const room = new Room();
  let subscribed = 0;
  let reconnecting = 0;
  let reconnected = 0;
  let closing = false;
  let onDisc!: (r: DisconnectReason | undefined) => void;
  const disconnected = new Promise<DisconnectReason | undefined>((r) => { onDisc = r; });
  room.on(RoomEvent.LocalTrackSubscribed, () => { subscribed++; });
  room.on(RoomEvent.Reconnecting, () => { reconnecting++; });
  room.on(RoomEvent.Reconnected, () => { reconnected++; });
  room.on(RoomEvent.Disconnected, (reason) => { if (!closing) onDisc(reason); });
  await room.connect(url, token, { autoSubscribe: o.autoSubscribe ?? false, dynacast: false });

  let source: AudioSource | undefined;
  let track: LocalAudioTrack | undefined;
  let sid: string | undefined;
  let tone: boolean | { onMs: number; offMs: number } = true;
  let sent = 0; // samples pushed since the start
  const isOn = (): boolean => {
    if (typeof tone === "boolean") return tone;
    const cycle = ((tone.onMs + tone.offMs) * PUBLISH_RATE) / 1000;
    return sent % cycle < (tone.onMs * PUBLISH_RATE) / 1000;
  };
  const pump = async (src: AudioSource): Promise<void> => {
    while (!src.closed && source === src) {
      const data = toneFrame(sent % PUBLISH_RATE, isOn());
      sent += PUSH_SAMPLES;
      try { await src.captureFrame(new AudioFrame(data, PUBLISH_RATE, 1, PUSH_SAMPLES)); } catch { break; }
    }
  };

  const unpublish = async (): Promise<void> => {
    const s = source;
    source = undefined;
    if (sid !== undefined && room.localParticipant) { try { await room.localParticipant.unpublishTrack(sid, true); } catch { /* already gone */ } }
    sid = undefined;
    track = undefined;
    if (s) await s.close().catch(() => undefined);
  };

  return {
    room,
    async publish(src = TrackSource.SOURCE_MICROPHONE) {
      if (source) await unpublish();
      const s = new AudioSource(PUBLISH_RATE, 1, 200);
      source = s;
      track = LocalAudioTrack.createAudioTrack("mic", s);
      void pump(s);
      const pub = await room.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: src }));
      sid = pub.sid;
      if (sid === undefined) throw new Error("the published track has no sid");
      return sid;
    },
    unpublish,
    setTone(on) { tone = on; },
    subscribedCount: () => subscribed,
    disconnected,
    reconnecting: () => reconnecting,
    reconnected: () => reconnected,
    async disconnect() {
      closing = true;
      await unpublish().catch(() => undefined);
      await room.disconnect().catch(() => undefined);
    },
  };
}
