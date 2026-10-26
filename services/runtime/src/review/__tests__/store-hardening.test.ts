import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { applyCommand, loadReview, openReview } from "../store.js";
import { readReview, sealEntries, writeEvents } from "../review-log.js";
import { ReviewCorruptError } from "../errors.js";
import type { Entry } from "../types.js";
import { fixedClock, makeDraftDir } from "./fixtures.js";

/** Store-level hardening from the independent review of the review-log fold. */
let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  await openReview(dir, { by: "kamal", now: fixedClock() });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
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
