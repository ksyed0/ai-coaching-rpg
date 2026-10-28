import { defineConfig, devices } from "@playwright/test";

// The sandbox ships a Chromium that may not match the pinned Playwright version: point PLAYWRIGHT_CHROMIUM_EXECUTABLE at it to launch that binary instead.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "e2e",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } } },
  ],
  use: { baseURL: process.env.WEB_BASE_URL },
});
