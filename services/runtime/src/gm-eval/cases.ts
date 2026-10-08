import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { NpcRole, Scenario } from "@acr/script";
import type { ShowcaseScript } from "../demo/showcase-script.js";

/** One labelled Game Master case: a scene, one exit condition, the dialogue so far, and the human label (is the condition met?). */
export type GmCase = {
  id: string;
  scene: { id: string; title: string; goal: string };
  condition: string;
  dialogue: { role: string; text: string }[];
  /** The human judgement: true = the condition is met by this dialogue. */
  label: boolean;
  /** Where the dialogue came from, e.g. `showcase:s3_internal_huddle:full`. */
  source: string;
};
export type GmCaseFile = { version: 1; description: string; cases: GmCase[] };

/**
 * The human labelling of the negative controls, made once and keyed by scenario id, then scene id: after how many scripted player lines of each
 * scene the condition is still NOT met (the lines are cut before the agreement). The full scene is labelled "met".
 * s3 keeps the proposal whose last line is the unanswered question: an unopposed proposal is not an agreement. Hard negatives: s1 at 4 lines ends on
 * the unanswered "What if we offer it as a phase two...?"; s6 at 3 lines has named owners for two follow-ups but the tech lead has only raised the
 * third (the risk review and the build plan) with "someone needs to ...", so one follow-up has no owner yet.
 */
export const NEGATIVE_CUTS: Readonly<Record<string, Readonly<Record<string, readonly number[]>>>> = {
  // US-0040, the original Friday Escalation (esc-scope-creep-01): s1 at 3 and 4 lines has concerns and the unanswered "What if we offer it as a phase two...?" but no agreed
  // position; s2 at 2 lines has the risk explained and a phased module offered (Priya's fact is earned) but she has agreed nothing yet, so no next step; s3 at 1 line has only
  // the proposal's owner stated, and at 3 lines the tech lead has raised the estimate and the message to the wider team with "someone should" (no owner yet).
  // These labels exist so a live run can report early Game Master exits (S-18); `tests/gm-cases/showcase.json` is built from the extended scenario only, so
  // `--max-false-exits` (which compares it) is not usable with this scenario until cases are built for it.
  "esc-scope-creep-01": { s1_huddle: [3, 4], s2_client_call: [2], s3_internal_wrap: [1, 3] },
  "esc-scope-creep-02": { s1_huddle: [3, 4], s2_priya_call: [2], s3_internal_huddle: [3], s4_escalation_call: [2], s5_final_terms: [3], s6_wrap_up: [1, 3] },
};

/** The most scripted lines of a scene after which an exit is still an EARLY exit (the condition is labelled not met up to there); 0 when unlabelled. */
export function lastNegativeLine(scenarioId: string, sceneId: string): number { return Math.max(0, ...(NEGATIVE_CUTS[scenarioId]?.[sceneId] ?? [])); }

/** The dialogue of a scene's first `keep` scripted lines, each followed by the mock replies of the AI characters present (junior first, as in a real run). */
function dialogueOf(scenario: Scenario, entry: ShowcaseScript["scenes"][number], participants: string[], keep: number): GmCase["dialogue"] {
  const npcs = participants.map((id) => scenario.roles[id]).filter((r): r is NpcRole => r?.type === "npc")
    .map((r, i) => ({ r, i })).sort((a, b) => a.r.seniority - b.r.seniority || a.i - b.i).map((x) => x.r);
  const out: GmCase["dialogue"] = [];
  entry.lines.slice(0, keep).forEach((line, i) => {
    out.push({ role: line.role, text: line.text });
    for (const n of npcs) { const reply = entry.mock.npc[n.id]?.[i]; if (reply) out.push({ role: n.id, text: reply }); }
  });
  return out;
}

/**
 * The cases built from a showcase script: per scene with a Game Master condition, the full scripted dialogue (label true) and a negative control
 * cut before the agreement (label false). Pure; `pnpm gm-eval --build <dir>` writes the result, and a test keeps the committed file in sync.
 */
