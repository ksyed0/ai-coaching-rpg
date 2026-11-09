import { defineConfig } from "vitest/config";
export default defineConfig({
  // 60 s: whole-demo, socket and process tests are slow under coverage on a loaded machine (BUG-0006); nothing here measures elapsed time.
  // US-0071: src/ingest/livekit-room.ts is the thin wrapper around the native @livekit/rtc-node; it needs a LiveKit server and is covered
  // by the opt-in live checks (A1b Task 18), so it is left out of the coverage count by name.
  test: {
    testTimeout: 60_000, hookTimeout: 60_000, include: ["src/**/*.test.ts"],
    coverage: { provider: "v8", thresholds: { lines: 80 }, exclude: ["src/ingest/livekit-room.ts", "src/**/__tests__/**"] },
  },
});
