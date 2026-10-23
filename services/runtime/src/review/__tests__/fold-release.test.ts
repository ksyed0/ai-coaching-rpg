import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { loadDrafts, type Drafts } from "../draft.js";
import { ReviewIllegalError } from "../errors.js";
import type { Body } from "../types.js";
import { currentView } from "../fold.js";
import { sealEntries } from "../review-log.js";
import { ZERO_HASH, type Actor } from "../types.js";
import {
  fixedClock,
  makeDraftDir,
  makeFold,
  resolveBodies,
} from "./fixtures.js";

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

const resolved = (...subjects: string[]): Body[] =>
  subjects.flatMap((s) => resolveBodies(f.fold(), s));
const released = (...s: string[]): Body[] => [
  ...resolved(...s),
  { type: "report.released", subjects: s },
];

describe("release", () => {
  it("is refused while a criterion needs review, naming it", () => {
    const open = f
      .fold()
      .subjects.get("alice")!
      .criteria.filter((c) => c.status === "needs_review")
      .map((c) => c.id);
    expect(open.length).toBeGreaterThan(0);
    expect(() =>
      f.fold({ type: "report.released", subjects: ["alice"] }),
    ).toThrow(new RegExp(open[0]!));
  });
  it("releases once every item is accepted: version is the event seq, state released, snapshot taken", () => {
    const v = f.fold(...released("alice"));
    const a = v.subjects.get("alice")!;
    expect(a.state).toBe("released");
    expect(a.versions).toEqual([v.lastSeq]);
    expect(a.snapshot?.version).toBe(v.lastSeq);
    expect(v.subjects.get("bob")!.state).toBe("draft");
  });
  it("blocks release behind a stale summary until it is edited or accepted", () => {
    const base = resolved("alice");
    const cur = f
      .fold()
      .subjects.get("alice")!
      .criteria.find((c) => c.id === "discovery")!.current;
    const edit: Body = {
      type: "score.edited",
      subject: "alice",
      criterion: "discovery",
      from: cur,
      to: cur === 4 ? 3 : 4,
      reason: "r",
    };
    expect(() =>
      f.fold(...base, edit, { type: "report.released", subjects: ["alice"] }),
    ).toThrow(/summary/);
    expect(
      f
        .fold(
          ...base,
          edit,
          { type: "summary.accepted", subject: "alice" },
          { type: "report.released", subjects: ["alice"] },
        )
        .subjects.get("alice")!.state,
    ).toBe("released");
  });
  it("needs every criterion edited by hand when the evaluation failed", () => {
    drafts.subjects.get("bob")!.evaluationOk = false;
    const v0 = f.fold();
    expect(() =>
      f.fold(...resolveBodies(v0, "bob"), {
        type: "report.released",
        subjects: ["bob"],
      }),
    ).toThrow(/evaluation failed/);
    const edits: Body[] = v0.subjects.get("bob")!.criteria.map((c): Body => ({
      type: "score.edited",
      subject: "bob",
      criterion: c.id,
      from: c.current,
      to: c.current === 1 ? 2 : 1,
      reason: "scored by hand",
    }));
    expect(
      f
        .fold(
          ...edits,
          { type: "summary.accepted", subject: "bob" },
          { type: "report.released", subjects: ["bob"] },
        )
        .subjects.get("bob")!.state,
    ).toBe("released");
  });
  it("releases several subjects in one event, all or none", () => {
    const ok = f.fold(...released("alice", "bob"));
    expect(ok.subjects.get("alice")!.versions).toEqual(
      ok.subjects.get("bob")!.versions,
    );
    expect(() =>
      f.fold(...resolved("alice"), {
        type: "report.released",
        subjects: ["alice", "bob"],
      }),
    ).toThrow(ReviewIllegalError);
    expect(() => f.fold({ type: "report.released", subjects: [] })).toThrow(
      ReviewIllegalError,
    );
    expect(() =>
      f.fold(...released("alice"), {
        type: "report.released",
        subjects: ["alice"],
      }),
    ).toThrow(/released/);
    expect(() =>
      f.fold(...resolved("alice"), {
        type: "report.released",
        subjects: ["alice", "alice"],
      }),
    ).toThrow(ReviewIllegalError);
  });
  it("blocks edits, accepts and summary changes after release but still allows comments", () => {
    const rel = released("alice");
    const crit = f.fold(...rel).subjects.get("alice")!.criteria[0]!;
    for (const b of [
      {
        type: "score.edited",
        subject: "alice",
        criterion: crit.id,
        from: crit.current,
        to: crit.current === 1 ? 2 : 1,
        reason: "r",
      },
      { type: "score.accepted", subject: "alice", criterion: crit.id },
      { type: "summary.accepted", subject: "alice" },
    ] as Body[])
      expect(() => f.fold(...rel, b)).toThrow(/released/);
    expect(
      f
        .fold(...rel, {
          type: "comment.added",
          subject: "alice",
          text: "after",
          visibility: "feedback",
        })
        .subjects.get("alice")!.comments,
    ).toHaveLength(1);
  });
});

