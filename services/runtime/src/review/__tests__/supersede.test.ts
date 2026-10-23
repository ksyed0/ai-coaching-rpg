import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyCommand,
  loadReview,
  openReview,
  supersedeReview,
  siblingReleased,
} from "../store.js";
import { readReview, sealEntries, writeEvents } from "../review-log.js";
import {
  ReviewCorruptError,
  ReviewRefusedError,
  ReviewUsageError,
} from "../errors.js";
import { makeDraftDir, fixedClock } from "./fixtures.js";
import { writeReports } from "../../evaluator/report-write.js";
import { sampleEvaluation } from "../../evaluator/__tests__/fixtures.js";

const fac = { kind: "facilitator", by: "kamal" } as const;
let root: string, dir1: string, dir2: string;
beforeEach(async () => {
  ({ root, dir: dir1 } = await makeDraftDir());
  const w = await writeReports(await sampleEvaluation(), {
    outDir: root,
    evaluator: {
      provider: "scripted mock",
      scripted: true,
      rubricHash: "h1",
      variant: "v1",
    },
  });
  dir2 = w.dir; // same session, a re-run
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Marks alice released in dir1 without going through the gate (the release event itself is built in story 2). */
async function forceRelease(dir: string) {
  const { events, tailHash } = await readReview(dir);
  await writeEvents(
    dir,
    sealEntries(
      events,
      tailHash,
      [{ actor: fac, body: { type: "report.released", subjects: ["alice"] } }],
      fixedClock(),
    ),
  );
}

describe("re-runs", () => {
  it("opens a second review freely while no earlier review of the session has a release", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    await expect(
      openReview(dir2, { by: "kamal", now: fixedClock() }),
    ).resolves.toBeTruthy();
  });
  it("refuses to open on a re-run when an earlier directory of the same session was released", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    await forceRelease(dir1);
    expect(await siblingReleased(dir2)).toBe(path.basename(dir1));
    await expect(
      openReview(dir2, { by: "kamal", now: fixedClock() }),
    ).rejects.toThrow(/supersede/);
  });
  it("supersede carries byte-identical subjects forward as events marked carriedFrom, starts changed subjects clean, and makes the old review read-only", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    await applyCommand(dir1, fixedClock(), (l) => {
      const c = l.view.subjects
        .get("alice")!
        .criteria.find((x) => x.status === "needs_review")!;
      return [
        {
          actor: fac,
          body: { type: "score.accepted", subject: "alice", criterion: c.id },
        },
        {
          actor: fac,
          body: {
            type: "comment.added",
            subject: "bob",
            text: "bob note",
            visibility: "internal",
          },
        },
      ];
    });
    const bobJson = path.join(dir2, "bob.json");
    await writeFile(
      bobJson,
      (await readFile(bobJson, "utf8")).replace(
        /Clear on effort\./,
        "Clear on effort!",
      ),
    ); // bob's draft differs in the re-run
    await forceRelease(dir1);
    const r = await supersedeReview(dir1, dir2, {
      by: "kamal",
      now: fixedClock(),
    });
    expect(r.carried).toContain("alice");
    expect(r.fresh).toContain("bob");
    const l2 = await loadReview(dir2);
    expect(
      l2.events.filter((e) => e.carriedFrom === path.basename(dir1)).length,
    ).toBeGreaterThan(0);
    expect(
      l2.view.subjects
        .get("alice")!
        .criteria.some((c) => c.status === "accepted"),
    ).toBe(true);
    expect(l2.view.subjects.get("bob")!.comments).toHaveLength(0);
    expect(l2.view.subjects.get("alice")!.state).toBe("draft");
    expect((await readReview(dir1)).events.at(-1)!.type).toBe(
      "review.superseded",
    );
    await expect(
      applyCommand(dir1, fixedClock(), () => [
        {
          actor: fac,
          body: {
            type: "comment.added",
            subject: "alice",
            text: "x",
            visibility: "internal",
          },
        },
      ]),
    ).rejects.toThrow(); // passes today because the fold rejects report.released; Task 9 tightens it to ReviewRefusedError
  });
  it("refuses to supersede when a review is already open on the new directory", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    await openReview(dir2, { by: "kamal", now: fixedClock() });
    await applyCommand(dir2, fixedClock(), () => [
      {
        actor: fac,
        body: {
          type: "comment.added",
          subject: "alice",
          text: "own work",
          visibility: "internal",
        },
      },
    ]); // moderation of its own: not a copy left by an interrupted supersede
    await forceRelease(dir1);
    await expect(
      supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() }),
    ).rejects.toThrow(/already open[\s\S]*interrupted supersede/);
  });
  it("refuses a second supersede of the same old review", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    await forceRelease(dir1);
    await supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() });
    await expect(
      supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() }),
    ).rejects.toThrow(/already superseded/);
  });
  it("a superseded release no longer blocks a later re-run", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    await forceRelease(dir1);
    await supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() });
    expect(await siblingReleased(dir2)).toBeNull();
  });
  it("refuses to open when a same-session sibling has a damaged log, naming a sanitised directory; a missing log or a stray file is skipped", async () => {
    await writeFile(path.join(root, `${path.basename(dir1)}-notes.txt`), "x");
    expect(await siblingReleased(dir2)).toBeNull();
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    const f = path.join(dir1, "review.jsonl");
    await writeFile(f, (await readFile(f, "utf8")).slice(0, -5)); // cut-off tail
    const err = await siblingReleased(dir2).catch((e) => e);
    expect(err).toBeInstanceOf(ReviewCorruptError);
    expect(err.message).toContain(path.basename(dir1));
    await expect(
      openReview(dir2, { by: "kamal", now: fixedClock() }),
    ).rejects.toThrow(ReviewCorruptError);
  });
  it("a broken hash chain in a sibling is also a refusal", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    const f = path.join(dir1, "review.jsonl");
    await writeFile(
      f,
      (await readFile(f, "utf8")).replace('"prev":"000', '"prev":"111'),
    );
    await expect(siblingReleased(dir2)).rejects.toThrow(ReviewCorruptError);
  });
  it("refuses the same directory twice (also through another spelling of the path), exit class usage", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    await expect(
      supersedeReview(dir1, dir1, { by: "kamal", now: fixedClock() }),
    ).rejects.toThrow(ReviewUsageError);
    await expect(
      supersedeReview(dir1, path.join(dir1, "..", path.basename(dir1)), {
        by: "kamal",
        now: fixedClock(),
      }),
    ).rejects.toThrow(ReviewUsageError);
  });
  it("carried events keep their original actor, and subjects missing from the new drafts are reported as dropped", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    const other = { kind: "facilitator", by: "sam" } as const;
    await applyCommand(dir1, fixedClock(), () => [
      {
        actor: other,
        body: {
          type: "comment.added",
          subject: "alice",
          text: "hi",
          visibility: "internal",
        },
      },
    ]);
    await rm(path.join(dir2, "bob.json"));
    const r = await supersedeReview(dir1, dir2, {
      by: "kamal",
      now: fixedClock(),
    });
    expect(r.dropped).toContain("bob");
    const l2 = await loadReview(dir2);
    const c = l2.events.find((e) => e.type === "comment.added")!;
    expect(c.actor).toEqual(other);
  });
});
