import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { runReviewCheck } from "../demo-check.js";
import { fixedClock, makeDraftDir } from "./fixtures.js";

// Mutation: a peer's response leaks into the group report that participants read. The check must notice.
vi.mock("../view.js", async (orig) => {
  const real = await orig<typeof import("../view.js")>();
  return {
    ...real,
    participantGroupReport: (
      ...a: Parameters<typeof real.participantGroupReport>
    ) => {
      const r = real.participantGroupReport(...a);
      // a structural leak: a peer's response and self-rating attached to the group report
      Object.assign(r, {
        responses: [{ text: "S17-RESPONSE-PEER", dispute: false }],
        self: {
          x: { level: 2, label: "Developing", note: "S17-SELF-NOTE-PEER" },
        },
      });
      return r;
    },
  };
});

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runReviewCheck notices a leaked response", () => {
  it("fails when a peer's response appears in a participant's group report", async () => {
    await expect(runReviewCheck(dir, { now: fixedClock() })).rejects.toThrow(
      /review check: .*peer's self-rating or response/,
    );
  });
});
