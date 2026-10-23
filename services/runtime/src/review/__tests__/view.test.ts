import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { applyCommand, loadReview, openReview } from "../store.js";
import { viewReport, renderSubjectMarkdown } from "../view.js";
import { makeDraftDir, fixedClock } from "./fixtures.js";
import type { ParticipantReport } from "../../evaluator/report-model.js";

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  await openReview(dir, { by: "kamal", now: fixedClock() });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const fac = { kind: "facilitator", by: "kamal" } as const;
const draftOf = async (s: string) =>
  JSON.parse(
    await readFile(path.join(dir, `${s}.json`), "utf8"),
  ) as ParticipantReport;

describe("viewReport / renderSubjectMarkdown", () => {
  it("shows an unreviewed subject as in review, facilitator only, with the AI scores and no 'adjusted' marks", async () => {
    const l = await loadReview(dir);
    const r = viewReport(await draftOf("alice"), l.view, "alice", {
      audience: "facilitator",
    }) as ParticipantReport;
    const md = renderSubjectMarkdown(r, []);
    expect(r.schema).toBe("acr.view/1");
    expect(r.status).toBe("moderated");
    expect(md).toContain("IN REVIEW");
    expect(md).toContain("Visibility: facilitator only");
    expect(md).not.toContain("Facilitator-adjusted");
    expect(md).toContain("AI draft calibration");
    expect(r.criteria.every((c) => c.moderation?.adjusted === false)).toBe(
      true,
    );
  });
  it("shows an edited criterion as Facilitator-adjusted with the AI original and the reason, and recomputes the objectives", async () => {
    const a0 = await draftOf("alice");
    const c0 = a0.criteria.find((c) => c.id === "listening")!;
    const to = c0.score === 4 ? 3 : 4;
    const { loaded } = await applyCommand(dir, fixedClock(), (l) => {
      const cur = l.view.subjects
        .get("alice")!
        .criteria.find((c) => c.id === "listening")!.current;
      return [
        {
          actor: fac,
          body: {
            type: "score.edited",
            subject: "alice",
            criterion: "listening",
            from: cur,
            to,
            reason: "Heard in scene 2 <b>x</b>",
          },
        },
      ];
    });
    const r = viewReport(a0, loaded.view, "alice", {
      audience: "facilitator",
    }) as ParticipantReport;
    const c = r.criteria.find((x) => x.id === "listening")!;
    expect(c.score).toBe(to);
    expect(c.moderation).toMatchObject({
      adjusted: true,
      ai_score: c0.score,
      reason: "Heard in scene 2 <b>x</b>",
      by: "kamal",
    });
    const md = renderSubjectMarkdown(r, []);
    expect(md).toContain("Facilitator-adjusted");
    expect(md).toContain("AI draft");
    expect(md).not.toContain("<b>");
    expect(r.notes.join(" ")).toMatch(/moderated by a facilitator \(kamal\)/);
    expect(r.learning_objectives).not.toEqual(a0.learning_objectives);
    expect(r.summary).toEqual(a0.summary);
  });
  it("does not modify the draft object it was given", async () => {
    const l = await loadReview(dir);
    const a0 = await draftOf("alice");
    const copy = JSON.stringify(a0);
    viewReport(a0, l.view, "alice", { audience: "facilitator" });
    expect(JSON.stringify(a0)).toBe(copy);
  });
  it("renders facilitator-only internal comments only for the facilitator audience", async () => {
    const { loaded } = await applyCommand(dir, fixedClock(), () => [
      {
        actor: fac,
        body: {
          type: "comment.added",
          subject: "alice",
          text: "INTERNAL-NOTE",
          visibility: "internal",
        },
      },
      {
        actor: fac,
        body: {
          type: "comment.added",
          subject: "alice",
          text: "KIND-WORDS-NOTE",
          visibility: "feedback",
        },
      },
    ]);
    const a0 = await draftOf("alice");
    const f = renderSubjectMarkdown(
      viewReport(a0, loaded.view, "alice", { audience: "facilitator" }),
      [],
    );
    expect(f).toContain("INTERNAL-NOTE");
    expect(f).toContain("KIND-WORDS-NOTE");
    const p = renderSubjectMarkdown(
      viewReport(a0, loaded.view, "alice", {
        audience: "released",
        line: "Visibility: released",
      }),
      [],
    );
    expect(p).not.toContain("INTERNAL-NOTE");
    expect(p).toContain("KIND-WORDS-NOTE");
    expect(p).toContain("Reviewed by kamal and released");
  });
  it("rebuilds the group lo_coverage from the view", async () => {
    const l = await loadReview(dir);
    const g = JSON.parse(await readFile(path.join(dir, "group.json"), "utf8"));
    const r = viewReport(g, l.view, "group", { audience: "facilitator" });
    expect(r.kind).toBe("group");
    expect(renderSubjectMarkdown(r, [])).toContain("IN REVIEW");
  });
});
