import { defineConfig } from "vitest/config";
export default defineConfig({
  // 60 s: whole-demo, socket and process tests are slow under coverage on a loaded machine (BUG-0006); nothing here measures elapsed time.
  test: { testTimeout: 60_000, hookTimeout: 60_000, include: ["src/**/*.test.ts"], coverage: { provider: "v8", thresholds: { lines: 80 } } },
});
