import { mkdtempSync, rmSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeDraftDir, makeRunner } from "../../../runtime/src/review/__tests__/fixtures.js";
import { loadReview } from "../../../runtime/src/review/store.js";
import type { ControlConfig } from "../config.js";
import { ReportAccessStore } from "../report-access.js";

/** A real released review folder (alice and bob released) plus a store in a temp dir, for the report service and API tests. */
export async function makeReportWorld(opts: { release?: boolean } = {}) {
  const { root, dir } = await makeDraftDir();
  const sessionId = path.basename(dir);
  const run = makeRunner(root);
  const rel = path.relative(root, dir);
  await run(["open", rel, "--by", "kamal"]);
  const l = await loadReview(dir);
  for (const sv of l.view.subjects.values()) {
    for (const c of sv.criteria.filter((x) => x.status === "needs_review")) await run(["accept", rel, sv.id, c.id, "--by", "kamal"]);
    const cur = (await loadReview(dir)).view.subjects.get(sv.id)!;
    if (cur.summaryStale) await run(["accept", rel, sv.id, "--summary", "--by", "kamal"]);
  }
  if (opts.release !== false) await run(["release", rel, "--all", "--by", "kamal"]);
  const storeDir = mkdtempSync(path.join(tmpdir(), "acr-ctl-rptsvc-"));
  const file = path.join(storeDir, "report-access.json");
  const clock = { t: 1_800_000_000_000 };
  const store = new ReportAccessStore({ file, days: 90, now: () => clock.t });
  const config = { reportsDir: root } as ControlConfig;
  return {
    root, dir, sessionId, run, rel, file, clock, store, config,
    moveToRerun: async () => { await rename(dir, path.join(root, `${sessionId}-2`)); },
    removeReports: async () => { await rm(root, { recursive: true, force: true }); },
    corrupt: async () => { await writeFile(path.join(dir, "review.jsonl"), "not json\n"); },
    cleanup: async () => { await rm(root, { recursive: true, force: true }); rmSync(storeDir, { recursive: true, force: true }); },
  };
}
export type ReportWorld = Awaited<ReturnType<typeof makeReportWorld>>;