describe("amend and withdraw", () => {
  it("amend reopens the subject for edits, re-release makes version 2 and keeps version 1", () => {
    const rel = released("alice");
    const v1 = f.fold(...rel).lastSeq;
    const crit = f
      .fold(...rel)
      .subjects.get("alice")!
      .criteria.find((c) => c.id === "discovery")!;
    const amend: Body = {
      type: "report.amended",
      subject: "alice",
      reason: "new evidence",
      basedOn: v1,
    };
    const edit: Body = {
      type: "score.edited",
      subject: "alice",
      criterion: "discovery",
      from: crit.current,
      to: crit.current === 4 ? 3 : 4,
      reason: "r",
    };
    const v = f.fold(
      ...rel,
      amend,
      edit,
      { type: "summary.accepted", subject: "alice" },
      { type: "report.released", subjects: ["alice"] },
    );
    const a = v.subjects.get("alice")!;
    expect(a.versions).toEqual([v1, v.lastSeq]);
    expect(a.snapshot?.version).toBe(v.lastSeq);
    expect(a.state).toBe("released");
    expect(f.fold(...rel, amend).subjects.get("alice")!.state).toBe("amending");
  });
  it("refuses an amend of a draft, with the wrong basedOn, or with no reason", () => {
    expect(() =>
      f.fold({
        type: "report.amended",
        subject: "alice",
        reason: "r",
        basedOn: 1,
      }),
    ).toThrow(ReviewIllegalError);
    const rel = released("alice");
    expect(() =>
      f.fold(...rel, {
        type: "report.amended",
        subject: "alice",
        reason: "r",
        basedOn: 1,
      }),
    ).toThrow(/basedOn|version/);
    expect(() =>
      f.fold(...rel, {
        type: "report.amended",
        subject: "alice",
        reason: "",
        basedOn: f.fold(...rel).lastSeq,
      }),
    ).toThrow(ReviewIllegalError);
  });
  it("withdraw is terminal: no amend, release or edit afterwards", () => {
    const rel = released("alice");
    const v1 = f.fold(...rel).lastSeq;
    const w: Body = {
      type: "report.withdrawn",
      subject: "alice",
      reason: "wrong session",
    };
    expect(f.fold(...rel, w).subjects.get("alice")!.state).toBe("withdrawn");
    expect(() =>
      f.fold(...rel, w, {
        type: "report.amended",
        subject: "alice",
        reason: "r",
        basedOn: v1,
      }),
    ).toThrow(ReviewIllegalError);
    expect(() =>
      f.fold(...rel, w, { type: "report.released", subjects: ["alice"] }),
    ).toThrow(ReviewIllegalError);
    expect(() =>
      f.fold({ type: "report.withdrawn", subject: "alice", reason: "r" }),
    ).toThrow(ReviewIllegalError);
  });
  it("marks a released group's player table stale after a player edit and clears it when the group is re-released", () => {
    const rel = released("alice", "bob", "group");
    const v1 = f.fold(...rel).lastSeq;
    const dis = f
      .fold(...rel)
      .subjects.get("alice")!
      .criteria.find((c) => c.id === "discovery")!;
    const amendA: Body = {
      type: "report.amended",
      subject: "alice",
      reason: "r",
      basedOn: v1,
    };
    const edit: Body = {
      type: "score.edited",
      subject: "alice",
      criterion: "discovery",
      from: dis.current,
      to: dis.current === 4 ? 3 : 4,
      reason: "r",
    };
    expect(f.fold(...rel, amendA, edit).subjects.get("group")!.tableStale).toBe(
      true,
    );
    const fresh = f.fold(
      ...rel,
      amendA,
      edit,
      { type: "summary.accepted", subject: "alice" },
      {
        type: "report.amended",
        subject: "group",
        reason: "refresh",
        basedOn: v1,
      },
      { type: "report.released", subjects: ["alice", "group"] },
    );
    expect(fresh.subjects.get("group")!.tableStale).toBe(false);
    expect(
      fresh.subjects.get("group")!.snapshot?.table?.objectives[0]?.byRole.alice,
    ).toBeTruthy();
  });
});

