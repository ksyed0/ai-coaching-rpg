import { readdir } from "node:fs/promises";
import path from "node:path";
import { isFileSafeId, isSafeId } from "@acr/events";
import { FLAG_CODE_LIST } from "../evaluator/report-model.js";
import { readRegularCapped } from "../util/read-regular.js";
import { ReviewCorruptError } from "./errors.js";
import { sha256 } from "./hash.js";
import { GROUP, type Summary } from "./types.js";

export type DraftCriterion = {
  id: string;
  name: string;
  score: 1 | 2 | 3 | 4 | null;
  level_label: string;
  confidence: "high" | "medium" | "low" | null;
  rationale: string;
  flags: string[];
  flag_codes: string[];
  invalid: boolean;
};
export type DraftObjective = {
  id: string;
  statement: string;
  criteria: string[];
  incomplete: boolean;
};
export type DraftSubject = {
  id: string;
  kind: "participant" | "group";
  file: string;
  evaluationOk: boolean;
  criteria: DraftCriterion[];
  objectives: DraftObjective[];
  summary: Summary | null;
  raw: Record<string, unknown>;
};
export type Drafts = {
  sessionId: string;
  scenarioId: string;
  startedAt: string;
  rubricHash: string | null;
  legacy: boolean;
  subjects: Map<string, DraftSubject>;
  files: Record<string, string>;
};

const MAX_DRAFT_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 200;
const MAX_FLAGS = 20;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 2000): string | null =>
  typeof v === "string" && v.length <= max ? v : null;
const strs = (v: unknown, max = 50): string[] | null =>
  Array.isArray(v) &&
  v.length <= max &&
  v.every((x) => typeof x === "string" && x.length <= 2000)
    ? (v as string[])
    : null;

function bad(file: string, why: string): never {
  throw new ReviewCorruptError(`${file}: ${why}`);
}

/**
 * C0 and C1 controls except line feed and tab (terminal escape sequences start here) and the bidirectional controls
 * (U+202A-202E, U+2066-2069). Other invisible characters (ZWJ in emoji sequences, soft hyphen, U+2028) are legitimate in
 * titles; the renderers and `show` strip them before output.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-misleading-character-class
const BIDI = /[\u202a-\u202e\u2066-\u2069]/;
const dirty = (s: string): boolean => CONTROL.test(s) || BIDI.test(s);

/** Every string anywhere under `v` is free of control and hidden characters. */
function cleanDeep(file: string, v: unknown, what: string, depth = 0): void {
  if (depth > 8) bad(file, `${what} is nested too deeply`);
  if (typeof v === "string") {
    if (dirty(v)) bad(file, `${what} contains control characters`);
  } else if (Array.isArray(v))
    for (const x of v) cleanDeep(file, x, what, depth + 1);
  else if (isObj(v))
    for (const [k, x] of Object.entries(v)) {
      if (dirty(k)) bad(file, `${what} contains control characters`);
      cleanDeep(file, x, what, depth + 1);
    }
}
const isCount = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e9;

/** Fields the renderer prints as they are (numbers, times, method text) must be plain numbers and clean text; quotes and rationales are escaped by the renderer. */
function checkRaw(file: string, raw: Record<string, unknown>): void {
  const ev = raw.evaluator;
  if (!isObj(ev) || !isCount(ev.model_calls))
    bad(file, "evaluator.model_calls is not a count");
  cleanDeep(file, ev, "evaluator");
  cleanDeep(file, raw.method, "method");
  cleanDeep(file, raw.session, "session");
  cleanDeep(file, raw.scenario, "scenario");
  if (raw.kind === "participant") {
    const p = raw.participant;
    if (!isObj(p) || !isCount(p.utterances))
      bad(file, "participant.utterances is not a count");
  }
  const moments = (list: unknown, what: string) => {
    if (list === undefined) return;
    if (!Array.isArray(list) || list.length > MAX_ITEMS)
      bad(file, `${what} is invalid`);
    for (const m of list) {
      if (
        !isObj(m) ||
        !isCount(m.seq) ||
        !isCount(m.scene) ||
        typeof m.time !== "string" ||
        dirty(m.time) ||
        (m.scene_title !== undefined &&
          (typeof m.scene_title !== "string" || dirty(m.scene_title)))
      )
        bad(file, `${what} has an invalid seq, scene, time or scene title`);
    }
  };
  moments(raw.notable_moments, "notable_moments");
  if (Array.isArray(raw.criteria))
    for (const c of raw.criteria) {
      if (!isObj(c)) continue;
      moments(c.evidence, "evidence");
      if (typeof c.level_label === "string" && dirty(c.level_label))
        bad(file, "a level label contains control characters");
      if (typeof c.name === "string" && dirty(c.name))
        bad(file, "a criterion name contains control characters");
    }
}

