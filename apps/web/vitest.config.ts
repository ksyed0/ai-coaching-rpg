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
      // Files the Next framework executes (pages, layouts, route handlers, middleware) are covered by e2e; logic in src/server and src/lib is gated.
      exclude: ["src/app/**", "src/middleware.ts", "src/**/*.test.{ts,tsx}", "src/__tests__/**"],
      thresholds: { lines: 80 },
    },
  },
});
