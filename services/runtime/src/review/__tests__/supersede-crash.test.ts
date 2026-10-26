import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

vi.mock("../review-log.js", async (orig) => {
  const m = await orig<typeof import("../review-log.js")>();
  return { ...m, writeEvents: vi.fn(m.writeEvents) };
});
import * as log from "../review-log.js";
import { loadReview, openReview, supersedeReview } from "../store.js";
import { makeDraftDir, fixedClock, resolveBodies } from "./fixtures.js";
import { writeReports } from "../../evaluator/report-write.js";
import { sampleEvaluation } from "../../evaluator/__tests__/fixtures.js";

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
});
afterEach(async () => {
  vi.mocked(log.writeEvents).mockClear();
  await rm(root, { recursive: true, force: true });
});
const text = (d: string) => readFile(path.join(d, "review.jsonl"), "utf8");

describe("supersede interrupted between the two writes", () => {
  it("leaves both reviews live with an actionable message, and re-running finishes it exactly once", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    const { events, tailHash } = await log.readReview(dir1);
    // a real release (through the gate): supersede folds the old review, so it must be legal
    const open = resolveBodies((await loadReview(dir1)).view, "alice");
    await log.writeEvents(
      dir1,
      log.sealEntries(
        events,
        tailHash,
        [
          ...open.map((body) => ({ actor: fac, body })),
          {
            actor: fac,
            body: { type: "report.released", subjects: ["alice"] },
          },
        ],
        fixedClock(),
      ),
    );
    const real = vi.mocked(log.writeEvents).getMockImplementation()!;
    vi.mocked(log.writeEvents).mockImplementation(async (d, ev) => {
      if (d === dir1 && ev[0]?.type === "review.superseded")
        throw new Error("disk\u001b[31m full");
      return real(d, ev);
    });
    const oldBefore = await text(dir1);
    await expect(
      supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() }),
    ).rejects.toThrow(/run the same supersede command again/);
    // observed state: old untouched (still live), new holds the copies
    expect(await text(dir1)).toBe(oldBefore);
    const newAfterCrash = await text(dir2);
    expect(newAfterCrash).toContain("review.opened");
    // the message carries a bounded, printable cause
    await expect(
      supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() }),
    ).rejects.toThrow(/disk\?\[31m full/);

    vi.mocked(log.writeEvents).mockImplementation(real);
    const r = await supersedeReview(dir1, dir2, {
      by: "kamal",
      now: fixedClock(),
    });
    expect(r.completed).toBe(true);
    expect((await log.readReview(dir1)).events.at(-1)!.type).toBe(
      "review.superseded",
    );
    expect(await text(dir2)).toBe(newAfterCrash);
    await expect(
      supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() }),
    ).rejects.toThrow(/already superseded/);
  });
  it("a retry after the earlier review was used meanwhile says that it changed since the copy was made", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    const { events, tailHash } = await log.readReview(dir1);
    const open = resolveBodies((await loadReview(dir1)).view, "alice");
    await log.writeEvents(
      dir1,
      log.sealEntries(
        events,
        tailHash,
        [
          ...open.map((body) => ({ actor: fac, body })),
          {
            actor: fac,
            body: { type: "report.released", subjects: ["alice"] },
          },
        ],
        fixedClock(),
      ),
    );
    const real = vi.mocked(log.writeEvents).getMockImplementation()!;
    vi.mocked(log.writeEvents).mockImplementation(async (d, ev) => {
      if (d === dir1 && ev[0]?.type === "review.superseded")
        throw new Error("disk full");
      return real(d, ev);
    });
    await expect(
      supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() }),
    ).rejects.toThrow(/run the same supersede command again/);
    vi.mocked(log.writeEvents).mockImplementation(real);
    // the old review is still live, and alice responds there before the retry
    const after = await log.readReview(dir1);
    await log.writeEvents(
      dir1,
      log.sealEntries(
        after.events,
        after.tailHash,
        [
          {
            actor: { kind: "participant", role: "alice", attestedBy: "kamal" },
            body: { type: "response.added", role: "alice", text: "late" },
          },
        ],
        fixedClock(),
      ),
    );
    await expect(
      supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() }),
    ).rejects.toThrow(/earlier review changed since/);
  });
});
