import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentView, type View } from "../fold.js";
import { sealEntries } from "../review-log.js";
import {
  POLICY_VERSION,
  REVIEW_SCHEMA,
  ZERO_HASH,
  type Actor,
  type Body,
  type ReviewEvent,
} from "../types.js";
import type { Drafts } from "../draft.js";
import { runModerate } from "../cli.js";
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

export function makeFold(drafts: Drafts) {
  const fac: Actor = { kind: "facilitator", by: "kamal" };
  const opened = (): Body => ({
    type: "review.opened",
    schema: REVIEW_SCHEMA,
    policyVersion: POLICY_VERSION,
    legacy: false,
    session: {
      id: drafts.sessionId,
      logSha256: null,
      startedAt: drafts.startedAt,
    },
    scenario: { id: drafts.scenarioId, sha256: null },
    rubricHash: drafts.rubricHash,
    files: drafts.files,
    codes: null,
  });
  const log = (...bodies: Body[]): ReviewEvent[] =>
    sealEntries(
      [],
      ZERO_HASH,
      [opened(), ...bodies].map((body) => ({ actor: fac, body })),
      fixedClock(),
    );
  const fold = (...b: Body[]): View => currentView(drafts, log(...b));
  return { fac, opened, log, fold };
}

/** An accept for every needs-review criterion of a subject, plus summary.accepted when its summary is stale. */
export function resolveBodies(view: View, subject: string): Body[] {
  const sv = view.subjects.get(subject)!;
  return [
    ...sv.criteria
      .filter((c) => c.status === "needs_review")
      .map((c): Body => ({ type: "score.accepted", subject, criterion: c.id })),
    ...(sv.summaryStale ? [{ type: "summary.accepted", subject } as Body] : []),
  ];
}

/** The `pnpm moderate` runner of the CLI tests: one fixed clock per runner, cwd = root. */
export function makeRunner(root: string) {
  const now = fixedClock();
  return async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
    let out = "",
      err = "";
    const r = await runModerate({
      argv,
      stdout: { write: (s) => (out += s) },
      stderr: { write: (s) => (err += s) },
      env,
      cwd: root,
      now,
    });
    return { code: r.exitCode, out, err };
  };
}
