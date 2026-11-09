import { describe, expect, it } from "vitest";
import { Reframer } from "../ingest/reframe.js";

// US-0071 (EPIC-0003 voice A1b, Task 7, R10): rtc-node's frame size is not the segmenter's; the ingest re-frames to exactly 320 samples.
const ramp = (from: number, n: number): Int16Array => Int16Array.from({ length: n }, (_, i) => (from + i) % 30000);

describe("Reframer (US-0071, A1b Task 7)", () => {
  it("160 + 160 samples give one frame", () => {
    const r = new Reframer(320);
    expect(r.push(ramp(0, 160))).toEqual([]);
    const out = r.push(ramp(160, 160));
    expect(out).toHaveLength(1);
    expect([...out[0]!]).toEqual([...ramp(0, 320)]);
  });

  it("500 samples give one frame and keep 180", () => {
    const r = new Reframer(320);
    expect(r.push(ramp(0, 500))).toHaveLength(1);
    const out = r.push(ramp(500, 140));
    expect(out).toHaveLength(1);
    expect([...out[0]!]).toEqual([...ramp(320, 320)]);
  });

  it("a chunk of several frames gives them all, each an independent copy", () => {
    const r = new Reframer(320);
    const chunk = ramp(0, 960);
    const out = r.push(chunk);
    expect(out).toHaveLength(3);
    chunk.fill(0);
    expect(out[2]![0]).toBe(640);
    for (const f of out) expect(f.length).toBe(320);
  });

  it("no sample is lost or duplicated over 10 000 random chunk sizes", () => {
    const r = new Reframer(320);
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    let sent = 0;
    const got: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      const n = next() % 1000;
      for (const f of r.push(ramp(sent, n))) got.push(...f);
      sent += n;
    }
    expect(got.length).toBe(Math.floor(sent / 320) * 320);
    for (let i = 0; i < got.length; i++) if (got[i] !== i % 30000) throw new Error(`sample ${i} is wrong`);
  });

  it("refuses a frame size that is not a positive whole number", () => {
    expect(() => new Reframer(0)).toThrow(RangeError);
    expect(() => new Reframer(1.5)).toThrow(RangeError);
  });
});
