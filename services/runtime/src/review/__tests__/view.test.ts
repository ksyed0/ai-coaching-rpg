import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { applyCommand, loadReview, openReview } from "../store.js";
import { viewReport, renderSubjectMarkdown } from "../view.js";
import { makeDraftDir, fixedClock } from "./fixtures.js";
import { sha256 } from "../hash.js";
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
    expect(p).toContain("Released (version 0)");
  });
  it("rebuilds the group lo_coverage from the view", async () => {
    const l = await loadReview(dir);
    const g = JSON.parse(await readFile(path.join(dir, "group.json"), "utf8"));
    const r = viewReport(g, l.view, "group", { audience: "facilitator" });
    expect(r.kind).toBe("group");
    expect(renderSubjectMarkdown(r, [])).toContain("IN REVIEW");
  });

  describe("fix round 1", () => {
    const H = "a|b\nc ‮​ [x](http://evil) <b>x</b> end";
    const fAud = { audience: "facilitator" } as const;
    const flipped = (c: number | null) => (c === 4 ? 3 : 4);

    it("marks open, accepted, adjusted and rationale-edited criteria and the summary for the facilitator only", async () => {
      const a0 = await draftOf("alice");
      const ids = a0.criteria.map((c) => c.id);
      const { loaded } = await applyCommand(dir, fixedClock(), (l) => {
        const sv = l.view.subjects.get("alice")!;
        const cr = (id: string) => sv.criteria.find((c) => c.id === id)!;
        return [
          {
            actor: fac,
            body: {
              type: "score.edited",
              subject: "alice",
              criterion: ids[0]!,
              from: cr(ids[0]!).current,
              to: flipped(a0.criteria[0]!.score),
              reason: "because",
            },
          },
          {
            actor: fac,
            body: {
              type: "rationale.edited",
              subject: "alice",
              criterion: ids[1]!,
              fromHash: sha256(cr(ids[1]!).rationale),
              text: "new rationale",
              reason: "clearer",
            },
          },
          {
            actor: fac,
            body: {
              type: "summary.edited",
              subject: "alice",
              summary: {
                strengths: ["s"],
                development_points: [],
                next_actions: [],
              },
              reason: "r",
            },
          },
        ];
      });
      const r = viewReport(a0, loaded.view, "alice", fAud) as ParticipantReport;
      const states = r.criteria.map((c) => c.moderation?.state);
      expect(states[0]).toBe("edited");
      expect(r.criteria[1]!.moderation?.rationale_edited).toBe(true);
      const md = renderSubjectMarkdown(r, []);
      expect(md).toContain("Facilitator-adjusted");
      expect(md).toContain("Rationale edited");
      expect(md).toContain("Summary edited by a facilitator");
      if (states.includes("open")) expect(md).toContain("Needs review");
      const rel = viewReport(a0, loaded.view, "alice", {
        audience: "released",
        line: "L",
      }) as ParticipantReport;
      const relMd = renderSubjectMarkdown(rel, []);
      expect(relMd).toContain("Facilitator-adjusted");
      expect(relMd).not.toContain("Needs review");
      expect(relMd).not.toContain("Rationale edited");
      expect(relMd).not.toContain("Summary edited by a facilitator");
      expect(rel.criteria.every((c) => c.moderation?.state === undefined)).toBe(
        true,
      );
    });

    it("shows an accepted criterion as accepted, and names the acceptor on the released banner", async () => {
      const a0 = await draftOf("alice");
      const id = a0.criteria[0]!.id;
      const { loaded } = await applyCommand(dir, fixedClock(), () => [
        {
          actor: fac,
          body: { type: "score.accepted", subject: "alice", criterion: id },
        },
        {
          actor: { kind: "facilitator", by: "zed" },
          body: {
            type: "comment.added",
            subject: "alice",
            text: "hi",
            visibility: "feedback",
          },
        },
      ]);
      const md = renderSubjectMarkdown(
        viewReport(a0, loaded.view, "alice", fAud),
        [],
      );
      expect(md).toContain("Accepted by facilitator");
      const rel = renderSubjectMarkdown(
        viewReport(a0, loaded.view, "alice", {
          audience: "released",
          line: "L",
        }),
        [],
      );
      expect(rel).toContain("Reviewed by kamal and released");
      expect(rel).not.toContain("zed");
    });

    it("omits the Reviewed by part when no facilitator edited or accepted anything", async () => {
      const l = await loadReview(dir);
      const md = renderSubjectMarkdown(
        viewReport(await draftOf("alice"), l.view, "alice", {
          audience: "released",
          line: "L",
        }),
        [],
      );
      expect(md).toMatch(/> Released \(version 0\)/);
      expect(md).not.toContain("Reviewed by");
      expect(md).not.toContain("  ");
    });

    it("says Invalid, not Not observed, when the AI draft was invalid", async () => {
      const a0 = await draftOf("alice");
      const id = a0.criteria[0]!.id;
      const { loaded } = await applyCommand(dir, fixedClock(), (l) => [
        {
          actor: fac,
          body: {
            type: "score.edited",
            subject: "alice",
            criterion: id,
            from: l.view.subjects.get("alice")!.criteria[0]!.current,
            to: flipped(a0.criteria[0]!.score),
            reason: "fix",
          },
        },
      ]);
      const inv = structuredClone(a0);
      inv.criteria[0] = {
        ...inv.criteria[0]!,
        invalid: true,
        score: null,
        level_label: "Invalid (evaluator error)",
      };
      const r = viewReport(
        inv,
        loaded.view,
        "alice",
        fAud,
      ) as ParticipantReport;
      expect(r.criteria[0]!.moderation?.ai_invalid).toBe(true);
      const md = renderSubjectMarkdown(r, []);
      expect(md).toContain("Facilitator-adjusted** from Invalid");
      expect(md).not.toContain("from N/O");
    });

    it("renders a 1500-character edited rationale, summary item and comment in full", async () => {
      const a0 = await draftOf("alice");
      const long = "x".repeat(1500);
      const item = "y".repeat(400);
      const { loaded } = await applyCommand(dir, fixedClock(), (l) => [
        {
          actor: fac,
          body: {
            type: "rationale.edited",
            subject: "alice",
            criterion: a0.criteria[0]!.id,
            fromHash: sha256(
              l.view.subjects.get("alice")!.criteria[0]!.rationale,
            ),
            text: long,
            reason: "r",
          },
        },
        {
          actor: fac,
          body: {
            type: "summary.edited",
            subject: "alice",
            summary: {
              strengths: [item],
              development_points: [],
              next_actions: [],
            },
            reason: "r",
          },
        },
        {
          actor: fac,
          body: {
            type: "comment.added",
            subject: "alice",
            text: "z".repeat(1500),
            visibility: "internal",
          },
        },
      ]);
      const md = renderSubjectMarkdown(
        viewReport(a0, loaded.view, "alice", fAud),
        [],
      );
      expect(md).toContain(long);
      expect(md).toContain(item);
      expect(md).toContain("z".repeat(1500));
      expect(md).not.toContain("…");
    });

    it("keeps hostile text in a reason, comment, rationale and summary item from breaking rows, linking or hiding", async () => {
      const a0 = await draftOf("alice");
      const lo = a0.learning_objectives[0]!.id;
      const { loaded } = await applyCommand(dir, fixedClock(), (l) => {
        const c0 = l.view.subjects.get("alice")!.criteria;
        return [
          {
            actor: fac,
            body: {
              type: "score.edited",
              subject: "alice",
              criterion: a0.criteria[0]!.id,
              from: c0[0]!.current,
              to: flipped(a0.criteria[0]!.score),
              reason: H,
            },
          },
          {
            actor: fac,
            body: {
              type: "rationale.edited",
              subject: "alice",
              criterion: a0.criteria[1]!.id,
              fromHash: sha256(c0[1]!.rationale),
              text: H,
              reason: "r",
            },
          },
          {
            actor: fac,
            body: {
              type: "summary.edited",
              subject: "alice",
              summary: {
                strengths: [H],
                development_points: [H],
                next_actions: [{ lo, action: H }],
              },
              reason: "r",
            },
          },
          {
            actor: fac,
            body: {
              type: "comment.added",
              subject: "alice",
              text: H,
              visibility: "feedback",
            },
          },
        ];
      });
      const md = renderSubjectMarkdown(
        viewReport(a0, loaded.view, "alice", fAud),
        [],
      );
      expect(md).not.toMatch(
        /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2028\u2029]/,
      );
      expect(md).not.toContain("<b>");
      expect(md).not.toMatch(/(?<!\\)\]\(/);
      expect(md).not.toMatch(/(?<!\\)\[x/);
      const rows = md
        .split("\n")
        .filter((x) => x.startsWith("| ") && x.includes("("));
      const critRows = md
        .split("\n")
        .filter(
          (x) =>
            x.includes("Facilitator-adjusted") ||
            x.includes("Rationale edited"),
        );
      expect(critRows.length).toBeGreaterThanOrEqual(2);
      const cols = (x: string) => (x.match(/(?<!\\)\|/g) ?? []).length;
      for (const row of critRows) {
        expect(row.startsWith("|")).toBe(true);
        expect(row.endsWith("|")).toBe(true);
        expect(cols(row)).toBe(5);
      }
      expect(rows.length).toBeGreaterThan(0);
      expect(md.split("\n").every((x) => !/^c /.test(x))).toBe(true);
    });
  });
});