export function buildShowcaseCases(scenario: Scenario, script: ShowcaseScript): GmCase[] {
  const cases: GmCase[] = [];
  for (const scene of scenario.script.scenes) {
    const entry = script.scenes.find((s) => s.scene === scene.id);
    const conditions = scene.exit_when.any_of.filter((c): c is { gm_detects: string } => typeof c === "object").map((c) => c.gm_detects);
    if (!entry) continue;
    const cuts = NEGATIVE_CUTS[scenario.meta.id]?.[scene.id] ?? [];
    for (const condition of conditions) {
      const meta = { id: scene.id, title: scene.title, goal: scene.goal };
      cases.push({ id: `${scene.id}:full`, scene: meta, condition, dialogue: dialogueOf(scenario, entry, scene.participants, entry.lines.length), label: true, source: `showcase:${scene.id}:full` });
      for (const keep of cuts) {
        if (keep >= entry.lines.length) continue;
        cases.push({ id: `${scene.id}:cut-${keep}`, scene: meta, condition, dialogue: dialogueOf(scenario, entry, scene.participants, keep), label: false, source: `showcase:${scene.id}:cut-${keep}` });
      }
    }
  }
  return cases;
}

export class CaseFileError extends Error {
  constructor(message: string) { super(message); this.name = "CaseFileError"; }
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Validates one case; every problem names the case. Never trusts a file's shape. */
export function validateCase(raw: unknown, where: string): GmCase {
  const bad = (m: string): never => { throw new CaseFileError(`${where}: ${m}`); };
  if (!raw || typeof raw !== "object") return bad("a case must be an object");
  const c = raw as Record<string, unknown>;
  if (!isStr(c.id)) bad("id must be a non-empty string");
  const scene = c.scene as Record<string, unknown> | undefined;
  if (!scene || !isStr(scene.id) || !isStr(scene.title) || typeof scene.goal !== "string") bad("scene needs id, title and goal");
  if (!isStr(c.condition)) bad("condition must be a non-empty string");
  if (typeof c.label !== "boolean") bad("label must be true or false (the human judgement)");
  if (!isStr(c.source)) bad("source must be a non-empty string");
  if (!Array.isArray(c.dialogue) || c.dialogue.length === 0) bad("dialogue must be a non-empty array");
  for (const [i, d] of (c.dialogue as unknown[]).entries()) {
    const r = d as Record<string, unknown>;
    if (!r || !isStr(r.role) || typeof r.text !== "string") bad(`dialogue[${i}] needs a role and a text`);
  }
  // Rebuild a typed object from the validated fields only: unknown extra keys in a case file are dropped, never passed on to a prompt.
  const scene2 = c.scene as { id: string; title: string; goal: string };
  return {
    id: c.id as string, scene: { id: scene2.id, title: scene2.title, goal: scene2.goal }, condition: c.condition as string,
    dialogue: (c.dialogue as { role: string; text: string }[]).map((d) => ({ role: d.role, text: d.text })), label: c.label as boolean, source: c.source as string,
  };
}

/** Loads cases from one JSON file or every `*.json` file of a directory (a file may hold `{cases: [...]}` or a bare array). Files without cases (e.g. the parser corpus) are skipped. */
export async function loadCases(target: string): Promise<GmCase[]> {
  let files: string[];
  let info;
  try { info = await stat(target); } catch { throw new CaseFileError(`cannot read ${target}`); }
  if (info.isDirectory()) files = (await readdir(target)).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(target, f));
  else files = [target];
  const out: GmCase[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    let data: unknown;
    try { data = JSON.parse(await readFile(file, "utf8")); } catch { throw new CaseFileError(`${path.basename(file)}: not valid JSON`); }
    const list = Array.isArray(data) ? data : (data as { cases?: unknown })?.cases;
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new CaseFileError(`${path.basename(file)}: cases must be an array`);
    list.forEach((raw, i) => {
      const c = validateCase(raw, `${path.basename(file)} case ${i + 1}`);
      if (seen.has(c.id)) throw new CaseFileError(`${path.basename(file)}: duplicate case id ${JSON.stringify(c.id)}`);
      seen.add(c.id); out.push(c);
    });
  }
  return out;
}
