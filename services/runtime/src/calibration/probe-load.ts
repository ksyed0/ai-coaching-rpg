import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { isPrototypeKey } from "@acr/events";
import { readTextCapped, type Criterion, type Rubric, type Scenario } from "@acr/script";
import { MIN_UTTERANCES } from "../evaluator/evaluate.js";
import { ProbeSchema, scoredRoles, type Probe } from "./probe-schema.js";

export const MIN_SET_PROBES = 20;
export const MIN_CRITERION_PROBES = 4;
export const MIN_HOLDOUT_PROBES = 10;
export const MAX_PROBE_BYTES = 128 * 1024;
const MAX_ALIASES = 10;
const MAX_REPORTED_ISSUES = 5;

export type LoadedProbes = { probes: Probe[]; errors: string[]; warnings: string[] };

function hasPrototypeKey(v: unknown, depth = 0): boolean {
  if (v === null || typeof v !== "object" || depth > 8) return false;
  for (const k of Object.keys(v as object)) {
    if (isPrototypeKey(k) || hasPrototypeKey((v as Record<string, unknown>)[k], depth + 1)) return true;
  }
  return false;
}

/**
 * Characters that must never reach a terminal or a rendered report from untrusted text: C0 and C1 controls, zero-width characters and
 * direction marks (U+200B..U+200F), the line and paragraph separators and bidi embeddings and overrides (U+2028..U+202E), the bidi
 * isolates (U+2066..U+2069), the Arabic letter mark (U+061C) and the zero-width no-break space (U+FEFF).
 */
function isHidden(c: number): boolean {
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x061c || c === 0xfeff;
}

/** Make untrusted text safe for a one-line message: control, bidi and zero-width characters become a dot, long text is cut. */
export function printable(s: string, max = 80): string {
  let out = "";
  let n = 0;
  for (const ch of s) {
    if (n === max) return `${out}…`;
    out += isHidden(ch.codePointAt(0)!) ? "·" : ch;
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
  const individual = new Map<string, Criterion>();
  for (const r of rubrics) if (r.scope === "individual") for (const c of r.criteria) individual.set(c.id, c);
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
    const problems = checkProbe(name, probe, scenario, individual);
    if (seen.has(probe.id)) problems.push(`${printable(name)}: duplicate probe id ${probe.id}`);
    if (problems.length) { out.errors.push(...problems); continue; }
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

function checkProbe(name: string, p: Probe, scenario: Scenario, individual: Map<string, Criterion>): string[] {
  const problems: string[] = [];
  const label = printable(name);
  if (`${p.id}.yaml` !== name) problems.push(`${label}: the id ${p.id} must match the file name`);
  if (!individual.has(p.criterion)) problems.push(`${label}: criterion ${p.criterion} is not an individual criterion of this scenario's rubrics`);
  const sceneIds = new Set(scenario.script.scenes.map((s) => s.id));
  const counts = new Map<string, number>();
  for (const l of p.transcript) {
    if (!sceneIds.has(l.scene)) problems.push(`${label}: unknown scene ${l.scene}`);
    if (!Object.hasOwn(scenario.roles, l.role)) problems.push(`${label}: unknown role ${l.role}`);
    counts.set(l.role, (counts.get(l.role) ?? 0) + 1);
  }
  for (const role of scoredRoles(p)) {
    const def = Object.hasOwn(scenario.roles, role) ? scenario.roles[role] : undefined;
    if (def?.type !== "player") problems.push(`${label}: ${role} is not a player role`);
    else if ((counts.get(role) ?? 0) < MIN_UTTERANCES) problems.push(`${label}: ${role} needs at least ${MIN_UTTERANCES} lines to be scored`);
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
  if (expected.length > 0 && (!expected.includes(1) || !expected.includes(4) || ends / expected.length < 0.3)) {
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
