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
    it("stops streaming after the signal aborts mid-stream", async () => {
      const p = make();
      const ac = new AbortController();
      let total = 0;
      let afterAbort = 0;
      let aborted = false;
      try {
        for await (const _chunk of p.stream({ system: "Count from 1 to 500 separated by single spaces. Output only the numbers.", messages: [{ role: "user", content: "Go." }], maxTokens: 2000 }, ac.signal)) {
          total++;
          if (aborted) afterAbort++;
          else { aborted = true; ac.abort(); }
        }
      } catch { /* an abort error is acceptable; continued streaming is not */ }
      expect(total).toBeGreaterThanOrEqual(1);
      expect(afterAbort).toBeLessThanOrEqual(1);
    });
  });
}
