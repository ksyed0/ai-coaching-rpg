import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { readTextCapped } from "@acr/script";
import { printable } from "./probe-load.js";

export type Targets = { contrastOrdering: number; maxAbsBias: number; exactAgreement: number | null; minUsable: number };
export const DEFAULT_TARGETS: Targets = { contrastOrdering: 0.8, maxAbsBias: 0.3, exactAgreement: null, minUsable: 0.9 };

const MAX_TARGETS_BYTES = 16 * 1024;
const MAX_ALIASES = 10;
const FILE_LABEL = "calibration/targets.yaml";

const TargetsSchema = z.object({
  contrastOrdering: z.number().min(0).max(1).optional(),
  maxAbsBias: z.number().min(0).max(3).optional(),
  exactAgreement: z.number().min(0).max(1).nullable().optional(),
  minUsable: z.number().min(0).max(1).optional(),
}).strict();

export async function loadTargets(dir: string): Promise<Targets> {
  let text: string;
  try { text = await readTextCapped(path.join(dir, "calibration", "targets.yaml"), MAX_TARGETS_BYTES); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_TARGETS;
    throw new Error(`${FILE_LABEL}: ${printable(((e as Error).message ?? "").split("\n")[0] ?? "", 200)}`);
  }
  let raw: unknown;
  try { raw = parse(text, { maxAliasCount: MAX_ALIASES }); }
  catch (e) { throw new Error(`${FILE_LABEL}: ${printable(((e as Error).message ?? "").split("\n")[0] ?? "", 200)}`); }
  const parsed = TargetsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`${FILE_LABEL}: ${printable(issue.path.map((k) => String(k)).join("."), 200) || "(root)"} ${printable(issue.message, 200)}`);
  }
  return { ...DEFAULT_TARGETS, ...parsed.data } as Targets;
}
