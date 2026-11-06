import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeDraftDir, makeRunner } from "../../review/__tests__/fixtures.js";

export type Env = {
  root: string;
  dir: string;
  sessionId: string;
  rel: string;
  run: ReturnType<typeof makeRunner>;
};

/** A live review of the sample session in a temp reports dir; `tweak` may edit alice.json before the review is opened. */
export async function liveReview(tweak?: (alice: any) => void): Promise<Env> {
  const { root, dir } = await makeDraftDir();
  if (tweak) {
    const f = path.join(dir, "alice.json");
    const j = JSON.parse(await readFile(f, "utf8"));
    tweak(j);
    await writeFile(f, JSON.stringify(j, null, 2));
  }
  const run = makeRunner(root);
  const rel = path.relative(root, dir);
  const r = await run(["open", rel, "--by", "kamal"]);
  if (r.code !== 0) throw new Error(r.err);
  return { root, dir, sessionId: path.basename(dir), rel, run };
}
