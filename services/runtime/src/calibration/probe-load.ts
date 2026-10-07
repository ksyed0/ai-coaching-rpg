import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { isPrototypeKey } from "@acr/events";
import { readTextCapped, type Criterion, type Rubric, type Scenario } from "@acr/script";
import { MIN_UTTERANCES } from "../evaluator/evaluate.js";
import { ProbeSchema, scoredRoles, type Probe } from "./probe-schema.js";

export const MIN_SET_PROBES = 20;
export const MIN_CRITERION_PROBES = 4;
export const MIN_HOLDOUT_PROBES = 10;
export const MAX_PROBE_BYTES = 128 * 1024;
const MAX_ALIASES = 10;

export type LoadedProbes = { probes: Probe[]; errors: string[]; warnings: string[] };

function hasPrototypeKey(v: unknown, depth = 0): boolean {
  if (v === null || typeof v !== "object" || depth > 8) return false;
  for (const k of Object.keys(v as object)) {
    if (isPrototypeKey(k) || hasPrototypeKey((v as Record<string, unknown>)[k], depth + 1)) return true;
  }
  return false;
}

export async function loadProbes(dir: string, scenario: Scenario, rubrics: Rubric[]): Promise<LoadedProbes> {
  const out: LoadedProbes = { probes: [], errors: [], warnings: [] };
  const calDir = path.join(dir, "calibration");
  let entries;
  try {
    entries = await readdir(calDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      out.warnings.push(`no calibration directory at ${calDir}`);
      return out;
    }
    throw e;
  }
  const individual = new Map<string, Criterion>();
  for (const r of rubrics) if (r.scope === "individual") for (const c of r.criteria) individual.set(c.id, c);
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".yaml") && e.name !== "targets.yaml").map((e) => e.name).sort();
  const seen = new Set<string>();
  for (const name of files) {
    const probe = await parseOne(path.join(calDir, name), name, out.errors);
    if (!probe) continue;
    const problems = checkProbe(name, probe, scenario, individual);
    if (seen.has(probe.id)) problems.push(`${name}: duplicate probe id ${probe.id}`);
    if (problems.length) { out.errors.push(...problems); continue; }
    seen.add(probe.id);
    out.probes.push(probe);
  }
  out.warnings.push(...lintProbeSet(out.probes));
  return out;
}

async function parseOne(file: string, name: string, errors: string[]): Promise<Probe | null> {
  let raw: unknown;
  try {
    raw = parse(await readTextCapped(file, MAX_PROBE_BYTES), { maxAliasCount: MAX_ALIASES });
  } catch (e) {
    errors.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
    return null;
  }
  if (hasPrototypeKey(raw)) { errors.push(`${name}: a prototype key is not allowed`); return null; }
  const r = ProbeSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0]!;
    errors.push(`${name}: ${i.path.join(".") || "(root)"} ${i.message}`);
    return null;
  }
  return r.data;
}

function checkProbe(name: string, p: Probe, scenario: Scenario, individual: Map<string, Criterion>): string[] {
  const problems: string[] = [];
  if (`${p.id}.yaml` !== name) problems.push(`${name}: the id ${p.id} must match the file name`);
  if (!individual.has(p.criterion)) problems.push(`${name}: criterion ${p.criterion} is not an individual criterion of this scenario's rubrics`);
  const sceneIds = new Set(scenario.script.scenes.map((s) => s.id));
  const counts = new Map<string, number>();
  for (const l of p.transcript) {
    if (!sceneIds.has(l.scene)) problems.push(`${name}: unknown scene ${l.scene}`);
    if (!Object.hasOwn(scenario.roles, l.role)) problems.push(`${name}: unknown role ${l.role}`);
    counts.set(l.role, (counts.get(l.role) ?? 0) + 1);
  }
  for (const role of scoredRoles(p)) {
    const def = Object.hasOwn(scenario.roles, role) ? scenario.roles[role] : undefined;
    if (def?.type !== "player") problems.push(`${name}: ${role} is not a player role`);
    else if ((counts.get(role) ?? 0) < MIN_UTTERANCES) problems.push(`${name}: ${role} needs at least ${MIN_UTTERANCES} lines to be scored`);
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
