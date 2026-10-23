import { isSafeId } from "@acr/events";
import { readRegularCapped } from "../util/read-regular.js";
import { MIN_SET_PROBES } from "./probe-load.js";
import { summaryFile, type CalibrationSummary } from "./report.js";

export type StampState =
  | { state: "not_calibrated" }
  | { state: "stale"; reason: string }
  | { state: "ok" | "thin"; summary: CalibrationSummary };

/** Contrast needs at least this many usable groups before its ordering count means anything. */
const MIN_CONTRAST_GROUPS = 3;
const NOT_CALIBRATED: StampState = { state: "not_calibrated" };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
/** A summary file is a few hundred bytes; anything bigger is not one. */
const MAX_SUMMARY_BYTES = 256 * 1024;
/** An ISO date or datetime naming a day that exists (2026-02-30 is refused). */
function isRealIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_DATE.test(v) || !Number.isFinite(Date.parse(v))) return false;
  const day = v.slice(0, 10);
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === day;
}
/** Bias is a mean signed difference between levels 1 to 4, so it cannot exceed 3 in size; 4 leaves room. */
const MAX_BIAS = 4;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[0-9:.+Z-]+)?$/;
/** A short value printed in the stamp: printable ASCII without spaces, so it cannot carry control, bidirectional or markup-breaking text. */
const isToken = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && [...v].every((c) => c > " " && c < "\u007f");
const isPair = (v: unknown, keys: string[]): boolean => isObj(v) && keys.every((k) => isCount(v[k]));

/** True when every field that `stampLine` or the lookup reads has the expected type: a parseable but malformed file is not a calibration. */
function isSummary(v: unknown): v is CalibrationSummary {
  if (!isObj(v)) return false;
  return v.schema === "acr.calibration.summary/1" && isToken(v.scenarioId, 64) && isToken(v.rubricHash, 128) && isToken(v.variant, 64)
    && isObj(v.judge) && isToken(v.judge.label, 64) && isToken(v.judge.model, 200)
    && isRealIsoDate(v.ranAt)
    && isPair(v.probes, ["total", "tune", "holdout"]) && isPair(v.exact, ["n", "of"]) && isPair(v.contrast, ["ordered", "of", "probes"]) && isPair(v.usable, ["n", "of"])
    && (v.exact as { n: number; of: number }).n <= (v.exact as { of: number }).of
    && (v.contrast as { ordered: number }).ordered <= (v.contrast as { of: number }).of && (v.contrast as { of: number }).of <= (v.contrast as { probes: number }).probes
    && (v.bias === null || (typeof v.bias === "number" && Number.isFinite(v.bias) && Math.abs(v.bias) <= MAX_BIAS))
    && (v.label === "PASS" || v.label === "WARN" || v.label === "FAIL");
}

/** Why the figures are thin, or an empty list. A set is thin when it has too few probes or contrast was measured on too few usable groups. */
function thinReasons(s: CalibrationSummary): { fewProbes: boolean; fewContrast: boolean } {
  return { fewProbes: s.probes.total < MIN_SET_PROBES, fewContrast: s.contrast.of < s.contrast.probes || s.contrast.of < MIN_CONTRAST_GROUPS };
}

/**
 * What the calibration data says about this judge model, prompt variant and rubric. Never throws: a missing, unreadable, corrupt or malformed
 * file, a hostile id, or a file that names another model than the one asked for (file names are slugged and can collide) is `not_calibrated`.
 */
export async function lookupCalibration(dataDir: string, scenarioId: string, model: string, variant: string, rubricHash: string): Promise<StampState> {
  try {
    if (!isSafeId(scenarioId) || typeof model !== "string" || typeof variant !== "string" || typeof rubricHash !== "string") return NOT_CALIBRATED;
    const file = summaryFile(dataDir, scenarioId, model, variant);
    const s: unknown = JSON.parse(await readRegularCapped(file, MAX_SUMMARY_BYTES));
    if (!isSummary(s) || s.scenarioId !== scenarioId || s.judge.model !== model) return NOT_CALIBRATED;
    if (s.rubricHash !== rubricHash) return { state: "stale", reason: "the rubric changed since the last calibration" };
    if (s.variant !== variant) return { state: "stale", reason: "the prompt variant changed since the last calibration" };
    const t = thinReasons(s);
    return { state: t.fewProbes || t.fewContrast ? "thin" : "ok", summary: project(s) };
  } catch {
    return NOT_CALIBRATED;
  }
}

/** A copy holding only the validated fields: nothing else in the file reaches a report. */
function project(m: CalibrationSummary): CalibrationSummary {
  return {
    schema: m.schema, scenarioId: m.scenarioId, rubricHash: m.rubricHash, variant: m.variant, judge: { label: m.judge.label, model: m.judge.model }, ranAt: m.ranAt,
    probes: { total: m.probes.total, tune: m.probes.tune, holdout: m.probes.holdout }, exact: { n: m.exact.n, of: m.exact.of }, bias: m.bias,
    contrast: { ordered: m.contrast.ordered, of: m.contrast.of, probes: m.contrast.probes },
    usable: { n: m.usable.n, of: m.usable.of }, label: m.label,
  };
}

/** The state as it may be recorded: a malformed one (not produced by lookupCalibration) is replaced by not_calibrated. Never throws. */
export function normalizeStamp(s: unknown): StampState {
  try {
    if (!isObj(s)) return NOT_CALIBRATED;
    if (s.state === "stale" && typeof s.reason === "string") return { state: "stale", reason: s.reason.slice(0, 200) };
    if ((s.state === "ok" || s.state === "thin") && isSummary(s.summary)) return { state: s.state, summary: project(s.summary) };
    return NOT_CALIBRATED;
  } catch {
    return NOT_CALIBRATED;
  }
}

const NOT_CALIBRATED_LINE = "Calibration: not calibrated (no calibration result for this judge, prompt variant and rubric).";

/** The one-line stamp. States measurements only; never claims the scores are accurate. Never throws. */
export function stampLine(s: StampState | undefined): string {
  try {
    if (!s || s.state === "not_calibrated") return NOT_CALIBRATED_LINE;
    if (s.state === "stale") return `Calibration: not calibrated for this rubric or prompt version (${String(s.reason).slice(0, 200)}).`;
    if ((s.state !== "ok" && s.state !== "thin") || !isSummary(s.summary)) return NOT_CALIBRATED_LINE;
    const m = s.summary;
    const rounded = m.bias === null ? 0 : Number(m.bias.toFixed(1));
    const bias = m.bias === null ? "bias n/a" : `bias ${rounded === 0 ? "0.0" : `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}`} levels`;
    const t = thinReasons(m);
    const notes: string[] = [];
    if (t.fewProbes) notes.push(`fewer than ${MIN_SET_PROBES} probes`);
    if (t.fewContrast) notes.push("contrast was measured on few groups");
    const thin = s.state === "thin" ? ` Thin: ${notes.length ? notes.join(" and ") : "few probes"}; treat these numbers as indicative only.` : "";
    return `Scored by ${m.judge.model}, prompt ${m.variant}. Calibration on ${m.probes.total} probes (${m.ranAt.slice(0, 10)}): ${m.exact.n} of ${m.exact.of} exact, ${bias}, ${m.contrast.ordered} of ${m.contrast.of} contrast groups ordered, label ${m.label}.${thin}`;
  } catch {
    return NOT_CALIBRATED_LINE;
  }
}
