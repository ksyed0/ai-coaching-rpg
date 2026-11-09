import { defineConfig } from "vitest/config";
export default defineConfig({
  // 60 s: whole-demo, socket and process tests are slow under coverage on a loaded machine (BUG-0006); nothing here measures elapsed time.
  // US-0071: src/ingest/livekit-room-native.ts is the only module that loads the native @livekit/rtc-node (logger silencing, connect,
  // the library values handed to RtcConn); it needs a LiveKit server and is covered by the opt-in live checks (A1b Task 18), so it is
  // left out of the coverage count by name. RtcConn (livekit-room.ts: re-subscribe on Reconnected, the per-read subscribe timeout,
  // fault-to-lost routing) is measured like any other file (review finding 4).
  test: {
    testTimeout: 60_000, hookTimeout: 60_000, include: ["src/**/*.test.ts"],
    coverage: { provider: "v8", thresholds: { lines: 80 }, exclude: ["src/ingest/livekit-room-native.ts", "src/**/__tests__/**"] },
  },
});
