import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyCommand,
  loadReview,
  openReview,
  supersedeReview,
  type Loaded,
} from "../store.js";
import { ReviewRefusedError } from "../errors.js";
import { canView } from "../policy.js";
import { POLICY_VERSION, type Body, type Entry } from "../types.js";
import { renderSubjectMarkdown, viewReport } from "../view.js";
import type { ParticipantReport } from "../../evaluator/report-model.js";
import {
  fixedClock,
  makeDraftDir,
  makeRunner,
  resolveBodies,
} from "./fixtures.js";
import { writeReports } from "../../evaluator/report-write.js";
import { sampleEvaluation } from "../../evaluator/__tests__/fixtures.js";

/** Finding 1 of the fold review: supersede carries participant events, keeps disputes resolvable and never re-opens a blind self-rating. */
const fac = { kind: "facilitator", by: "kamal" } as const;
const part = (role: string) =>
  ({ kind: "participant", role, attestedBy: "kamal" }) as const;
let root: string, dir1: string, dir2: string;
beforeEach(async () => {
  ({ root, dir: dir1 } = await makeDraftDir());
  const w = await writeReports(await sampleEvaluation(), {
    outDir: root,
    evaluator: {
      provider: "scripted mock",
      scripted: true,
      rubricHash: "h1",
      variant: "v1",
    },
  });
  dir2 = w.dir; // same session, a re-run
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const apply = (dir: string, build: (l: Loaded) => Entry[]) =>
  applyCommand(dir, fixedClock(), build);
const fb = (body: Body): Entry => ({ actor: fac, body });
const releaseOf = (dir: string, subject: string) =>
  apply(dir, (l) => [
    ...resolveBodies(l.view, subject).map(fb),
    fb({ type: "report.released", subjects: [subject] }),
  ]);
const respond = (dir: string, role: string, text: string, dispute: boolean) =>
  apply(dir, () => [
    {
      actor: part(role),
      body: {
        type: "response.added",
        role,
        text,
        ...(dispute ? { dispute: true } : {}),
      },
    },
  ]);
const selfRate = (dir: string, role: string, level: 1 | 2 | 3 | 4) =>
  apply(dir, () => [
    {
      actor: part(role),
      body: { type: "self.rated", role, criterion: "listening", level },
    },
  ]);
const resolveDispute = (
  dir: string,
  response: number,
  outcome: "upheld" | "amended" | "declined",
) =>
  apply(dir, () => [
    fb({ type: "dispute.resolved", response, outcome, reason: "checked" }),
  ]);
const lastSeq = async (dir: string) => (await loadReview(dir)).view.lastSeq;

/** The old review: alice self-rated, released, one dispute answered, one open, one plain response; an internal comment on alice. */
async function oldReview() {
  await openReview(dir1, { by: "kamal", now: fixedClock() });
  await selfRate(dir1, "alice", 3);
  await apply(dir1, () => [
    fb({
      type: "comment.added",
      subject: "alice",
      text: "INTERNAL-NOTE",
      visibility: "internal",
    }),
  ]);
  await releaseOf(dir1, "alice");
  await respond(dir1, "alice", "first dispute", true);
  const answered = await lastSeq(dir1);
  await resolveDispute(dir1, answered, "declined");
  await respond(dir1, "alice", "OPEN-DISPUTE", true);
  await respond(dir1, "alice", "thanks", false);
  return (await loadReview(dir1)).view.subjects.get("alice")!;
}

describe("supersede carries participant events", () => {
  it("full round trip: self-rating, responses and resolutions arrive in order, the open dispute is resolvable, and alice cannot re-rate", async () => {
    const old = await oldReview();
    const r = await supersedeReview(dir1, dir2, {
      by: "kamal",
      now: fixedClock(),
    });
    expect(r.carried).toContain("alice");
    const l2 = await loadReview(dir2);
    const a = l2.view.subjects.get("alice")!;
    // the new review starts alice in draft (not visible to her) with her own events carried
    expect(a.state).toBe("draft");
    expect(a.criteria.find((c) => c.id === "listening")!.self?.level).toBe(3);
    expect(a.responses.map((x) => [x.text, x.dispute])).toEqual(
      old.responses.map((x) => [x.text, x.dispute]),
    );
    // carried: no claim to a version of the new review
    expect(a.responses.every((x) => x.carried && x.version === null)).toBe(
      true,
    );
    expect(a.responses[0]!.resolution?.outcome).toBe("declined");
    expect(a.responses[1]!.resolution).toBeNull();
    // carried in the old order, all marked
    const carried = l2.events.filter((e) => e.carriedFrom !== undefined);
    expect(
      carried
        .map((e) => e.type)
        .filter((t) => t !== "score.accepted" && t !== "summary.accepted"),
    ).toEqual([
      "self.rated",
      "comment.added",
      "response.added",
      "dispute.resolved",
      "response.added",
      "response.added",
    ]);
    // the resolution points at the response's NEW seq
    const res = carried.find((e) => e.type === "dispute.resolved")!;
    const firstResp = carried.find((e) => e.type === "response.added")!;
    expect((res as { response: number }).response).toBe(firstResp.seq);

    // a participant still sees nothing of the new review before a release there
    expect(
      canView({
        principal: "participant:alice",
        subject: "alice",
        state: a.state,
        versions: a.versions.length,
        view: "report",
        superseded: false,
        policyVersion: POLICY_VERSION,
      }).allowed,
    ).toBe(false);

    // a blind self-rating cannot be made again after alice saw her released scores in the old review
    await expect(selfRate(dir2, "alice", 4)).rejects.toThrow(
      ReviewRefusedError,
    );
    await expect(selfRate(dir2, "alice", 4)).rejects.toThrow(/closed/);
    // bob was never released: he may still rate himself
    await expect(selfRate(dir2, "bob", 2)).resolves.toBeTruthy();

    // the open dispute is on the list and resolvable in the new review; 'amended' needs an amendment released HERE:
    // the first release of a byte-identical re-run changed nothing, so it does not count
    const open = a.responses[1]!.seq;
    await expect(resolveDispute(dir2, open, "amended")).rejects.toThrow(
      /release/,
    );
    await releaseOf(dir2, "alice");
    await expect(resolveDispute(dir2, open, "amended")).rejects.toThrow(
      /amend/,
    );
    const v1 = await lastSeq(dir2);
    await apply(dir2, () => [
      fb({
        type: "report.amended",
        subject: "alice",
        reason: "r",
        basedOn: v1,
      }),
    ]);
    await expect(resolveDispute(dir2, open, "amended")).rejects.toThrow(
      /release/,
    );
    await apply(dir2, () => [
      fb({ type: "report.released", subjects: ["alice"] }),
    ]);
    await resolveDispute(dir2, open, "amended");
    const after = (await loadReview(dir2)).view;
    expect(after.subjects.get("alice")!.responses[1]!.resolution?.outcome).toBe(
      "amended",
    );

    // released again: alice's own report has her responses and replies, and no internal comment
    const draft = JSON.parse(
      await readFile(path.join(dir2, "alice.json"), "utf8"),
    ) as ParticipantReport;
    const shown = JSON.stringify(
      viewReport(draft, after, "alice", { audience: "released", line: "l" }),
    );
    expect(shown).toContain("OPEN-DISPUTE");
    expect(shown).not.toContain("INTERNAL-NOTE");
    // rendered as answered in an earlier review, never as "not part of version N" of this one
    const md = renderSubjectMarkdown(
      viewReport(draft, after, "alice", { audience: "released", line: "l" }),
      [],
    );
    expect(md).toContain("earlier review");
    expect(md).not.toMatch(/not part of version/);
    expect(
      (
        JSON.parse(shown) as {
          responses: { version?: number; earlier_review?: boolean }[];
        }
      ).responses.every(
        (x) => x.version === undefined && x.earlier_review === true,
      ),
    ).toBe(true);
  });
  it("a changed draft starts unreviewed but keeps the participant's events, and self-rating stays closed", async () => {
    await oldReview();
    const aliceJson = path.join(dir2, "alice.json");
    const j = JSON.parse(await readFile(aliceJson, "utf8"));
    j.criteria[0].rationale = `Re-run. ${j.criteria[0].rationale}`;
    await writeFile(aliceJson, JSON.stringify(j, null, 2));
    const r = await supersedeReview(dir1, dir2, {
      by: "kamal",
      now: fixedClock(),
    });
    expect(r.fresh).toContain("alice");
    const a = (await loadReview(dir2)).view.subjects.get("alice")!;
    expect(a.comments).toHaveLength(0); // moderation is not carried for a changed draft
    expect(a.responses.filter((x) => x.dispute && !x.resolution)).toHaveLength(
      1,
    );
    await expect(selfRate(dir2, "alice", 4)).rejects.toThrow(/closed/);
  });
  it("a role that only self-rated before any release may still re-rate in the new review (it never saw scores)", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    await selfRate(dir1, "bob", 2);
    await releaseOf(dir1, "alice");
    await supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() });
    await expect(selfRate(dir2, "bob", 3)).resolves.toBeTruthy();
    expect(
      (await loadReview(dir2)).view.subjects
        .get("bob")!
        .criteria.find((c) => c.id === "listening")!.self?.level,
    ).toBe(3);
  });
  it("closure survives a second supersede even when nothing was released in between", async () => {
    await oldReview();
    await supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() });
    const w = await writeReports(await sampleEvaluation(), {
      outDir: root,
      evaluator: {
        provider: "scripted mock",
        scripted: true,
        rubricHash: "h1",
        variant: "v1",
      },
    });
    await supersedeReview(dir2, w.dir, { by: "kamal", now: fixedClock() });
    await expect(selfRate(w.dir, "alice", 4)).rejects.toThrow(/closed/);
    const a = (await loadReview(w.dir)).view.subjects.get("alice")!;
    expect(a.responses.filter((x) => x.dispute && !x.resolution)).toHaveLength(
      1,
    );
  });
  it("the CLI says what was carried and refuses a self-rating in the new review with the reason", async () => {
    await oldReview();
    const run = makeRunner(root);
    const rel = (d: string) => path.relative(root, d);
    const r = await run(["supersede", rel(dir1), rel(dir2), "--by", "kamal"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/carried \d+ self-rating, response and dispute/);
    const s = await run([
      "self-assess",
      rel(dir2),
      "--role",
      "alice",
      "--rate",
      "listening=4",
      "--by",
      "kamal",
    ]);
    expect(s.code).toBe(1);
    expect(s.err).toMatch(/superseded/);
    expect((await run(["status", rel(dir2)])).out).toMatch(
      /open dispute: #\d+ by alice/,
    );
  });
});
