import { defineConfig } from "vitest/config";

// Default environment is node; a test file that needs the DOM starts with `// @vitest-environment jsdom`.
export default defineConfig({
  // JSX in .tsx tests: the automatic runtime, matching what Next compiles.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // e2e/** holds Playwright specs, which vitest must never pick up (pnpm test:coverage runs every package).
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Files the Next framework executes (pages, layouts, route files) are covered by e2e; logic in src/server and src/lib is gated.
      // src/proxy.ts (Next 16's middleware) is measured: headers.test.ts runs it.
      // src/demo is the web demo (`pnpm demo --web`): a test harness over a production build and real processes, run as its own
      // CI step (Web E2E), never by vitest.
      // src/lib/livekit-room-browser.ts (US-0071) is the thin wrapper over livekit-client, the one file that imports it: unit tests run
      // VoiceClient against a fake room instead; the wrapper is covered by the opt-in live checks and the browser e2e.
      // Review finding 4: the rule "disableMicrophone unpublishes the track" (not merely mutes it) is proven in CI ONLY against the fake
      // BrowserRoom; against a real LiveKit server it is proven only by the opt-in VOICE_LIVE=1 run, which CI does not execute.
      exclude: ["src/app/**", "src/demo/**", "src/**/*.test.{ts,tsx}", "src/**/__tests__/**", "src/server/test-support/**", "src/lib/livekit-room-browser.ts"],
      thresholds: { lines: 80 },
    },
  },
});
