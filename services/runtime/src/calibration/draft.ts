import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Document, isMap, isScalar, parseDocument, stringify, type YAMLMap } from "yaml";
import type { ChatRequest, ModelProvider } from "@acr/adapters";
import { isFileSafeId, type SessionEvent } from "@acr/events";
import type { Criterion, Rubric, Scenario } from "@acr/script";
import { collectModelReply } from "../agents/model-reply.js";
import { extractJson } from "../evaluator/parse.js";
import { hasHiddenChar, HIDDEN_CHARS_MESSAGE } from "./hidden-chars.js";
import { CalibrationInputError, modelFamily, type Judge } from "./judge.js";
import { assignSplit, checkProbeAgainstScenario, hasPrototypeKey, hiddenFactRoles, individualCriteria, MAX_PROBE_BYTES, parseYamlQuiet, printable } from "./probe-load.js";
import { LineSchema, MAX_PROBE_ID, ProbeSchema, type Expected, type Level, type Probe } from "./probe-schema.js";

// The draft -> review -> approve workflow (spec section 6). Drafts live in <scenario>/calibration/drafts/, which the loader never reads (it
// skips sub-directories), so a draft is never part of a calibration run. Only `approveDraft`, a command the owner runs, turns a draft into a
// probe. Every file is created exclusively (`wx`, mode 0o600): nothing here ever overwrites a file.

export const LEVELS: readonly Level[] = [1, 2, 3, 4];
export const MAX_PER_LEVEL = 3;
export const MAX_DRAFT_LINES = 8;
/** A draft reply is a few KiB of JSON; anything longer is cut off and refused, so a runaway model cannot fill memory. */
export const MAX_DRAFT_REPLY_CHARS = 64 * 1024;
export const MAX_EXCERPT_LINES = 80;
export const MAX_APPROVER_CHARS = 120;
const MAX_ALIASES = 10;
const DRAFT_PREFIX = "draft-";
const DEFAULT_DRAFT_TEMPERATURE = 0.7;
/** O_NOFOLLOW where the platform has it: a symbolic link at the last path component is refused (ELOOP) instead of followed. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const ID_RULE = `1 to ${MAX_PROBE_ID} characters of lower-case letters, digits, '_' or '-'`;
const isProbeId = (id: string): boolean => isFileSafeId(id) && id.length <= MAX_PROBE_ID;
const code = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? "failed";
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
const oneLine = (s: string): string => s.split(/\s+/).filter((w) => w !== "").join(" ");

export type Timeouts = { firstTokenTimeoutMs: number; replyTimeoutMs: number };

// ---- files ---------------------------------------------------------------------------------------------------------

/**
 * Makes sure `dir` is a real directory: created with mode 0o700 when missing, then opened with O_DIRECTORY | O_NOFOLLOW, so a pre-planted
 * symbolic link (or a file) in its place is refused rather than written through. No stat-then-use: the open itself is the check. A link
 * planted in the window between this open and the file creation that follows is not detected (Node has no openat); the file creation
 * itself is exclusive, so even then no existing file is ever overwritten.
 */
async function ensureRealDir(dir: string, label: string): Promise<void> {
  try { await mkdir(dir, { mode: 0o700 }); } catch (e) {
    if (code(e) !== "EEXIST") throw new CalibrationInputError(`${label} cannot be created (${code(e)})`);
  }
  try { await assertRealDir(dir, label); } catch (e) {
    if (e instanceof CalibrationInputError) throw e;
    throw new CalibrationInputError(`${label} cannot be opened (${code(e)})`);
  }
}

/** `dir` opened with O_DIRECTORY | O_NOFOLLOW (never created): a symbolic link or a file in its place is refused. ENOENT is rethrown as is. */
async function assertRealDir(dir: string, label: string): Promise<void> {
  let fh: FileHandle;
  try { fh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW); } catch (e) {
    const c = code(e);
    if (c === "ELOOP" || c === "ENOTDIR") throw new CalibrationInputError(`${label} must be a directory, not a symbolic link or a file`);
    if (c === "ENOENT") throw e;
    throw new CalibrationInputError(`${label} cannot be opened (${c})`);
  }
  await fh.close();
}

/**
 * Creates `file` exclusively (`wx`, 0o600) and writes `text` through that one handle. When the write or close fails (ENOSPC midway), the
 * file this call created is removed (unlink errors ignored) before the error is rethrown, so no truncated draft or probe is left. When
 * the open itself fails (EEXIST: someone else's file) nothing is removed.
 */
