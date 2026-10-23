import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { runReviewCheck } from "../demo-check.js";
import { fixedClock, makeDraftDir } from "./fixtures.js";

// Mutation: the redaction of the group report for a participant is switched off. The check must notice.
vi.mock("../policy.js", async (orig) => ({
  ...(await orig<typeof import("../policy.js")>()),
  redactGroupForParticipant: <T>(g: T): T => g,
}));

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runReviewCheck fails closed", () => {
  it("fails with a clear message when the group redaction is removed", async () => {
    await expect(runReviewCheck(dir, { now: fixedClock() })).rejects.toThrow(
      /review check: .*(group|peer|facilitator-directed)/,
    );
  });
});
