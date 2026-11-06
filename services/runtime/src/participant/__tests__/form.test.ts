import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { readSelfAssessForm } from "../index.js";
import { buildMethod } from "../../evaluator/method.js";
import { loadReview } from "../../review/store.js";
import { makeFold } from "../../review/__tests__/fixtures.js";
import { fixedClock } from "../../review/__tests__/fixtures.js";
import { REVIEW_FILE } from "../../review/types.js";
import { liveReview, type Env } from "./helpers.js";

let env: Env | undefined;
afterEach(async () => {
  if (env) await rm(env.root, { recursive: true, force: true });
  env = undefined;
});
const resolveAll = async (e: Env, s: string) => {
  for (const c of (await loadReview(e.dir)).view.subjects
    .get(s)!
    .criteria.filter((x) => x.status === "needs_review"))
    await e.run(["accept", e.rel, s, c.id, "--by", "kamal"]);
};
const asForm = (r: Awaited<ReturnType<typeof readSelfAssessForm>>) => {
  if (r.kind !== "form") throw new Error(r.kind);
  return r;
};

describe("readSelfAssessForm", () => {
  it("form: returns only criteria {id,name}, the scale and the role's own ratings", async () => {
    env = await liveReview();
    await env.run([
      "self-assess",
      env.rel,
      "--role",
      "alice",
      "--rate",
      "listening=3",
      "--note",
      "I asked questions",
      "--by",
      "kamal",
    ]);
    await env.run([
      "self-assess",
      env.rel,
      "--role",
      "alice",
      "--rate",
      "discovery=na",
      "--by",
      "kamal",
    ]);
    await env.run([
      "self-assess",
      env.rel,
      "--role",
      "bob",
      "--rate",
      "listening=1",
      "--by",
      "kamal",
    ]);
    const f = asForm(
      await readSelfAssessForm(env.root, env.sessionId, "alice"),
    );
    const l = await loadReview(env.dir);
    expect(f.criteria).toEqual(
      l.view.subjects
        .get("alice")!
        .criteria.map((c) => ({ id: c.id, name: c.name })),
    );
    expect(f.scale).toEqual(buildMethod().scale);
    expect(f.existing).toEqual({
      listening: { level: 3, note: "I asked questions" },
      discovery: { level: null },
    });
  });

  it("form: the result's keys are exactly kind, criteria, scale, existing", async () => {
    env = await liveReview();
    const f = asForm(
      await readSelfAssessForm(env.root, env.sessionId, "alice"),
    );
    expect(Object.keys(f).sort()).toEqual([
      "criteria",
      "existing",
      "kind",
      "scale",
    ]);
    for (const c of f.criteria)
      expect(Object.keys(c).sort()).toEqual(["id", "name"]);
    expect(f.existing).toEqual({});
  });

  it("form: evaluator rationale, evidence and comment canaries appear nowhere in JSON.stringify(result)", async () => {
    env = await liveReview((a) => {
      for (const c of a.criteria) {
        c.rationale = "CANARY_RATIONALE_xq7";
        if (Array.isArray(c.evidence))
          for (const e of c.evidence) e.quote = "CANARY_EVIDENCE_xq7 said this";
      }
    });
    await env.run([
      "comment",
      env.rel,
      "alice",
      "--text",
      "CANARY_COMMENT_xq7",
      "--criterion",
      "listening",
      "--by",
      "kamal",
    ]);
    await env.run([
      "edit",
      env.rel,
      "alice",
      "listening",
      "--level",
      "4",
      "--reason",
      "CANARY_REASON_xq7",
      "--rationale",
      "CANARY_EDITED_xq7",
      "--by",
      "kamal",
    ]);
    const draft = JSON.parse(
      await readFile(path.join(env.dir, "alice.json"), "utf8"),
    );
    expect(JSON.stringify(draft)).toContain("CANARY_EVIDENCE_xq7");
    const s = JSON.stringify(
      await readSelfAssessForm(env.root, env.sessionId, "alice"),
    );
    expect(s).toContain('"kind":"form"');
    expect(s).not.toContain("CANARY");
    // nor any draft-side field name of the evaluator (the generic scale labels are allowed: they are not the evaluator's)
    expect(s).not.toMatch(/rationale|evidence|confidence|score|comment/i);
  });

  it("form: closed after release and for a draft with selfClosed; withdrawn for a withdrawn report", async () => {
    env = await liveReview();
    await resolveAll(env, "alice");
    await resolveAll(env, "bob");
    await resolveAll(env, "group");
    expect(
      (await env.run(["release", env.rel, "alice", "bob", "--by", "kamal"]))
        .code,
    ).toBe(0);
    expect(
      (
        await env.run([
          "withdraw",
          env.rel,
          "bob",
          "--reason",
          "x",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect(await readSelfAssessForm(env.root, env.sessionId, "alice")).toEqual({
      kind: "closed",
    });
    expect(await readSelfAssessForm(env.root, env.sessionId, "bob")).toEqual({
      kind: "withdrawn",
    });
    // supersede: alice saw a released version, so her new draft is selfClosed
    const { supersedeReview } = await import("../../review/store.js");
    const { writeReports } = await import("../../evaluator/report-write.js");
    const { sampleEvaluation } =
      await import("../../evaluator/__tests__/fixtures.js");
    const w = await writeReports(await sampleEvaluation(), {
      outDir: env.root,
      evaluator: {
        provider: "scripted mock",
        scripted: true,
        rubricHash: "h1",
        variant: "v1",
      },
    });
    await supersedeReview(env.dir, w.dir, { by: "kamal", now: fixedClock() });
    const l2 = await loadReview(w.dir);
    expect(l2.view.subjects.get("alice")!.selfClosed).toBe(true);
    expect(
      await readSelfAssessForm(env.root, l2.view.opened.session.id, "alice"),
    ).toEqual({ kind: "closed" });
  });

  it("form: old_schema for a /1 review", async () => {
    env = await liveReview();
    const l = await loadReview(env.dir);
    const events = makeFold(l.drafts, { schema: "acr.review/1" }).log();
    await writeFile(
      path.join(env.dir, REVIEW_FILE),
      events.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
    expect(await readSelfAssessForm(env.root, env.sessionId, "alice")).toEqual({
      kind: "old_schema",
    });
  });

  it("form: none for an AI role, an unknown role and a session with no live review", async () => {
    env = await liveReview();
    expect(await readSelfAssessForm(env.root, env.sessionId, "npc1")).toEqual({
      kind: "none",
    });
    expect(await readSelfAssessForm(env.root, env.sessionId, "nobody")).toEqual(
      { kind: "none" },
    );
    expect(await readSelfAssessForm(env.root, env.sessionId, "group")).toEqual({
      kind: "none",
    });
    expect(
      await readSelfAssessForm(env.root, env.sessionId, "../alice"),
    ).toEqual({ kind: "none" });
    expect(
      await readSelfAssessForm(env.root, "no-such-session", "alice"),
    ).toEqual({ kind: "none" });
  });

  it("form: symlinked or invalid session id gives none, never a path", async () => {
    env = await liveReview();
    await symlink(env.dir, path.join(env.root, "linked-session"));
    for (const id of ["linked-session", "../x", "a/b", ""]) {
      const r = await readSelfAssessForm(env.root, id, "alice");
      expect(r).toEqual({ kind: "none" });
      expect(JSON.stringify(r)).not.toContain(env.root);
    }
  });

  it("form: a torn log gives unavailable and never throws; no result carries a path or id", async () => {
    env = await liveReview();
    const f = path.join(env.dir, REVIEW_FILE);
    await writeFile(f, (await readFile(f, "utf8")) + '{"seq":99,"ts"');
    const r = await readSelfAssessForm(env.root, env.sessionId, "alice");
    expect(r).toEqual({ kind: "unavailable" });
  });
});
