import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  ReviewBusyError,
  ReviewRefusedError,
  ReviewUsageError,
} from "../../review/errors.js";
import { withReviewLock } from "../../review/review-log.js";
import { loadReview } from "../../review/store.js";
import { REVIEW_FILE } from "../../review/types.js";
import { readReleasedView } from "../../reports/index.js";
import {
  acceptCriterion,
  acceptSummary,
  commentOn,
  editScore,
  editSummary,
} from "../index.js";
import { openedReview, releaseViaCli, type Env } from "./helpers.js";

let env: Env | undefined;
afterEach(async () => {
  if (env) await rm(env.root, { recursive: true, force: true });
  env = undefined;
});
const base = (e: Env, secrets: string[] = []) => ({
  dir: e.dir,
  by: "priya-console",
  now: e.now,
  secrets,
});
const bytes = (e: Env) => readFile(path.join(e.dir, REVIEW_FILE));
const events = async (e: Env) => (await loadReview(e.dir)).events;
const alice = async (e: Env) =>
  (await loadReview(e.dir)).view.subjects.get("alice")!;
const asExpect = (cur: unknown) =>
  (cur === "invalid" ? "invalid" : cur === null ? "na" : String(cur)) as
    "1" | "2" | "3" | "4" | "na" | "invalid";

describe("moderation writes, part A", () => {
  it("editScore with a matching expect writes score.edited", async () => {
    env = await openedReview();
    const c = (await alice(env)).criteria[0]!;
    const to = c.current === 4 ? 3 : 4;
    await editScore({
      ...base(env),
      subject: "alice",
      criterion: c.id,
      level: to,
      reason: "the quote shows more",
      rationale: "a new rationale",
      expect: asExpect(c.current),
    });
    const ev = await events(env);
    expect(ev.at(-2)).toMatchObject({
      type: "score.edited",
      subject: "alice",
      criterion: c.id,
      from: c.current,
      to,
      reason: "the quote shows more",
      actor: { kind: "facilitator", by: "priya-console" },
    });
    expect(ev.at(-1)).toMatchObject({
      type: "rationale.edited",
      text: "a new rationale",
    });
    expect(
      (await alice(env)).criteria.find((x) => x.id === c.id)!.current,
    ).toBe(to);
  });

  it("editScore with a stale expect throws code stale and the file bytes are unchanged", async () => {
    env = await openedReview();
    const c = (await alice(env)).criteria[0]!;
    const stale = c.current === 1 ? "2" : "1";
    const before = await bytes(env);
    const e = await editScore({
      ...base(env),
      subject: "alice",
      criterion: c.id,
      level: 3,
      reason: "r",
      expect: stale,
    }).catch((x) => x);
    expect(e).toBeInstanceOf(ReviewRefusedError);
    expect((e as ReviewRefusedError).code).toBe("stale");
    expect((e as Error).message).toContain("nothing was changed");
    expect(await bytes(env)).toEqual(before);
    // unknown subject and criterion carry their own codes
    const u = await editScore({
      ...base(env),
      subject: "nobody",
      criterion: c.id,
      level: 3,
      reason: "r",
    }).catch((x) => x);
    expect((u as ReviewRefusedError).code).toBe("unknown_subject");
    const k = await editScore({
      ...base(env),
      subject: "alice",
      criterion: "nope",
      level: 3,
      reason: "r",
    }).catch((x) => x);
    expect((k as ReviewRefusedError).code).toBe("unknown_criterion");
    expect(await bytes(env)).toEqual(before);
  });

  it("acceptCriterion and acceptSummary append their events", async () => {
    env = await openedReview();
    const open = (await alice(env)).criteria.find(
      (c) => c.status === "needs_review",
    )!;
    await acceptCriterion({
      ...base(env),
      subject: "alice",
      criterion: open.id,
    });
    await acceptSummary({ ...base(env), subject: "alice" });
    const ev = await events(env);
    expect(ev.at(-2)).toMatchObject({
      type: "score.accepted",
      subject: "alice",
      criterion: open.id,
    });
    expect(ev.at(-1)).toMatchObject({
      type: "summary.accepted",
      subject: "alice",
    });
    // a released subject is not editable until amended
    await releaseViaCli(env, "alice");
    const ne = await acceptSummary({ ...base(env), subject: "alice" }).catch(
      (x) => x,
    );
    expect((ne as ReviewRefusedError).code).toBe("not_editable");
    expect((ne as Error).message).toContain("amend it first");
  });

  it("commentOn with feedback is visible in the participant view only after release", async () => {
    env = await openedReview();
    await commentOn({
      ...base(env, ["sk-live-abcdef123456"]),
      subject: "alice",
      text: "Good questions sk-live-abcdef123456",
      feedback: true,
    });
    await commentOn({
      ...base(env),
      subject: "alice",
      text: "internal only",
    });
    const sv = await alice(env);
    expect(sv.comments.map((c) => [c.visibility, c.text])).toEqual([
      ["feedback", "Good questions [redacted]"],
      ["internal", "internal only"],
    ]);
    expect(
      (await readReleasedView(env.root, env.sessionId, "alice", [])).kind,
    ).toBe("not_released");
    await releaseViaCli(env, "alice");
    const r = await readReleasedView(env.root, env.sessionId, "alice", []);
    expect(r.kind).toBe("released");
    const texts = (r.kind === "released" ? (r.own.comments ?? []) : []).map(
      (c) => c.text,
    );
    expect(texts).toEqual(["Good questions [redacted]"]);
  });

  it("editSummary with an unknown LO id throws a ReviewUsageError", async () => {
    env = await openedReview();
    const before = await bytes(env);
    const e = await editSummary({
      ...base(env),
      subject: "alice",
      reason: "clearer",
      strengths: ["asks good questions"],
      actions: [{ lo: "no-such-lo", text: "practise" }],
    }).catch((x) => x);
    expect(e).toBeInstanceOf(ReviewUsageError);
    expect(await bytes(env)).toEqual(before);
    const empty = await editSummary({
      ...base(env),
      subject: "alice",
      reason: "clearer",
    }).catch((x) => x);
    expect(empty).toBeInstanceOf(ReviewUsageError);
  });

  it("the appended events verify (loadReview succeeds)", async () => {
    env = await openedReview();
    const sv = await alice(env);
    const lo = (await loadReview(env.dir)).drafts.subjects.get("alice")!
      .objectives[0]!.id;
    await commentOn({
      ...base(env),
      subject: "alice",
      criterion: sv.criteria[0]!.id,
      text: "per criterion",
    });
    await editSummary({
      ...base(env),
      subject: "alice",
      reason: "clearer",
      strengths: ["one"],
      developments: ["two"],
      actions: [{ lo, text: "three" }],
    });
    const l = await loadReview(env.dir);
    expect(l.events.map((e) => e.type).slice(-2)).toEqual([
      "comment.added",
      "summary.edited",
    ]);
    expect(l.view.subjects.get("alice")!.summary).toEqual({
      strengths: ["one"],
      development_points: ["two"],
      next_actions: [{ lo, action: "three" }],
    });
  });

  it("a held lock throws ReviewBusyError", async () => {
    env = await openedReview();
    const c = (await alice(env)).criteria[0]!;
    const before = await bytes(env);
    const e = await withReviewLock(env.dir, () =>
      acceptCriterion({ ...base(env!), subject: "alice", criterion: c.id }),
    ).catch((x) => x);
    expect(e).toBeInstanceOf(ReviewBusyError);
    expect(await bytes(env)).toEqual(before);
  });
});
