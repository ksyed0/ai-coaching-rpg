/**
 * US-0071 (EPIC-0003 voice A1b, Task 7): the LiveKit room as the ingest sees it, behind a port so the privacy rules are tested with a
 * fake (`__tests__/fake-room.ts`) and only `livekit-room-native.ts` loads `@livekit/rtc-node`. A track is described by what the ingest may use
 * and nothing more: the publisher's identity, the track's id, its kind and whether it is a microphone. Never a track name, a participant
 * name, metadata or attributes (Global Constraints).
 */
export type RoomTrack = { identity: string; trackSid: string; kind: "audio" | "video" | "unknown"; source: "microphone" | "other" };

export interface RoomConn {
  /** Every published remote track: those already in the room at once (on registration), then each new one. */
  onTrack(fn: (t: RoomTrack) => void): void;
  /** A track was unpublished or its participant left. */
  onTrackGone(fn: (t: { identity: string; trackSid: string }) => void): void;
  /** The connection dropped without `disconnect` being called. */
  onDisconnected(fn: () => void): void;
  subscribe(trackSid: string): void;
  unsubscribe(trackSid: string): void;
  /**
   * The track's audio as 16 kHz mono PCM chunks (any size). It may keep yielding frames buffered before an unsubscribe: the consumer
   * checks every frame itself and calls `return()` on the iterator to stop.
   */
  frames(trackSid: string, sampleRate: 16000, channels: 1): AsyncIterable<Int16Array>;
  disconnect(): Promise<void>;
}

export interface RoomPort {
  /** Connects to one seat room with a token minted for this connect only. Rejects on any failure (the message is never passed on). */
  open(url: string, token: string): Promise<RoomConn>;
}
