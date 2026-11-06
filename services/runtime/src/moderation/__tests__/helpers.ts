import path from "node:path";
import { loadReview } from "../../review/store.js";
import {
  fixedClock,
  makeDraftDir,
  makeRunner,
} from "../../review/__tests__/fixtures.js";
import { openFacilitatorReview } from "../index.js";

export type Env = {
  root: string;
  dir: string;
  rel: string;
  sessionId: string;
  run: ReturnType<typeof makeRunner>;
  now: () => number;
};

/** A review opened through the module (alice, bob, group); `run` is the CLI runner for steps part A does not cover. */
export async function openedReview(): Promise<Env> {
  const { root, dir } = await makeDraftDir();
  const now = fixedClock(1_900_000_000_000);
  await openFacilitatorReview({
    dir,
    by: "kamal",
    now,
    codesDir: path.join(root, "no-codes"),
  });
  return {
    root,
    dir,
    rel: path.relative(root, dir),
    sessionId: path.basename(dir),
    run: makeRunner(root),
    now,
  };
}

/** Accepts every open criterion (and a stale summary) of a subject, then releases it, through the CLI. */
export async function releaseViaCli(e: Env, subject: string): Promise<void> {
  const sv = (await loadReview(e.dir)).view.subjects.get(subject)!;
  for (const c of sv.criteria.filter((x) => x.status === "needs_review"))
    await e.run(["accept", e.rel, subject, c.id, "--by", "kamal"]);
  if ((await loadReview(e.dir)).view.subjects.get(subject)!.summaryStale)
    await e.run(["accept", e.rel, subject, "--summary", "--by", "kamal"]);
  const r = await e.run(["release", e.rel, subject, "--by", "kamal"]);
  if (r.code !== 0) throw new Error(r.err);
}
