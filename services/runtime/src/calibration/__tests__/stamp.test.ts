import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lookupCalibration, stampLine } from "../stamp.js";
import { summaryFile, type CalibrationSummary } from "../report.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-cal-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const SID = "esc-scope-creep-01";
const summary = (over: Partial<CalibrationSummary> = {}): CalibrationSummary => ({
  schema: "acr.calibration.summary/1", scenarioId: SID, rubricHash: "h1", variant: "v1", judge: { label: "primary", model: "gemma-4-31b" },
  ranAt: "2026-10-08T00:00:00.000Z", probes: { total: 24, tune: 12, holdout: 12 }, exact: { n: 24, of: 24 }, bias: 0.4, contrast: { ordered: 6, of: 8, probes: 8 },
  usable: { n: 24, of: 24 }, label: "WARN", ...over,
});
async function put(s: CalibrationSummary, raw?: string) {
  const f = summaryFile(dir, s.scenarioId, s.judge.model, s.variant);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, raw ?? JSON.stringify(s));
}
const look = (model = "gemma-4-31b", variant = "v1", hash = "h1", sid = SID) => lookupCalibration(dir, sid, model, variant, hash);

describe("lookupCalibration", () => {
  it("is not_calibrated when there is no file or the file is corrupt", async () => {
    expect(await look()).toEqual({ state: "not_calibrated" });
    await put(summary(), "{not json");
    expect((await look()).state).toBe("not_calibrated");
  });
  it("is stale when the rubric hash or variant no longer matches the file's", async () => {
    await put(summary());
    expect(await look("gemma-4-31b", "v1", "OTHER")).toMatchObject({ state: "stale" });
    // the file for variant v1 whose content says another variant
    await put(summary(), JSON.stringify(summary({ variant: "v2" })));
    expect(await look("gemma-4-31b", "v1", "h1")).toMatchObject({ state: "stale" });
  });
  it("is ok for a full set and thin under 20 probes", async () => {
    await put(summary({ probes: { total: 8, tune: 4, holdout: 4 } }));
    expect((await look()).state).toBe("thin");
    await put(summary({ probes: { total: 19, tune: 9, holdout: 10 } }));
    expect((await look()).state).toBe("thin");
    await put(summary({ probes: { total: 20, tune: 10, holdout: 10 } }));
    expect((await look()).state).toBe("ok");
  });
  it("is thin when contrast was measured on fewer usable groups than there were contrast probes, or on fewer than 3", async () => {
    await put(summary({ contrast: { ordered: 5, of: 7, probes: 8 } }));
    expect((await look()).state).toBe("thin");
    await put(summary({ contrast: { ordered: 2, of: 2, probes: 2 } }));
    expect((await look()).state).toBe("thin");
    await put(summary({ contrast: { ordered: 3, of: 3, probes: 3 } }));
    expect((await look()).state).toBe("ok");
  });
  it("is not_calibrated when the file names another model than the one asked for (file names are slugged and can collide)", async () => {
    const s = summary({ judge: { label: "primary", model: "Gemma:4" } });
    const f = summaryFile(dir, SID, "gemma-4", "v1");
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify(s));
    expect(await look("gemma-4")).toEqual({ state: "not_calibrated" });
  });
  it("is not_calibrated for a parseable file of the wrong shape, and never throws", async () => {
    const bad: unknown[] = [
      null, 7, "x", [], {}, { ...summary(), probes: null }, { ...summary(), probes: { total: "24" } }, { ...summary(), exact: undefined }, { ...summary(), contrast: { ordered: 6, of: 8 } },
      { ...summary(), bias: "0.4" }, { ...summary(), judge: "gemma-4-31b" }, { ...summary(), ranAt: 5 }, { ...summary(), ranAt: "not a date" }, { ...summary(), label: "GREAT" },
      { ...summary(), rubricHash: 5 }, { ...summary(), probes: { total: Number.NaN, tune: 1, holdout: 1 } }, { ...summary(), scenarioId: "other-scenario" }, { ...summary(), schema: "acr.calibration.summary/2" },
    ];
    for (const b of bad) {
      await put(summary(), JSON.stringify(b));
      expect(await look(), JSON.stringify(b)).toEqual({ state: "not_calibrated" });
    }
  });
  it("never throws on hostile scenario ids or models, and never reads outside the calibration directory", async () => {
    for (const sid of ["../x", "", "a/b", "..", "x\0y", "A B"]) expect(await look("m", "v1", "h", sid)).toEqual({ state: "not_calibrated" });
    for (const model of ["../../etc/passwd", "", "a/../../b", "\0", "x".repeat(5000), "‮"]) expect(await look(model)).toEqual({ state: "not_calibrated" });
    expect(await lookupCalibration(dir, SID, undefined as unknown as string, "v1", "h1")).toEqual({ state: "not_calibrated" });
    expect(await lookupCalibration(dir, SID, "m", { toString() { throw new Error("x"); } } as unknown as string, "h1")).toEqual({ state: "not_calibrated" });
  });
});

describe("stampLine", () => {
  it("states measurements and never claims accuracy", async () => {
    await put(summary());
    const line = stampLine(await look());
    expect(line).toMatch(/gemma-4-31b/); expect(line).toMatch(/24 probes/); expect(line).toMatch(/24 of 24 exact/);
    expect(line).toMatch(/6 of 8 contrast/); expect(line).toMatch(/\+0\.4/); expect(line).toContain("2026-10-08");
    expect(line).not.toMatch(/accurate|validated|reliable/i);
    expect(line).not.toMatch(/Thin/);
  });
  it("is explicit when not calibrated, stale or thin", async () => {
    expect(stampLine({ state: "not_calibrated" })).toMatch(/not calibrated/i);
    expect(stampLine({ state: "stale", reason: "the rubric changed" })).toMatch(/not calibrated for this rubric version/i);
    expect(stampLine(undefined)).toMatch(/not calibrated/i);
    await put(summary({ probes: { total: 8, tune: 4, holdout: 4 } }));
    expect(stampLine(await look())).toMatch(/fewer than 20 probes/);
  });
  it("a thin state caused by contrast prints the contrast count and says contrast was measured on few groups", async () => {
    await put(summary({ contrast: { ordered: 2, of: 2, probes: 2 } }));
    const line = stampLine(await look());
    expect(line).toMatch(/2 of 2 contrast/); expect(line).toMatch(/contrast was measured on few groups/i); expect(line).not.toMatch(/fewer than 20 probes/);
    await put(summary({ contrast: { ordered: 5, of: 7, probes: 8 } }));
    expect(stampLine(await look())).toMatch(/5 of 7 contrast[^.]*\(8 contrast probes\)|contrast was measured on few groups/i);
  });
  it("prints n/a for a null bias and a minus sign for a negative one", async () => {
    await put(summary({ bias: null }));
    expect(stampLine(await look())).toMatch(/bias n\/a/);
    await put(summary({ bias: -0.25 }));
    expect(stampLine(await look())).toMatch(/-0\.3|-0\.2/);
  });
  it("never throws on a malformed state", () => {
    for (const s of [{ state: "ok" }, { state: "thin", summary: null }, { state: "ok", summary: {} }, { state: "stale" }, { state: "weird" }, 5, null]) {
      expect(() => stampLine(s as never)).not.toThrow();
      expect(stampLine(s as never)).toMatch(/not calibrated/i);
    }
  });
});
