import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { loadDrafts, type Drafts } from "../draft.js";
import { ReviewIllegalError } from "../errors.js";
import type { Body, Entry } from "../types.js";
import { makeDraftDir, makeFold, resolveBodies } from "./fixtures.js";

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

const rate = (
  role: string,
  criterion: string,
  level: 1 | 2 | 3 | 4 | null,
  note?: string,
): Entry => ({
  actor: f.part(role),
  body: {
    type: "self.rated",
    role,
    criterion,
    level,
    ...(note ? { note } : {}),
  },
});
const fb = (body: Body): Entry => ({ actor: f.fac, body });
const releaseAlice = (): Entry[] => [
  ...resolveBodies(f.fold(), "alice").map(fb),
  fb({ type: "report.released", subjects: ["alice"] }),
];
const crit = (v: ReturnType<typeof f.foldE>, id = "listening") =>
  v.subjects.get("alice")!.criteria.find((x) => x.id === id)!;

describe("self-rating", () => {
  it("records a rating per criterion, the last one wins, and never changes the score, status or objectives", () => {
    const before = f.fold().subjects.get("alice")!;
    const v = f.foldE(
      rate("alice", "listening", 2),
      rate("alice", "listening", 4, "I think I did well"),
    );
    const a = v.subjects.get("alice")!;
    const c = a.criteria.find((x) => x.id === "listening")!;
    expect(c.self).toMatchObject({ level: 4, note: "I think I did well" });
    expect(c.current).toBe(
      before.criteria.find((x) => x.id === "listening")!.current,
    );
    expect(c.status).toBe(
      before.criteria.find((x) => x.id === "listening")!.status,
    );
    expect(a.objectives).toEqual(before.objectives);
    expect(
      f
        .foldE(rate("alice", "listening", null))
        .subjects.get("alice")!
        .criteria.find((x) => x.id === "listening")!.self?.level,
    ).toBeNull();
  });
  it("a later rating without a note drops the earlier note (overwrite, not merge)", () => {
    const v = f.foldE(
      rate("alice", "listening", 4, "first"),
      rate("alice", "listening", 3),
    );
    expect(crit(v).self?.note).toBeUndefined();
    expect(crit(v).self?.level).toBe(3);
  });
  it("is private to the role's own subject: a peer's criteria stay unrated", () => {
    const v = f.foldE(rate("alice", "listening", 3));
    expect(v.subjects.get("bob")!.criteria.every((c) => c.self === null)).toBe(
      true,
    );
  });
  it("closes at release and is kept in the frozen snapshot", () => {
    const v = f.foldE(rate("alice", "listening", 3), ...releaseAlice());
    expect(
      v.subjects
        .get("alice")!
        .snapshot!.criteria.find((x) => x.id === "listening")!.self?.level,
    ).toBe(3);
    expect(() =>
      f.foldE(...releaseAlice(), rate("alice", "listening", 2)),
    ).toThrow(/released|closed/);
  });
  it("stays closed while the report is being amended", () => {
    const v1 = f.foldE(...releaseAlice()).lastSeq;
    expect(() =>
      f.foldE(
        ...releaseAlice(),
        fb({
          type: "report.amended",
          subject: "alice",
          reason: "r",
          basedOn: v1,
        }),
        rate("alice", "listening", 2),
      ),
    ).toThrow(/closed/);
  });
  it("is refused once the review is superseded", () => {
    expect(() =>
      f.foldE(
        fb({ type: "review.superseded", by: "x" }),
        rate("alice", "listening", 2),
      ),
    ).toThrow(/superseded/);
  });
  it("accepts a code-point-exact note and refuses one code point over", () => {
    expect(
      crit(f.foldE(rate("alice", "listening", 3, "😀".repeat(1500)))).self
        ?.note,
    ).toHaveLength(3000);
    expect(() =>
      f.foldE(rate("alice", "listening", 3, "😀".repeat(1501))),
    ).toThrow(ReviewIllegalError);
  });
  const raw = (over: Record<string, unknown>): Entry => ({
    actor: f.part("alice"),
    body: {
      type: "self.rated",
      role: "alice",
      criterion: "listening",
      level: 3,
      ...over,
    } as Body,
  });
  it.each([
    [
      "a facilitator actor",
      () =>
        f.foldE(
          fb({
            type: "self.rated",
            role: "alice",
            criterion: "listening",
            level: 3,
          }),
        ),
    ],
    [
      "another role's actor",
      () =>
        f.foldE({
          actor: f.part("bob"),
          body: {
            type: "self.rated",
            role: "alice",
            criterion: "listening",
            level: 3,
          },
        }),
    ],
    [
      "no attestation",
      () =>
        f.foldE({
          actor: { kind: "participant", role: "alice", attestedBy: "" },
          body: {
            type: "self.rated",
            role: "alice",
            criterion: "listening",
            level: 3,
          },
        }),
    ],
    [
      "an unsafe attestation id",
      () =>
        f.foldE({
          actor: { kind: "participant", role: "alice", attestedBy: "../x" },
          body: {
            type: "self.rated",
            role: "alice",
            criterion: "listening",
            level: 3,
          },
        }),
    ],
    [
      "a non-string attestation",
      () =>
        f.foldE({
          actor: {
            kind: "participant",
            role: "alice",
            attestedBy: { by: "kamal" } as never,
          },
          body: {
            type: "self.rated",
            role: "alice",
            criterion: "listening",
            level: 3,
          },
        }),
    ],
    [
      "a system actor",
      () =>
        f.foldE({
          actor: { kind: "system" },
          body: {
            type: "self.rated",
            role: "alice",
            criterion: "listening",
            level: 3,
          },
        }),
    ],
    ["the group", () => f.foldE(rate("group", "shared_understanding", 3))],
    ["an unknown criterion", () => f.foldE(rate("alice", "nope", 3))],
    ["a prototype criterion", () => f.foldE(rate("alice", "__proto__", 3))],
    ["a prototype role", () => f.foldE(rate("__proto__", "listening", 3))],
    ["a constructor role", () => f.foldE(rate("constructor", "listening", 3))],
    ["an unknown role", () => f.foldE(rate("carol", "listening", 3))],
    ["a non-string role", () => f.foldE(raw({ role: 7 }))],
    [
      "a non-string criterion",
      () => f.foldE(raw({ criterion: ["listening"] })),
    ],
    [
      "a level outside 1 to 4",
      () => f.foldE(rate("alice", "listening", 7 as never)),
    ],
    ["a string level", () => f.foldE(raw({ level: "3" }))],
    ["a fractional level", () => f.foldE(raw({ level: 2.5 }))],
    ["a missing level", () => f.foldE(raw({ level: undefined }))],
    ["a non-string note", () => f.foldE(raw({ note: { a: 1 } }))],
    ["an empty note", () => f.foldE(raw({ note: "" }))],
    [
      "an over-long note",
      () => f.foldE(rate("alice", "listening", 3, "x".repeat(1501))),
    ],
  ])("rejects %s", (_n, run) => {
    expect(run).toThrow(ReviewIllegalError);
  });
  it("never echoes the hostile payload in the message", () => {
    try {
      f.foldE(rate("alice", "SECRET-CRIT", 3));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("SECRET-CRIT");
    }
  });
});

