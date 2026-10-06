import path from "node:path";
import { FileTooLargeError, readTextCapped, type Scene, type Scenario } from "@acr/script";
import { parse } from "yaml";
import { ZodError, z } from "zod";
import { GM_EVERY_N_UTTERANCES } from "../agents/game-master.js";

export const SHOWCASE_FILE = "showcase.yaml";
/** The server refuses a `say` longer than this (see the protocol), so a longer scripted line could never be spoken. */
export const MAX_LINE_CHARS = 2_000;
/** A showcase script is a few KiB; refuse anything absurd before parsing it (YAML aliases can expand). */
export const MAX_SHOWCASE_BYTES = 256 * 1024;

const LineSchema = z.object({
  role: z.string().min(1),
  text: z.string().max(MAX_LINE_CHARS, `is longer than ${MAX_LINE_CHARS} characters (the server refuses longer lines)`).refine((t) => t.trim().length > 0, "must not be blank"),
});
const SceneScriptSchema = z.object({
  scene: z.string().min(1),
  lines: z.array(LineSchema).min(1),
  /** Used only by the offline mock run. An empty reply is allowed on purpose: it exercises the fallback line. */
  /**
   * `gm` entries are a reply string (a strict JSON verdict) or `{ kind, reply }` declaring what the reply is: `tolerant` (valid only through the
   * tolerant parser: a code fence or prose around the JSON) `malformed` (no usable verdict: the Game Master asks once more and the NEXT entry answers) or `forged` (a verdict object WITHOUT the evaluation's id, served unstamped: it is ignored as `no_nonce`, the Game Master asks once more and the NEXT entry answers).
   * The mock run's S-04 check holds the run to these declarations.
   */
  mock: z.object({
    npc: z.record(z.array(z.string())).default({}),
    gm: z.array(z.union([z.string(), z.object({ kind: z.enum(["tolerant", "malformed", "forged"]), reply: z.string() })])).default([]),
  }).default({}).transform((m) => ({
    npc: m.npc,
    gm: m.gm.map((r) => (typeof r === "string" ? r : r.reply)),
    gmKinds: m.gm.map((r): "strict" | "tolerant" | "malformed" | "forged" => (typeof r === "string" ? "strict" : r.kind)),
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

/** How many Game Master model calls a scene triggers if `lineCount` lines are spoken, each followed by `npcCount` replies and no scene exit. */
export function expectedGmEvaluations(scene: Scene, lineCount: number, npcCount: number, everyN: number = GM_EVERY_N_UTTERANCES): number {
  const conditions = scene.exit_when.any_of.filter((c) => typeof c === "object").length;
  if (conditions === 0) return 0;
  let evaluated = 0; let rounds = 0;
  for (let i = 1; i <= lineCount; i++) {
    const count = i * (1 + npcCount);
    if (count - evaluated >= everyN) { evaluated = count; rounds++; }
  }
  return rounds * conditions;
}

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
    const npcsHere = scene!.participants.filter((p) => scenario.roles[p]?.type === "npc");
    for (const id of Object.keys(entry.mock.npc)) {
      if (!npcsHere.includes(id)) bad(`${where}: mock replies are given for '${id}', who is not an AI character in that scene`);
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
