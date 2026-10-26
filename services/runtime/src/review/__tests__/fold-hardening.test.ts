import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { loadDrafts, type Drafts } from "../draft.js";
import { ReviewIllegalError } from "../errors.js";
import type { Body, Entry } from "../types.js";
import { makeDraftDir, makeFold, resolveBodies } from "./fixtures.js";

/** Fold hardening from the independent review of the review-log fold (findings 2 to 9). */
let root: string, drafts: Drafts, f: ReturnType<typeof makeFold>;
beforeEach(async () => {
  const m = await makeDraftDir();
  root = m.root;
  drafts = await loadDrafts(m.dir);
  f = makeFold(drafts);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const fb = (body: Body): Entry => ({ actor: f.fac, body });
const resolved = (...subjects: string[]): Body[] =>
  subjects.flatMap((s) => resolveBodies(f.fold(), s));
const released = (...s: string[]): Body[] => [
  ...resolved(...s),
  { type: "report.released", subjects: s },
];
const editOf = (subject: string, criterion = "discovery"): Body => {
  const c = f
    .fold()
    .subjects.get(subject)!
    .criteria.find((x) => x.id === criterion)!;
  return {
    type: "score.edited",
    subject,
    criterion,
    from: c.current,
    to: c.current === 4 ? 3 : 4,
    reason: "r",
  };
};

describe("finding 9: the group's table goes stale on a player release or withdrawal only", () => {
  it("a score edit on an unreleased player leaves a released group's table fresh; that player's release makes it stale", () => {
    const rel = released("group");
    const edited = f.fold(...rel, editOf("bob"));
    expect(edited.subjects.get("group")!.tableStale).toBe(false);
    const bobRel = f.fold(
      ...rel,
      ...resolveBodies(f.fold(), "bob"),
      editOf("bob"),
      { type: "summary.accepted", subject: "bob" },
      { type: "report.released", subjects: ["bob"] },
    );
    expect(bobRel.subjects.get("group")!.tableStale).toBe(true);
  });
});

describe("finding 3: every actor is validated in the fold", () => {
  const comment: Body = {
    type: "comment.added",
    subject: "alice",
    text: "x",
    visibility: "feedback",
  };
  it.each([
    ["a number", 42],
    ["an object", { evil: 1 }],
    ["missing", undefined],
    ["empty", ""],
    ["not a safe id", "a b"],
    ["65 characters", "x".repeat(65)],
    ["5,000 characters", "x".repeat(5000)],
  ])(
    "a facilitator by that is %s is ReviewIllegalError with a bounded message",
    (_n, by) => {
      let err: unknown;
      try {
        f.foldE({
          actor: { kind: "facilitator", by } as unknown as Entry["actor"],
          body: comment,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ReviewIllegalError);
      const m = (err as Error).message;
      expect(m.length).toBeLessThanOrEqual(200);
      expect(m).not.toContain("evil");
      expect(m).not.toContain("xxxxxxxxxx");
    },
  );
  it("refuses an actor that is not an object, and a participant actor with a bad role or attestedBy", () => {
    expect(() =>
      f.foldE({ actor: null as unknown as Entry["actor"], body: comment }),
    ).toThrow(ReviewIllegalError);
    const rate = (actor: unknown): Entry => ({
      actor: actor as Entry["actor"],
      body: {
        type: "self.rated",
        role: "alice",
        criterion: "listening",
        level: 3,
      },
    });
    expect(() =>
      f.foldE(rate({ kind: "participant", role: "alice", attestedBy: 7 })),
    ).toThrow(ReviewIllegalError);
    expect(() =>
      f.foldE(
        rate({
          kind: "participant",
          role: "alice",
          attestedBy: "y".repeat(65),
        }),
      ),
    ).toThrow(ReviewIllegalError);
  });
  it("keeps accepting a valid facilitator and a valid attested participant", () => {
    expect(f.foldE(fb(comment)).subjects.get("alice")!.comments[0]!.by).toBe(
      "kamal",
    );
  });
});

describe("finding 7: review.superseded.by is a bounded safe id", () => {
  it.each([
    ["65 characters", "x".repeat(65)],
    ["a path", "../other"],
    ["control characters", "new\u001b[31m"],
    ["empty", ""],
  ])("refuses a marker whose by is %s", (_n, by) => {
    expect(() => f.fold({ type: "review.superseded", by })).toThrow(
      ReviewIllegalError,
    );
  });
  it("accepts a directory basename", () => {
    expect(
      f.fold({ type: "review.superseded", by: "sess-1_2" }).superseded,
    ).toBe("sess-1_2");
  });
});

describe("finding 8: report.exported names the current released version and a clean destination", () => {
  const ex = (version: number, destination = "out"): Body => ({
    type: "report.exported",
    subject: "alice",
    version,
    principal: "facilitator",
    destination,
  });
  it("refuses an earlier version once a later one exists", () => {
    const rel = released("alice");
    const v1 = f.fold(...rel).lastSeq;
    const again: Body[] = [
      ...rel,
      { type: "report.amended", subject: "alice", reason: "r", basedOn: v1 },
      { type: "report.released", subjects: ["alice"] },
    ];
    const v2 = f.fold(...again).lastSeq;
    expect(() => f.fold(...again, ex(v1))).toThrow(/current/);
    expect(
      f.fold(...again, ex(v2)).subjects.get("alice")!.exports,
    ).toHaveLength(1);
  });
  it.each([
    ["a bell", "a\u0007"],
    ["an escape", "\u001b[31mred"],
    ["a bidi override", `a${String.fromCharCode(0x202e)}b`],
  ])("refuses a destination with %s", (_n, d) => {
    const rel = released("alice");
    const v1 = f.fold(...rel).lastSeq;
    expect(() => f.fold(...rel, ex(v1, d))).toThrow(ReviewIllegalError);
  });
});
