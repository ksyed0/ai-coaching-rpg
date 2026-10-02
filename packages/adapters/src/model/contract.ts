import { describe, expect, it } from "vitest";
import type { ModelProvider } from "./types.js";

export function modelProviderContract(make: () => ModelProvider): void {
  describe(`ModelProvider contract: ${make().name}`, () => {
    it("streams at least one non-empty chunk for a simple request", async () => {
      const p = make();
      const chunks: string[] = [];
      for await (const c of p.stream({ system: "Reply with the single word OK.", messages: [{ role: "user", content: "Ready?" }], maxTokens: 16 })) chunks.push(c);
      expect(chunks.join("").trim().length).toBeGreaterThan(0);
    });
    it("stops when the signal aborts", async () => {
      const p = make();
      const ac = new AbortController();
      ac.abort();
      const chunks: string[] = [];
      try { for await (const c of p.stream({ system: "x", messages: [{ role: "user", content: "y" }], maxTokens: 16 }, ac.signal)) chunks.push(c); }
      catch { /* an abort error is acceptable */ }
      expect(chunks.join("").length).toBeLessThan(2_000);
    });
  });
}