async function writeExclusive(file: string, text: string): Promise<void> {
  const fh = await open(file, "wx", 0o600);
  try {
    const buf = Buffer.from(text, "utf8");
    for (let off = 0; off < buf.length;) off += (await fh.write(buf, off, buf.length - off)).bytesWritten;
    await fh.close();
  } catch (e) {
    await fh.close().catch(() => undefined);
    await unlink(file).catch(() => undefined);
    throw e;
  }
}

/** <scenario>/calibration/drafts, both levels checked as real directories. */
async function draftsDir(scenarioDir: string): Promise<string> {
  const cal = path.join(scenarioDir, "calibration");
  await ensureRealDir(cal, "calibration");
  const drafts = path.join(cal, "drafts");
  await ensureRealDir(drafts, "calibration/drafts");
  return drafts;
}

/** Reads at most `max` bytes from ONE handle opened without following a symbolic link (ELOOP), so there is no check-then-use. */
async function readNoFollow(file: string, max: number): Promise<string> {
  const fh = await open(file, constants.O_RDONLY | NOFOLLOW);
  try {
    const buf = Buffer.allocUnsafe(max + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, null);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    if (got > max) throw Object.assign(new Error(`the file is larger than ${max} bytes`), { code: "EFBIG" });
    return buf.subarray(0, got).toString("utf8");
  } finally { await fh.close(); }
}

const HEADER = {
  drafted: " A DRAFT written by a model: never used by `pnpm calibrate` runs. Review and edit it (the transcript must show exactly the\n expected level), then the owner approves it: pnpm calibrate approve --scenario <dir> --draft <id> --by <name> [--expected <level>]",
  excerpt: " A DRAFT cut from a real session log: never used by `pnpm calibrate` runs. Make sure it is demo or synthetic text (or consented and\n redacted), rate the subject's level, then the owner approves it: pnpm calibrate approve --scenario <dir> --draft <id> --by <name> --expected <level>",
} as const;

/** YAML from the library's own stringifier (no string is ever interpolated into YAML), with an optional fixed comment on top. */
function toYaml(value: object, comment?: string): string {
  if (!comment) return stringify(value);
  const doc = new Document(value);
  doc.commentBefore = comment;
  return String(doc);
}

// ---- drafting --------------------------------------------------------------------------------------------------------

export type DraftInput = {
  /** The scenario package directory. */ dir: string; scenario: Scenario; rubrics: Rubric[];
  drafter: Judge;
  /** The primary judge's model family, or null when it cannot be determined (then drafting needs allowSameFamily). */ primaryFamily: string | null;
  allowSameFamily: boolean;
  /** One individual criterion, or every individual criterion when undefined. */ criterion?: string;
  /** The player role whose lines demonstrate the level (default: the first player role by id). */ subject?: string;
  /** Drafts per (criterion, level): 1 to 3. */ perLevel: number;
  timeouts: Timeouts; /** The drafter's token budget per call (the CLI passes EVAL_MAX_TOKENS). */ maxTokens: number; temperature?: number;
  signal?: AbortSignal; onProgress?: (message: string) => void;
};
export type DraftResult = { written: string[]; problems: string[] };

/** The criteria a draft run covers, or a CalibrationInputError for an unknown or group-level criterion. */
export function draftCriteria(rubrics: Rubric[], criterion?: string): Criterion[] {
  const individual = individualCriteria(rubrics);
  if (criterion === undefined) return [...individual.values()];
  const c = individual.get(criterion);
  if (!c) throw new CalibrationInputError(`criterion ${printable(criterion, 64)} is not an individual criterion of this scenario's rubrics`);
  return [c];
}

/** The model calls a draft run makes: criteria x 4 levels x perLevel (no re-asks). */
export const plannedDraftCalls = (criteria: number, perLevel: number): number => criteria * LEVELS.length * perLevel;

/** The longest criterion id a draft id can carry: draft-<criterion>-l<level>-1 is at most MAX_PROBE_ID (58) characters. */
export const MAX_DRAFT_CRITERION_ID = MAX_PROBE_ID - `${DRAFT_PREFIX}-l1-1`.length;

/** Refuses (CalibrationInputError) a criterion whose id is too long to become a draft id, before any call is planned or made. */
export function checkDraftCriteria(criteria: Criterion[]): void {
  const long = criteria.find((c) => c.id.length > MAX_DRAFT_CRITERION_ID);
  if (long) throw new CalibrationInputError(`criterion ${printable(long.id, 64)} is too long for a draft id (at most ${MAX_DRAFT_CRITERION_ID} characters)`);
}