describe("response and dispute", () => {
  const respond = (
    over: Partial<Extract<Body, { type: "response.added" }>> = {},
  ): Entry => ({
    actor: f.part("alice"),
    body: {
      type: "response.added",
      role: "alice",
      text: "I disagree about scene 2",
      ...over,
    },
  });
  it("accepts a response only after that subject's release, overall or per criterion", () => {
    expect(() => f.foldE(respond())).toThrow(ReviewIllegalError);
    const v = f.foldE(
      ...releaseAlice(),
      respond(),
      respond({ criterion: "listening", dispute: true }),
    );
    expect(
      v.subjects
        .get("alice")!
        .responses.map((r) => [r.criterion, r.dispute, r.resolution]),
    ).toEqual([
      [undefined, false, null],
      ["listening", true, null],
    ]);
    expect(() =>
      f.foldE(...releaseAlice(), respond({ criterion: "nope" })),
    ).toThrow(ReviewIllegalError);
    expect(() =>
      f.foldE(...releaseAlice(), {
        actor: f.fac,
        body: { type: "response.added", role: "alice", text: "x" },
      }),
    ).toThrow(ReviewIllegalError);
  });
  it("a role cannot respond on a peer's subject or as another role", () => {
    expect(() =>
      f.foldE(...releaseAlice(), {
        actor: f.part("bob"),
        body: { type: "response.added", role: "alice", text: "x" },
      }),
    ).toThrow(ReviewIllegalError);
    expect(() =>
      f.foldE(...releaseAlice(), {
        actor: f.part("alice"),
        body: { type: "response.added", role: "bob", text: "x" },
      }),
    ).toThrow(ReviewIllegalError);
  });
  it.each([
    ["the group", { role: "group" }],
    ["a prototype role", { role: "__proto__" }],
    ["a prototype criterion", { criterion: "constructor" }],
    ["a non-string text", { text: 5 }],
    ["an empty text", { text: "" }],
    ["an over-long text", { text: "x".repeat(1501) }],
    ["a non-boolean dispute", { dispute: "yes" }],
  ])("refuses a response with %s", (_n, over) => {
    expect(() =>
      f.foldE(...releaseAlice(), {
        actor: f.part("alice"),
        body: {
          type: "response.added",
          role: "alice",
          text: "t",
          ...over,
        } as Body,
      }),
    ).toThrow(ReviewIllegalError);
  });
  it("refuses an unsafe attestation and a system actor", () => {
    for (const actor of [
      { kind: "participant", role: "alice", attestedBy: "a/b" },
      { kind: "participant", role: "alice", attestedBy: 3 },
      { kind: "system" },
    ] as never[]) {
      expect(() =>
        f.foldE(...releaseAlice(), {
          actor,
          body: { type: "response.added", role: "alice", text: "x" },
        }),
      ).toThrow(ReviewIllegalError);
    }
  });
  it("counts code points, not UTF-16 units, and caps responses per subject", () => {
    expect(() =>
      f.foldE(...releaseAlice(), respond({ text: "😀".repeat(1500) })),
    ).not.toThrow();
    expect(() =>
      f.foldE(...releaseAlice(), respond({ text: "😀".repeat(1501) })),
    ).toThrow(ReviewIllegalError);
    const many = Array.from({ length: 50 }, () => respond());
    expect(() => f.foldE(...releaseAlice(), ...many)).not.toThrow();
    expect(() => f.foldE(...releaseAlice(), ...many, respond())).toThrow(
      /too many/,
    );
  });
  it("refuses a response after withdrawal, and records which version it answers", () => {
    const rel = releaseAlice();
    const v1 = f.foldE(...rel).lastSeq;
    expect(() =>
      f.foldE(
        ...rel,
        fb({ type: "report.withdrawn", subject: "alice", reason: "r" }),
        respond(),
      ),
    ).toThrow(ReviewIllegalError);
    const amend = fb({
      type: "report.amended",
      subject: "alice",
      reason: "r",
      basedOn: v1,
    });
    const v = f.foldE(...rel, respond(), amend, respond());
    expect(v.subjects.get("alice")!.responses.map((r) => r.version)).toEqual([
      v1,
      v1,
    ]);
  });
  it("resolves a dispute once with an outcome and a reason; upheld and declined leave the score", () => {
    const base = [...releaseAlice(), respond({ dispute: true })];
    const seq = f.foldE(...base).lastSeq;
    const resolve = (
      outcome: "upheld" | "amended" | "declined",
      reason = "checked the recording",
    ): Entry =>
      fb({ type: "dispute.resolved", response: seq, outcome, reason });
    const v = f.foldE(...base, resolve("upheld"));
    expect(v.subjects.get("alice")!.responses[0]!.resolution).toMatchObject({
      outcome: "upheld",
      reason: "checked the recording",
      by: "kamal",
    });
    const before = f.foldE(...base).subjects.get("alice")!;
    const a = v.subjects.get("alice")!;
    expect(a.criteria.map((c) => c.current)).toEqual(
      before.criteria.map((c) => c.current),
    );
    expect(a.snapshot).toEqual(before.snapshot);
    expect(a.versions).toEqual(before.versions);
    expect(a.state).toBe("released");
    expect(() =>
      f.foldE(...base, resolve("upheld"), resolve("declined")),
    ).toThrow(/already/);
    expect(() => f.foldE(...base, resolve("declined", ""))).toThrow(
      ReviewIllegalError,
    );
    expect(() =>
      f.foldE(...base, {
        actor: f.part("alice"),
        body: {
          type: "dispute.resolved",
          response: seq,
          outcome: "upheld",
          reason: "r",
        },
      }),
    ).toThrow(ReviewIllegalError);
  });
  it.each([
    ["an unknown outcome", { outcome: "won" }],
    ["a long reason", { reason: "x".repeat(501) }],
    ["a non-string reason", { reason: 4 }],
    ["a string response seq", { response: "SEQ" }],
    ["a fractional response seq", { response: 1.5 }],
    ["a prototype response seq", { response: "__proto__" }],
  ])("refuses a resolution with %s", (_n, over) => {
    const base = [...releaseAlice(), respond({ dispute: true })];
    const seq = f.foldE(...base).lastSeq;
    expect(() =>
      f.foldE(...base, {
        actor: f.fac,
        body: {
          type: "dispute.resolved",
          response: seq,
          outcome: "upheld",
          reason: "r",
          ...over,
        } as Body,
      }),
    ).toThrow(ReviewIllegalError);
  });
  it("refuses to resolve a response that is not a dispute or does not exist", () => {
    const base = [...releaseAlice(), respond()];
    const seq = f.foldE(...base).lastSeq;
    expect(() =>
      f.foldE(
        ...base,
        fb({
          type: "dispute.resolved",
          response: seq,
          outcome: "upheld",
          reason: "r",
        }),
      ),
    ).toThrow(/not a dispute/);
    expect(() =>
      f.foldE(
        ...base,
        fb({
          type: "dispute.resolved",
          response: 999,
          outcome: "upheld",
          reason: "r",
        }),
      ),
    ).toThrow(/no such response/);
  });
  it("'amended' needs a new released version after the response: not while the amendment is open, nor after it was withdrawn", () => {
    const base = [...releaseAlice(), respond({ dispute: true })];
    const seq = f.foldE(...base).lastSeq;
    const res = fb({
      type: "dispute.resolved",
      response: seq,
      outcome: "amended",
      reason: "fixed",
    });
    expect(() => f.foldE(...base, res)).toThrow(/amend/);
    const v1 = f.foldE(...releaseAlice()).lastSeq;
    const amend = fb({
      type: "report.amended",
      subject: "alice",
      reason: "r",
      basedOn: v1,
    });
    expect(() => f.foldE(...base, amend, res)).toThrow(/release/);
    expect(() =>
      f.foldE(
        ...base,
        amend,
        fb({ type: "report.withdrawn", subject: "alice", reason: "r" }),
        res,
      ),
    ).toThrow(/release/);
    expect(
      f
        .foldE(
          ...base,
          amend,
          fb({ type: "report.released", subjects: ["alice"] }),
          res,
        )
        .subjects.get("alice")!.responses[0]!.resolution?.outcome,
    ).toBe("amended");
  });
  it("an amendment that came before the response does not justify 'amended'", () => {
    const rel = releaseAlice();
    const v1 = f.foldE(...rel).lastSeq;
    const amend = fb({
      type: "report.amended",
      subject: "alice",
      reason: "r",
      basedOn: v1,
    });
    const pre = [...rel, amend, respond({ dispute: true })];
    const seq = f.foldE(...pre).lastSeq;
    expect(() =>
      f.foldE(
        ...pre,
        fb({
          type: "dispute.resolved",
          response: seq,
          outcome: "amended",
          reason: "r",
        }),
      ),
    ).toThrow(/amend/);
  });
  it("disputing while amending, then re-releasing, lets the dispute resolve as 'amended'", () => {
    const rel = releaseAlice();
    const v1 = f.foldE(...rel).lastSeq;
    const pre = [
      ...rel,
      fb({
        type: "report.amended",
        subject: "alice",
        reason: "r",
        basedOn: v1,
      }),
      respond({ dispute: true }),
    ];
    const seq = f.foldE(...pre).lastSeq;
    const res = fb({
      type: "dispute.resolved",
      response: seq,
      outcome: "amended",
      reason: "fixed",
    });
    expect(() => f.foldE(...pre, res)).toThrow(/amend/);
    const v = f.foldE(
      ...pre,
      fb({ type: "report.released", subjects: ["alice"] }),
      res,
    );
    const a = v.subjects.get("alice")!;
    expect(a.responses[0]!.resolution?.outcome).toBe("amended");
    expect(a.responses[0]!.version).toBe(v1);
    expect(a.versions).toHaveLength(2);
  });
  it("resolving never changes the released score; only the amendment does", () => {
    const base = [...releaseAlice(), respond({ dispute: true })];
    const seq = f.foldE(...base).lastSeq;
    const v = f.foldE(
      ...base,
      fb({
        type: "report.amended",
        subject: "alice",
        reason: "r",
        basedOn: f.foldE(...releaseAlice()).lastSeq,
      }),
      fb({
        type: "dispute.resolved",
        response: seq,
        outcome: "upheld",
        reason: "fixed",
      }),
    );
    const a = v.subjects.get("alice")!;
    expect(a.snapshot!.version).toBe(a.versions[0]);
    expect(a.criteria.map((c) => c.current)).toEqual(
      a.snapshot!.criteria.map((c) => c.current),
    );
  });
});

describe("who may emit what", () => {
  it.each<[string, Body]>([
    [
      "score.edited",
      {
        type: "score.edited",
        subject: "alice",
        criterion: "listening",
        from: 1,
        to: 2,
        reason: "r",
      },
    ],
    [
      "score.accepted",
      { type: "score.accepted", subject: "alice", criterion: "listening" },
    ],
    ["summary.accepted", { type: "summary.accepted", subject: "alice" }],
    [
      "comment.added",
      {
        type: "comment.added",
        subject: "alice",
        text: "t",
        visibility: "feedback",
      },
    ],
    ["report.released", { type: "report.released", subjects: ["alice"] }],
    [
      "report.exported",
      {
        type: "report.exported",
        subject: "alice",
        version: 2,
        principal: "facilitator",
        destination: "d",
      },
    ],
    ["review.superseded", { type: "review.superseded", by: "x" }],
  ])("a participant actor cannot emit %s", (_n, body) => {
    expect(() => f.foldE({ actor: f.part("alice"), body })).toThrow(
      ReviewIllegalError,
    );
  });
});
