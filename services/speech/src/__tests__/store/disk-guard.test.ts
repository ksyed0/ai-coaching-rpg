import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { DiskGuard } from "../../store/disk-guard.js";

/** US-0073 (voice A2a, Task 5): the disk guard checks both volumes, fails closed, and never names a path. */
const MIB = 1024 * 1024;
const free = (mb: number, extra = 0) => ({ bavail: BigInt(mb * MIB + extra), bsize: 1n });
const fake = (m: Record<string, { bavail: bigint | number; bsize: bigint | number }>) => (p: string) => {
  const v = m[p];
  if (!v) throw new Error("ENOENT");
  return v;
};
const mk = (m: Record<string, { bavail: bigint | number; bsize: bigint | number }>, minFreeMb = 100) =>
  new DiskGuard({ volumes: ["/a", "/s"], minFreeMb, statfs: fake(m) });

describe("DiskGuard", () => {
  it("is ok when both volumes exceed the floor plus the next file", () => {
    expect(mk({ "/a": free(100, 1001), "/s": free(200) }).check(1000)).toEqual({ ok: true });
  });
  it("names the audio volume when it is below", () => {
    expect(mk({ "/a": free(50), "/s": free(500) }).check(0)).toEqual({ ok: false, volume: "audio" });
  });
  it("names the sessions volume when only it is below", () => {
    expect(mk({ "/a": free(500), "/s": free(50) }).check(0)).toEqual({ ok: false, volume: "sessions" });
  });
  it("reports audio first when both fail", () => {
    expect(mk({ "/a": free(1), "/s": free(1) }).check(0)).toEqual({ ok: false, volume: "audio" });
  });
  it("exactly at the floor is not ok, one byte more is", () => {
    expect(mk({ "/a": free(100), "/s": free(500) }).check(0)).toEqual({ ok: false, volume: "audio" });
    expect(mk({ "/a": free(100, 1), "/s": free(500) }).check(0)).toEqual({ ok: true });
  });
  it("counts the next file against the floor", () => {
    const g = mk({ "/a": free(100, 10), "/s": free(500) });
    expect(g.check(9)).toEqual({ ok: true });
    expect(g.check(10)).toEqual({ ok: false, volume: "audio" });
  });
  it("fails closed when statfs throws, naming the volume that threw", () => {
    expect(mk({ "/a": free(500) }).check(0)).toEqual({ ok: false, volume: "sessions" });
    expect(new DiskGuard({ volumes: ["/a", "/s"], minFreeMb: 1, statfs: () => { throw new Error("EIO"); } }).check(0)).toEqual({ ok: false, volume: "audio" });
  });
  it("fails closed on a bad nextBytes", () => {
    const g = mk({ "/a": free(500), "/s": free(500) });
    for (const n of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) expect(g.check(n)).toEqual({ ok: false, volume: "audio" });
  });
  it("accepts number results and does not overflow on huge block counts", () => {
    expect(mk({ "/a": { bavail: 1000, bsize: 4096 * 1024 }, "/s": { bavail: 2 ** 40, bsize: 2 ** 20 } }).check(0)).toEqual({ ok: true });
  });
  it("fails closed on negative or non-integer statfs fields", () => {
    expect(mk({ "/a": { bavail: -1, bsize: 4096 }, "/s": free(500) }).check(0)).toEqual({ ok: false, volume: "audio" });
    expect(mk({ "/a": { bavail: Number.NaN, bsize: 4096 }, "/s": free(500) }).check(0)).toEqual({ ok: false, volume: "audio" });
  });
  it("the failed result carries nothing but the volume name", () => {
    const r = mk({ "/a": free(1), "/s": free(500) }).check(0);
    expect(Object.keys(r).sort()).toEqual(["ok", "volume"]);
    expect(JSON.stringify(r)).not.toContain("/a");
  });
  it("rejects a bad constructor", () => {
    const sf = fake({});
    for (const mb of [0, -1, 1.5, Number.NaN]) expect(() => new DiskGuard({ volumes: ["/a", "/s"], minFreeMb: mb, statfs: sf })).toThrow(/minFreeMb/);
    for (const v of [[], ["/a"], ["/a", "/s", "/x"], ["/a", ""], ["", "/s"]]) expect(() => new DiskGuard({ volumes: v, minFreeMb: 1, statfs: sf })).toThrow(/volumes/);
    expect(() => new DiskGuard({ volumes: ["/a", 5 as unknown as string], minFreeMb: 1, statfs: sf })).toThrow(/volumes/);
  });
  it("works against the real statfs on the temp directory", () => {
    expect(new DiskGuard({ volumes: [tmpdir(), tmpdir()], minFreeMb: 1 }).check(0)).toEqual({ ok: true });
  });
});