/** The draft subject: `subject` when it is a player role, else the first player role by id; a CalibrationInputError otherwise. */
export function subjectOf(scenario: Scenario, subject: string | undefined): string {
  if (subject === undefined) {
    const players = Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => r.id).sort();
    if (players.length === 0) throw new CalibrationInputError("the scenario has no player role to draft for");
    return players[0]!;
  }
  const def = Object.hasOwn(scenario.roles, subject) ? scenario.roles[subject] : undefined;
  if (def?.type !== "player") throw new CalibrationInputError(`subject ${printable(subject, 64)} is not a player role of this scenario`);
  return subject;
}

/** Refuses a drafter from the primary judge's family (a baseline over its own drafts would be self-agreement), and the mock provider. */
export function checkDrafter(drafter: Judge, primaryFamily: string | null, allowSameFamily: boolean): void {
  if (drafter.provider.name === "mock") throw new CalibrationInputError("the mock provider cannot draft probes: give a real model with --drafter label,model[,baseUrl]");
  if (allowSameFamily) return;
  if (primaryFamily === null) {
    throw new CalibrationInputError("the primary judge's model is not known (set EVAL_MODEL or NPC_MODEL), so the drafter's family cannot be checked against it: pass --allow-same-family to draft anyway");
  }
  const family = modelFamily(drafter.model);
  if (family === primaryFamily) {
    throw new CalibrationInputError(`the drafter's model family (${printable(family, 40)}) is the primary judge's family (${printable(primaryFamily, 40)}): use a drafter from another family, or pass --allow-same-family (a baseline over such probes is self-agreement)`);
  }
}

/**
 * The request for one draft. HARD RULE (spec section 9): it carries only public scenario data: the title and context, role ids, and for an
 * AI character its name, title and persona; scene ids, titles and participants; the criterion and the target anchor. Never a hidden fact,
 * an earned_when condition, a player's brief or private facts, an AI character's goals, knowledge or guardrails, or the facilitator notes.
 */
export function buildDraftRequest(scenario: Scenario, criterion: Criterion, level: Level, subject: string, o: { maxTokens: number; temperature?: number }): ChatRequest {
  const roles = Object.values(scenario.roles).filter((r) => r.id !== subject).map((r) =>
    r.type === "npc" ? `- ${r.id} (AI character): ${oneLine(r.name)}${r.title ? `, ${oneLine(r.title)}` : ""}. ${oneLine(r.persona)}` : `- ${r.id} (player)`);
  const scenes = scenario.script.scenes.map((s) => `- ${s.id} "${oneLine(s.title)}": participants ${s.participants.join(", ")}`);
  const system = [
    "You write a short synthetic dialogue for testing an evaluator of a coaching role-play. It is a test probe, not a real session.",
    "",
    `Scenario: ${scenario.meta.title}`,
    `Context: ${scenario.meta.context.trim()}`,
    "",
    `The subject is the player role ${subject}. Only the subject's own lines are scored; the other lines are context.`,
    "Other roles:",
    ...roles,
    "Scenes (use only these scene ids; a role may speak only in a scene it takes part in):",
    ...scenes,
    "",
    `Criterion: ${oneLine(criterion.name)} (${criterion.id})`,
    `Description: ${criterion.description.trim()}`,
    `Target: level ${level} of 4. The anchor for level ${level}, verbatim:`,
    criterion.levels[level].anchor.trim(),
    "",
    `Write 4 to ${MAX_DRAFT_LINES} lines of dialogue in ONE scene in which the subject's own lines demonstrate exactly level ${level} and no higher.`,
    "The subject speaks at least twice. The other lines come from other participants of that scene and give the subject a clear opportunity",
    "to show the behaviour. Write natural speech in your own words: do not copy the rubric wording.",
    'Answer with JSON only, no prose and no code fence: {"transcript":[{"scene":"<scene id>","role":"<role id>","text":"<what they say>"}]}',
  ].join("\n");
  return {
    system, maxTokens: o.maxTokens, temperature: o.temperature ?? DEFAULT_DRAFT_TEMPERATURE,
    messages: [{ role: "user", content: `Draft the transcript for criterion ${criterion.id} at level ${level}.` }],
  };
}

/** The provider, cut off with an error once a reply exceeds `max` characters (the stream is stopped, nothing more is buffered). */
function capped(p: ModelProvider, max: number): ModelProvider {
  return {
    name: p.name,
    async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> {
      let n = 0;
      for await (const chunk of p.stream(req, signal)) {
        n += chunk.length;
        if (n > max) throw new Error(`the reply is longer than ${max} characters`);
        yield chunk;
      }
    },
  };
}

