import path from "node:path";
import { FileTooLargeError, earnedWhenOf, readTextCapped, type Scene, type Scenario } from "@acr/script";
import { parse } from "yaml";
import { ZodError, z } from "zod";
import { GM_EVERY_N_UTTERANCES } from "../agents/game-master.js";
import { parseGmReply } from "../agents/gm-parse.js";

export const SHOWCASE_FILE = "showcase.yaml";
/** The server refuses a `say` longer than this (see the protocol), so a longer scripted line could never be spoken. */
export const MAX_LINE_CHARS = 2_000;
/** A showcase script is a few KiB; refuse anything absurd before parsing it (YAML aliases can expand). */
export const MAX_SHOWCASE_BYTES = 256 * 1024;

const LineSchema = z.object({
  role: z.string().min(1),
  text: z.string().max(MAX_LINE_CHARS, `is longer than ${MAX_LINE_CHARS} characters (the server refuses longer lines)`).refine((t) => t.trim().length > 0, "must not be blank"),
});
/**
 * A scripted facilitator step, run by the facilitator's own connection right after the scripted player line `after_line` (1-based) has been
 * answered. The only step today is `release_hidden`: `fact` is the 1-based number of the character's hidden fact (the number `/hidden` shows).
 * A step whose line is never spoken (a `--max-lines` cap, or the scene ended first) is skipped.
 */
const FacilitatorStepSchema = z.object({
  after_line: z.number().int().min(1).max(1_000),
  release_hidden: z.object({ role: z.string().min(1).max(128), fact: z.number().int().min(1).max(50) }).strict(),
}).strict();
export type FacilitatorStep = { afterLine: number; role: string; fact: number };

const SceneScriptSchema = z.object({
  scene: z.string().min(1),
  lines: z.array(LineSchema).min(1),
  facilitator: z.array(FacilitatorStepSchema).max(20).default([]).transform((steps): FacilitatorStep[] => steps.map((x) => ({ afterLine: x.after_line, role: x.release_hidden.role, fact: x.release_hidden.fact }))),
  /** Used only by the offline mock run. An empty reply is allowed on purpose: it exercises the fallback line. */
  /**
   * `gm` entries are a reply string (a strict JSON verdict) or `{ kind, reply }` declaring what the reply is: `tolerant` (valid only through the
   * tolerant parser: a code fence or prose around the JSON) `malformed` (no usable verdict: the Game Master asks once more and the NEXT entry answers) or `forged` (a verdict object WITHOUT the evaluation's id, served unstamped: it is ignored as `no_nonce`, the Game Master asks once more and the NEXT entry answers).
   * The mock run's S-04 check holds the run to these declarations.
   */
  mock: z.object({
    /** A reply is a string, or `{ reply, requires_release: n }`: the reply is only valid once hidden fact `n` of that character has been released (the loader checks that a facilitator step releases it earlier in the scene). */
    npc: z.record(z.array(z.union([z.string(), z.object({ reply: z.string(), requires_release: z.number().int().min(1).max(50) }).strict()]))).default({}),
    gm: z.array(z.union([z.string(), z.object({ kind: z.enum(["tolerant", "malformed", "forged"]), reply: z.string() })])).default([]),
    /**
     * US-0034: the Game Master's verdicts on a hidden fact's earned_when condition, per AI character and fact number, in the order it is asked
     * (once per Game Master round while the fact is neither judged earned nor released). A true verdict is the release suggestion.
     */
    gm_earned: z.array(z.object({ role: z.string().min(1).max(128), fact: z.number().int().min(1).max(50), replies: z.array(z.string()).min(1).max(50) }).strict()).max(20).default([]),
  }).default({}).transform((m) => ({
    npc: Object.fromEntries(Object.entries(m.npc).map(([k, v]) => [k, v.map((r) => (typeof r === "string" ? r : r.reply))])) as Record<string, string[]>,
    /** Per character and reply index: the fact number the reply needs released first, or null. */
    npcNeeds: Object.fromEntries(Object.entries(m.npc).map(([k, v]) => [k, v.map((r) => (typeof r === "string" ? null : r.requires_release))])) as Record<string, (number | null)[]>,
    gm: m.gm.map((r) => (typeof r === "string" ? r : r.reply)),
    gmKinds: m.gm.map((r): "strict" | "tolerant" | "malformed" | "forged" => (typeof r === "string" ? "strict" : r.kind)),
    gmEarned: m.gm_earned,
  })),
});
export const ShowcaseScriptSchema = z.object({ scenes: z.array(SceneScriptSchema).min(1) });
export type ShowcaseLine = z.infer<typeof LineSchema>;
export type ShowcaseScene = z.infer<typeof SceneScriptSchema>;
export type ShowcaseScript = z.infer<typeof ShowcaseScriptSchema>;

export class ShowcaseScriptError extends Error {
  constructor(message: string) { super(message); this.name = "ShowcaseScriptError"; }
}

