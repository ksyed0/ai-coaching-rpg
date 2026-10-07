import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { isPrototypeKey } from "@acr/events";
import { readTextCapped, type Criterion, type Rubric, type Scenario } from "@acr/script";
import { MIN_UTTERANCES } from "../evaluator/evaluate.js";
import { isHiddenChar, stripHidden } from "./hidden-chars.js";
import { ProbeSchema, scoredRoles, type Probe } from "./probe-schema.js";

export const MIN_SET_PROBES = 20;
export const MIN_CRITERION_PROBES = 4;
export const MIN_HOLDOUT_PROBES = 10;
export const MAX_PROBE_BYTES = 128 * 1024;
const MAX_ALIASES = 10;
const MAX_REPORTED_ISSUES = 5;
const MIN_BALANCE_EXPECTATIONS = 8;
const MIN_LEVEL_SHARE = 15;
const MAX_LEVEL_SHARE = 40;

export type LoadedProbes = { probes: Probe[]; errors: string[]; warnings: string[] };

/** True when a parsed YAML/JSON value holds a prototype-like key at any depth (up to 8 levels). */
export function hasPrototypeKey(v: unknown, depth = 0): boolean {
  if (v === null || typeof v !== "object" || depth > 8) return false;
  for (const k of Object.keys(v as object)) {
    if (isPrototypeKey(k) || hasPrototypeKey((v as Record<string, unknown>)[k], depth + 1)) return true;
  }
  return false;
}

/** Make untrusted text safe for a one-line message: every character of the hidden-character table, and TAB and LF, becomes a dot; long text is cut. */
export function printable(s: string, max = 80): string {
  let out = "";
  let n = 0;
  for (const ch of s) {
    if (n === max) return `${out}…`;
    const c = ch.codePointAt(0)!;
    out += c === 0x09 || c === 0x0a || isHiddenChar(c) ? "·" : ch;
    n++;
  }
  return out;
}

/**
 * Parses YAML without ever writing to the process: the yaml library's `parse` reports warnings (an unknown tag, for example) through
 * process.emitWarning with a snippet of the source, unscrubbed. Here every error and warning becomes the thrown message instead.
 */
export function parseYamlQuiet(text: string, maxAliasCount: number): unknown {
  const doc = parseDocument(text, { logLevel: "silent", prettyErrors: false });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) throw new Error(problem.message);
  return doc.toJS({ maxAliasCount });
}

export async function loadProbes(dir: string, scenario: Scenario, rubrics: Rubric[]): Promise<LoadedProbes> {
  const out: LoadedProbes = { probes: [], errors: [], warnings: [] };
  const calDir = path.join(dir, "calibration");
  let st;
  try {
    st = await lstat(calDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      out.warnings.push(`no calibration directory at ${printable(calDir, 300)}`);
      return out;
    }
    out.errors.push(`calibration directory cannot be read: ${printable((e as Error).message.split("\n")[0] ?? "", 200)}`);
    return out;
  }
  if (st.isSymbolicLink()) {
    out.errors.push("calibration directory must not be a symbolic link");
    return out;
  }
  if (!st.isDirectory()) {
    out.errors.push("calibration exists but is not a directory");
    return out;
  }
  let entries;
  try {
    entries = await readdir(calDir, { withFileTypes: true });
  } catch (e) {
    out.errors.push(`calibration directory cannot be read: ${printable((e as Error).message.split("\n")[0] ?? "", 200)}`);
    return out;
  }
  const individual = individualCriteria(rubrics);
  const files: string[] = [];
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (e.isDirectory() || e.name === "targets.yaml") continue;
    if (e.name.endsWith(".yml")) out.warnings.push(`${printable(e.name)}: ignored (probe files must end in .yaml)`);
    else if (!e.name.endsWith(".yaml")) continue;
    else if (e.isSymbolicLink()) out.errors.push(`${printable(e.name)}: symbolic links are not followed`);
    else if (e.isFile()) files.push(e.name);
  }
  const seen = new Set<string>();
  for (const name of files) {
    const probe = await parseOne(path.join(calDir, name), name, out.errors);
    if (!probe) continue;
    const probeWarnings: string[] = [];
    const problems = checkProbe(name, probe, scenario, individual, probeWarnings);
    if (seen.has(probe.id)) problems.push(`${printable(name)}: duplicate probe id ${probe.id}`);
    if (problems.length) { out.errors.push(...problems); continue; }
    out.warnings.push(...probeWarnings);
    seen.add(probe.id);
    out.probes.push(probe);
  }
  out.warnings.push(...lintProbeSet(out.probes));
  return out;
}