type Line = { scene: string; role: string; text: string };

/** The problems of a transcript against the scenario (scenes, roles, participants, hidden facts, the subject's line count), unprefixed. */
function transcriptProblems(id: string, criterion: string, subject: string, transcript: Line[], scenario: Scenario, rubrics: Rubric[]): string[] {
  const name = `${id}.yaml`;
  const candidate = { kind: "single", id, criterion, source: "drafted", drafter: null, approved_by: null, approved_at: null, split: "tune", subject, expected: 1, transcript } as Probe;
  return checkProbeAgainstScenario(name, candidate, scenario, rubrics).problems.map((m) => (m.startsWith(`${name}: `) ? m.slice(name.length + 2) : m));
}

/** Validates a drafter reply into transcript lines, or returns why it is refused. */
function readReply(text: string, id: string, criterion: string, subject: string, scenario: Scenario, rubrics: Rubric[]): { lines: Line[] } | { problem: string } {
  const json = extractJson(text);
  if (!json.ok) return { problem: json.error };
  if (hasPrototypeKey(json.value)) return { problem: "the reply holds a prototype key" };
  const t = json.value.transcript;
  if (!Array.isArray(t)) return { problem: 'the reply needs a transcript list ({"transcript":[...]})' };
  if (t.length > MAX_DRAFT_LINES) return { problem: `the reply has more than ${MAX_DRAFT_LINES} lines (${t.length})` };
  if (t.length < 2) return { problem: "the reply needs at least 2 lines" };
  if (t.some((l: unknown) => l !== null && typeof l === "object" && typeof (l as { text?: unknown }).text === "string" && hasHiddenChar((l as { text: string }).text))) {
    return { problem: `the reply contains ${HIDDEN_CHARS_MESSAGE}` };
  }
  const lines: Line[] = [];
  const issues: string[] = [];
  t.forEach((raw: unknown, k: number) => {
    const r = LineSchema.safeParse(raw);
    if (r.success) lines.push(r.data);
    else issues.push(...r.error.issues.map((i) => `${["transcript", k, ...i.path].join(".")} ${i.message}`));
  });
  if (issues.length) return { problem: issues.join("; ") };
  const problems = transcriptProblems(id, criterion, subject, lines, scenario, rubrics);
  return problems.length ? { problem: problems.join("; ") } : { lines };
}

/**
 * Asks the drafter for one candidate transcript per (criterion, level, n) and writes each valid one to calibration/drafts/<id>.yaml
 * (exclusive, 0o600). A reply that fails validation is reported (`draft <id>: <reason>`) and not written; the run goes on with the next
 * draft, and the drafts written so far are kept. Throws CalibrationInputError (before any call) for a refused drafter or bad input.
 */
export async function draftProbes(i: DraftInput): Promise<DraftResult> {
  checkDrafter(i.drafter, i.primaryFamily, i.allowSameFamily);
  if (!Number.isInteger(i.perLevel) || i.perLevel < 1 || i.perLevel > MAX_PER_LEVEL) throw new CalibrationInputError(`--per-level must be a whole number from 1 to ${MAX_PER_LEVEL}`);
  const criteria = draftCriteria(i.rubrics, i.criterion);
  const subject = subjectOf(i.scenario, i.subject);
  const drafts = await draftsDir(i.dir);
  const taken = new Set([...(await readdir(drafts)), ...(await readdir(path.dirname(drafts)))]);
  const provider = capped(i.drafter.provider, MAX_DRAFT_REPLY_CHARS);
  const out: DraftResult = { written: [], problems: [] };
  const total = plannedDraftCalls(criteria.length, i.perLevel);
  let done = 0;
  for (const c of criteria) {
    for (const level of LEVELS) {
      for (let k = 0; k < i.perLevel; k++) {
        if (i.signal?.aborted) { out.problems.push(`aborted: ${plural(total - done, "draft")} not written`); return out; }
        let n = 1;
        const nameOf = (m: number) => `${c.id}-l${level}-${m}`;
        while (taken.has(`${DRAFT_PREFIX}${nameOf(n)}.yaml`) || taken.has(`${nameOf(n)}.yaml`)) n++;
        const id = `${DRAFT_PREFIX}${nameOf(n)}`;
        taken.add(`${id}.yaml`);
        const fail = (why: string) => { out.problems.push(`draft ${printable(id, 80)}: ${printable(why, 300)}`); };
        if (!isProbeId(id)) { fail(`the id is longer than ${MAX_PROBE_ID} characters (the criterion id is too long for a draft id)`); done++; continue; }
        const req = buildDraftRequest(i.scenario, c, level, subject, { maxTokens: i.maxTokens, temperature: i.temperature });
        const got = await collectModelReply(provider, req, { firstTokenTimeoutMs: i.timeouts.firstTokenTimeoutMs, replyTimeoutMs: i.timeouts.replyTimeoutMs, signal: i.signal });
        // A reply that arrives as the run is aborted is not written: the abort means "stop here".
        if (i.signal?.aborted) { out.problems.push(`aborted: ${plural(total - done, "draft")} not written`); return out; }
        done++;
        if (got.failure !== null) { fail(`the drafter failed: ${got.failure}`); continue; }
        const r = readReply(got.text, id, c.id, subject, i.scenario, i.rubrics);
        if ("problem" in r) { fail(r.problem); continue; }
        const draft = { kind: "single", id, criterion: c.id, source: "drafted", drafter: i.drafter.model, approved_by: null, approved_at: null, subject, expected: level, transcript: r.lines };
        const file = path.join(drafts, `${id}.yaml`);
        try { await writeExclusive(file, toYaml(draft, HEADER.drafted)); }
        catch (e) { fail(code(e) === "EEXIST" ? "a file with this name appeared meanwhile: not overwritten" : `cannot be written (${code(e)})`); continue; }
        out.written.push(file);
        i.onProgress?.(`draft ${id} written (${c.id}, level ${level})`);
      }
    }
  }
  return out;
}