export type ShowcaseLoadOptions = {
  mode: "mock" | "live";
  /** Lines per scene that will really be spoken (the `--max-lines` cap). Mock coverage is checked against these. */
  maxLines?: number;
  file?: string;
};

/** The scripted lines (1-based) after which the Game Master judges, if `lineCount` lines are spoken, each followed by `npcCount` replies and no scene exit. */
export function gmRoundLines(lineCount: number, npcCount: number, everyN: number = GM_EVERY_N_UTTERANCES): number[] {
  const out: number[] = [];
  let evaluated = 0;
  for (let i = 1; i <= lineCount; i++) {
    const count = i * (1 + npcCount);
    if (count - evaluated >= everyN) { evaluated = count; out.push(i); }
  }
  return out;
}

/** How many Game Master model calls a scene triggers for its exit conditions if `lineCount` lines are spoken, each followed by `npcCount` replies and no scene exit. */
export function expectedGmEvaluations(scene: Scene, lineCount: number, npcCount: number, everyN: number = GM_EVERY_N_UTTERANCES): number {
  const conditions = scene.exit_when.any_of.filter((c) => typeof c === "object").length;
  if (conditions === 0) return 0;
  return gmRoundLines(lineCount, npcCount, everyN).length * conditions;
}

/** A scripted earned_when verdict is a true one (read as the Game Master reads it, without a nonce). */
const isTrueVerdict = (reply: string): boolean => { const p = parseGmReply(reply, { nonce: null }); return p.ok && p.verdict; };

/**
 * Parses and validates the showcase script text against the scenario. Pure. Every failure is a ShowcaseScriptError whose
 * message names the file and the problem (one line, no stack trace); nothing is returned half-valid.
 */
