import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadDrafts } from "../draft.js";
import { applyCommand, loadReview, openReview } from "../store.js";
import { readReview, sealEntries, writeEvents } from "../review-log.js";
import {
  ReviewCorruptError,
  ReviewIllegalError,
  ReviewRefusedError,
} from "../errors.js";
import type { Entry } from "../types.js";
import {
  fixedClock,
  makeDraftDir,
  makeFold,
  resolveBodies,
} from "./fixtures.js";

/** Store-level hardening from the independent review of the review-log fold. */
let root: string, dir: string;
const extra: string[] = [];
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  await openReview(dir, { by: "kamal", now: fixedClock() });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  for (const r of extra.splice(0))
    await rm(r, { recursive: true, force: true });
});

/** Appends entries to the log on disk with a valid chain, as a hand edit that re-hashes the chain would. */
async function forge(entries: Entry[]): Promise<void> {
  const { events, tailHash } = await readReview(dir);
  await writeEvents(dir, sealEntries(events, tailHash, entries, fixedClock()));
}

describe("finding 3: a forged actor on disk is damage, never a rendered name", () => {
  it.each([
    ["an object", { evil: 1 }],
    ["a number", 42],
    ["missing", undefined],
    ["a long name", "x".repeat(5000)],
  ])("by %s makes the log corrupt (load and every command)", async (_n, by) => {
    await forge([
      {
        actor: { kind: "facilitator", by } as unknown as Entry["actor"],
        body: {
          type: "comment.added",
          subject: "alice",
          text: "x",
          visibility: "feedback",
        },
      },
    ]);
    await expect(loadReview(dir)).rejects.toThrow(ReviewCorruptError);
    await expect(applyCommand(dir, fixedClock(), () => [])).rejects.toThrow(
      ReviewCorruptError,
    );
  });
});

describe("finding 5: malformed drafts are refused at open, and the fold is total", () => {
  async function editJson(
    file: string,
    fn: (j: Record<string, unknown>) => void,
  ): Promise<string> {
    const { root: r, dir: d } = await makeDraftDir();
    extra.push(r);
    const p = path.join(d, file);
    const j = JSON.parse(await readFile(p, "utf8"));
    fn(j);
    await writeFile(p, JSON.stringify(j));
    return d;
  }
  it.each([
    [
      "a null lo_coverage objective",
      "group.json",
      (j: Record<string, unknown>) => {
        (j.lo_coverage as { objectives: unknown[] }).objectives.push(null);
      },
    ],
    [
      "a lo_coverage objective without an id",
      "group.json",
      (j: Record<string, unknown>) => {
        (j.lo_coverage as { objectives: unknown[] }).objectives.push({
          statement: "s",
        });
      },
    ],
    [
      "a missing lo_coverage",
      "group.json",
      (j: Record<string, unknown>) => {
        delete j.lo_coverage;
      },
    ],
    [
      "a duplicated criterion id",
      "alice.json",
      (j: Record<string, unknown>) => {
        const c = j.criteria as unknown[];
        c.push(structuredClone(c[0]));
      },
    ],
  ])("%s: loadDrafts and open refuse it", async (_n, file, fn) => {
    const d = await editJson(file, fn);
    await expect(loadDrafts(d)).rejects.toThrow(ReviewCorruptError);
    await expect(
      openReview(d, { by: "kamal", now: fixedClock() }),
    ).rejects.toThrow(ReviewCorruptError);
    await expect(readFile(path.join(d, "review.jsonl"))).rejects.toThrow();
  });
  it("the fold itself refuses such drafts with ReviewIllegalError, never a TypeError", async () => {
    const good = await loadDrafts(dir);
    const nullCov = structuredClone(good);
    (
      nullCov.subjects.get("group")!.raw.lo_coverage as {
        objectives: unknown[];
      }
    ).objectives.push(null);
    const f1 = makeFold(nullCov);
    expect(() =>
      f1.fold(...resolveBodies(f1.fold(), "group"), {
        type: "report.released",
        subjects: ["group"],
      }),
    ).toThrow(ReviewIllegalError);
    const dup = structuredClone(good);
    const a = dup.subjects.get("alice")!;
    a.criteria.push(structuredClone(a.criteria[0]!));
    expect(() => makeFold(dup).fold()).toThrow(ReviewIllegalError);
  });
  it("applyCommand turns an unexpected error into a bounded refusal that does not echo it", async () => {
    const secret = "TOPSECRET".repeat(100);
    const err = await applyCommand(dir, fixedClock(), () => {
      throw new TypeError(secret);
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ReviewRefusedError);
    expect(err.message).not.toContain("TOPSECRET");
    expect(err.message.length).toBeLessThanOrEqual(200);
    // a fold that breaks on the new entries is a refusal too, and nothing is written
    const before = await readFile(path.join(dir, "review.jsonl"), "utf8");
    const err2 = await applyCommand(dir, fixedClock(), (l) => {
      (l.drafts.subjects.get("alice") as { objectives: unknown }).objectives =
        null;
      const c = l.view.subjects.get("alice")!.criteria[0]!;
      return [
        {
          actor: { kind: "facilitator", by: "kamal" },
          body: {
            type: "score.edited",
            subject: "alice",
            criterion: c.id,
            from: c.current,
            to: c.current === 4 ? 3 : 4,
            reason: "r",
          },
        },
      ];
    }).catch((e) => e);
    expect(err2).toBeInstanceOf(ReviewRefusedError);
    expect(await readFile(path.join(dir, "review.jsonl"), "utf8")).toBe(before);
  });
});
