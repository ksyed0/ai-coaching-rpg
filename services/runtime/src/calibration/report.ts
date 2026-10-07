import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSafeId } from "@acr/events";
import type { Rubric } from "@acr/script";
import { isValidModelId } from "../evaluator/config.js";
import { compareJudges, type Comparison, type Disagreement } from "./compare.js";
import { modelFamily, type Judge } from "./judge.js";
import { computeMetrics, labelFor, splitMetrics, type JudgeMetrics } from "./metrics.js";
import { MIN_CRITERION_PROBES, MIN_SET_PROBES, printable } from "./probe-load.js";
import type { Probe } from "./probe-schema.js";
import { rubricHash } from "./rubric-hash.js";
import type { Targets } from "./targets.js";
import type { Evidence, Observed, Outcome } from "./types.js";

export type CalibrationSummary = {
  schema: "acr.calibration.summary/1"; scenarioId: string; rubricHash: string; variant: string; judge: { label: string; model: string }; ranAt: string;
  probes: { total: number; tune: number; holdout: number }; exact: { n: number; of: number }; bias: number | null; contrast: { ordered: number; of: number };
  label: "PASS" | "WARN" | "FAIL";
};
export type JudgeReport = {
  judge: { label: string; model: string; family: string }; outcomes: Outcome[]; metrics: JudgeMetrics;
  /** Prototype-less records (see splitMetrics): read them with Object.keys, never with hasOwnProperty. */
  byCriterion: Record<string, JudgeMetrics>; bySplit: Record<string, JudgeMetrics>; bySource: Record<string, JudgeMetrics>; byDrafter: Record<string, JudgeMetrics>;
  label: { label: "PASS" | "WARN" | "FAIL"; reasons: string[] }; warnings: string[];
};
export type CalibrationRun = {
  schema: "acr.calibration/1"; scenario: { id: string; version: string }; rubricHash: string; variant: string; startedAt: string; probeCount: number;
  lint: string[]; judges: JudgeReport[]; comparison: ReturnType<typeof compareJudges> | null;
};

/** The group key splitMetrics gives a null drafter (a handwritten probe). A drafter literally named "(none)" merges with it. */
const NO_DRAFTER = "(none)";
const MAX_RUN_DIRS = 99;
const SUMMARY_LINES = 5;

/** A drafter name as it may be shown: only a model id is printed, anything else (a URL, a credential-looking string) is withheld. */
function drafterName(d: string): string {
  return d === NO_DRAFTER || isValidModelId(d) ? d : "a drafter whose name is not a model id";
}

function byCriterion(os: Outcome[]): Record<string, JudgeMetrics> {
  const groups = new Map<string, Outcome[]>();
  for (const o of os) {
    const g = groups.get(o.criterion);
    if (g) g.push(o); else groups.set(o.criterion, [o]);
  }
  const out = Object.create(null) as Record<string, JudgeMetrics>;
  for (const [k, v] of groups) out[k] = computeMetrics(v);
  return out;
}

/**
 * Metrics, label and honesty warnings for one judge. `probes` is the set the run was planned on: when it is larger than the outcomes the
 * run was cut short and the report says so. Thinness is computed from the outcomes, because those are what the figures rest on.
 */
export function buildJudgeReport(judge: Judge, outcomes: Outcome[], targets: Targets, probes: Probe[]): JudgeReport {
  const metrics = computeMetrics(outcomes);
  const crit = byCriterion(outcomes);
  const byDrafter = splitMetrics(outcomes, "drafter");
  const warnings: string[] = [];
  if (outcomes.length < MIN_SET_PROBES) warnings.push(`thin: too few probes (${outcomes.length}, fewer than ${MIN_SET_PROBES}): the figures are noisy`);
  for (const c of Object.keys(crit).sort()) {
    const n = crit[c]!.probes;
    if (n < MIN_CRITERION_PROBES) warnings.push(`thin: criterion ${printable(c, 64)} has ${n} probe${n === 1 ? "" : "s"} (fewer than ${MIN_CRITERION_PROBES})`);
  }
  if (probes.length > outcomes.length) warnings.push(`partial: ${outcomes.length} of ${probes.length} probes have results`);
  for (const d of Object.keys(byDrafter).sort()) {
    if (d === NO_DRAFTER) continue;
    if (modelFamily(d) === judge.family) warnings.push(`agreement on probes drafted by ${printable(drafterName(d), 200)} is self-agreement: same model family as the judge`);
  }
  return {
    judge: { label: judge.label, model: judge.model, family: judge.family }, outcomes, metrics,
    byCriterion: crit, bySplit: splitMetrics(outcomes, "split"), bySource: splitMetrics(outcomes, "source"), byDrafter,
    label: labelFor(metrics, targets), warnings,
  };
}

