import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";

// Defence in depth: whatever the view holds, subjectView cleans each string line by line (as `show` does).
vi.mock("../../review/view.js", async (orig) => {
  const real = await orig<typeof import("../../review/view.js")>();
  return {
    ...real,
    viewReport: (...a: Parameters<typeof real.viewReport>) => {
      const r = real.viewReport(...a);
      if (r.criteria[0])
        r.criteria[0].rationale = `before\u001b[31m sk-live-abcdef123456‮\nafter`;
      return r;
    },
  };
});
import { ReviewRefusedError } from "../../review/errors.js";
import { loadReview } from "../../review/store.js";
import { moderationStatus, subjectView } from "../index.js";
import { openedReview, releaseViaCli, type Env } from "./helpers.js";

let env: Env | undefined;
afterEach(async () => {
  if (env) await rm(env.root, { recursive: true, force: true });
  env = undefined;
});

describe("moderation reads", () => {
  it("moderationStatus lists open criteria, open disputes, evaluationOk and tableStale per subject", async () => {
    env = await openedReview();
    const fresh = await moderationStatus(env.dir);
    const l0 = await loadReview(env.dir);
    expect(fresh.superseded).toBeNull();
    expect(fresh.subjects.map((s) => s.id).sort()).toEqual(
      [...l0.view.subjects.keys()].sort(),
    );
    for (const s of fresh.subjects) {
      const sv = l0.view.subjects.get(s.id)!;
      expect(s).toEqual({
        id: s.id,
        state: "draft",
        version: null,
        criteriaTotal: sv.criteria.length,
        openCriteria: sv.criteria
          .filter((c) => c.status === "needs_review")
          .map((c) => c.id),
        summaryStale: false,
        tableStale: false,
        evaluationOk: sv.evaluationOk,
        selfRated: 0,
        openDisputes: [],
      });
    }
    // group first, then alice alone: the group's frozen table is out of date; then alice disputes
    await releaseViaCli(env, "group");
    await releaseViaCli(env, "alice");
    const crit = l0.view.subjects.get("alice")!.criteria[0]!.id;
    const d = await env.run([
      "respond",
      env.rel,
      "--role",
      "alice",
      "--text",
      "I disagree",
      "--dispute",
      "--by",
      "kamal",
    ]);
    expect(d.code).toBe(0);
    await env.run([
      "respond",
      env.rel,
      "--role",
      "alice",
      "--text",
      "on this one",
      "--criterion",
      crit,
      "--dispute",
      "--by",
      "kamal",
    ]);
    const st = await moderationStatus(env.dir);
    const by = (id: string) => st.subjects.find((s) => s.id === id)!;
    expect(by("group").tableStale).toBe(true);
    expect(by("group").state).toBe("released");
    expect(by("alice").state).toBe("released");
    expect(by("alice").version).toEqual(expect.any(Number));
    expect(by("alice").openCriteria).toEqual([]);
    expect(by("alice").evaluationOk).toBe(true);
    expect(by("alice").openDisputes).toEqual([
      { seq: expect.any(Number), role: "alice", criterion: null },
      { seq: expect.any(Number), role: "alice", criterion: crit },
    ]);
    expect(by("bob").openDisputes).toEqual([]);
  });

  it("subjectView returns only the listed fields (a JSON key check) and strips control characters and secrets", async () => {
    env = await openedReview();
    await env.run([
      "comment",
      env.rel,
      "alice",
      "--text",
      "note to self",
      "--by",
      "kamal",
    ]);
    const v = await subjectView(env.dir, "alice", ["sk-live-abcdef123456"]);
    expect(Object.keys(v).sort()).toEqual(
      [
        "comments",
        "criteria",
        "id",
        "objectives",
        "responses",
        "state",
        "summary",
        "versions",
      ].sort(),
    );
    expect(v.id).toBe("alice");
    expect(v.state).toBe("draft");
    expect(v.criteria.length).toBeGreaterThan(0);
    for (const c of v.criteria) {
      for (const k of Object.keys(c))
        expect([
          "id",
          "name",
          "current",
          "status",
          "rationale",
          "evidence",
          "flags",
          "selfLevel",
        ]).toContain(k);
      for (const ev of c.evidence)
        for (const k of Object.keys(ev))
          expect(["quote", "scene"]).toContain(k);
    }
    expect(Object.keys(v.summary).sort()).toEqual(
      ["actions", "developments", "strengths"].sort(),
    );
    for (const a of v.summary.actions)
      expect(Object.keys(a).sort()).toEqual(["lo", "text"]);
    for (const o of v.objectives)
      expect(Object.keys(o).sort()).toEqual(["id", "label"]);
    expect(v.comments).toEqual([
      { visibility: "internal", text: "note to self" },
    ]);
    const json = JSON.stringify(v);
    expect(json).not.toContain("sk-live");
    expect(json).not.toMatch(/\\u001b|\\u202e|‮/);
    expect(v.criteria[0]!.rationale).toBe("before[31m [redacted]\nafter");
    // nothing that names a facilitator or a path
    expect(json).not.toContain("kamal");
    expect(json).not.toContain(env.root);
  });

  it("subjectView of an unknown subject throws a ReviewRefusedError with code unknown_subject", async () => {
    env = await openedReview();
    const e = await subjectView(env.dir, "nobody", []).catch((x) => x);
    expect(e).toBeInstanceOf(ReviewRefusedError);
    expect((e as ReviewRefusedError).code).toBe("unknown_subject");
    expect((e as Error).message).toBe(
      "unknown subject; run status to list them",
    );
  });
});
