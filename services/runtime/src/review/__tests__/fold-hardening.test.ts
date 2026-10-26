import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { loadDrafts, type Drafts } from "../draft.js";
import { ReviewIllegalError } from "../errors.js";
import { currentView } from "../fold.js";
import { sealEntries } from "../review-log.js";
import { ZERO_HASH, type Body, type Entry } from "../types.js";
import { snapshotReport, viewReport } from "../view.js";
import {
  fixedClock,
  makeDraftDir,
  makeFold,
  resolveBodies,
} from "./fixtures.js";

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

describe("finding 4: the reviewer names of a released version are frozen", () => {
  it("a summary accepted by another facilitator during an amendment is not in the released view or the snapshot export", () => {
    const rel = released("alice");
    const v1 = f.fold(...rel).lastSeq;
    const amend: Body = {
      type: "report.amended",
      subject: "alice",
      reason: "r",
      basedOn: v1,
    };
    const v = f.foldE(...rel.map(fb), fb(amend), {
      actor: { kind: "facilitator", by: "mallory" },
      body: { type: "summary.accepted", subject: "alice" },
    });
    expect(v.subjects.get("alice")!.snapshot!.summaryBy).not.toContain(
      "mallory",
    );
    const draft = drafts.subjects.get("alice")!.raw as unknown as Parameters<
      typeof viewReport
    >[0];
    const released_ = viewReport(draft, v, "alice", {
      audience: "released",
      line: "l",
    });
    expect(JSON.stringify(released_)).not.toContain("mallory");
    expect(JSON.stringify(snapshotReport(draft, v, "alice"))).not.toContain(
      "mallory",
    );
    // the facilitator's live view does name the new reviewer
    expect(
      JSON.stringify(
        viewReport(draft, v, "alice", { audience: "facilitator" }),
      ),
    ).toContain("mallory");
  });
});

describe("finding 2: an evaluator-error criterion needs a score decision before release", () => {
  const withInvalid = () => {
    const d = structuredClone(drafts);
    const a = d.subjects.get("alice")!;
    a.criteria[0] = {
      ...a.criteria[0]!,
      invalid: true,
      score: null,
      confidence: null,
    };
    return { d, id: a.criteria[0]!.id, g: makeFold(d) };
  };
  it("accepting it as-is does not make it releasable, and the gate says to score it by hand", () => {
    const { id, g } = withInvalid();
    expect(g.fold().subjects.get("alice")!.evaluationOk).toBe(true);
    const acc = resolveBodies(g.fold(), "alice");
    expect(acc.some((b) => "criterion" in b && b.criterion === id)).toBe(true);
    expect(() =>
      g.fold(...acc, { type: "report.released", subjects: ["alice"] }),
    ).toThrow(new RegExp(`by hand[^]*${id}`));
  });
  it("an edit to a level (or Not observed) makes it releasable", () => {
    const { id, g } = withInvalid();
    const others = resolveBodies(g.fold(), "alice").filter(
      (b) => !("criterion" in b && b.criterion === id),
    );
    const v = g.fold(
      ...others,
      {
        type: "score.edited",
        subject: "alice",
        criterion: id,
        from: "invalid",
        to: null,
        reason: "not observed",
      },
      { type: "summary.accepted", subject: "alice" },
      { type: "report.released", subjects: ["alice"] },
    );
    expect(v.subjects.get("alice")!.state).toBe("released");
  });
});

