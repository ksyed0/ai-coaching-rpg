import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { loadDrafts, type Drafts } from "../draft.js";
import { currentView, type View } from "../fold.js";
import { releaseProblems } from "../gate.js";
import { sealEntries } from "../review-log.js";
import { sha256 } from "../hash.js";
import {
  POLICY_VERSION,
  REVIEW_SCHEMA,
  ZERO_HASH,
  type Body,
  type Actor,
  type ReviewEvent,
} from "../types.js";
import { ReviewIllegalError } from "../errors.js";
import { fixedClock, makeDraftDir, makeFold } from "./fixtures.js";

let root: string, drafts: Drafts;
beforeEach(async () => {
  const m = await makeDraftDir();
  root = m.root;
  drafts = await loadDrafts(m.dir);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let fac: Actor,
  opened: () => Body,
  log: (...b: Body[]) => ReviewEvent[],
  fold: (...b: Body[]) => View;
beforeEach(() => {
  ({ fac, opened, log, fold } = makeFold(drafts));
});
const aliceNeeds = () =>
  [...drafts.subjects.get("alice")!.criteria]
    .filter((c) => c.confidence !== "high" || c.flags.length > 0 || c.invalid)
    .map((c) => c.id);

describe("currentView (moderation)", () => {
  it("starts every subject in draft, marking low-confidence and flagged criteria as needing review", () => {
    const v = fold();
    const alice = v.subjects.get("alice")!;
    expect(alice.state).toBe("draft");
    expect(
      alice.criteria.filter((c) => c.needsReview).map((c) => c.id),
    ).toEqual(aliceNeeds());
    expect(alice.criteria.find((c) => c.id === "discovery")!.status).toBe(
      "clear",
    );
    expect(v.lastSeq).toBe(1);
  });
  it("treats a valid Not-observed criterion with no flag as clear (P6)", () => {
    const d = drafts.subjects.get("alice")!.criteria[0]!;
    Object.assign(d, {
      score: null,
      confidence: null,
      flags: [],
      flag_codes: [],
      invalid: false,
    });
    expect(fold().subjects.get("alice")!.criteria[0]!.needsReview).toBe(false);
  });
  it("applies an edit: current level, history, status edited, recomputed objectives, stale summary", () => {
    const before = fold().subjects.get("alice")!;
    const c = before.criteria.find((x) => x.id === "listening")!;
    const to = c.current === 4 ? 3 : 4;
    const v = fold({
      type: "score.edited",
      subject: "alice",
      criterion: "listening",
      from: c.current,
      to,
      reason: "Heard it in scene 2",
    });
    const a = v.subjects.get("alice")!;
    const l = a.criteria.find((x) => x.id === "listening")!;
    expect(l.current).toBe(to);
    expect(l.ai).toBe(c.current);
    expect(l.status).toBe("edited");
    expect(l.edits).toEqual([
      {
        seq: 2,
        from: c.current,
        to,
        reason: "Heard it in scene 2",
        by: "kamal",
      },
    ]);
    expect(a.summaryStale).toBe(true);
    expect(a.objectives).not.toEqual(before.objectives);
  });
  it("accepting resolves a needs-review criterion; an edit after an acceptance wins", () => {
    const id = aliceNeeds()[0]!;
    const v = fold({ type: "score.accepted", subject: "alice", criterion: id });
    expect(
      v.subjects.get("alice")!.criteria.find((c) => c.id === id)!.status,
    ).toBe("accepted");
  });
  it("edits the rationale only against the matching hash, and the summary clears staleness", () => {
    const cur = fold()
      .subjects.get("alice")!
      .criteria.find((c) => c.id === "listening")!;
    const v = fold({
      type: "rationale.edited",
      subject: "alice",
      criterion: "listening",
      fromHash: sha256(cur.rationale),
      text: "Better words",
      reason: "clarity",
    });
    expect(
      v.subjects.get("alice")!.criteria.find((c) => c.id === "listening")!
        .rationale,
    ).toBe("Better words");
    const lvl = cur.current === 4 ? 3 : 4;
    const s = fold(
      {
        type: "score.edited",
        subject: "alice",
        criterion: "listening",
        from: cur.current,
        to: lvl,
        reason: "r",
      },
      { type: "summary.accepted", subject: "alice" },
    );
    expect(s.subjects.get("alice")!.summaryStale).toBe(false);
  });
  it("records comments with their visibility, on a subject or a criterion", () => {
    const v = fold(
      {
        type: "comment.added",
        subject: "alice",
        text: "note",
        visibility: "internal",
      },
      {
        type: "comment.added",
        subject: "alice",
        criterion: "listening",
        text: "fb",
        visibility: "feedback",
      },
    );
    expect(
      v.subjects.get("alice")!.comments.map((c) => [c.visibility, c.criterion]),
    ).toEqual([
      ["internal", undefined],
      ["feedback", "listening"],
    ]);
  });
});

describe("currentView rejects illegal sequences", () => {
  const cur = () =>
    fold()
      .subjects.get("alice")!
      .criteria.find((c) => c.id === "listening")!.current;
  it.each([
    [
      "an unknown subject",
      () => fold({ type: "score.accepted", subject: "carol", criterion: "x" }),
    ],
    [
      "an unknown criterion",
      () =>
        fold({ type: "score.accepted", subject: "alice", criterion: "nope" }),
    ],
    [
      "a stale from (compare-and-set)",
      () =>
        fold({
          type: "score.edited",
          subject: "alice",
          criterion: "listening",
          from: cur() === 1 ? 2 : 1,
          to: 3,
          reason: "r",
        }),
    ],
    [
      "an unchanged level",
      () =>
        fold({
          type: "score.edited",
          subject: "alice",
          criterion: "listening",
          from: cur(),
          to: cur() as 1,
          reason: "r",
        }),
    ],
    [
      "an empty reason",
      () =>
        fold({
          type: "score.edited",
          subject: "alice",
          criterion: "listening",
          from: cur(),
          to: cur() === 4 ? 3 : 4,
          reason: "",
        }),
    ],
    [
      "a rationale edit against the wrong hash",
      () =>
        fold({
          type: "rationale.edited",
          subject: "alice",
          criterion: "listening",
          fromHash: "0".repeat(64),
          text: "x",
          reason: "r",
        }),
    ],
    [
      "a summary edit on the group",
      () =>
        fold({
          type: "summary.edited",
          subject: "group",
          summary: { strengths: [], development_points: [], next_actions: [] },
          reason: "r",
        }),
    ],
    [
      "accepting twice",
      () =>
        fold(
          { type: "score.accepted", subject: "alice", criterion: "listening" },
          { type: "score.accepted", subject: "alice", criterion: "listening" },
        ),
    ],
    ["an unknown event type", () => fold({ type: "nope" } as never)],
  ])("%s", (_name, run) => {
    expect(run).toThrow(ReviewIllegalError);
  });
  it("rejects a log that does not start with review.opened, a second review.opened, a gap in seq and a superseded review", () => {
    const e = log();
    expect(() => currentView(drafts, [])).toThrow(ReviewIllegalError);
    expect(() => currentView(drafts, [{ ...e[0]!, seq: 2 }])).toThrow(
      ReviewIllegalError,
    );
    expect(() =>
      currentView(
        drafts,
        sealEntries(
          [],
          ZERO_HASH,
          [
            {
              actor: fac,
              body: {
                type: "comment.added",
                subject: "alice",
                text: "x",
                visibility: "internal",
              },
            },
          ],
          fixedClock(),
        ),
      ),
    ).toThrow(ReviewIllegalError);
    expect(() => fold(opened())).toThrow(ReviewIllegalError);
    const gap = log({
      type: "comment.added",
      subject: "alice",
      text: "x",
      visibility: "internal",
    });
    gap[1]!.seq = 5;
    expect(() => currentView(drafts, gap)).toThrow(ReviewIllegalError);
    expect(() =>
      fold(
        { type: "review.superseded", by: "sess1-2" },
        {
          type: "comment.added",
          subject: "alice",
          text: "x",
          visibility: "internal",
        },
      ),
    ).toThrow(ReviewIllegalError);
    expect(fold({ type: "review.superseded", by: "sess1-2" }).superseded).toBe(
      "sess1-2",
    );
  });
  it("is total: shuffled and truncated random event lists either fold or throw ReviewIllegalError, never anything else", () => {
    const pool: Body[] = [
      { type: "score.accepted", subject: "alice", criterion: "listening" },
      { type: "score.accepted", subject: "bob", criterion: "listening" },
      {
        type: "comment.added",
        subject: "group",
        text: "x",
        visibility: "feedback",
      },
      { type: "summary.accepted", subject: "alice" },
      {
        type: "score.edited",
        subject: "alice",
        criterion: "listening",
        from: 1,
        to: 2,
        reason: "r",
      },
      { type: "review.superseded", by: "x" },
    ];
    let seed = 7;
    const rnd = () =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 200; i++) {
      const picks = Array.from(
        { length: Math.floor(rnd() * 6) },
        () => pool[Math.floor(rnd() * pool.length)]!,
      );
      try {
        currentView(drafts, log(...picks));
      } catch (e) {
        expect(e).toBeInstanceOf(ReviewIllegalError);
      }
    }
  });
});

describe("releaseProblems and summary edits", () => {
  it("lists open criteria and a stale summary, and clears once resolved", () => {
    const open = aliceNeeds();
    const bodies: Body[] = open.map((criterion) => ({
      type: "score.accepted",
      subject: "alice",
      criterion,
    }));
    expect(releaseProblems(fold().subjects.get("alice")!).join(" ")).toContain(
      open[0]!,
    );
    expect(releaseProblems(fold(...bodies).subjects.get("alice")!)).toEqual([]);
  });
  it("asks for hand scoring when the evaluation failed, and flags a stale summary", () => {
    const sv = fold().subjects.get("alice")!;
    sv.evaluationOk = false;
    sv.summaryStale = true;
    const p = releaseProblems(sv);
    expect(p[0]).toContain("score these by hand");
    expect(p[1]).toContain("summary");
  });
  it("applies a valid summary edit and rejects a malformed one", () => {
    const summary = {
      strengths: ["a"],
      development_points: ["b"],
      next_actions: [{ lo: "lo1", action: "do" }],
    };
    const v = fold({
      type: "summary.edited",
      subject: "alice",
      summary,
      reason: "tighten",
    });
    const a = v.subjects.get("alice")!;
    expect(a.summary).toEqual(summary);
    expect(a.summaryEdited).toBe(true);
    for (const bad of [
      null,
      [],
      { strengths: "x" },
      { ...summary, next_actions: [1] },
    ])
      expect(() =>
        fold({
          type: "summary.edited",
          subject: "alice",
          summary: bad as never,
          reason: "r",
        }),
      ).toThrow(ReviewIllegalError);
  });
});

describe("fix round 1", () => {
  const rationaleEdit = (
    sv: ReturnType<typeof fold>,
    criterion: string,
  ): Body => ({
    type: "rationale.edited",
    subject: "alice",
    criterion,
    fromHash: sha256(
      sv.subjects.get("alice")!.criteria.find((c) => c.id === criterion)!
        .rationale,
    ),
    text: "new words",
    reason: "clarity",
  });
  it("a rationale-only edit leaves a needs-review criterion open; accept then resolves it", () => {
    const id = aliceNeeds()[0]!;
    const base = fold();
    const edit = rationaleEdit(base, id);
    const a = fold(edit).subjects.get("alice")!;
    expect(a.criteria.find((c) => c.id === id)!.status).toBe("needs_review");
    expect(releaseProblems(a).join(" ")).toContain(id);
    const b = fold(edit, {
      type: "score.accepted",
      subject: "alice",
      criterion: id,
    }).subjects.get("alice")!;
    expect(b.criteria.find((c) => c.id === id)!.status).toBe("accepted");
  });
  it("an edit after an acceptance wins", () => {
    const id = aliceNeeds()[0]!;
    const cur = fold()
      .subjects.get("alice")!
      .criteria.find((c) => c.id === id)!.current;
    const v = fold(
      { type: "score.accepted", subject: "alice", criterion: id },
      {
        type: "score.edited",
        subject: "alice",
        criterion: id,
        from: cur,
        to: cur === 4 ? 3 : 4,
        reason: "r",
      },
    );
    expect(
      v.subjects.get("alice")!.criteria.find((c) => c.id === id)!.status,
    ).toBe("edited");
  });
  it("a failed evaluation with only rationale edits stays blocked", () => {
    const base = fold();
    const ids = base.subjects.get("alice")!.criteria.map((c) => c.id);
    const v = fold(...ids.map((i) => rationaleEdit(base, i)));
    const sv = v.subjects.get("alice")!;
    sv.evaluationOk = false;
    expect(releaseProblems(sv)[0]).toContain("score these by hand");
  });
  it("counts code points: 400 astral characters pass in a summary item", () => {
    const item = "\u{1F600}".repeat(400);
    const v = fold({
      type: "summary.edited",
      subject: "alice",
      summary: {
        strengths: [item],
        development_points: [],
        next_actions: [],
      },
      reason: "r",
    });
    expect(v.subjects.get("alice")!.summary!.strengths[0]).toBe(item);
  });
  it("rejects empty summary items", () => {
    expect(() =>
      fold({
        type: "summary.edited",
        subject: "alice",
        summary: { strengths: [""], development_points: [], next_actions: [] },
        reason: "r",
      }),
    ).toThrow(ReviewIllegalError);
  });
  it("rejects non-string payload fields without echoing them", () => {
    const evil = { toString: 1 } as never;
    for (const b of [
      { type: "score.accepted", subject: evil, criterion: "x" },
      { type: "score.accepted", subject: "alice", criterion: evil },
      {
        type: "score.edited",
        subject: "alice",
        criterion: "listening",
        from: evil,
        to: 3,
        reason: "r",
      },
      { type: "review.superseded", by: evil },
      { type: "review.superseded", by: 5 },
    ] as Body[])
      expect(() => fold(b)).toThrow(ReviewIllegalError);
    const e = log();
    (e[0] as { type: unknown }).type = evil;
    expect(() => currentView(drafts, e)).toThrow(ReviewIllegalError);
    const g = log({ type: "score.accepted", subject: "alice", criterion: "x" });
    (g[1] as { type: unknown }).type = { toString: 1 };
    expect(() => currentView(drafts, g)).toThrow(ReviewIllegalError);
  });
  it("only a facilitator can comment in this story", () => {
    const evs = sealEntries(
      [],
      ZERO_HASH,
      [
        { actor: fac, body: opened() },
        {
          actor: { kind: "participant", role: "alice", attestedBy: "kamal" },
          body: {
            type: "comment.added",
            subject: "alice",
            text: "x",
            visibility: "feedback",
          },
        },
      ],
      fixedClock(),
    );
    expect(() => currentView(drafts, evs)).toThrow(ReviewIllegalError);
  });
});