function parseCriteria(file: string, raw: unknown): DraftCriterion[] {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS)
    bad(file, "criteria is missing or too long");
  return raw.map((c): DraftCriterion => {
    if (!isObj(c)) bad(file, "a criterion is not an object");
    const id = str(c.id, 64);
    const score = c.score;
    if (!id || !isSafeId(id)) bad(file, "a criterion id is not a safe id");
    if (!(
      score === null ||
      score === 1 ||
      score === 2 ||
      score === 3 ||
      score === 4
    ))
      bad(file, `criterion ${id}: score is not 1 to 4 or null`);
    const conf = c.confidence;
    if (!(
      conf === null ||
      conf === "high" ||
      conf === "medium" ||
      conf === "low"
    ))
      bad(file, `criterion ${id}: confidence is not valid`);
    const flags = strs(c.flags, MAX_FLAGS);
    const rationale = str(c.rationale, 5000);
    const name = str(c.name, 200);
    const label = str(c.level_label, 200);
    if (
      !flags ||
      rationale === null ||
      name === null ||
      label === null ||
      typeof c.invalid !== "boolean"
    )
      bad(file, `criterion ${id}: a field is missing or invalid`);
    let codes: string[] = [];
    if (c.flag_codes !== undefined) {
      const fc = strs(c.flag_codes, MAX_FLAGS);
      if (
        !fc ||
        fc.length !== flags.length ||
        !fc.every((x) => (FLAG_CODE_LIST as readonly string[]).includes(x))
      )
        bad(file, `criterion ${id}: flag_codes is not valid`);
      codes = fc;
    }
    return {
      id,
      name,
      score,
      level_label: label,
      confidence: conf,
      rationale,
      flags,
      flag_codes: codes,
      invalid: c.invalid,
    };
  });
}

function parseObjectives(file: string, raw: unknown): DraftObjective[] {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS)
    bad(file, "learning_objectives is missing or too long");
  return raw.map((o) => {
    if (!isObj(o)) bad(file, "a learning objective is not an object");
    const id = str(o.id, 64);
    const statement = str(o.statement, 1000);
    const criteria = strs(o.criteria, MAX_ITEMS);
    if (
      !id ||
      !isSafeId(id) ||
      statement === null ||
      !criteria ||
      !criteria.every(isSafeId) ||
      typeof o.incomplete !== "boolean"
    )
      bad(file, "a learning objective is invalid");
    return { id, statement, criteria, incomplete: o.incomplete };
  });
}