describe("finding 1 (fold side): carried participant events", () => {
  const withOpener = (over: Record<string, unknown>, ...entries: Entry[]) =>
    currentView(
      drafts,
      sealEntries(
        [],
        ZERO_HASH,
        [
          { actor: f.fac, body: { ...f.opened(), ...over } as Body },
          ...entries,
        ],
        fixedClock(),
      ),
    );
  const rate = (carriedFrom?: string): Entry => ({
    actor: f.part("alice"),
    ...(carriedFrom ? { carriedFrom } : {}),
    body: {
      type: "self.rated",
      role: "alice",
      criterion: "listening",
      level: 3,
    },
  });
  const resp = (
    over: Record<string, unknown>,
    carriedFrom?: string,
  ): Entry => ({
    actor: f.part("alice"),
    ...(carriedFrom ? { carriedFrom } : {}),
    body: {
      type: "response.added",
      role: "alice",
      text: "t",
      dispute: true,
      ...over,
    } as Body,
  });
  it("selfClosed in the opener closes a new self-rating but keeps a carried one", () => {
    expect(() => withOpener({ selfClosed: ["alice"] }, rate())).toThrow(
      /closed/,
    );
    const v = withOpener({ selfClosed: ["alice"] }, rate("old"));
    expect(v.subjects.get("alice")!.selfClosed).toBe(true);
    expect(
      v.subjects.get("alice")!.criteria.find((c) => c.id === "listening")!.self
        ?.level,
    ).toBe(3);
    expect(() =>
      withOpener({ selfClosed: ["alice"] }, rate("old"), rate()),
    ).toThrow(/closed/);
  });
  it.each([
    ["the group", ["group"]],
    ["an unknown role", ["zed"]],
    ["a non-list", "alice"],
    ["a duplicate", ["alice", "alice"]],
  ])("refuses a selfClosed naming %s", (_n, selfClosed) => {
    expect(() => withOpener({ selfClosed })).toThrow(ReviewIllegalError);
  });
  it("a carried response is marked carried and claims no version of this review; no response may set a version", () => {
    const v = f.foldE(resp({}, "old"));
    expect(v.subjects.get("alice")!.responses[0]).toMatchObject({
      version: null,
      carried: true,
      dispute: true,
    });
    expect(v.subjects.get("alice")!.state).toBe("draft");
    expect(() => f.foldE(resp({ version: 7 }, "old"))).toThrow(/version/);
    expect(() =>
      f.foldE(...released("alice").map(fb), resp({ version: 3 })),
    ).toThrow(/version/);
    const own = f.foldE(...released("alice").map(fb), resp({}));
    expect(own.subjects.get("alice")!.responses[0]).toMatchObject({
      carried: false,
    });
    expect(own.subjects.get("alice")!.responses[0]!.version).toBeGreaterThan(1);
  });
  it("carried events come directly after the opener, from a safe directory name, and only of carried types", () => {
    expect(() =>
      f.foldE(
        fb({
          type: "comment.added",
          subject: "alice",
          text: "x",
          visibility: "internal",
        }),
        rate("old"),
      ),
    ).toThrow(/directly follow/);
    expect(() => f.foldE(rate("../x"))).toThrow(/carriedFrom/);
    expect(() =>
      f.foldE(
        ...resolveBodies(f.fold(), "alice").map((body) => ({
          ...fb(body),
          carriedFrom: "old",
        })),
        {
          ...fb({ type: "report.released", subjects: ["alice"] }),
          carriedFrom: "old",
        },
      ),
    ).toThrow(/never carried/);
  });
  it("a carried 'amended' resolution is kept (it was checked in the superseded review); a new one needs a release here", () => {
    const res = (carriedFrom?: string): Entry => ({
      ...fb({
        type: "dispute.resolved",
        response: 2,
        outcome: "amended",
        reason: "r",
      }),
      ...(carriedFrom ? { carriedFrom } : {}),
    });
    expect(
      f.foldE(resp({}, "old"), res("old")).subjects.get("alice")!.responses[0]!
        .resolution?.outcome,
    ).toBe("amended");
    expect(() => f.foldE(resp({}, "old"), res())).toThrow(/release/);
  });
});

describe("fix round F2: 'amended' depends on amend and release events, never on a carried seq", () => {
  it("a carried open dispute is not answered by the first release of the re-run, only by an amendment released here", () => {
    const carriedDispute: Entry = {
      actor: f.part("alice"),
      carriedFrom: "old",
      body: {
        type: "response.added",
        role: "alice",
        text: "t",
        dispute: true,
      } as Body,
    };
    const res = fb({
      type: "dispute.resolved",
      response: 2,
      outcome: "amended",
      reason: "r",
    });
    const first = [carriedDispute, ...released("alice").map(fb)];
    expect(() => f.foldE(...first, res)).toThrow(/amend/);
    const v1 = f.foldE(...first).lastSeq;
    const v = f.foldE(
      ...first,
      fb({
        type: "report.amended",
        subject: "alice",
        reason: "r",
        basedOn: v1,
      }),
      fb({ type: "report.released", subjects: ["alice"] }),
      res,
    );
    expect(v.subjects.get("alice")!.responses[0]!.resolution?.outcome).toBe(
      "amended",
    );
  });
});
