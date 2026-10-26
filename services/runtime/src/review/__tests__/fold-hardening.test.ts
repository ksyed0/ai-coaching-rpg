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
