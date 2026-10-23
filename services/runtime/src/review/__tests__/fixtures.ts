import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeReports } from "../../evaluator/report-write.js";
import { sampleEvaluation } from "../../evaluator/__tests__/fixtures.js";

/** A real draft directory written by `writeReports` (alice, bob, group). Returns the directory and the output root. */
export async function makeDraftDir(
  over: Record<string, unknown> = {},
): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "acr-rv-"));
  const result = await sampleEvaluation(over);
  const w = await writeReports(result, {
    outDir: root,
    evaluator: {
      provider: "scripted mock",
      scripted: true,
      rubricHash: "h1",
      variant: "v1",
    },
  });
  return { root, dir: w.dir };
}
export const fixedClock = (start = 1_800_000_000_000) => {
  let t = start;
  return () => (t += 1000);
};
