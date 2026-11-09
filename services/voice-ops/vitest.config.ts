import { defineConfig } from "vitest/config";
export default defineConfig({
  // 60 s: the real-process and real-file tests are slow under coverage on a loaded machine (BUG-0006); nothing here measures elapsed time.
  // US-0072 (A1c, K1): src/cli.ts is thin wiring of real built-ins (process, signals, sockets); it is left out of the coverage count by
  // name and covered by the real-process test of the plan's Task 7.
  test: {
    testTimeout: 60_000, hookTimeout: 60_000, include: ["src/**/*.test.ts"],
    coverage: { provider: "v8", thresholds: { lines: 80 }, exclude: ["src/cli.ts", "src/**/__tests__/**"] },
  },
});