describe("export", () => {
  it("records an export of an existing version of a released subject and refuses the rest", () => {
    const rel = released("alice");
    const v1 = f.fold(...rel).lastSeq;
    const ex = (
      over: Partial<Extract<Body, { type: "report.exported" }>> = {},
    ): Body => ({
      type: "report.exported",
      subject: "alice",
      version: v1,
      principal: "facilitator",
      destination: "out",
      ...over,
    });
    expect(f.fold(...rel, ex()).subjects.get("alice")!.exports).toEqual([
      {
        seq: v1 + 1,
        version: v1,
        principal: "facilitator",
        destination: "out",
        by: "kamal",
      },
    ]);
    expect(() => f.fold(ex({ version: 1 }))).toThrow(ReviewIllegalError); // draft: nothing to export
    expect(() => f.fold(...rel, ex({ version: v1 + 5 }))).toThrow(/version/);
    expect(() => f.fold(...rel, ex({ principal: "" }))).toThrow(
      ReviewIllegalError,
    );
    expect(() =>
      f.fold(
        ...rel,
        { type: "report.withdrawn", subject: "alice", reason: "r" },
        ex(),
      ),
    ).toThrow(ReviewIllegalError);
  });
});

describe("untrusted payloads and states", () => {
  const v1of = () => f.fold(...released("alice")).lastSeq;
  const attacks = (): [string, () => Body][] => [
    ["report.released", () => ({ type: "report.released", subjects: ["bob"] })],
    [
      "report.amended",
      () => ({
        type: "report.amended",
        subject: "alice",
        reason: "r",
        basedOn: v1of(),
      }),
    ],
    [
      "report.withdrawn",
      () => ({ type: "report.withdrawn", subject: "alice", reason: "r" }),
    ],
    [
      "report.exported",
      () => ({
        type: "report.exported",
        subject: "alice",
        version: v1of(),
        principal: "p",
        destination: "d",
      }),
    ],
  ];
  const actors: [string, Actor][] = [
    ["system", { kind: "system" }],
    [
      "participant",
      { kind: "participant", role: "alice", attestedBy: "kamal" },
    ],
  ];
  it.each(
    attacks().flatMap(([n, mk]) =>
      actors.map(([an, a]) => [n, an, mk, a] as const),
    ),
  )("%s by a %s actor is refused", (_n, _an, mk, actor) => {
    const base = released("alice").map((body) => ({ actor: f.fac, body }));
    // bob is resolved by the facilitator so only the actor can make the release illegal
    const prep = resolved("bob").map((body) => ({ actor: f.fac, body }));
    const ev = sealEntries(
      [],
      ZERO_HASH,
      [
        { actor: f.fac, body: f.opened() },
        ...base,
        ...prep,
        { actor, body: mk() },
      ],
      fixedClock(),
    );
    expect(() => currentView(drafts, ev)).toThrow(/only a facilitator/);
  });
  it("does not echo hostile payloads and survives non-string fields", () => {
    const bad = [
      { type: "report.released", subjects: "alice" },
      { type: "report.released", subjects: [{}] },
      { type: "report.amended", subject: {}, reason: "r", basedOn: 1 },
      { type: "report.withdrawn", subject: "alice", reason: 7 },
      {
        type: "report.exported",
        subject: "alice",
        version: "x",
        principal: "p",
        destination: "d",
      },
    ] as unknown as Body[];
    for (const b of bad)
      expect(() => f.fold(...released("alice"), b)).toThrow(ReviewIllegalError);
    try {
      f.fold(...released("alice"), {
        type: "report.exported",
        subject: "alice",
        version: f.fold(...released("alice")).lastSeq,
        principal: "SECRET-ECHO".repeat(20),
        destination: "d",
      });
      throw new Error("should refuse");
    } catch (e) {
      expect((e as Error).message).not.toMatch(/SECRET-ECHO/);
    }
  });
  it("withdraw from amending works; an amending subject still exports its last release, a withdrawn one does not", () => {
    const rel = released("alice");
    const v1 = f.fold(...rel).lastSeq;
    const amend: Body = {
      type: "report.amended",
      subject: "alice",
      reason: "r",
      basedOn: v1,
    };
    expect(
      f
        .fold(...rel, amend, {
          type: "report.withdrawn",
          subject: "alice",
          reason: "r",
        })
        .subjects.get("alice")!.state,
    ).toBe("withdrawn");
    const exp = (principal: string): Body => ({
      type: "report.exported",
      subject: "alice",
      version: v1,
      principal,
      destination: "d",
    });
    expect(
      f.fold(...rel, amend, exp("participant:alice")).subjects.get("alice")!
        .exports,
    ).toHaveLength(1);
    expect(() =>
      f.fold(
        ...rel,
        { type: "report.withdrawn", subject: "alice", reason: "r" },
        exp("facilitator"),
      ),
    ).toThrow(ReviewIllegalError);
  });
  it("accepts only facilitator or participant:<participant role of this review> as an export principal", () => {
    const rel = released("alice");
    const v1 = f.fold(...rel).lastSeq;
    const exp = (principal: string): Body => ({
      type: "report.exported",
      subject: "alice",
      version: v1,
      principal,
      destination: "d",
    });
    for (const ok of ["facilitator", "participant:alice", "participant:bob"])
      expect(() => f.fold(...rel, exp(ok))).not.toThrow();
    for (const bad of [
      "p",
      "line_manager",
      "hr",
      "participant:",
      "participant:group",
      "participant:nobody",
      "participant:../x",
      "participant:Alice",
      " facilitator",
    ])
      expect(() => f.fold(...rel, exp(bad))).toThrow(ReviewIllegalError);
  });
  it("keeps the last released snapshot while amending (P12) and the latest release wins", () => {
    const rel = released("alice");
    const v1 = f.fold(...rel).lastSeq;
    const crit = f
      .fold(...rel)
      .subjects.get("alice")!
      .criteria.find((c) => c.id === "discovery")!;
    const to = crit.current === 4 ? 3 : 4;
    const v = f.fold(
      ...rel,
      { type: "report.amended", subject: "alice", reason: "r", basedOn: v1 },
      {
        type: "score.edited",
        subject: "alice",
        criterion: "discovery",
        from: crit.current,
        to,
        reason: "r",
      },
    );
    const a = v.subjects.get("alice")!;
    expect(a.state).toBe("amending");
    expect(a.snapshot?.version).toBe(v1);
    expect(
      a.snapshot?.criteria.find((c) => c.id === "discovery")?.current,
    ).toBe(crit.current);
    expect(a.criteria.find((c) => c.id === "discovery")?.current).toBe(to);
  });
});

