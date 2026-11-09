import { Room, RoomEvent, Track, setLogLevel } from "livekit-client";
import type { BrowserRoom } from "./voice-client";

// US-0071 (A1b Task 15): the ONLY file that imports livekit-client (lint:sdk allows it in apps/web only). SessionScreen loads it with a
// dynamic import on the first "Join with voice", so the library is a separate chunk that a page which never joins does not load.
// Excluded from unit coverage by name (vitest.config.ts): it is the thin wrapper over the real library, exercised by the opt-in live
// checks (Task 18) and the browser e2e.
//
// livekit-client 2.23.0, read from the installed source: `setMicrophoneEnabled(false)` only MUTES the published track (`track.mute()`);
// it does not unpublish. So `disableMicrophone` unpublishes the microphone track explicitly and stops it, and `enableMicrophone`
// publishes a new one: while muted the server holds no microphone track for this seat at all.

// The library logs through its own logger; warnings and errors only (never the token or a room detail at debug level).
setLogLevel("warn");

const CAPTURE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true } as const;

export function createBrowserRoom(): BrowserRoom {
  // `stopMicTrackOnMute` is a publish default in 2.23.0 (TrackPublishDefaults), not a top-level room option.
  const room = new Room({ adaptiveStream: false, dynacast: false, publishDefaults: { stopMicTrackOnMute: true } });
  return {
    async connect(url, token) {
      // Microphone only: nothing is subscribed (the token cannot subscribe anyway).
      await room.connect(url, token, { autoSubscribe: false });
    },
    async enableMicrophone() {
      await room.localParticipant.setMicrophoneEnabled(true, CAPTURE);
    },
    async disableMicrophone() {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (pub?.track) await room.localParticipant.unpublishTrack(pub.track, true);
    },
    async disconnect() {
      await room.disconnect(true);
    },
    onDisconnected(fn) {
      room.on(RoomEvent.Disconnected, () => fn());
    },
  };
}