export function parseShowcaseScript(text: string, scenario: Scenario, o: ShowcaseLoadOptions): ShowcaseScript {
  const file = o.file ?? SHOWCASE_FILE;
  const bad = (msg: string): never => { throw new ShowcaseScriptError(`${file}: ${msg}`); };
  if (Buffer.byteLength(text, "utf8") > MAX_SHOWCASE_BYTES) bad(`the file is larger than ${MAX_SHOWCASE_BYTES / 1024} KiB`);
  let raw: unknown;
  try { raw = parse(text); }
  catch (err) { return bad(`not valid YAML: ${(err as Error).message.split("\n")[0]}`); }
  let script: ShowcaseScript;
  try { script = ShowcaseScriptSchema.parse(raw); }
  catch (err) {
    if (err instanceof ZodError) { const first = err.issues[0]!; return bad(`${first.path.join(".") || "(root)"} ${first.message}`); }
    throw err;
  }

  const seen = new Set<string>();
  const released = new Set<string>();
  // US-0034: facts the mock Game Master has already judged earned (a scripted true verdict) in an earlier scene: never asked again.
  const earnedBefore = new Set<string>();
  for (const entry of script.scenes) {
    const scene = scenario.script.scenes.find((s) => s.id === entry.scene);
    if (!scene) bad(`scene '${entry.scene}' is not in the scenario`);
    if (seen.has(entry.scene)) bad(`scene '${entry.scene}' is listed more than once`);
    seen.add(entry.scene);
    const where = `scene '${entry.scene}'`;
    entry.lines.forEach((line, i) => {
      const role = scenario.roles[line.role];
      if (!role) bad(`${where}: line ${i + 1} uses role '${line.role}', which is not a role in the scenario`);
      if (role!.type !== "player") bad(`${where}: line ${i + 1} is spoken by '${line.role}', an AI character; only player roles may have scripted lines`);
      if (!scene!.participants.includes(line.role)) bad(`${where}: line ${i + 1} is spoken by '${line.role}', who is not in that scene`);
    });
    for (const step of entry.facilitator) {
      const role = Object.hasOwn(scenario.roles, step.role) ? scenario.roles[step.role] : undefined;
      const at = `${where}: facilitator step after line ${step.afterLine}`;
      if (!role) return bad(`${at} releases a fact of '${step.role}', which is not a role in the scenario`);
      if (role.type !== "npc") return bad(`${at} releases a fact of '${step.role}', which is a player role; only an AI character has hidden facts`);
      if (!scene!.participants.includes(step.role)) bad(`${at} releases a fact of '${step.role}', who is not in that scene`);
      if (step.fact > role.hidden.length) bad(`${at} releases fact ${step.fact} of '${step.role}', who has ${role.hidden.length} hidden fact(s)`);
      if (step.afterLine > entry.lines.length) bad(`${at} comes after line ${step.afterLine}, but the scene has ${entry.lines.length} scripted line(s)`);
      if (released.has(`${step.role}#${step.fact}`)) bad(`${at} releases fact ${step.fact} of '${step.role}' a second time (the server refuses it: already released)`);
      released.add(`${step.role}#${step.fact}`);
    }
    const npcsHere = scene!.participants.filter((p) => scenario.roles[p]?.type === "npc");
    for (const id of Object.keys(entry.mock.npc)) {
      if (!npcsHere.includes(id)) bad(`${where}: mock replies are given for '${id}', who is not an AI character in that scene`);
    }
    // A mock reply that needs a released fact must come after the facilitator step that releases it (reply i answers line i + 1).
    for (const [id, needs] of Object.entries(entry.mock.npcNeeds)) {
      needs.forEach((fact, i) => {
        if (fact === null) return;
        const ok = entry.facilitator.some((st) => st.role === id && st.fact === fact && st.afterLine <= i);
        if (!ok) bad(`${where}: mock reply ${i + 1} of '${id}' requires hidden fact ${fact} of '${id}' to be released first, but no facilitator step of this scene releases it after line ${i} or earlier`);
      });
    }
    if (o.mode === "mock") {
      const spoken = Math.min(entry.lines.length, o.maxLines ?? entry.lines.length);
      for (const id of npcsHere) {
        const have = entry.mock.npc[id]?.length ?? 0;
        if (have < spoken) bad(`${where}: '${id}' has ${have} mock replies but the scene has ${spoken} scripted line(s) and needs one reply per line`);
      }
      const need = expectedGmEvaluations(scene!, spoken, npcsHere.length);
      if (entry.mock.gm.length < need) bad(`${where}: the mock run needs ${need} Game Master verdict(s) but only ${entry.mock.gm.length} are scripted`);
    }
    // US-0034: the scripted earned_when verdicts. Each pending condition of a character here is judged once per Game Master round, until a true
    // verdict (the suggestion) or a facilitator release of the fact in this scene (the round of that line still judges it, the release follows).
    // This is an upper bound: a round whose exit verdict is true, or the per-round cap (MAX_EARNED_CHECKS_PER_ROUND) with more pending conditions, asks fewer.
    const listed = new Set<string>();
    for (const g of entry.mock.gmEarned) {
      const role = Object.hasOwn(scenario.roles, g.role) ? scenario.roles[g.role] : undefined;
      if (role?.type !== "npc" || !npcsHere.includes(g.role)) bad(`${where}: mock gm_earned names '${g.role}', who is not an AI character in that scene`);
      if (!earnedWhenOf(role as Extract<typeof role, { type: "npc" }>).some((c) => c.fact === g.fact)) bad(`${where}: mock gm_earned: hidden fact ${g.fact} of '${g.role}' has no earned_when condition`);
      if (listed.has(`${g.role}#${g.fact}`)) bad(`${where}: mock gm_earned: hidden fact ${g.fact} of '${g.role}' is listed twice`);
      listed.add(`${g.role}#${g.fact}`);
    }
    const spoken = Math.min(entry.lines.length, o.maxLines ?? entry.lines.length);
    const rounds = gmRoundLines(spoken, npcsHere.length);
    for (const id of npcsHere) {
      const role = scenario.roles[id];
      if (role?.type !== "npc") continue;
      for (const c of earnedWhenOf(role)) {
        const key = `${id}#${c.fact}`;
        const releasedBefore = released.has(key) && !entry.facilitator.some((st) => st.role === id && st.fact === c.fact);
        if (earnedBefore.has(key) || releasedBefore) continue;
        const replies = entry.mock.gmEarned.find((g) => g.role === id && g.fact === c.fact)?.replies ?? [];
        const stepAt = entry.facilitator.find((st) => st.role === id && st.fact === c.fact)?.afterLine;
        const asked = stepAt === undefined ? rounds : rounds.filter((l) => l <= stepAt);
        const firstTrue = replies.slice(0, asked.length).findIndex(isTrueVerdict);
        const need = firstTrue >= 0 ? firstTrue + 1 : asked.length;
        if (o.mode === "mock" && replies.length < need) bad(`${where}: the mock run needs ${need} earned_when verdict(s) for hidden fact ${c.fact} of '${id}' but ${replies.length} are scripted`);
        if (firstTrue >= 0) earnedBefore.add(key);
      }
    }
  }
  for (const s of scenario.script.scenes) if (!seen.has(s.id)) bad(`scene '${s.id}' has no entry (every scene needs scripted player lines)`);
  return script;
}

/** Reads `<dir>/showcase.yaml` and validates it (see parseShowcaseScript). */
export async function loadShowcaseScript(dir: string, scenario: Scenario, o: ShowcaseLoadOptions): Promise<ShowcaseScript> {
  let text: string;
  // one bounded read (one byte over the cap, so parseShowcaseScript can report an oversize file)
  try { text = await readTextCapped(path.join(dir, SHOWCASE_FILE), MAX_SHOWCASE_BYTES + 1); }
  catch (err) {
    if (err instanceof FileTooLargeError) throw new ShowcaseScriptError(`${SHOWCASE_FILE}: the file is larger than ${MAX_SHOWCASE_BYTES / 1024} KiB`);
    throw new ShowcaseScriptError(`${SHOWCASE_FILE}: the scenario has no showcase script (expected a ${SHOWCASE_FILE} file next to scenario.yaml)`);
  }
  return parseShowcaseScript(text, scenario, o);
}
