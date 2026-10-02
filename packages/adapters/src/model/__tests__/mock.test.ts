import { describe, expect, it } from "vitest";
import { MockModelProvider } from "../mock.js";
import { modelProviderContract } from "../contract.js";

const LONG = Array.from({ length: 500 }, (_, i) => String(i + 1)).join(" ");
modelProviderContract(() => new MockModelProvider([(req) => (req.maxTokens >= 1000 ? LONG : "OK")]));

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
});
