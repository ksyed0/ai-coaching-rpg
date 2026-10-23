import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderGroupMarkdown } from "../../evaluator/report-md.js";
import type { GroupReport } from "../../evaluator/report-model.js";
import { loadReview } from "../store.js";
import { makeDraftDir, makeRunner } from "./fixtures.js";

let root: string, dir: string, run: ReturnType<typeof makeRunner>, rel: string;
async function resolveAll() {
  const l = await loadReview(dir);
  for (const sv of l.view.subjects.values()) {
    for (const c of sv.criteria.filter((x) => x.status === "needs_review"))
      await run(["accept", rel, sv.id, c.id, "--by", "kamal"]);
    const cur = (await loadReview(dir)).view.subjects.get(sv.id)!;
    if (cur.summaryStale)
      await run(["accept", rel, sv.id, "--summary", "--by", "kamal"]);
  }
}
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  run = makeRunner(root);
  rel = path.relative(root, dir);
  await run(["open", rel, "--by", "kamal"]);
  await resolveAll();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const ex = (subject: string, to: string, who: string, by = "kamal") =>
  run(["export", rel, subject, "--for", who, "--to", to, "--by", by]);
const read = (p: string) => readFile(path.join(root, p), "utf8");
const release = async () =>
  expect((await run(["release", rel, "--all", "--by", "kamal"])).code).toBe(0);
const comment = (subject: string, text: string, feedback: boolean) =>
  run([
    "comment",
    rel,
    subject,
    "--text",
    text,
    ...(feedback ? ["--feedback"] : []),
    "--by",
    "kamal",
  ]);
const events = async () =>
  (await loadReview(dir)).events.filter((e) => e.type === "report.exported");

