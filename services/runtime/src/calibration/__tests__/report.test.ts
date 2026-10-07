import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildJudgeReport, buildRun, renderMarkdown, summaryFile, writeRun, writeSummaries, type CalibrationRun } from "../report.js";
import { DEFAULT_TARGETS } from "../targets.js";
import { MIN_SET_PROBES } from "../probe-load.js";
import type { Probe } from "../probe-schema.js";
import type { ContrastOutcome, Evidence, Observed, SingleOutcome } from "../types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-cal-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const out = (id: string, expected: 1 | 2 | 3 | 4, run: SingleOutcome["runs"][number]): SingleOutcome =>
  ({ probeId: id, criterion: "discovery", split: "tune", source: "handwritten", drafter: null, capped: 0, dropped: 0, evidence: [], kind: "single", subject: "p", expected, acceptable: [expected], runs: [run] });
const contrastOut = (id: string, run: Record<string, Observed>, evidence: Evidence[] = []): ContrastOutcome =>
  ({ probeId: id, criterion: "discovery", split: "holdout", source: "handwritten", drafter: null, capped: 0, dropped: 0, evidence, kind: "contrast", expected: { x: 4, y: 1 }, minGap: 2, runs: [run] });
const probes = [] as Probe[];
const provider = { name: "x", async *stream() { yield ""; } };
const gemma = { label: "primary", model: "gemma-4-31b", family: "gemma", provider };
function run(): CalibrationRun {
  const jr = buildJudgeReport(gemma, [out("a", 1, 1), out("b", 4, 3)], DEFAULT_TARGETS, probes);
  return { schema: "acr.calibration/1", scenario: { id: "esc-scope-creep-01", version: "1.2" }, rubricHash: "abc123", variant: "v1", startedAt: "2026-10-08T00:00:00.000Z", probeCount: 2, lint: ["thin set"], judges: [jr], comparison: null };
}

/** Every value reachable from `v` is JSON-native: no undefined, NaN or Infinity anywhere. */
function jsonNative(v: unknown, where = "$"): string[] {
  if (v === undefined) return [where];
  if (typeof v === "number") return Number.isFinite(v) ? [] : [where];
  if (v === null || typeof v !== "object") return [];
  return Object.keys(v).flatMap((k) => jsonNative((v as Record<string, unknown>)[k], `${where}.${k}`));
}

// Raw control, bidi and zero-width characters must never reach the Markdown.
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u;

