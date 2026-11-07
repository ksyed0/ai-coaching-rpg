import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { loadDrafts, type Drafts } from "../draft.js";
import { ReviewIllegalError } from "../errors.js";
import { shortLinkId, who } from "../fold.js";
import { isCredentialIdShape, type Actor, type Body, type Entry } from "../types.js";
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

const fb = (body: Body): Entry => ({ actor: f.fac, body });
const rated = (): Body => ({
  type: "self.rated",
  role: "alice",
  criterion: "listening",
  level: 3,
});
const respond = (): Body => ({
  type: "response.added",
  role: "alice",
  text: "I disagree",
});
const releaseAlice = (): Entry[] => [
  ...resolveBodies(f.fold(), "alice").map(fb),
  fb({ type: "report.released", subjects: ["alice"] }),
];
const bad = (a: unknown): Actor => a as Actor;

describe("participant_session actor", () => {
  it("accepts self.rated and response.added from a participant_session in a /2 review", () => {
    const v = f.foldE(
      { actor: f.web("alice"), body: rated() },
      ...releaseAlice(),
      { actor: f.web("alice"), body: respond() },
    );
    const a = v.subjects.get("alice")!;
    expect(a.criteria.find((c) => c.id === "listening")!.self?.level).toBe(3);
    expect(a.responses).toHaveLength(1);
  });

  it("refuses participant_session on every other event type", () => {
    const types: Body["type"][] = [
      "review.opened",
      "score.edited",
      "rationale.edited",
      "summary.edited",
      "summary.accepted",
      "score.accepted",
      "comment.added",
      "report.released",
      "report.amended",
      "report.withdrawn",
      "report.exported",
      "dispute.resolved",
      "review.superseded",
    ];
    const bodies: Record<string, Body> = {
      "score.edited": { type: "score.edited", subject: "alice", criterion: "listening", from: 2, to: 3, reason: "r" },
      "rationale.edited": { type: "rationale.edited", subject: "alice", criterion: "listening", fromHash: "x", text: "t", reason: "r" },
      "summary.edited": { type: "summary.edited", subject: "alice", summary: { strengths: ["a"], development_points: ["b"], next_actions: [] }, reason: "r" },
      "summary.accepted": { type: "summary.accepted", subject: "alice" },
      "score.accepted": { type: "score.accepted", subject: "alice", criterion: "listening" },
      "comment.added": { type: "comment.added", subject: "alice", text: "t", visibility: "internal" },
      "report.released": { type: "report.released", subjects: ["alice"] },
      "report.amended": { type: "report.amended", subject: "alice", reason: "r", basedOn: 1 },
      "report.withdrawn": { type: "report.withdrawn", subject: "alice", reason: "r" },
      "report.exported": { type: "report.exported", subject: "alice", version: 1, principal: "p", destination: "d" },
      "dispute.resolved": { type: "dispute.resolved", response: 1, outcome: "upheld", reason: "r" },
      "review.superseded": { type: "review.superseded", by: "x" },
    };
    for (const t of types.filter((x) => x !== "review.opened")) {
      expect(
        () => f.foldE({ actor: f.web("alice"), body: bodies[t]! }),
        t,
      ).toThrow(ReviewIllegalError);
    }
    // every Body type is covered either here or by the two accepted types
    expect(new Set([...types, "self.rated", "response.added"]).size).toBe(15);
  });

  it("refuses it in a /1 review", () => {
    const f1 = makeFold(drafts, { schema: "acr.review/1" });
    expect(() => f1.foldE({ actor: f1.web("alice"), body: rated() })).toThrow(
      ReviewIllegalError,
    );
  });

  it("a /1 opener still typechecks and folds", () => {
    const f1 = makeFold(drafts, { schema: "acr.review/1" });
    expect(() =>
      f1.foldE({ actor: f1.part("alice"), body: rated() }),
    ).not.toThrow();
  });

  it("an unknown schema string is refused", () => {
    const f2 = makeFold(drafts, { schema: "acr.review/3" as never });
    expect(() => f2.fold()).toThrow(ReviewIllegalError);
  });

  it("refuses v other than 1 (0, 2, undefined)", () => {
    for (const v of [0, 2, undefined]) {
      const a = bad({ ...f.web("alice"), v });
      expect(
        () => f.foldE({ actor: a, body: rated() }),
        String(v),
      ).toThrow(ReviewIllegalError);
    }
  });

  it("refuses a role that differs from event.role", () => {
    expect(() => f.foldE({ actor: f.web("bob"), body: rated() })).toThrow(
      ReviewIllegalError,
    );
  });

  it("refuses a malformed credentialId or role", () => {
    expect(() =>
      f.foldE({ actor: f.web("alice", "short"), body: rated() }),
    ).toThrow(ReviewIllegalError);
    expect(() =>
      f.foldE({ actor: bad({ ...f.web("alice"), role: "../x" }), body: rated() }),
    ).toThrow(ReviewIllegalError);
  });

  it("still accepts the attested actor, including a log that mixes both kinds", () => {
    const v = f.foldE(
      { actor: f.part("alice"), body: rated() },
      { actor: f.web("alice"), body: { ...rated(), level: 4 } as Body },
      ...releaseAlice(),
      { actor: f.part("alice"), body: respond() },
      { actor: f.web("alice"), body: respond() },
    );
    expect(v.subjects.get("alice")!.responses).toHaveLength(2);
  });

  it("self-rating after release and response before release are still illegal for the new kind", () => {
    expect(() =>
      f.foldE(...releaseAlice(), { actor: f.web("alice"), body: rated() }),
    ).toThrow(ReviewIllegalError);
    expect(() =>
      f.foldE({ actor: f.web("alice"), body: respond() }),
    ).toThrow(ReviewIllegalError);
  });

  it('who() renders "alice (web link <id>)"', () => {
    expect(who(f.web("alice", "AAAAAAAAAAA"))).toBe(
      "alice (web link AAAAAAAAAAA)",
    );
  });

  it("isCredentialIdShape accepts 11-char base64url only", () => {
    expect(isCredentialIdShape("AAAAAAAAAAA")).toBe(true);
    expect(isCredentialIdShape("AAAAAAAAAA")).toBe(false);
    expect(isCredentialIdShape("AAAAAAAAAA+")).toBe(false);
    expect(isCredentialIdShape("AAAAAAAAAAB")).toBe(false); // non-canonical trailing bits
    expect(isCredentialIdShape(7)).toBe(false);
  });
});