function parseSubject(
  file: string,
  raw: Record<string, unknown>,
): DraftSubject {
  checkRaw(file, raw);
  const group = raw.kind === "group";
  if (raw.kind !== "participant" && !group)
    bad(file, "kind is neither participant nor group");
  const role = group
    ? GROUP
    : str((raw.participant as Record<string, unknown> | undefined)?.role, 64);
  if (!group && role === GROUP)
    bad(file, "a participant report cannot use the group role id");
  if (!role || !isFileSafeId(role))
    bad(file, "the role id is not a safe file name");
  if (file !== `${role}.json`)
    bad(file, "the file name does not match the role");
  const ev = raw.evaluation;
  if (!isObj(ev) || typeof ev.status !== "string")
    bad(file, "evaluation is missing");
  let summary: Summary | null = null;
  if (!group) {
    const s = raw.summary;
    if (!isObj(s)) bad(file, "summary is missing");
    const strengths = strs(s.strengths);
    const dev = strs(s.development_points);
    const na =
      Array.isArray(s.next_actions) &&
      s.next_actions.length <= 50 &&
      s.next_actions.every(
        (a) =>
          isObj(a) && typeof a.lo === "string" && typeof a.action === "string",
      )
        ? (s.next_actions as { lo: string; action: string }[])
        : null;
    if (!strengths || !dev || !na) bad(file, "summary is invalid");
    summary = {
      strengths,
      development_points: dev,
      next_actions: na.map((a) => ({ lo: a.lo, action: a.action })),
    };
  }
  return {
    id: role,
    kind: group ? "group" : "participant",
    file,
    evaluationOk: ev.status === "ok",
    criteria: parseCriteria(file, raw.criteria),
    objectives: parseObjectives(file, raw.learning_objectives),
    summary,
    raw,
  };
}

/** Reads the draft directory like untrusted input: every file hashed, every report validated, sizes capped. `only` limits it to the files a review recorded. */
export async function loadDrafts(
  dir: string,
  only?: ReadonlySet<string>,
): Promise<Drafts> {
  const names = (await readdir(dir))
    .filter(
      (n) =>
        /\.(md|json)$/.test(n) &&
        n !== "review.jsonl" &&
        n !== "review.lock" &&
        (only ? only.has(n) : true),
    )
    .sort();
  const files: Record<string, string> = {};
  const subjects = new Map<string, DraftSubject>();
  let meta: {
    sessionId: string;
    scenarioId: string;
    startedAt: string;
    rubricHash: string | null;
  } | null = null;
  let legacy = false;
  for (const name of names) {
    let text: string;
    try {
      text = await readRegularCapped(path.join(dir, name), MAX_DRAFT_BYTES);
    } catch {
      bad(
        name,
        "cannot be read (too large, not a regular file or a symbolic link)",
      );
    }
    files[name] = sha256(text);
    if (!name.endsWith(".json")) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      bad(name, "is not valid JSON");
    }
    if (!isObj(raw) || raw.schema !== "acr.report/1")
      bad(name, "is not an acr.report/1 report");
    const s = parseSubject(name, raw);
    if (
      (raw.criteria as Record<string, unknown>[]).some(
        (c) => c.flag_codes === undefined,
      )
    )
      legacy = true;
    const session = raw.session as Record<string, unknown> | undefined;
    const scenario = raw.scenario as Record<string, unknown> | undefined;
    const evaluator = raw.evaluator as Record<string, unknown> | undefined;
    const m = {
      sessionId: str(session?.id, 64) ?? "",
      scenarioId: str(scenario?.id, 64) ?? "",
      startedAt: str(session?.date, 64) ?? "",
      rubricHash: str(evaluator?.rubricHash, 128),
    };
    if (!isSafeId(m.sessionId) || !isSafeId(m.scenarioId))
      bad(name, "session or scenario id is not a safe id");
    if (
      meta &&
      (meta.sessionId !== m.sessionId ||
        meta.scenarioId !== m.scenarioId ||
        meta.startedAt !== m.startedAt ||
        meta.rubricHash !== m.rubricHash)
    )
      bad(
        name,
        "belongs to a different session or scenario than the other reports",
      );
    meta = m;
    subjects.set(s.id, s);
  }
  if (!meta || !subjects.has(GROUP) || subjects.size < 2)
    throw new ReviewCorruptError(
      "this directory does not hold a complete set of draft reports (a group report and at least one player)",
    );
  return { ...meta, legacy, subjects, files };
}
