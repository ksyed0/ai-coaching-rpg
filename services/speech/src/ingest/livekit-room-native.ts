import { createRequire } from "node:module";
import path from "node:path";
import { AudioStream, Room, RoomEvent, TrackKind, TrackSource, type RemoteTrack } from "@livekit/rtc-node";
import type { RoomPort } from "./room-port.js";
import { RtcConn, realSetTimer, type RtcBindings } from "./livekit-room.js";

/**
 * US-0071 (EPIC-0003 voice A1b, Task 7): the ONLY module that loads `@livekit/rtc-node` (a native library: glibc builds only), and only
 * main.ts imports it, dynamically and only with SPEECH_INGEST=livekit. Just the wiring that needs a real LiveKit server: the logger
 * silencing (R26), the connect, and the library values handed to RtcConn. It is covered by the opt-in live checks (Task 18) and is the
 * one file excluded from coverage; RtcConn itself (livekit-room.ts) is measured (review finding 4).
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

/** The library's own values for RtcConn (its tests use these too, so a renamed event fails there). */
export const rtcBindings: RtcBindings = {
  RoomEvent, TrackKind, TrackSource,
  // The track is the one rtc-node itself delivered with TrackSubscribed (RtcConn only hands it back).
  audioStream: (track, o) => new AudioStream(track as RemoteTrack, o),
};

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
      return new RtcConn(room, rtcBindings, { setTimer: realSetTimer });
    },
  };
}
