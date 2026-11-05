import { describe, expect, it } from "vitest";
import { MockModelProvider } from "../mock.js";
import { modelProviderContract } from "../contract.js";
import { ModelProviderError } from "../errors.js";

const LONG = Array.from({ length: 500 }, (_, i) => String(i + 1)).join(" ");
modelProviderContract(() => new MockModelProvider([(req) => (req.maxTokens >= 1000 ? LONG : "OK")]), {
  make: () => new MockModelProvider([new ModelProviderError("mock overloaded", { kind: "overloaded", transient: true, status: 503 })]), kind: "overloaded", transient: true,
});

describe("MockModelProvider", () => {
  it("replays scripted replies in order, then the default", async () => {
    const p = new MockModelProvider(["one", (req) => `echo:${req.messages.at(-1)?.content}`]);
    const read = async () => { let s = ""; for await (const c of p.stream({ system: "", messages: [{ role: "user", content: "hi" }], maxTokens: 8 })) s += c; return s; };
    expect(await read()).toBe("one");
    expect(await read()).toBe("echo:hi");
    expect(await read()).toBe("[mock reply]");
    expect(p.calls).toHaveLength(3);
  });
  it("streams word by word", async () => {
    const p = new MockModelProvider(["two words"]);
    const chunks: string[] = [];
    for await (const c of p.stream({ system: "", messages: [], maxTokens: 8 })) chunks.push(c);
    expect(chunks).toEqual(["two ", "words"]);
  });
  it("yields no chunks when the signal is already aborted", async () => {
    const p = new MockModelProvider(["two words"]);
    const ac = new AbortController();
    ac.abort();
    const chunks: string[] = [];
    for await (const c of p.stream({ system: "", messages: [], maxTokens: 8 }, ac.signal)) chunks.push(c);
    expect(chunks).toEqual([]);
  });
  describe("scripted failures", () => {
    const read = async (p: MockModelProvider) => { const out: string[] = []; for await (const c of p.stream({ system: "", messages: [], maxTokens: 8 })) out.push(c); return out; };
    const overloaded = () => new ModelProviderError("mock overloaded", { kind: "overloaded", transient: true, status: 503 });
    it("an Error entry is thrown on the first read, consumes one script slot and still records the call", async () => {
      const err = overloaded();
      const p = new MockModelProvider([err, "ok then"]);
      await expect(read(p)).rejects.toBe(err);
      expect(await read(p)).toEqual(["ok ", "then"]);
      expect(p.calls).toHaveLength(2);
    });
    it("{ text, thenFail } yields the words and then throws (a mid-stream failure)", async () => {
      const err = overloaded();
      const p = new MockModelProvider([{ text: "half a", thenFail: err }]);
      const seen: string[] = [];
      let thrown: unknown;
      try { for await (const c of p.stream({ system: "", messages: [], maxTokens: 8 })) seen.push(c); } catch (e) { thrown = e; }
      expect(seen).toEqual(["half ", "a"]);
      expect(thrown).toBe(err);
    });
    it("a plain Error entry works too (a permanent, untyped failure)", async () => {
      await expect(read(new MockModelProvider([new Error("boom")]))).rejects.toThrow("boom");
    });
  });
});
