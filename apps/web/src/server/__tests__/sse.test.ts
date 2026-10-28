import { describe, expect, it } from "vitest";
import { sseBody } from "../sse";

const read = async (r: ReadableStreamDefaultReader<Uint8Array>) => new TextDecoder().decode((await r.read()).value);

describe("sseBody", () => {
  it("out.write returns false under backpressure (desiredSize <= 0) and true again once the consumer has read", async () => {
    const b = sseBody(16);
    expect(b.out.write("0123456789")).toBe(true); // 10 of 16 bytes queued
    expect(b.out.write("abcdef")).toBe(false); // 16 of 16: the consumer is behind
    expect(b.out.write("more")).toBe(false);
    const r = b.stream.getReader();
    expect(await read(r)).toBe("0123456789");
    expect(await read(r)).toBe("abcdef");
    expect(await read(r)).toBe("more");
    expect(b.out.write("x")).toBe(true);
  });

  it("end closes the body once; a write after the end or after the consumer cancelled throws", async () => {
    const b = sseBody();
    let cancels = 0;
    b.onCancel(() => { cancels++; });
    b.out.write("a");
    b.out.end();
    b.out.end();
    const r = b.stream.getReader();
    expect(await read(r)).toBe("a");
    expect((await r.read()).done).toBe(true);
    expect(() => b.out.write("late")).toThrow();
    expect(cancels).toBe(0);

    const c = sseBody();
    c.onCancel(() => { cancels++; });
    await c.stream.cancel();
    expect(cancels).toBe(1);
    expect(() => c.out.write("gone")).toThrow();
    c.out.end(); // harmless
  });
});