describe("group table from released snapshots", () => {
  const rowOf = (v: ReturnType<typeof f.fold>) =>
    v.subjects.get("group")!.snapshot!.table!.objectives[0]!.byRole.alice;
  it("omits a player who has no release", () => {
    expect(rowOf(f.fold(...released("group")))).toBeNull();
  });
  it("includes a player released in the same event", () => {
    expect(rowOf(f.fold(...released("alice", "group")))).toBeTruthy();
  });
  it("uses the last released snapshot while the player is amending, not in-progress edits", () => {
    const rel = released("alice");
    const v1 = f.fold(...rel).lastSeq;
    const crit = f
      .fold(...rel)
      .subjects.get("alice")!
      .criteria.find((c) => c.id === "discovery")!;
    const before = f.fold(...rel).subjects.get("alice")!.snapshot!.objectives;
    const v = f.fold(
      ...rel,
      { type: "report.amended", subject: "alice", reason: "r", basedOn: v1 },
      {
        type: "score.edited",
        subject: "alice",
        criterion: "discovery",
        from: crit.current,
        to: crit.current === 4 ? 3 : 4,
        reason: "r",
      },
      ...resolved("group"),
      { type: "report.released", subjects: ["group"] },
    );
    expect(v.subjects.get("alice")!.objectives).not.toEqual(before);
    expect(rowOf(v)).toEqual(before[0]);
  });
  it("omits a withdrawn player", () => {
    const rel = released("alice");
    const v = f.fold(
      ...rel,
      { type: "report.withdrawn", subject: "alice", reason: "r" },
      ...resolved("group"),
      { type: "report.released", subjects: ["group"] },
    );
    expect(rowOf(v)).toBeNull();
  });
});

