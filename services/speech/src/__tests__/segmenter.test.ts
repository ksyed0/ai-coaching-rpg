import { describe, expect, it } from "vitest";
import { DEFAULT_SEGMENTER, Segmenter, type SegmentOut, type SegmenterSettings } from "../segmenter.js";
import { concat, frames, silence, tone } from "./signals.js";

const LOUD = -20;

/** Pushes the whole signal frame by frame; returns every emitted segment and how many times `started` was reported. */
function run(pcm: Int16Array, s: Partial<SegmenterSettings> = {}, o: { flush?: boolean } = {}): { segs: SegmentOut[]; starts: number; seg: Segmenter } {
  const seg = new Segmenter({ ...DEFAULT_SEGMENTER, ...s });
  const segs: SegmentOut[] = [];
  let starts = 0;
  for (const f of frames(pcm)) {
    const r = seg.push(f);
    if (r.started) starts++;
    segs.push(...r.segments);
  }
  if (o.flush) segs.push(...seg.flush());
  return { segs, starts, seg };
}

describe("Segmenter (US-0070, spec 7.1)", () => {
  it("has the defaults of the overview", () => {
    expect(DEFAULT_SEGMENTER).toEqual({ hangoverMs: 500, maxSegmentMs: 2500, frameMs: 20, thresholdDbfs: -45, leadInMs: 200, minSpeechMs: 300, splitSearchMs: 1000 });
  });

  it("1 s tone between silences gives one segment with 200 ms lead-in and endMs one hangover after the tone", () => {
    const { segs } = run(concat(silence(1000), tone(1000, LOUD), silence(1000)));
    expect(segs).toHaveLength(1);
    const s = segs[0]!;
    expect(s.reason).toBe("silence");
    expect(s.startMs).toBe(800);
    expect(s.lastSpeechMs).toBe(2000);
    expect(s.endMs).toBe(2500);
    expect(s.speechMs).toBe(1000);
    expect(s.pcm.length).toBe(16 * (2500 - 800));
    expect(s.meanDbfs).toBeLessThan(LOUD);
    expect(s.meanDbfs).toBeGreaterThan(-45);
  });

  it("a 240 ms tone is dropped (under minSpeechMs), and the drop is reported with its last speech time", () => {
    const seg = new Segmenter(DEFAULT_SEGMENTER);
    const out: SegmentOut[] = [];
    const dropped: number[] = [];
    for (const f of frames(concat(silence(400), tone(240, LOUD), silence(1000)))) {
      const r = seg.push(f);
      out.push(...r.segments);
      if (r.dropped) dropped.push(r.dropped.lastSpeechMs);
    }
    expect(out).toEqual([]);
    expect(dropped).toEqual([640]);
    expect(seg.speaking).toBe(false);
  });

  it("two tones 400 ms apart with hangover 500 merge into one; 600 ms apart split into two", () => {
    const merged = run(concat(silence(300), tone(600, LOUD), silence(400), tone(600, LOUD), silence(800))).segs;
    expect(merged.map((s) => [s.startMs, s.endMs, s.speechMs])).toEqual([[100, 2400, 1200]]);
    const two = run(concat(silence(300), tone(600, LOUD), silence(600), tone(600, LOUD), silence(800))).segs;
    expect(two.map((s) => [s.startMs, s.endMs, s.reason])).toEqual([[100, 1400, "silence"], [1400, 2600, "silence"]]);
    // The 100 ms of silence after the first close is the second segment's lead-in; nothing of the first is repeated.
    expect(two[1]!.pcm.length).toBe(16 * 1200);
  });

  it("a 7 s tone with maxSegmentMs 2500 splits at 2500 and 5000 when the signal is flat (latest frame wins the tie)", () => {
    const { segs, starts } = run(concat(tone(7000, LOUD), silence(1000)));
    expect(segs.map((s) => [s.startMs, s.endMs, s.reason])).toEqual([[0, 2500, "split"], [2500, 5000, "split"], [5000, 7500, "silence"]]);
    expect(segs.map((s) => s.speechMs)).toEqual([2500, 2500, 2000]);
    expect(starts).toBe(1); // a split continues the same speech: one onset
  });

  it("a 7 s tone with a 40 ms dip at 2.1 s splits at the dip", () => {
    const pcm = concat(tone(2100, LOUD), silence(40), tone(4860, LOUD, 2140 * 16), silence(1000));
    const { segs } = run(pcm);
    expect(segs[0]!.endMs).toBe(2140);
    expect(segs[0]!.reason).toBe("split");
    expect(segs[1]!.startMs).toBe(2140);
    expect(segs.at(-1)!.reason).toBe("silence");
  });

  it("total samples out equal samples in minus the dropped silence (no duplication across a split)", () => {
    const pcm = concat(silence(1000), tone(2100, LOUD), silence(40), tone(4860, LOUD), silence(1500));
    const { segs } = run(pcm);
    const total = segs.reduce((n, s) => n + s.pcm.length, 0);
    // Kept: 200 ms lead-in + 7000 ms of tone and dip + 500 ms hangover; dropped: 800 ms before and 1000 ms after.
    expect(total).toBe(16 * (200 + 7000 + 500));
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.startMs).toBe(segs[i - 1]!.endMs);
    for (const s of segs) expect(s.pcm.length).toBe(16 * (s.endMs - s.startMs));
  });

  it("flush emits the open segment", () => {
    const { segs, seg } = run(concat(silence(200), tone(800, LOUD)), {}, { flush: true });
    expect(segs.map((s) => [s.startMs, s.endMs, s.lastSpeechMs, s.reason])).toEqual([[0, 1000, 1000, "flush"]]);
    expect(seg.speaking).toBe(false);
    expect(seg.flush()).toEqual([]);
  });

  it("flush drops an open segment under minSpeechMs", () => {
    expect(run(tone(200, LOUD), {}, { flush: true }).segs).toEqual([]);
  });

  it("discard drops it and the next tone starts fresh", () => {
    const seg = new Segmenter(DEFAULT_SEGMENTER);
    for (const f of frames(concat(silence(300), tone(1000, LOUD)))) seg.push(f);
    expect(seg.speaking).toBe(true);
    seg.discard();
    expect(seg.speaking).toBe(false);
    const out: SegmentOut[] = [];
    let starts = 0;
    for (const f of frames(concat(tone(600, LOUD), silence(600)))) { const r = seg.push(f); if (r.started) starts++; out.push(...r.segments); }
    expect(starts).toBe(1);
    // No lead-in survives the discard, and nothing of the discarded speech: the new segment starts at its own first frame (1300 ms).
    expect(out.map((s) => [s.startMs, s.endMs, s.speechMs])).toEqual([[1300, 2400, 600]]);
  });

  it("started is reported once per segment start", () => {
    const { starts, segs } = run(concat(tone(500, LOUD), silence(700), tone(500, LOUD), silence(700), tone(500, LOUD), silence(700)));
    expect(starts).toBe(3);
    expect(segs).toHaveLength(3);
  });

  it("quiet audio below the threshold never opens a segment", () => {
    const { segs, starts } = run(concat(tone(2000, -50), silence(600)), {}, { flush: true });
    expect(starts).toBe(0);
    expect(segs).toEqual([]);
  });

  it("settings outside the ranges throw RangeError", () => {
    for (const bad of [{ hangoverMs: 299 }, { hangoverMs: 601 }, { hangoverMs: 400.5 }, { maxSegmentMs: 1999 }, { maxSegmentMs: 6001 }, { frameMs: 10 }, { thresholdDbfs: -40 }, { leadInMs: 100 }, { minSpeechMs: 200 }, { splitSearchMs: 500 }]) {
      expect(() => new Segmenter({ ...DEFAULT_SEGMENTER, ...bad } as SegmenterSettings), JSON.stringify(bad)).toThrow(RangeError);
    }
    for (const ok of [{ hangoverMs: 300 }, { hangoverMs: 600 }, { maxSegmentMs: 2000 }, { maxSegmentMs: 6000 }]) expect(() => new Segmenter({ ...DEFAULT_SEGMENTER, ...ok })).not.toThrow();
  });

  it("a frame of the wrong length throws RangeError", () => {
    const seg = new Segmenter(DEFAULT_SEGMENTER);
    expect(() => seg.push(new Int16Array(319))).toThrow(RangeError);
  });
});