describe("participants see released reports only, and only their own scores", () => {
  it("refuses every export before release (exit 1), for a participant", async () => {
    expect((await ex("alice", "o/a", "participant:alice")).code).toBe(1);
    expect((await ex("group", "o/g", "participant:alice")).code).toBe(1);
    expect((await ex("index", "o/i", "participant:alice")).code).toBe(1);
    expect(await events()).toHaveLength(0);
  });
  describe("after release", () => {
    beforeEach(release);
    it("alice gets her own report; bob's is refused; inert audiences are refused; a malformed principal is a usage error", async () => {
      expect((await ex("alice", "o/a", "participant:alice")).code).toBe(0);
      expect(await read("o/a/alice.md")).toContain(
        "Visibility: you and the facilitator",
      );
      expect((await ex("bob", "o/b", "participant:alice")).code).toBe(1);
      for (const p of ["line_manager", "ld", "hr", "sponsor"])
        expect((await ex("alice", `o/${p}`, p)).code).toBe(1);
      expect((await ex("alice", "o/bad", "participant:../x")).code).toBe(2);
      expect((await ex("alice", "o/bad2", "nobody")).code).toBe(2);
      const evs = await events();
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({
        subject: "alice",
        principal: "participant:alice",
      });
    });
    it("a role that is not a participant of this review is refused without echoing it", async () => {
      const r = await ex("alice", "o/n", "participant:mallory");
      expect(r.code).toBe(1);
      expect(r.err).not.toContain("mallory");
      expect(await events()).toHaveLength(0);
    });
    it("alice's group report and index contain no byte of bob's individual results, in Markdown or JSON", async () => {
      expect((await ex("group", "o/g", "participant:alice")).code).toBe(0);
      expect((await ex("index", "o/i", "participant:alice")).code).toBe(0);
      const files = [
        await read("o/g/group.md"),
        await read("o/g/group.json"),
        await read("o/i/index.md"),
      ];
      for (const text of files) {
        expect(text).not.toMatch(/`bob`\s*\|/);
        expect(text).not.toMatch(/"bob":\s*\{\s*"score"/);
      }
      const gj = JSON.parse(files[1]!);
      expect(gj.lo_coverage.players).toEqual(["alice"]);
      expect(
        Object.values(
          gj.lo_coverage.objectives as { by_role: Record<string, unknown> }[],
        ).every((o) => Object.keys(o.by_role).join() === "alice"),
      ).toBe(true);
      expect(files[0]).toContain("`alice`");
      expect(files[2]).toContain("alice.md");
      expect(files[2]).not.toContain("bob");
      expect(files[2]).toContain("group.md");
      // the index is audited under the group
      const evs = await events();
      expect(evs.at(-1)).toMatchObject({
        subject: "group",
        principal: "participant:alice",
      });
    });
    it("the participant group report carries no facilitator-directed section and no facilitator state", async () => {
      await ex("group", "o/g", "participant:alice");
      const md = await read("o/g/group.md");
      const json = await read("o/g/group.json");
      expect(md).not.toContain("Talking points for the facilitator");
      expect(md).not.toContain("Compare the first price");
      expect(json).not.toContain("Compare the first price");
      await ex("group", "o/fg", "facilitator");
      expect(await read("o/fg/group.md")).toContain(
        "Talking points for the facilitator",
      );
    });
    it("the released JSON and Markdown carry no review-state marks", async () => {
      await ex("alice", "o/a", "participant:alice");
      const j = JSON.parse(await read("o/a/alice.json"));
      for (const c of j.criteria) {
        expect(c.moderation).not.toHaveProperty("accepted");
        expect(c.moderation).not.toHaveProperty("rationale_edited");
        expect(c.moderation).not.toHaveProperty("state");
      }
      expect(j).not.toHaveProperty("summary_state");
      const md = await read("o/a/alice.md");
      for (const t of [
        "Needs review",
        "Accepted by facilitator",
        "Rationale edited",
        "Summary needs review",
        "out of date",
      ])
        expect(md).not.toContain(t);
    });
    it("the facilitator's export of the index lists every subject with its state", async () => {
      expect((await ex("index", "o/fi", "facilitator")).code).toBe(0);
      const t = await read("o/fi/index.md");
      for (const s of ["alice", "bob", "group"]) expect(t).toContain(s);
      expect(t).toMatch(/released \(version/);
    });
    it("a comment made after the release (feedback or internal) stays out until the next release", async () => {
      await comment("alice", "INTERNAL-LATE", false);
      await comment("alice", "FEEDBACK-LATE", true);
      await ex("alice", "o/a", "participant:alice");
      const t = (await read("o/a/alice.md")) + (await read("o/a/alice.json"));
      expect(t).not.toContain("INTERNAL-LATE");
      expect(t).not.toContain("FEEDBACK-LATE");
    });
    it("during an amendment the participant gets the last released snapshot, not the working edits, comments or notes", async () => {
      await ex("alice", "o/v1", "participant:alice");
      const v1 = await read("o/v1/alice.json");
      await run(["amend", rel, "alice", "--reason", "r", "--by", "kamal"]);
      const cur = (await loadReview(dir)).view.subjects
        .get("alice")!
        .criteria.find((c) => c.id === "discovery")!.current;
      await run([
        "edit",
        rel,
        "alice",
        "discovery",
        "--level",
        cur === 4 ? "3" : "4",
        "--reason",
        "r",
        "--rationale",
        "AMEND-RATIONALE",
        "--by",
        "kamal",
      ]);
      await comment("alice", "AMEND-FEEDBACK", true);
      const r = await ex("alice", "o/v1b", "participant:alice");
      expect(r.code).toBe(0);
      expect(await read("o/v1b/alice.json")).toBe(v1);
      expect(await read("o/v1b/alice.md")).not.toContain("AMEND-");
      // the facilitator export of an amending subject stays refused
      expect((await ex("alice", "o/fa", "facilitator")).code).toBe(1);
      expect((await ex("index", "o/ia", "participant:alice")).code).toBe(0);
    });
    it("withdrawal removes participant access, and the index drops the withdrawn report", async () => {
      await run([
        "withdraw",
        rel,
        "alice",
        "--reason",
        "wrong session",
        "--by",
        "kamal",
      ]);
      expect((await ex("alice", "o/w", "participant:alice")).code).toBe(1);
      expect((await ex("index", "o/wi", "participant:alice")).code).toBe(0);
      const t = await read("o/wi/index.md");
      expect(t).not.toContain("alice.md");
      expect(t).toContain("group.md");
    });
  });
  it("a participant cannot get the index until the group is released", async () => {
    expect((await run(["release", rel, "alice", "--by", "kamal"])).code).toBe(
      0,
    );
    expect((await ex("alice", "o/a", "participant:alice")).code).toBe(0);
    expect((await ex("index", "o/i", "participant:alice")).code).toBe(1);
    expect((await ex("index", "o/fi", "facilitator")).code).toBe(1);
  });
});

describe("feedback, hostile text and peer leakage", () => {
  const HOSTILE = "<script>alert(1)</script> [x](javascript:alert(2)) | `tick`";
  beforeEach(async () => {
    await comment("alice", "INTERNAL-ONLY", false);
    await comment("alice", `FEEDBACK-VISIBLE ${HOSTILE}`, true);
    await comment("bob", "BOB-FEEDBACK-PEER", true);
    const bobCur = (await loadReview(dir)).view.subjects
      .get("bob")!
      .criteria.find((c) => c.id === "discovery")!.current;
    await run([
      "edit",
      rel,
      "bob",
      "discovery",
      "--level",
      bobCur === 4 ? "3" : "4",
      "--reason",
      "r",
      "--rationale",
      `BOB-RATIONALE ${HOSTILE}`,
      "--by",
      "kamal",
    ]);
    await resolveAll();
    await release();
  });
  it("feedback comments made before the release reach the participant, escaped; internal ones never do", async () => {
    await ex("alice", "o/a", "participant:alice");
    const md = await read("o/a/alice.md");
    const t = md + (await read("o/a/alice.json"));
    expect(t).toContain("FEEDBACK-VISIBLE");
    expect(t).not.toContain("INTERNAL-ONLY");
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("[x](");
    expect(md).toContain("\\[x\\]");
    await ex("alice", "o/f", "facilitator");
    expect(await read("o/f/alice.md")).not.toContain("<script>");
  });
  it("no peer quote, rationale, comment or name appears in alice's own report or index", async () => {
    await ex("alice", "o/a", "participant:alice");
    await ex("index", "o/i", "participant:alice");
    for (const text of [
      await read("o/a/alice.md"),
      await read("o/a/alice.json"),
      await read("o/i/index.md"),
    ]) {
      expect(text).not.toContain("BOB-");
      expect(text).not.toMatch(/\bbob\b/i);
    }
    // bob's own export carries his, not alice's
    await ex("bob", "o/b", "participant:bob");
    const b = await read("o/b/bob.md");
    expect(b).toContain("BOB-RATIONALE");
    expect(b).not.toContain("FEEDBACK-VISIBLE");
  });
});

describe("legacy draft sets", () => {
  it("carries the legacy note for a participant and not for the facilitator", async () => {
    const m = await makeDraftDir();
    try {
      for (const f of ["alice", "bob", "group"]) {
        const p = path.join(m.dir, `${f}.json`);
        const j = JSON.parse(await readFile(p, "utf8"));
        for (const c of j.criteria) delete c.flag_codes;
        await writeFile(p, JSON.stringify(j, null, 2));
      }
      const r2 = makeRunner(m.root);
      const rl = path.relative(m.root, m.dir);
      expect((await r2(["open", rl, "--by", "kamal"])).code).toBe(0);
      const l = await loadReview(m.dir);
      for (const sv of l.view.subjects.values())
        for (const c of sv.criteria.filter((x) => x.status === "needs_review"))
          await r2(["accept", rl, sv.id, c.id, "--by", "kamal"]);
      for (const sv of (await loadReview(m.dir)).view.subjects.values())
        if (sv.summaryStale)
          await r2(["accept", rl, sv.id, "--summary", "--by", "kamal"]);
      expect((await r2(["release", rl, "--all", "--by", "kamal"])).code).toBe(
        0,
      );
      const e = (s: string, to: string, who: string) =>
        r2(["export", rl, s, "--for", who, "--to", to, "--by", "kamal"]);
      expect((await e("alice", "o/p", "participant:alice")).code).toBe(0);
      expect(
        await readFile(path.join(m.root, "o/p/alice.md"), "utf8"),
      ).toContain("Legacy draft set");
      expect((await e("alice", "o/f", "facilitator")).code).toBe(0);
      expect(
        await readFile(path.join(m.root, "o/f/alice.md"), "utf8"),
      ).not.toContain("Legacy draft set");
    } finally {
      await rm(m.root, { recursive: true, force: true });
    }
  });
});

describe("group Markdown renderer", () => {
  it("does not throw when a player has no row in a coverage objective", () => {
    const g = {
      kind: "group",
      draft_notice: "n",
      visibility: "v",
      scenario: { id: "s", title: "t", version: "1" },
      session: { id: "x1", date: "d", complete: true, scenes: [] },
      evaluator: {
        provider: "p",
        model_calls: 0,
        calibration_line: "c",
        variant: "v",
        rubricHash: "h",
      },
      notes: [],
      evaluation: { status: "ok" },
      criteria: [],
      learning_objectives: [],
      lo_coverage: {
        players: ["alice"],
        objectives: [
          {
            id: "lo1",
            statement: "s",
            by_role: {},
            team: { score: null, label: "Not observed", incomplete: false },
          },
        ],
      },
      facilitator_notes: "",
      talking_points: { from_scenario: "", from_evaluator: [] },
      notable_moments: [],
      method: undefined,
    } as unknown as GroupReport;
    expect(() => renderGroupMarkdown(g, [])).not.toThrow();
  });
});
