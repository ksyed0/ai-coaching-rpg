import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { loadDrafts, type Drafts } from "../draft.js";
import { ReviewIllegalError } from "../errors.js";
import { type Actor, type Body, type Entry, LIMITS } from "../types.js";
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
const respond = (dispute = false): Body => ({
  type: "response.added",
  role: "alice",
  text: "I disagree",
  ...(dispute ? { dispute: true } : {}),
});
const releaseAlice = (): Entry[] => [
  ...resolveBodies(f.fold(), "alice").map(fb),
  fb({ type: "report.released", subjects: ["alice"] }),
];
// the opener is seq 1, then the release entries, so the first response lands at releaseAlice().length + 2
const firstResponseSeq = () => releaseAlice().length + 2;
const hide = (response: number, reasonText = "off topic"): Body => ({
  type: "response.hidden",
  response,
  reason: reasonText,
});
const asPart = (b: Body): Entry => ({ actor: f.part("alice"), body: b });
const refused = (...entries: Entry[]) =>
  expect(() =>
    f.foldE(
      ...releaseAlice(),
      { actor: f.part("alice"), body: respond() },
      ...entries,
    ),
  ).toThrow(ReviewIllegalError);

describe("response.hidden fold", () => {
  it("a facilitator hide sets hidden from the event and keeps the response in the list", () => {
    const seq = firstResponseSeq();
    const v = f.foldE(
      ...releaseAlice(),
      { actor: f.part("alice"), body: respond() },
      fb(hide(seq)),
    );
    const rs = v.subjects.get("alice")!.responses;
    expect(rs).toHaveLength(1);
    expect(rs[0]!.hidden).toEqual({
      seq: seq + 1,
      ts: expect.any(Number),
      reason: "off topic",
      by: "kamal",
    });
    expect(rs[0]!.hidden!.ts).toBeGreaterThan(0);
  });

  it("a response is not hidden until the event: hidden is null", () => {
    const v = f.foldE(...releaseAlice(), {
      actor: f.part("alice"),
      body: respond(),
    });
    expect(v.subjects.get("alice")!.responses[0]!.hidden).toBeNull();
  });

  it("hiding does not free a slot: the response cap still counts the hidden one", () => {
    const seq = firstResponseSeq();
    const adds: Entry[] = Array.from({ length: LIMITS.responses }, () => ({
      actor: f.part("alice"),
      body: respond(),
    }));
    const fold = (...extra: Entry[]) =>
      f.foldE(...releaseAlice(), ...adds, ...extra);
    expect(fold().subjects.get("alice")!.responses).toHaveLength(
      LIMITS.responses,
    );
    expect(() =>
      fold(fb(hide(seq)), { actor: f.part("alice"), body: respond() }),
    ).toThrow(/too many responses/);
    expect(fold(fb(hide(seq))).subjects.get("alice")!.responses).toHaveLength(
      LIMITS.responses,
    );
  });

  it("refuses a participant_session actor", () => {
    const seq = firstResponseSeq();
    refused({ actor: f.web("alice"), body: hide(seq) });
    expect(() =>
      f.foldE(
        ...releaseAlice(),
        { actor: f.part("alice"), body: respond() },
        { actor: f.web("alice"), body: hide(seq) },
      ),
    ).toThrow(/a web link can only rate or respond/);
  });

  it("refuses the attested participant and a system actor", () => {
    const seq = firstResponseSeq();
    refused(asPart(hide(seq)));
    refused({ actor: { kind: "system" } as unknown as Actor, body: hide(seq) });
  });

  it("refuses a response that does not exist", () => {
    refused(fb(hide(999)));
  });

  it("refuses a second hide of the same response, and yields one accepted event", () => {
    const seq = firstResponseSeq();
    refused(fb(hide(seq)), fb(hide(seq, "again")));
    const v = f.foldE(
      ...releaseAlice(),
      { actor: f.part("alice"), body: respond() },
      fb(hide(seq)),
    );
    expect(v.subjects.get("alice")!.responses[0]!.hidden!.reason).toBe(
      "off topic",
    );
  });

  it("refuses an empty reason and a reason over 500 characters; accepts exactly 500", () => {
    const seq = firstResponseSeq();
    refused(fb(hide(seq, "")));
    refused(fb(hide(seq, "x".repeat(501))));
    const v = f.foldE(
      ...releaseAlice(),
      { actor: f.part("alice"), body: respond() },
      fb(hide(seq, "x".repeat(500))),
    );
    expect(v.subjects.get("alice")!.responses[0]!.hidden!.reason).toHaveLength(
      500,
    );
  });
});

describe("response.hidden and disputes", () => {
  const dispute = (): Entry => ({
    actor: f.part("alice"),
    body: respond(true),
  });
  const resolve = (response: number): Entry =>
    fb({
      type: "dispute.resolved",
      response,
      outcome: "declined",
      reason: "checked",
    });

  it("refuses to resolve a hidden dispute, naming that it is hidden", () => {
    const seq = firstResponseSeq();
    expect(() =>
      f.foldE(...releaseAlice(), dispute(), fb(hide(seq)), resolve(seq)),
    ).toThrow(/hidden/);
  });

  it("a dispute can be resolved before it is hidden, and hiding then keeps the resolution", () => {
    const seq = firstResponseSeq();
    const v = f.foldE(
      ...releaseAlice(),
      dispute(),
      resolve(seq),
      fb(hide(seq)),
    );
    const r = v.subjects.get("alice")!.responses[0]!;
    expect(r.hidden).not.toBeNull();
    expect(r.resolution?.outcome).toBe("declined");
  });
});