async function parseOne(file: string, name: string, errors: string[]): Promise<Probe | null> {
  const label = printable(name);
  let raw: unknown;
  try {
    raw = parseYamlQuiet(await readTextCapped(file, MAX_PROBE_BYTES), MAX_ALIASES);
  } catch (e) {
    errors.push(`${label}: ${printable((e as Error).message.split("\n")[0] ?? "", 200)}`);
    return null;
  }
  if (hasPrototypeKey(raw)) { errors.push(`${label}: a prototype key is not allowed`); return null; }
  const r = ProbeSchema.safeParse(raw);
  if (!r.success) {
    const shown = r.error.issues.slice(0, MAX_REPORTED_ISSUES).map((i) => `${i.path.map((k) => printable(String(k))).join(".") || "(root)"} ${printable(i.message, 200)}`);
    const more = r.error.issues.length - shown.length;
    errors.push(`${label}: ${shown.join("; ")}${more > 0 ? ` (+${more} more)` : ""}`);
    return null;
  }
  return r.data;
}

/**
 * Invisible characters stripped, lower-cased, every whitespace run collapsed to one space: a hidden fact is found whatever the casing or
 * spacing of the line, and tag characters, zero-width characters or soft hyphens inside it cannot smuggle it past the check.
 */
function normalise(s: string): string {
  return stripHidden(s).toLowerCase().split(/\s+/).filter((w) => w !== "").join(" ");
}

/** A hidden fact shorter than this is too generic to be told apart from ordinary speech. */
const MIN_HIDDEN_FACT_CHARS = 20;

/** The individual criteria of the rubrics by id (probes target only these). */
export function individualCriteria(rubrics: Rubric[]): Map<string, Criterion> {
  const individual = new Map<string, Criterion>();
  for (const r of rubrics) if (r.scope === "individual") for (const c of r.criteria) individual.set(c.id, c);
  return individual;
}

/**
 * The AI characters one of whose hidden facts appears in one of `texts` (after normalising case and spacing; facts under 20 characters are
 * ignored as too generic). Returns role ids only: the fact text is never part of a message.
 */
export function hiddenFactRoles(texts: string[], scenario: Scenario): string[] {
  const lines = texts.map(normalise);
  const out: string[] = [];
  for (const [role, def] of Object.entries(scenario.roles)) {
    const facts = (def.type === "npc" ? def.hidden : []).map(normalise).filter((f) => f.length >= MIN_HIDDEN_FACT_CHARS);
    if (facts.some((f) => lines.some((t) => t.includes(f)))) out.push(role);
  }
  return out;
}

/**
 * The loader's semantic checks of one probe against its scenario and rubrics (file name, criterion, scenes, roles, participants, hidden
 * facts, scored roles), for callers outside the loader (the approve command). `name` is the file name the probe has or will have.
 */
export function checkProbeAgainstScenario(name: string, p: Probe, scenario: Scenario, rubrics: Rubric[]): { problems: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const problems = checkProbe(name, p, scenario, individualCriteria(rubrics), warnings);
  return { problems, warnings: problems.length ? [] : warnings };
}