describe("via: the web link behind a self-rating or response (AC-0383)", () => {
  it("a self.rated from a web link records via as the 8-character id", () => {
    const v = f.foldE({ actor: f.web("alice", "AAAAAAAAAAA"), body: rated() });
    expect(
      v.subjects.get("alice")!.criteria.find((c) => c.id === "listening")!.self,
    ).toMatchObject({ level: 3, via: "AAAAAAAA" });
  });

  it("a response.added from a web link records via too", () => {
    const v = f.foldE(
      ...releaseAlice(),
      { actor: f.web("alice", "AAAAAAAAAAA"), body: respond() },
    );
    expect(v.subjects.get("alice")!.responses[0]!.via).toBe("AAAAAAAA");
  });

  it("a facilitator-attested self.rated has via null", () => {
    const v = f.foldE({ actor: f.part("alice"), body: rated() });
    expect(
      v.subjects.get("alice")!.criteria.find((c) => c.id === "listening")!.self!.via,
    ).toBeNull();
  });

  it("a facilitator-attested response has via null", () => {
    const v = f.foldE(...releaseAlice(), { actor: f.part("alice"), body: respond() });
    expect(v.subjects.get("alice")!.responses[0]!.via).toBeNull();
  });

  it("shortLinkId keeps ids of 8 characters or fewer whole", () => {
    expect(shortLinkId("AAAAAAAAAAA")).toBe("AAAAAAAA");
    expect(shortLinkId("12345678")).toBe("12345678");
    expect(shortLinkId("abc")).toBe("abc");
    expect(shortLinkId("")).toBe("");
  });
});