describe("group table staleness", () => {
  const stale = (v: ReturnType<typeof f.fold>) =>
    v.subjects.get("group")!.tableStale;
  it("goes stale when a player is released alone after the group, and clears on group re-release", () => {
    const g = released("group");
    const withAlice = [...g, ...released("alice")];
    expect(stale(f.fold(...g))).toBe(false);
    expect(stale(f.fold(...withAlice))).toBe(true);
    const v1 = f.fold(...g).lastSeq;
    const v = f.fold(
      ...withAlice,
      { type: "report.amended", subject: "group", reason: "r", basedOn: v1 },
      { type: "report.released", subjects: ["group"] },
    );
    expect(stale(v)).toBe(false);
    expect(
      v.subjects.get("group")!.snapshot!.table!.objectives[0]!.byRole.alice,
    ).toBeTruthy();
  });
  it("goes stale when a player in the table is withdrawn, and the re-released row is null", () => {
    const rel = released("alice", "group");
    const w: Body = { type: "report.withdrawn", subject: "alice", reason: "r" };
    expect(stale(f.fold(...rel))).toBe(false);
    expect(stale(f.fold(...rel, w))).toBe(true);
    const v1 = f.fold(...rel).lastSeq;
    const v = f.fold(
      ...rel,
      w,
      { type: "report.amended", subject: "group", reason: "r", basedOn: v1 },
      { type: "report.released", subjects: ["group"] },
    );
    expect(stale(v)).toBe(false);
    expect(
      v.subjects.get("group")!.snapshot!.table!.objectives[0]!.byRole.alice,
    ).toBeNull();
  });
  it("does not go stale for a release of players together with the group", () => {
    expect(stale(f.fold(...released("alice", "group")))).toBe(false);
  });
});
