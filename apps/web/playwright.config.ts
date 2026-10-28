import { defineConfig, devices } from "@playwright/test";

// The sandbox ships a Chromium that may not match the pinned Playwright version: point PLAYWRIGHT_CHROMIUM_EXECUTABLE at it to launch that binary instead.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "e2e",
  // Each test starts its own stack (a runtime process, a relay and `next start`): one at a time keeps a loaded runner predictable.
  workers: 1,
  fullyParallel: false,
  // A generous default; each test sets its own explicit limit too. Nothing asserts elapsed time. No retries: a flaky test is a bug.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } } },
  ],
  use: { trace: "retain-on-failure" },
});