// ---- excerpts --------------------------------------------------------------------------------------------------------

export type ExcerptInput = {
  log: SessionEvent[]; scenario: Scenario; rubrics: Rubric[];
  /** First and last event seq (inclusive). */ from: number; to: number;
  subject: string; criterion: string; /** The draft id (also the probe id once approved, unless approve gives --id). */ id: string; dir: string;
};

/**
 * A draft probe cut from a real session log: the utterances with seq in [from, to], each with the scene active at that seq. It has no
 * `expected` level and no approval: a human rates it when approving. Refuses (CalibrationInputError, nothing written) a bad range, a subject
 * with fewer than 2 lines, a line outside any scene, more than 80 lines, and an excerpt that contains an AI character's hidden fact.
 */
export async function excerptDraft(i: ExcerptInput): Promise<{ file: string; warnings: string[] }> {
  if (!isProbeId(i.id)) throw new CalibrationInputError(`--id must be ${ID_RULE}`);
  if (![i.from, i.to].every((n) => Number.isInteger(n) && n >= 1)) throw new CalibrationInputError("seq numbers are whole numbers from 1 (--from, --to)");
  if (i.from > i.to) throw new CalibrationInputError("--from must not be after --to");
  draftCriteria(i.rubrics, i.criterion);
  const subject = subjectOf(i.scenario, i.subject);
  const started = i.log.find((e) => e.type === "session.started");
  const sid = started?.type === "session.started" ? started.scenarioId : undefined;
  if (sid !== i.scenario.meta.id) throw new CalibrationInputError(`the log is of scenario ${printable(String(sid), 64)}, not ${i.scenario.meta.id}`);
  // A loop, not Math.min(...seqs): spreading ~110 000+ arguments overflows the stack, and a capped log can hold more events than that.
  let first = Infinity;
  let last = -Infinity;
  for (const e of i.log) { if (e.seq < first) first = e.seq; if (e.seq > last) last = e.seq; }
  if (i.from < first || i.to > last) throw new CalibrationInputError(`seq ${i.from} to ${i.to} is not inside the log (seq ${first} to ${last})`);
  let scene: string | null = null;
  const lines: Line[] = [];
  const lineSeqs: number[] = [];
  for (const e of i.log) {
    if (e.type === "scene.entered") scene = e.sceneId;
    else if (e.type === "scene.exited") scene = null;
    if (e.type !== "utterance" || e.seq < i.from || e.seq > i.to) continue;
    if (scene === null) throw new CalibrationInputError(`the line at seq ${e.seq} was spoken outside any scene: choose a range inside scenes`);
    lines.push({ scene, role: e.roleId, text: e.text });
    lineSeqs.push(e.seq);
  }
  if (lines.length > MAX_EXCERPT_LINES) throw new CalibrationInputError(`${lines.length} lines in seq ${i.from} to ${i.to}: at most ${MAX_EXCERPT_LINES} (choose a shorter range)`);
  const own = lines.filter((l) => l.role === subject).length;
  if (own < 2) throw new CalibrationInputError(`${subject} has ${plural(own, "line")} in seq ${i.from} to ${i.to} (at least 2 are needed)`);
  // The fact is never echoed: only the role id, and nothing is written.
  const leaked = hiddenFactRoles(lines.map((l) => l.text), i.scenario);
  if (leaked.length) throw new CalibrationInputError(`excerpt contains a hidden fact of ${leaked.join(", ")}: choose another range`);
  const problems: string[] = [];
  lines.forEach((l, k) => {
    if (hasHiddenChar(l.text)) problems.push(`the line at seq ${lineSeqs[k]} contains ${HIDDEN_CHARS_MESSAGE}`);
    const r = LineSchema.safeParse(l);
    if (!r.success) problems.push(...r.error.issues.map((x) => `the line at seq ${lineSeqs[k]}: ${x.path.join(".")} ${x.message}`));
  });
  problems.push(...transcriptProblems(i.id, i.criterion, subject, lines, i.scenario, i.rubrics));
  if (problems.length) throw new CalibrationInputError(`the excerpt is not a valid probe:\n${[...new Set(problems)].map((p) => `  - ${printable(p, 300)}`).join("\n")}`);
  const name = `${i.id}.yaml`;
  const candidate = { kind: "single", id: i.id, criterion: i.criterion, source: "excerpt", drafter: null, approved_by: null, approved_at: null, split: "tune", subject, expected: 1, transcript: lines } as Probe;
  const warnings = checkProbeAgainstScenario(name, candidate, i.scenario, i.rubrics).warnings;
  const draft = { kind: "single", id: i.id, criterion: i.criterion, source: "excerpt", drafter: null, approved_by: null, approved_at: null, subject, transcript: lines };
  const drafts = await draftsDir(i.dir);
  const file = path.join(drafts, name);
  try { await writeExclusive(file, toYaml(draft, HEADER.excerpt)); }
  catch (e) {
    if (code(e) === "EEXIST") throw new CalibrationInputError(`draft ${i.id} already exists in calibration/drafts (approve or delete it first)`);
    throw e;
  }
  return { file, warnings };
}

