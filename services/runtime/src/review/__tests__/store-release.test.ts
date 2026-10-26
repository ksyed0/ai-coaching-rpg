import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyCommand,
  loadReview,
  openReview,
  supersedeReview,
} from "../store.js";
import { readReview } from "../review-log.js";
import { ReviewRefusedError } from "../errors.js";
import type { Body } from "../types.js";
import { writeReports } from "../../evaluator/report-write.js";
import { sampleEvaluation } from "../../evaluator/__tests__/fixtures.js";
import { fixedClock, makeDraftDir, resolveBodies } from "./fixtures.js";

const fac = { kind: "facilitator", by: "kamal" } as const;
let root: string, dir1: string, dir2: string;
beforeEach(async () => {
  ({ root, dir: dir1 } = await makeDraftDir());
  dir2 = (
    await writeReports(await sampleEvaluation(), {
      outDir: root,
      evaluator: {
        provider: "scripted mock",
        scripted: true,
        rubricHash: "h1",
        variant: "v1",
      },
    })
  ).dir;
  await openReview(dir1, { by: "kamal", now: fixedClock() });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = (
  dir: string,
  mk: (v: Awaited<ReturnType<typeof loadReview>>) => Body[],
) =>
  applyCommand(dir, fixedClock(), (l) =>
    mk(l).map((body) => ({ actor: fac, body })),
  );
const release = (dir: string) =>
  run(dir, (l) => [
    ...resolveBodies(l.view, "alice"),
    { type: "report.released", subjects: ["alice"] },
  ]);

describe("release through the store", () => {
  it("version equals the seq of the release event, amend makes a new version, and the last snapshot stays during an amendment", async () => {
    const r = await release(dir1);
    const v1 = r.appended.at(-1)!.seq;
    expect(r.loaded.view.subjects.get("alice")!.versions).toEqual([v1]);
    const a = await run(dir1, () => [
      { type: "report.amended", subject: "alice", reason: "more", basedOn: v1 },
    ]);
    const sv = a.loaded.view.subjects.get("alice")!;
    expect(sv.state).toBe("amending");
    expect(sv.snapshot?.version).toBe(v1);
    const r2 = await run(dir1, () => [
      { type: "report.released", subjects: ["alice"] },
    ]);
    const v2 = r2.appended[0]!.seq;
    expect(r2.loaded.view.subjects.get("alice")!.versions).toEqual([v1, v2]);
  });
  it("refuses release and amend on a withdrawn subject, with exit 1", async () => {
    await release(dir1);
    await run(dir1, () => [
      { type: "report.withdrawn", subject: "alice", reason: "wrong" },
    ]);
    for (const b of [
      { type: "report.released", subjects: ["alice"] },
      { type: "report.amended", subject: "alice", reason: "r", basedOn: 1 },
    ] as Body[]) {
      const err = await run(dir1, () => [b]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReviewRefusedError);
      expect((err as ReviewRefusedError).exit).toBe(1);
    }
  });
  it("refuses release and amend on a superseded review", async () => {
    await release(dir1);
    await supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() });
    for (const b of [
      { type: "report.released", subjects: ["alice"] },
      { type: "report.amended", subject: "alice", reason: "r", basedOn: 1 },
    ] as Body[])
      await expect(run(dir1, () => [b])).rejects.toBeInstanceOf(
        ReviewRefusedError,
      );
  });
  it("refuses to release while another live review of the same session has an unsuperseded release (interrupted supersede)", async () => {
    await release(dir1);
    // simulate the crash: the new review exists, the old one is not yet marked superseded
    const old = await readReview(dir1);
    await supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() });
    const marked = await readReview(dir1);
    expect(marked.events.at(-1)!.type).toBe("review.superseded");
    // rebuild the old log without its marker
    await writeFile(
      path.join(dir1, "review.jsonl"),
      old.events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const err = await release(dir2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewRefusedError);
    expect((err as ReviewRefusedError).exit).toBe(1);
    expect((err as Error).message).toMatch(/not superseded/);
    expect((await loadReview(dir2)).view.subjects.get("alice")!.state).toBe(
      "draft",
    );
    // the old review can still amend and re-release itself
    await run(dir1, () => [
      {
        type: "report.amended",
        subject: "alice",
        reason: "r",
        basedOn: old.events.length,
      },
    ]);
    // completing the supersede unblocks the new directory
    await supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() });
    await expect(release(dir2)).resolves.toBeTruthy();
  });
});