describe("report", () => {
  it("opens with a one-screen summary and names the judge, variant and thinness", () => {
    const md = renderMarkdown(run());
    const head = md.split("\n").slice(0, 25).join("\n");
    expect(head).toMatch(/primary/); expect(head).toMatch(/v1/); expect(head).toMatch(/thin set/);
    expect(head).toMatch(/exact 1 of 2/); expect(head).toMatch(/(PASS|WARN|FAIL)/);
  });

  it("puts every headline figure in the first 25 lines, with two judges and a comparison", () => {
    const a = buildJudgeReport(gemma, [out("a", 1, 1), out("b", 4, 3), contrastOut("c", { x: 4, y: 1 }), out("d", 2, "failed")], DEFAULT_TARGETS, probes);
    const qwen = { label: "second", model: "qwen-3-32b", family: "qwen", provider };
    const b = buildJudgeReport(qwen, [out("a", 1, 3), out("b", 4, 4), contrastOut("c", { x: 1, y: 4 }), out("d", 2, "invalid")], DEFAULT_TARGETS, probes);
    const r = buildRun({ scenario: { id: "esc-scope-creep-01", version: "1.2" }, rubrics: [], variant: "v1", startedAt: "2026-10-08T00:00:00.000Z", probes, lint: ["the probe set has fewer than 20 probes (4): results are thin"], judges: [a, b] });
    expect(r.comparison?.bothUnusable).toBe(1);
    const lines = renderMarkdown(r).split("\n");
    const head = lines.slice(0, 25).join("\n");
    for (const re of [/primary/, /gemma-4-31b/, /second/, /qwen-3-32b/, /prompt v1/, /contrast ordered 1 of 1 usable/, /contrast ordered 0 of 1 usable/,
      /bias -0\.50/, /bias \+1\.00/, /exact 1 of 2/, /within-one 2 of 2/, /within-one 1 of 2/, /usable 4 of 5/, /\*\*FAIL\*\*/,
      /contrast ordering 0 of 1/, /bias 1\.00 levels exceeds/, /results are thin/, /1 entries were unusable for both judges/]) expect(head).toMatch(re);
    // the detail follows the summary
    expect(lines.slice(25).join("\n")).toMatch(/## /);
  });

  it("shows a positive bias with its sign and an unmeasured bias as n/a", () => {
    const lenient = buildJudgeReport(gemma, [out("a", 1, 2)], DEFAULT_TARGETS, probes);
    const none = buildJudgeReport(gemma, [out("a", 1, "failed")], DEFAULT_TARGETS, probes);
    const r = { ...run(), judges: [lenient] };
    expect(renderMarkdown(r)).toMatch(/bias \+1\.00/);
    expect(renderMarkdown({ ...r, judges: [none] })).toMatch(/bias n\/a/);
  });

  it("marks a set under 20 probes and a criterion under 4 probes as thin, from the outcomes", () => {
    const few = buildJudgeReport(gemma, [out("a", 1, 1), { ...out("b", 2, 2), criterion: "listening" }], DEFAULT_TARGETS, probes);
    expect(few.warnings.join("\n")).toMatch(/thin: too few probes/);
    expect(few.warnings.join("\n")).toMatch(/thin: criterion discovery has 1 probe/);
    expect(few.warnings.join("\n")).toMatch(/thin: criterion listening has 1 probe/);
    const many = Array.from({ length: MIN_SET_PROBES }, (_, i) => out(`p${i}`, 2, 2));
    const full = buildJudgeReport(gemma, many, DEFAULT_TARGETS, probes);
    expect(full.warnings).toEqual([]);
    expect(renderMarkdown({ ...run(), judges: [few] })).toMatch(/\| discovery \|.*\| thin \|/);
  });

  it("a criterion with exactly 4 probes is not thin, one with 3 is", () => {
    const set = (n: number) => [...Array.from({ length: n }, (_, i) => out(`d${i}`, 2, 2)), ...Array.from({ length: MIN_SET_PROBES }, (_, i) => ({ ...out(`l${i}`, 2, 2), criterion: "listening" }))];
    const four = buildJudgeReport(gemma, set(4), DEFAULT_TARGETS, probes);
    expect(four.warnings).toEqual([]);
    expect(renderMarkdown({ ...run(), judges: [four] })).not.toMatch(/\| thin \|/);
    expect(buildJudgeReport(gemma, set(3), DEFAULT_TARGETS, probes).warnings).toEqual(["thin: criterion discovery has 3 probes (fewer than 4)"]);
  });

  it("warns when some probes of the set have no outcome", () => {
    const set = [{ id: "a" }, { id: "b" }, { id: "c" }] as Probe[];
    expect(buildJudgeReport(gemma, [out("a", 1, 1)], DEFAULT_TARGETS, set).warnings.join("\n")).toMatch(/partial: 1 of 3 probes/);
  });

  it("warns when the drafter shares the judge's model family", () => {
    const drafted = { ...out("a", 1, 1), source: "drafted" as const, drafter: "gemma-4-31b-it" };
    const jr = buildJudgeReport(gemma, [drafted], DEFAULT_TARGETS, probes);
    expect(jr.warnings.join(" ")).toMatch(/same model family/);
  });

  it("gives one same-family warning per drafter, skips handwritten probes and other families, and never prints a non-model-id drafter", () => {
    const d = (id: string, drafter: string | null): SingleOutcome => ({ ...out(id, 1, 1), source: drafter ? "drafted" : "handwritten", drafter });
    const none = { ...gemma, family: "(none)" };
    expect(buildJudgeReport(none, [d("a", null)], DEFAULT_TARGETS, probes).warnings.join(" ")).not.toMatch(/same model family/);
    const jr = buildJudgeReport(gemma, [d("a", "gemma-3"), d("b", "gemma-3"), d("c", "qwen-3"), d("d", null), d("e", "https://u:sk-secret-value@h/gemma-2")], DEFAULT_TARGETS, probes);
    const same = jr.warnings.filter((w) => /same model family/.test(w));
    expect(same).toHaveLength(2);
    expect(same[0]).toBe("agreement on probes drafted by gemma-3 is self-agreement: same model family as the judge");
    expect(same.join(" ")).not.toMatch(/secret|https|u:/);
    expect(renderMarkdown({ ...run(), judges: [jr] })).not.toMatch(/sk-secret-value/);
  });

  it("escapes untrusted text: no raw control, bidi or zero-width characters, tables stay intact and lines stay bounded", () => {
    const evil = "a\u001b[2J\nb|c`d\u202ee\u200bf\r\n# head\n> quote <script>" + "x".repeat(5000);
    const ev = (role: string): Evidence[] => [{ role, rationale: evil, quotes: [evil, evil, evil, evil] }];
    const s: SingleOutcome = { ...out("p|1", 1, 1), criterion: `crit|${evil}`, source: "drafted", drafter: `gemma|\u202e${evil}`, evidence: ev("p") };
    const a = buildJudgeReport({ ...gemma, label: `lab|${evil}`, model: `mod\u0000|${evil}` }, [s, contrastOut("c", { x: 4, y: 1 }, ev("x"))], DEFAULT_TARGETS, probes);
    const b = buildJudgeReport({ ...gemma, label: "second" }, [{ ...s, runs: [4], evidence: ev("p") }, contrastOut("c", { x: 2, y: 1 }, ev("x"))], DEFAULT_TARGETS, probes);
    const r = buildRun({ scenario: { id: "esc-scope-creep-01", version: `1|${evil}` }, rubrics: [], variant: "v1", startedAt: "2026-10-08T00:00:00.000Z", probes, lint: [evil], judges: [a, b] });
    const md = renderMarkdown(r);
    expect(md).not.toMatch(HIDDEN);
    expect(md).not.toMatch(/<script>/);
    expect(md).toMatch(/\\</);
    const lines = md.split("\n");
    for (const l of lines) expect(l.length).toBeLessThan(4000);
    for (const l of lines) expect(l).not.toMatch(/^\s*(#{1,6} (?!Calibration|Judge|Per |By |Bias|Not observed|Stability|Usability|Cross-judge|Disagreements|Lint)|> )/);
    // a table row keeps exactly its header's column count: every untrusted pipe is escaped
    const tables = md.split("\n\n").filter((blk) => blk.startsWith("|"));
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      const rows = t.split("\n");
      const cols = rows[0]!.split(/(?<!\\)\|/).length;
      for (const row of rows) expect(row.split(/(?<!\\)\|/).length, row.slice(0, 80)).toBe(cols);
    }
    // a backtick never opens an inline code span
    expect(md).not.toMatch(/(?<!\\)`/);
  });

  it("the run's JSON holds no undefined, NaN or infinite value, and the judge carries no provider", () => {
    const empty = buildJudgeReport(gemma, [], DEFAULT_TARGETS, probes);
    const r = buildRun({ scenario: { id: "esc-scope-creep-01", version: "1.2" }, rubrics: [], variant: "v1", startedAt: "2026-10-08T00:00:00.000Z", probes, lint: [], judges: [empty, run().judges[0]!] });
    expect(jsonNative(r)).toEqual([]);
    expect(jsonNative(JSON.parse(JSON.stringify(r)))).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/NaN|provider/);
    expect(Object.keys(r.judges[0]!.judge).sort()).toEqual(["family", "label", "model"]);
    expect(r.rubricHash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.probeCount).toBe(0);
  });

  it("writes the run exclusively under the data dir with private modes and never overwrites", async () => {
    const r = run();
    const w = await writeRun(r, dir);
    expect((await stat(w.markdown)).mode & 0o777).toBe(0o600);
    expect((await stat(w.json)).mode & 0o777).toBe(0o600);
    expect((await stat(w.dir)).mode & 0o777).toBe(0o700);
    expect(path.basename(w.dir)).toBe("2026-10-08T00-00-00-000Z");
    expect(JSON.parse(await readFile(w.json, "utf8")).schema).toBe("acr.calibration/1");
    expect(await readFile(w.markdown, "utf8")).toBe(renderMarkdown(r));
    await expect(writeRun(r, dir)).resolves.toBeDefined(); // a second run gets its own directory
    expect((await readdir(path.join(dir, "esc-scope-creep-01"))).filter((n) => !n.endsWith(".json")).length).toBe(2);
  });

  it("gives runs started in the same millisecond their own directories: -2, -3", async () => {
    const r = run();
    const ws = [await writeRun(r, dir), await writeRun(r, dir), await writeRun(r, dir)];
    expect(ws.map((w) => path.basename(w.dir))).toEqual(["2026-10-08T00-00-00-000Z", "2026-10-08T00-00-00-000Z-2", "2026-10-08T00-00-00-000Z-3"]);
    expect(new Set(ws.map((w) => w.json)).size).toBe(3);
  });

  it("refuses a scenario id or start time that would not make a safe directory name", async () => {
    for (const id of ["../x", "a/b", "..", "", "a\u0000b", "x".repeat(65)]) {
      await expect(writeRun({ ...run(), scenario: { id, version: "1" } }, dir)).rejects.toThrow(/scenario id/);
    }
    await expect(writeRun({ ...run(), startedAt: "../../etc" }, dir)).rejects.toThrow(/start time/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("writes one summary file per judge, named from the model, replacing the previous one atomically", async () => {
    const r = run();
    const [file] = await writeSummaries(r, dir);
    expect(file).toBe(summaryFile(dir, "esc-scope-creep-01", "gemma-4-31b", "v1"));
    expect(path.basename(file!)).toBe("gemma-4-31b-v1.json");
    const s = JSON.parse(await readFile(file!, "utf8"));
    expect(s).toMatchObject({ schema: "acr.calibration.summary/1", rubricHash: "abc123", variant: "v1", exact: { n: 1, of: 2 } });
    expect((await stat(file!)).mode & 0o777).toBe(0o600);
    await writeSummaries(r, dir);
    expect(await readdir(path.join(dir, "esc-scope-creep-01"))).toEqual(["gemma-4-31b-v1.json"]);
  });

  it("a summary holds exactly the CalibrationSummary fields", async () => {
    const jr = buildJudgeReport(gemma, [out("a", 1, 1), { ...out("b", 4, 3), split: "holdout" }, contrastOut("c", { x: 4, y: 1 })], DEFAULT_TARGETS, probes);
    const [file] = await writeSummaries({ ...run(), judges: [jr] }, dir);
    const s = JSON.parse(await readFile(file!, "utf8")) as Record<string, unknown>;
    expect(Object.keys(s).sort()).toEqual(["bias", "contrast", "exact", "judge", "label", "probes", "ranAt", "rubricHash", "scenarioId", "schema", "variant"]);
    expect(s).toEqual({
      schema: "acr.calibration.summary/1", scenarioId: "esc-scope-creep-01", rubricHash: "abc123", variant: "v1", judge: { label: "primary", model: "gemma-4-31b" },
      ranAt: "2026-10-08T00:00:00.000Z", probes: { total: 3, tune: 1, holdout: 2 }, exact: { n: 1, of: 2 }, bias: -0.5, contrast: { ordered: 1, of: 1 }, label: jr.label.label,
    });
  });

  it("leaves no temporary file behind when the final rename fails", async () => {
    const target = summaryFile(dir, "esc-scope-creep-01", "gemma-4-31b", "v1");
    await mkdir(path.join(target, "occupied"), { recursive: true }); // a non-empty directory where the file should go
    await expect(writeSummaries(run(), dir)).rejects.toThrow();
    expect((await readdir(path.dirname(target))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps every summary path inside the data dir, whatever the model id", () => {
    const hostile = ["../../x", "..", "/etc/passwd", "a\u0000b", "a\u001b[2Jb", "x".repeat(10_000), "日本語", "ＡＢ", "\u202egemma", "", "C:\\x", "a/b/../../..", "--", "-.-"];
    for (const m of hostile) for (const v of ["v1", "../v", "\u0000"]) {
      const f = summaryFile(dir, "esc-scope-creep-01", m, v);
      expect(path.dirname(f), JSON.stringify(m.slice(0, 20))).toBe(path.join(dir, "esc-scope-creep-01"));
      expect(path.basename(f)).toMatch(/^[a-z0-9][a-z0-9-]{0,79}-[a-z0-9][a-z0-9-]{0,79}\.json$/);
    }
    expect(path.basename(summaryFile(dir, "s", "../../x", "v1"))).toBe("x-v1.json");
    expect(path.basename(summaryFile(dir, "s", "日本語", "v1"))).toBe("x-v1.json");
    expect(path.basename(summaryFile(dir, "s", "Org/Gemma-4_31B:Q4", "v1"))).toBe("org-gemma-4-31b-q4-v1.json");
    expect(path.basename(summaryFile(dir, "s", "x".repeat(10_000), "v1"))).toBe(`${"x".repeat(80)}-v1.json`);
  });

  it("refuses an unsafe scenario id for a summary file", () => {
    for (const id of ["../x", "a/b", "..", "", "a b", "x".repeat(65)]) expect(() => summaryFile(dir, id, "m", "v1")).toThrow(/scenario id/);
  });
});