// ---- approval --------------------------------------------------------------------------------------------------------

export type ApproveInput = {
  dir: string; draftId: string; /** Who approves (the owner): 1 to 120 printable characters. */ by: string;
  /** The level: required for an excerpt (the human rating); for a drafted probe it overrides the drafted level. */ expected?: Expected;
  /** The final probe id (default: the draft id without its draft- prefix). */ finalId?: string;
  scenario: Scenario; rubrics: Rubric[]; /** The probes already loaded (for the duplicate check; the split total is probeFileTotal). */ existing: Probe[]; now: () => Date;
};
export type ApproveResult = { file: string; /** False when the probe was written but the draft could not be deleted (delete it by hand). */ draftRemoved: boolean; warnings: string[] };

/**
 * Turns a reviewed draft into a probe: records the approver and time, fills `split` when the draft has none (assignSplit(id, probeFileTotal + 1)), validates it exactly like the
 * loader (schema and semantic checks), writes calibration/<id>.yaml exclusively, then deletes the draft. The probe is written BEFORE the
 * draft is deleted, so a crash leaves the draft, or both (approve then refuses the duplicate and the draft can be deleted), never neither.
 * Only the owner runs this: no agent or other command approves a draft.
 */
export async function approveDraft(i: ApproveInput): Promise<ApproveResult> {
  if (!isProbeId(i.draftId)) throw new CalibrationInputError(`--draft must be ${ID_RULE}`);
  const by = i.by.trim();
  if (by.length < 1 || by.length > MAX_APPROVER_CHARS || printable(by, MAX_APPROVER_CHARS + 1) !== by) throw new CalibrationInputError(`--by must be 1 to ${MAX_APPROVER_CHARS} printable characters (the approver's name)`);
  if (i.finalId !== undefined && !isProbeId(i.finalId)) throw new CalibrationInputError(`--id must be ${ID_RULE}`);
  const cal = path.join(i.dir, "calibration");
  const draftFile = path.join(cal, "drafts", `${i.draftId}.yaml`);
  // Both levels must be real directories (never created here): a symbolic link in place of calibration/ or drafts/ is refused before
  // the draft is read, the probe written or the draft deleted. A missing directory means there is no such draft.
  try { await assertRealDir(cal, "calibration"); await assertRealDir(path.dirname(draftFile), "calibration/drafts"); } catch (e) {
    if (e instanceof CalibrationInputError) throw e;
    throw new CalibrationInputError(code(e) === "ENOENT" ? `there is no draft ${i.draftId} in calibration/drafts` : `calibration/drafts cannot be opened (${code(e)})`);
  }
  let text: string;
  try { text = await readNoFollow(draftFile, MAX_PROBE_BYTES); } catch (e) {
    const c = code(e);
    if (c === "ENOENT") throw new CalibrationInputError(`there is no draft ${i.draftId} in calibration/drafts`);
    if (c === "ELOOP") throw new CalibrationInputError(`draft ${i.draftId} cannot be read (ELOOP): symbolic links are not followed`);
    throw new CalibrationInputError(`draft ${i.draftId} cannot be read (${c})`);
  }
  let raw: unknown;
  try { raw = parseYamlQuiet(text, MAX_ALIASES); } catch (e) { throw new CalibrationInputError(`draft ${i.draftId}: ${printable((e as Error).message.split("\n")[0] ?? "", 200)}`); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new CalibrationInputError(`draft ${i.draftId}: not a probe (a YAML mapping is expected)`);
  if (hasPrototypeKey(raw)) throw new CalibrationInputError(`draft ${i.draftId}: a prototype key is not allowed`);
  const d = raw as Record<string, unknown>;
  if (d.id !== i.draftId) throw new CalibrationInputError(`the draft's id ${printable(String(d.id), 64)} does not match its file name ${i.draftId}`);
  if (d.source !== "drafted" && d.source !== "excerpt") throw new CalibrationInputError(`draft ${i.draftId}: source must be drafted or excerpt (a handwritten probe goes straight into calibration/)`);
  let expected: unknown = d.expected;
  if (d.kind === "contrast") {
    if (i.expected !== undefined) throw new CalibrationInputError("--expected does not apply to a contrast probe (its players carry the levels)");
  } else if (i.expected !== undefined) expected = i.expected;
  else if (d.source === "excerpt") throw new CalibrationInputError("an excerpt needs --expected (the human rating: 1, 2, 3, 4 or not_observed)");
  const finalId = i.finalId ?? (i.draftId.startsWith(DRAFT_PREFIX) ? i.draftId.slice(DRAFT_PREFIX.length) : i.draftId);
  if (i.existing.some((p) => p.id === finalId)) throw new CalibrationInputError(`a probe ${finalId} already exists: approve never overwrites (choose another --id)`);
  const candidate: Record<string, unknown> = {
    ...d, id: finalId, approved_by: by, approved_at: i.now().toISOString(),
    split: d.split ?? assignSplit(finalId, (await probeFileTotal(i.dir)) + 1), ...(d.kind === "contrast" ? {} : { expected }),
  };
  const parsed = ProbeSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((x) => `${x.path.map((k) => printable(String(k), 40)).join(".") || "(root)"} ${printable(x.message, 200)}`);
    throw new CalibrationInputError(`draft ${i.draftId}: not a valid probe:\n${issues.map((x) => `  - ${x}`).join("\n")}`);
  }
  const name = `${finalId}.yaml`;
  const checked = checkProbeAgainstScenario(name, parsed.data, i.scenario, i.rubrics);
  if (checked.problems.length) throw new CalibrationInputError(`draft ${i.draftId}: not a valid probe:\n${checked.problems.map((x) => `  - ${x}`).join("\n")}`);
  const { transcript, ...rest } = parsed.data;
  const file = path.join(cal, name);
  try { await writeExclusive(file, toYaml({ ...rest, transcript })); }
  catch (e) {
    if (code(e) === "EEXIST") throw new CalibrationInputError(`a probe ${finalId} already exists (calibration/${name}): approve never overwrites (choose another --id)`);
    throw new CalibrationInputError(`calibration/${name} cannot be written (${code(e)})`);
  }
  let draftRemoved = true;
  try { await unlink(draftFile); } catch { draftRemoved = false; }
  return { file, draftRemoved, warnings: checked.warnings };
}