/** The problems of one probe; its warnings go to `warnings`, which the caller keeps only for a probe without problems. */
function checkProbe(name: string, p: Probe, scenario: Scenario, individual: Map<string, Criterion>, warnings: string[]): string[] {
  const problems: string[] = [];
  const label = printable(name);
  if (`${p.id}.yaml` !== name) problems.push(`${label}: the id ${p.id} must match the file name`);
  if (!individual.has(p.criterion)) problems.push(`${label}: criterion ${p.criterion} is not an individual criterion of this scenario's rubrics`);
  const scenes = new Map(scenario.script.scenes.map((s) => [s.id, s]));
  const counts = new Map<string, number>();
  const notParticipant = new Set<string>();
  for (const l of p.transcript) {
    const scene = scenes.get(l.scene);
    if (!scene) problems.push(`${label}: unknown scene ${l.scene}`);
    const known = Object.hasOwn(scenario.roles, l.role);
    if (!known) problems.push(`${label}: unknown role ${l.role}`);
    if (scene && known && !scene.participants.includes(l.role)) notParticipant.add(`${l.role} is not a participant of scene ${l.scene}`);
    counts.set(l.role, (counts.get(l.role) ?? 0) + 1);
  }
  for (const m of notParticipant) problems.push(`${label}: ${m}`);
  for (const role of hiddenFactRoles(p.transcript.map((l) => l.text), scenario)) problems.push(`${label}: a transcript line contains a hidden fact of ${role}`);
  const scored = new Set(scoredRoles(p));
  for (const role of scored) {
    const def = Object.hasOwn(scenario.roles, role) ? scenario.roles[role] : undefined;
    if (def?.type !== "player") problems.push(`${label}: ${role} is not a player role`);
    else if ((counts.get(role) ?? 0) < MIN_UTTERANCES) problems.push(`${label}: ${role} needs at least ${MIN_UTTERANCES} lines to be scored`);
  }
  // evaluateSession scores every scenario player with at least MIN_UTTERANCES lines, so an unscored one costs a call whose result is dropped
  for (const [role, n] of counts) {
    const def = Object.hasOwn(scenario.roles, role) ? scenario.roles[role] : undefined;
    if (def?.type === "player" && !scored.has(role) && n >= MIN_UTTERANCES) {
      warnings.push(`${label}: ${role} speaks ${n} times but is not scored (costs a model call); give them one line or make them a subject`);
    }
  }
  return problems;
}

export function lintProbeSet(probes: Probe[]): string[] {
  if (probes.length === 0) return [];
  const w: string[] = [];
  if (probes.length < MIN_SET_PROBES) w.push(`the probe set has fewer than ${MIN_SET_PROBES} probes (${probes.length}): results are thin`);
  const holdout = probes.filter((p) => p.split === "holdout").length;
  if (holdout < MIN_HOLDOUT_PROBES) w.push(`only ${holdout} holdout probes (at least ${MIN_HOLDOUT_PROBES} are needed before a default change)`);
  const byCriterion = new Map<string, number>();
  for (const p of probes) byCriterion.set(p.criterion, (byCriterion.get(p.criterion) ?? 0) + 1);
  for (const [c, n] of byCriterion) if (n < MIN_CRITERION_PROBES) w.push(`criterion ${c} has fewer than ${MIN_CRITERION_PROBES} probes (${n}): thin`);
  const expected: number[] = probes.flatMap((p) => (p.kind === "single" ? (typeof p.expected === "number" ? [p.expected] : []) : Object.values(p.players)));
  const ends = expected.filter((l) => l === 1 || l === 4).length;
  let unbalanced = false;
  if (expected.length >= MIN_BALANCE_EXPECTATIONS) {
    for (const level of [1, 2, 3, 4]) {
      const n = expected.filter((l) => l === level).length;
      // integer comparison: 15% and 40% exactly are inside the range
      if (n * 100 < MIN_LEVEL_SHARE * expected.length || n * 100 > MAX_LEVEL_SHARE * expected.length) {
        unbalanced = true;
        // floored to one decimal: a share that fails the range is never printed as the threshold it missed (14.6% is not 15%)
        w.push(`expected levels are unbalanced: level ${level} has ${n} of ${expected.length} expectations (share ${Math.floor((n * 1000) / expected.length) / 10}%); aim for ${MIN_LEVEL_SHARE}% to ${MAX_LEVEL_SHARE}% per level`);
      }
    }
  }
  // The unbalanced warning already says the set is lopsided; the mid-heavy one is for a small set the balance check does not cover.
  if (!unbalanced && expected.length > 0 && (!expected.includes(1) || !expected.includes(4) || ends / expected.length < 0.3)) {
    w.push("expected levels are mid-heavy: add probes at levels 1 and 4 (a judge that always answers 3 would otherwise go unnoticed)");
  }
  return w;
}

/** Deterministic tune/holdout assignment; the result is stored in the probe file and never recomputed for an existing probe. */
export function assignSplit(id: string, total: number): "tune" | "holdout" {
  const pct = total < 40 ? 50 : 70;
  const n = Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16);
  return n % 100 < pct ? "tune" : "holdout";
}
