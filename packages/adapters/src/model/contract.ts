import { describe, expect, it } from "vitest";
import { ModelProviderError, type ModelErrorKind } from "./errors.js";
import type { ModelProvider } from "./types.js";

/**
 * `failing` (optional, never needed for a live gate): builds a provider whose NEXT call fails with a known classified error.
 * Every provider must then surface that failure as a ModelProviderError with the stated kind and transience, and a message
 * without raw control characters.
 */
export type FailingCase = { make: () => ModelProvider | Promise<ModelProvider>; kind: ModelErrorKind; transient: boolean };

export function modelProviderContract(make: () => ModelProvider, failing?: FailingCase): void {
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
    if (failing) {
      it("reports a provider failure as a typed ModelProviderError (kind, transient, clean message)", async () => {
        const p = await failing.make();
        let thrown: unknown;
        try { for await (const _chunk of p.stream({ system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 16 })) void _chunk; } catch (e) { thrown = e; }
        expect(thrown).toBeInstanceOf(ModelProviderError);
        expect(thrown).toMatchObject({ kind: failing.kind, transient: failing.transient });
        // eslint-disable-next-line no-control-regex
        expect((thrown as Error).message).not.toMatch(/[\u0000-\u001f\u007f]/);
      });
    }
  });
}