// ---- the split total -------------------------------------------------------------------------------------------------

/** The calibration/*.yaml probe files (sorted; not targets.yaml, not directories), and the symbolic links among them (never followed). */
async function probeFiles(cal: string): Promise<{ files: string[]; links: string[] }> {
  let entries;
  try { entries = await readdir(cal, { withFileTypes: true }); }
  catch (e) { throw new CalibrationInputError(`the calibration directory cannot be read (${code(e)})`); }
  const out = { files: [] as string[], links: [] as string[] };
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!e.name.endsWith(".yaml") || e.name === "targets.yaml" || e.isDirectory()) continue;
    if (e.isSymbolicLink()) out.links.push(e.name);
    else if (e.isFile()) out.files.push(e.name);
  }
  return out;
}

/** A probe file parsed as a YAML document, or why not: it cannot be read, does not parse cleanly or is not a mapping. */
async function readProbeDocument(file: string): Promise<{ doc: ReturnType<typeof parseDocument> } | { problem: string }> {
  let text: string;
  try { text = await readNoFollow(file, MAX_PROBE_BYTES); } catch (e) { return { problem: `cannot be read (${code(e)})` }; }
  const doc = parseDocument(text, { logLevel: "silent", prettyErrors: false });
  const bad = doc.errors[0] ?? doc.warnings[0];
  if (bad) return { problem: printable(bad.message.split("\n")[0] ?? "", 200) };
  if (!isMap(doc.contents)) return { problem: "not a probe (a YAML mapping is expected)" };
  return { doc };
}

