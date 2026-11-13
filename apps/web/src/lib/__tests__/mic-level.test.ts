import { describe, expect, it } from "vitest";
import { dbfsOf, LEVEL_FLOOR_DBFS, LevelHistory, micLevel } from "../mic-level";
import { MESSAGES } from "../messages";
import { FakeAudioContext, FakeStream, manualFrames } from "./voice-fakes";

// US-0071 (A1b Task 15): the mic check's level (RMS of the time-domain buffer in dBFS, about ten updates a second on animation frames)
// and its words. Frames are driven by hand with their own timestamps: no clock, no sleep.

describe("dbfsOf", () => {
  it("silence gives -Infinity mapped to the floor", () => {
    expect(dbfsOf(new Float32Array(512))).toBe(LEVEL_FLOOR_DBFS);
  });

  it("a full-scale square wave gives 0 dBFS; a full-scale sine about -3 dBFS; nothing goes above 0", () => {
    const sq = Float32Array.from({ length: 512 }, (_, i) => (i % 2 ? 1 : -1));
    expect(dbfsOf(sq)).toBeCloseTo(0, 6);
    const sine = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * i) / 48));
    expect(dbfsOf(sine)).toBeCloseTo(-3.01, 1);
    expect(dbfsOf(new Float32Array(8).fill(4))).toBe(0);
  });
});

describe("micLevel", () => {
  it("reports about ten levels a second from the animation frames, then the returned stop disconnects the analyser", () => {
    const ctx = new FakeAudioContext();
    const f = manualFrames();
    ctx.level(-12);
    const got: [number, number][] = [];
    const stop = micLevel(ctx, new FakeStream(), (db, t) => got.push([Math.round(db), t]), f.raf, f.caf);
    expect(ctx.connected).toBe(true);
    for (let t = 0; t <= 300; t += 16) f.frame(t);
    expect(got.map(([, t]) => t)).toEqual([0, 112, 224]);
    expect(got.every(([db]) => db === -12)).toBe(true);
    stop();
    expect(ctx.analyserDisconnected).toBe(true);
    expect(ctx.sourceDisconnected).toBe(true);
    expect(f.pending).toBe(0);
    f.frame(1_000);
    expect(got).toHaveLength(3);
  });
});

describe("LevelHistory words", () => {
  const run = (levels: [number, number][]) => {
    const h = new LevelHistory();
    for (const [t, db] of levels) h.add(t, db);
    return h.words();
  };

  it("no update yet is No sound yet", () => {
    expect(new LevelHistory().words()).toBe(MESSAGES.micNoSound);
  });

  it("-12 dBFS for 300 ms is Hearing you; for 200 ms it is not yet", () => {
    expect(run([[0, -12], [100, -12], [200, -12], [300, -12]])).toBe(MESSAGES.micHearing);
    expect(run([[0, -12], [100, -12], [200, -12]])).not.toBe(MESSAGES.micHearing);
  });

  it("Hearing you holds for a second after the voice stops, then goes", () => {
    const h = new LevelHistory();
    for (const t of [0, 100, 200, 300]) h.add(t, -12);
    h.add(1_200, -90);
    expect(h.words()).toBe(MESSAGES.micHearing);
    h.add(1_400, -90);
    expect(h.words()).not.toBe(MESSAGES.micHearing);
  });

  it("-50 dBFS is Too quiet; -70 is No sound yet", () => {
    expect(run([[0, -50], [100, -50]])).toBe(MESSAGES.micTooQuiet);
    expect(run([[0, -70], [100, -70]])).toBe(MESSAGES.micNoSound);
  });

  it("Too quiet looks at the loudest level of the last 2 s only", () => {
    const h = new LevelHistory();
    h.add(0, -50);
    h.add(1_900, -80);
    expect(h.words()).toBe(MESSAGES.micTooQuiet);
    h.add(2_100, -80);
    expect(h.words()).toBe(MESSAGES.micNoSound);
  });

  it("keeps a bounded history", () => {
    const h = new LevelHistory();
    for (let t = 0; t < 100_000; t += 100) h.add(t, -70);
    expect(h.size).toBeLessThanOrEqual(25);
  });
});