export type RunInput = {
  scenario: { id: string; version: string }; rubrics: Rubric[]; variant: string; startedAt: string; probes: Probe[]; lint: string[]; judges: JudgeReport[];
};

/** Assembles the run; with two judges they are compared blind (from their finished outcomes only). */
export function buildRun(input: RunInput): CalibrationRun {
  const [a, b] = input.judges;
  return {
    schema: "acr.calibration/1", scenario: { id: input.scenario.id, version: input.scenario.version }, rubricHash: rubricHash(input.rubrics),
    variant: input.variant, startedAt: input.startedAt, probeCount: input.probes.length, lint: [...input.lint], judges: input.judges,
    comparison: a && b ? compareJudges(a.outcomes, b.outcomes) : null,
  };
}

// ---- Markdown ----

/** Untrusted text for Markdown: control, bidi and zero-width characters removed by printable, then every Markdown-active character escaped. */
function md(s: string, max = 120): string {
  return printable(s, max).replace(/[\\`*_[\]<>|#~&!]/g, (c) => `\\${c}`);
}
const signed = (x: number | null): string => (x === null ? "n/a" : Math.abs(x) < 0.005 ? "0.00" : `${x > 0 ? "+" : ""}${x.toFixed(2)}`);
const fixed = (x: number | null): string => (x === null ? "n/a" : x.toFixed(2));
const pct = (n: number, of: number): string => (of > 0 ? ` (${Math.round((n / of) * 100)}%)` : "");
const row = (cells: string[]): string => `| ${cells.join(" | ")} |`;
const table = (header: string[], rows: string[][]): string[] => [row(header), row(header.map(() => "---")), ...rows.map(row)];
const observed = (o: Observed): string => md(String(o), 20);

/** At most SUMMARY_LINES items on one line, so the summary stays one screen. */
function capped(items: string[], max: number): string {
  const shown = items.slice(0, SUMMARY_LINES).map((s) => md(s, max)).join("; ");
  return items.length > SUMMARY_LINES ? `${shown}; and ${items.length - SUMMARY_LINES} more (see below)` : shown;
}

function summaryLines(run: CalibrationRun): string[] {
  const lines: string[] = [];
  for (const j of run.judges) {
    const m = j.metrics, ag = m.agreement, us = m.usability;
    lines.push(
      `- **${md(j.judge.label, 64)}** (${md(j.judge.model, 200)}), prompt ${md(run.variant, 64)}: **${j.label.label}**. ` +
      `contrast ordered ${m.contrast.ordered} of ${m.contrast.usable} usable (${m.contrast.n} contrast probes); bias ${signed(m.bias.mean)} levels; ` +
      `exact ${ag.exact} of ${ag.n}${pct(ag.exact, ag.n)}; within-one ${ag.withinOne} of ${ag.n}${pct(ag.withinOne, ag.n)}; usable ${us.slots - us.unusable} of ${us.slots} answers.`,
    );
    if (j.label.reasons.length) lines.push(`  - reasons: ${capped(j.label.reasons, 200)}`);
    if (j.warnings.length) lines.push(`  - warnings: ${capped(j.warnings, 200)}`);
  }
  const c = run.comparison, [a, b] = run.judges;
  if (c && a && b) {
    lines.push(`- Cross-judge (${md(a.judge.label, 64)} vs ${md(b.judge.label, 64)}): ${c.pairs} numeric pairs, mean absolute difference ${fixed(c.meanAbsDiff)}, within one level ${c.withinOne} of ${c.pairs}; ${c.disagreements.length} disagreements listed below.`);
    if (c.bothUnusable > 0) lines.push(`- ${c.bothUnusable} entries were unusable for both judges (counted neither as pairs nor as disagreements).`);
  }
  lines.push(`- Lint: ${run.lint.length ? capped(run.lint, 200) : "none"}`);
  return lines;
}

const METRIC_HEADER = ["Probes", "Exact", "Within one", "Bias", "Contrast ordered", "Usable"];
function metricCells(m: JudgeMetrics): string[] {
  const ag = m.agreement, us = m.usability;
  return [String(m.probes), `${ag.exact} of ${ag.n}`, `${ag.withinOne} of ${ag.n}`, signed(m.bias.mean), `${m.contrast.ordered} of ${m.contrast.usable}`, `${us.slots - us.unusable} of ${us.slots}`];
}
function groupTable(title: string, rec: Record<string, JudgeMetrics>, name: (k: string) => string = (k) => k): string[] {
  const keys = Object.keys(rec).sort();
  return [`### ${title}`, "", ...table(["Group", ...METRIC_HEADER], keys.map((k) => [md(name(k), 120), ...metricCells(rec[k]!)])), ""];
}

function judgeDetail(j: JudgeReport): string[] {
  const m = j.metrics;
  const crit = Object.keys(j.byCriterion).sort();
  const out = [
    `## Judge ${md(j.judge.label, 64)} (${md(j.judge.model, 200)}, family ${md(j.judge.family, 64)}): ${j.label.label}`, "",
    ...j.label.reasons.map((r) => `- ${md(r, 300)}`), ...j.warnings.map((w) => `- warning: ${md(w, 300)}`), ...(j.label.reasons.length || j.warnings.length ? [""] : []),
    "### Per criterion", "",
    ...table(["Criterion", ...METRIC_HEADER, "Thin"], crit.map((c) => {
      const cm = j.byCriterion[c]!;
      return [md(c, 64), ...metricCells(cm), cm.probes < MIN_CRITERION_PROBES ? "thin" : ""];
    })), "",
    ...groupTable("By split", j.bySplit), ...groupTable("By source", j.bySource), ...groupTable("By drafter", j.byDrafter, drafterName),
    "### Bias by expected level", "",
    ...table(["Expected", "Scored", "Mean bias"], ([1, 2, 3, 4] as const).map((l) => [String(l), String(m.biasByExpected[l].n), signed(m.biasByExpected[l].mean)])), "",
    "### Not observed", "", `- precision ${fixed(m.notObserved.precision)}, recall ${fixed(m.notObserved.recall)}`, "",
    "### Stability", "", m.stability === null ? "- not measured (one run per probe; use --repeat)" : `- mean per-probe variance ${fixed(m.stability)}`, "",
    "### Usability", "",
    `- ${m.usability.slots - m.usability.unusable} of ${m.usability.slots} answers usable; ${m.usability.capped} scores capped for missing evidence; ${m.usability.dropped} quotes dropped as not verbatim`,
    `- spread: ${m.spread} distinct level(s) used; the probes expect ${m.expectedLevels}`, "",
  ];
  return out;
}

function evidenceCells(e: Evidence | undefined): [string, string] {
  if (!e) return ["", ""];
  const quotes = e.quotes.slice(0, 3).map((q) => `"${md(q, 120)}"`).join("; ") + (e.quotes.length > 3 ? `; and ${e.quotes.length - 3} more` : "");
  return [md(e.rationale, 300), quotes];
}

function comparisonDetail(c: Comparison, a: JudgeReport, b: JudgeReport): string[] {
  const la = md(a.judge.label, 64), lb = md(b.judge.label, 64);
  const rows = c.disagreements.map((d: Disagreement) => [md(d.probeId, 80), md(d.role, 64), observed(d.a), observed(d.b), ...evidenceCells(d.aEvidence), ...evidenceCells(d.bEvidence)]);
  return [
    `## Cross-judge comparison (${la} vs ${lb})`, "",
    `- ${c.pairs} numeric pairs; mean absolute difference ${fixed(c.meanAbsDiff)}; within one level ${c.withinOne} of ${c.pairs}`,
    ...(c.bothUnusable > 0 ? [`- ${c.bothUnusable} entries were unusable for both judges`] : []), "",
    "### Disagreements", "",
    ...(rows.length ? table(["Probe", "Role", la, lb, `${la} rationale`, `${la} quotes`, `${lb} rationale`, `${lb} quotes`], rows) : ["None."]), "",
  ];
}

/** The report: a one-screen summary first (well inside 25 lines for two judges), the detail below it. */
export function renderMarkdown(run: CalibrationRun): string {
  const lines = [
    `# Calibration: ${md(run.scenario.id, 64)} v${md(run.scenario.version, 40)}`, "",
    `Prompt variant ${md(run.variant, 64)}; rubric ${md(run.rubricHash, 64)}; ${run.probeCount} probes; started ${md(run.startedAt, 40)}. Positive bias means lenient; within-one agreement is shown for traceability and does not decide PASS.`, "",
    ...summaryLines(run), "",
  ];
  for (const j of run.judges) lines.push(...judgeDetail(j));
  const [a, b] = run.judges;
  if (run.comparison && a && b) lines.push(...comparisonDetail(run.comparison, a, b));
  lines.push("## Lint", "", ...(run.lint.length ? run.lint.map((l) => `- ${md(l, 300)}`) : ["- none"]), "");
  return lines.join("\n");
}

// ---- Files ----

/** Lower-case letters, digits and single dashes, at most 80 characters, never empty: safe as part of a file name by construction. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "") || "x";
}

export function summaryFile(dataDir: string, scenarioId: string, model: string, variant: string): string {
  if (!isSafeId(scenarioId)) throw new Error("calibration summary: the scenario id is not a safe file name");
  return path.join(dataDir, scenarioId, `${slug(model)}-${slug(variant)}.json`);
}

/** Writes calibration-report.md and calibration.json into a new directory per run; nothing is ever overwritten. */
export async function writeRun(run: CalibrationRun, dataDir: string): Promise<{ dir: string; markdown: string; json: string }> {
  if (!isSafeId(run.scenario.id)) throw new Error("calibration run: the scenario id is not a safe file name");
  const stamp = String(run.startedAt).replace(/[:.]/g, "-");
  if (!isSafeId(stamp) || stamp.length > 60) throw new Error("calibration run: the start time does not make a safe directory name");
  const parent = path.join(dataDir, run.scenario.id);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  let dir = "";
  for (let i = 1; dir === ""; i++) {
    const candidate = path.join(parent, i === 1 ? stamp : `${stamp}-${i}`);
    try {
      await mkdir(candidate, { mode: 0o700 });
      dir = candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || i >= MAX_RUN_DIRS) throw e;
    }
  }
  const markdown = path.join(dir, "calibration-report.md"), json = path.join(dir, "calibration.json");
  await writeFile(markdown, renderMarkdown(run), { flag: "wx", mode: 0o600 });
  await writeFile(json, `${JSON.stringify(run, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { dir, markdown, json };
}

function summaryOf(run: CalibrationRun, j: JudgeReport): CalibrationSummary {
  const m = j.metrics;
  return {
    schema: "acr.calibration.summary/1", scenarioId: run.scenario.id, rubricHash: run.rubricHash, variant: run.variant,
    judge: { label: j.judge.label, model: j.judge.model }, ranAt: run.startedAt,
    probes: { total: j.outcomes.length, tune: j.outcomes.filter((o) => o.split === "tune").length, holdout: j.outcomes.filter((o) => o.split === "holdout").length },
    exact: { n: m.agreement.exact, of: m.agreement.n }, bias: m.bias.mean, contrast: { ordered: m.contrast.ordered, of: m.contrast.usable }, label: j.label.label,
  };
}

/**
 * The latest result per judge, read by reports to stamp them: one file per (model, variant), replaced atomically (a private temp file in
 * the same directory, then rename). A failed write removes its temp file. Two judges with the same model id share a file (last wins).
 */
export async function writeSummaries(run: CalibrationRun, dataDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const j of run.judges) {
    const file = summaryFile(dataDir, run.scenario.id, j.judge.model, run.variant);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(summaryOf(run, j), null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    files.push(file);
  }
  return files;
}