const usableId = (doc: ReturnType<typeof parseDocument>): string | null => {
  const id = doc.get("id");
  return typeof id === "string" && isProbeId(id) ? id : null;
};

/**
 * THE split total, shared by approve and assign-splits so both give one probe the same split: the number of calibration/*.yaml files
 * that parse as probes (a YAML mapping with a usable id; whether the rest is valid does not matter, and a file without a split counts).
 * Approve adds one for the probe it is about to write; assign-splits does not, because the file it fills is already counted.
 */
export async function probeFileTotal(scenarioDir: string): Promise<number> {
  const cal = path.join(scenarioDir, "calibration");
  const { files } = await probeFiles(cal);
  let n = 0;
  for (const name of files) {
    const r = await readProbeDocument(path.join(cal, name));
    if ("doc" in r && usableId(r.doc) !== null) n++;
  }
  return n;
}

// ---- assign-splits ---------------------------------------------------------------------------------------------------

/**
 * Adds a `split` (assignSplit(id, number of probe files)) to every calibration/*.yaml probe that has none, keeping the rest of the file
 * (comments, order, styles, as far as the yaml library keeps them). An existing split is never changed and such files are not rewritten; a
 * null split counts as missing, any other value is reported. The total is `probeFileTotal`, the same rule approve uses.
 * Each change is atomic: a temp file in the same directory (0o600) renamed over the original. Unparseable files are reported, not touched.
 */
export async function assignSplits(dir: string, hooks: { /** Test hook: runs just before the temp file is renamed over `file`. */ beforeRename?: (file: string) => Promise<void> } = {}): Promise<{ changed: string[]; problems: string[] }> {
  const cal = path.join(dir, "calibration");
  const out = { changed: [] as string[], problems: [] as string[] };
  const { files, links } = await probeFiles(cal);
  for (const name of links) out.problems.push(`${printable(name)}: symbolic links are not followed`);
  const total = await probeFileTotal(dir);
  for (const name of files) {
    const label = printable(name);
    const file = path.join(cal, name);
    const r = await readProbeDocument(file);
    if ("problem" in r) { out.problems.push(`${label}: ${r.problem}`); continue; }
    const { doc } = r;
    const contents = doc.contents as YAMLMap;
    // A split of null (or an empty value) is no split: it is filled. Any other value that is not tune or holdout is the owner's to fix.
    const current = doc.get("split");
    if (current === "tune" || current === "holdout") continue;
    if (current !== null && current !== undefined) { out.problems.push(`${label}: split ${typeof current === "string" ? JSON.stringify(printable(current, 40)) : printable(String(current), 40)} is neither tune nor holdout: not changed`); continue; }
    const id = usableId(doc);
    if (id === null) { out.problems.push(`${label}: no usable id, split not added`); continue; }
    const split = assignSplit(id, total);
    if (doc.has("split")) doc.set("split", split);
    else {
      // The parsed map's items are typed as parsed nodes; a created pair is an ordinary node pair, which the map holds just as well.
      const items = contents.items as unknown[];
      const at = contents.items.findIndex((p) => isScalar(p.key) && p.key.value === "transcript");
      const pair = doc.createPair("split", split);
      if (at === -1) items.push(pair); else items.splice(at, 0, pair);
    }
    const tmp = path.join(cal, `.${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, String(doc), { flag: "wx", mode: 0o600 });
      await hooks.beforeRename?.(file);
      await rename(tmp, file);
      out.changed.push(file);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      out.problems.push(`${label}: cannot be rewritten (${code(e)})`);
    }
  }
  return out;
}
