import { describe, expect, it } from "vitest";
import { HEARTBEAT_MS, heartbeat, lastSeqOf, replayIncomplete, sseBody, sseFrame, SseWriter, type SseOut } from "../sse";
import { manualTimers } from "./fakes";

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

describe("sseFrame", () => {
  it("escapes CR and LF inside data and puts id first", () => {
    expect(sseFrame("event", { t: "a\r\nb" }, 7)).toBe('id: 7\nevent: event\ndata: {"t":"a\\r\\nb"}\n\n');
    expect(sseFrame("x", {})).toBe("event: x\ndata: {}\n\n");
  });
});

describe("SseWriter", () => {
  it("is stalled past the cap, ok again after a taken write, gone when out throws", () => {
    let take = false; let boom = false;
    const out: SseOut = { write: () => { if (boom) throw new Error("x"); return take; }, end() {} };
    const w = new SseWriter(out, 10);
    expect(w.write("12345")).toBe("ok"); // 5 pending, under the cap
    expect(w.write("123456")).toBe("stalled"); // 11 > 10
    take = true;
    expect(w.write("1")).toBe("ok"); // taken: pending resets
    take = false;
    expect(w.write("1234567890")).toBe("ok"); // 10 is not past the cap
    boom = true;
    expect(w.write("x")).toBe("gone");
  });
});

describe("heartbeat", () => {
  it("stops re-arming when beat returns false and on cancel", () => {
    const t = manualTimers();
    let beats = 0; let more = true;
    const cancel = heartbeat(t.setTimer, () => { beats++; return more; });
    t.fire(HEARTBEAT_MS); t.fire(HEARTBEAT_MS);
    expect(beats).toBe(2);
    expect(t.live()).toHaveLength(1);
    more = false;
    t.fire(HEARTBEAT_MS);
    expect(beats).toBe(3);
    expect(t.live()).toHaveLength(0);
    const t2 = manualTimers();
    const c2 = heartbeat(t2.setTimer, () => true);
    t2.fire(HEARTBEAT_MS);
    c2();
    expect(t2.live()).toHaveLength(0);
    cancel();
  });
});

describe("replayIncomplete", () => {
  it("is true for undefined and complete false", () => {
    expect(replayIncomplete(undefined)).toBe(true);
    expect(replayIncomplete({ afterSeq: 0, toSeq: 0, events: 0, complete: false })).toBe(true);
    expect(replayIncomplete({ afterSeq: 0, toSeq: 0, events: 0, complete: true })).toBe(false);
  });
});

describe("lastSeqOf", () => {
  it('gives 0 for null, "", "-1", "1e3" and 17 digits', () => {
    for (const v of [null, "", "-1", "1e3", "12345678901234567"]) expect(lastSeqOf(v)).toBe(0);
    expect(lastSeqOf("17")).toBe(17);
  });
});
