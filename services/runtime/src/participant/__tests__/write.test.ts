import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { submitResponse, submitSelfRatings, type SubmitCtx } from "../index.js";
import { loadReview } from "../../review/store.js";
import { readReview, sealEntries, withReviewLock, writeEvents } from "../../review/review-log.js";
import { makeFold, fixedClock } from "../../review/__tests__/fixtures.js";
import { REVIEW_FILE } from "../../review/types.js";
import { liveReview, type Env } from "./helpers.js";

let env: Env | undefined;
afterEach(async () => {
  if (env) await rm(env.root, { recursive: true, force: true });
  env = undefined;
});
const ctx = (e: Env, role = "alice", secrets: string[] = []): SubmitCtx => ({
  reportsDir: e.root,
  sessionId: e.sessionId,
  role,
  credentialId: "AAAAAAAAAAA",
  now: fixedClock(1_900_000_000_000),
  secrets,
});
const sv = async (e: Env, role = "alice") =>
  (await loadReview(e.dir)).view.subjects.get(role)!;
const logLen = async (e: Env) =>
  (await readFile(path.join(e.dir, REVIEW_FILE), "utf8")).length;
const crits = async (e: Env) => (await sv(e)).criteria.map((c) => c.id);
const resolveAll = async (e: Env, s: string) => {
  for (const c of (await loadReview(e.dir)).view.subjects
    .get(s)!
    .criteria.filter((x) => x.status === "needs_review"))
    await e.run(["accept", e.rel, s, c.id, "--by", "kamal"]);
};
const release = async (e: Env, ...roles: string[]) => {
  for (const r of roles) await resolveAll(e, r);
  expect(
    (await e.run(["release", e.rel, ...roles, "--by", "kamal"])).code,
  ).toBe(0);
};

describe("submitSelfRatings", () => {
  it("writes only changed ratings, in one append", async () => {
    env = await liveReview();
    const [a, b, c] = await crits(env);
    expect(
      await submitSelfRatings({
        ...ctx(env),
        ratings: [
          { criterion: a, level: 3 },
          { criterion: b, level: null },
        ],
      }),
    ).toEqual({ kind: "ok", wrote: 2 });
    const before = (await loadReview(env.dir)).events.length;
    expect(
      await submitSelfRatings({
        ...ctx(env),
        ratings: [
          { criterion: a, level: 3 },
          { criterion: b, level: 2 },
          { criterion: c, level: 1 },
        ],
      }),
    ).toEqual({ kind: "ok", wrote: 2 });
    expect((await loadReview(env.dir)).events.length).toBe(before + 2);
    const s = await sv(env);
    expect(s.criteria.find((x) => x.id === b)!.self!.level).toBe(2);
  });

  it("an unchanged resubmit writes nothing and is ok", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    const r = [{ criterion: a, level: 3 as const, note: "n" }];
    await submitSelfRatings({ ...ctx(env), ratings: r });
    const len = await logLen(env);
    expect(await submitSelfRatings({ ...ctx(env), ratings: r })).toEqual({
      kind: "ok",
      wrote: 0,
    });
    expect(await logLen(env)).toBe(len);
  });

  it("a note-only change writes", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    await submitSelfRatings({
      ...ctx(env),
      ratings: [{ criterion: a, level: 3, note: "one" }],
    });
    expect(
      await submitSelfRatings({
        ...ctx(env),
        ratings: [{ criterion: a, level: 3, note: "two" }],
      }),
    ).toEqual({ kind: "ok", wrote: 1 });
    expect((await sv(env)).criteria.find((x) => x.id === a)!.self!.note).toBe(
      "two",
    );
  });

  it("a rating without a note clears the earlier note", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    await submitSelfRatings({
      ...ctx(env),
      ratings: [{ criterion: a, level: 3, note: "one" }],
    });
    expect(
      await submitSelfRatings({
        ...ctx(env),
        ratings: [{ criterion: a, level: 3 }],
      }),
    ).toEqual({ kind: "ok", wrote: 1 });
    expect(
      (await sv(env)).criteria.find((x) => x.id === a)!.self!.note,
    ).toBeUndefined();
  });

  it("a criterion listed twice is invalid", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    const len = await logLen(env);
    expect(
      await submitSelfRatings({
        ...ctx(env),
        ratings: [
          { criterion: a, level: 3 },
          { criterion: a, level: 2 },
        ],
      }),
    ).toEqual({ kind: "invalid" });
    expect(await logLen(env)).toBe(len);
  });

  it("an unknown criterion is invalid", async () => {
    env = await liveReview();
    expect(
      await submitSelfRatings({
        ...ctx(env),
        ratings: [{ criterion: "nope", level: 3 }],
      }),
    ).toEqual({ kind: "invalid" });
  });

  it("an omitted criterion is unchanged", async () => {
    env = await liveReview();
    const [a, b] = await crits(env);
    await submitSelfRatings({
      ...ctx(env),
      ratings: [
        { criterion: a, level: 3 },
        { criterion: b, level: 4 },
      ],
    });
    await submitSelfRatings({
      ...ctx(env),
      ratings: [{ criterion: a, level: 1 }],
    });
    const s = await sv(env);
    expect(s.criteria.find((x) => x.id === b)!.self!.level).toBe(4);
  });

  it("closed after release (Review Focus 1), for selfClosed and for a withdrawn report", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    await release(env, "alice", "bob");
    await env.run([
      "withdraw",
      env.rel,
      "bob",
      "--reason",
      "x",
      "--by",
      "kamal",
    ]);
    const len = await logLen(env);
    for (const role of ["alice", "bob"])
      expect(
        await submitSelfRatings({
          ...ctx(env, role),
          ratings: [{ criterion: a, level: 3 }],
        }),
      ).toEqual({ kind: "closed" });
    expect(await logLen(env)).toBe(len);
    // a draft with selfClosed (superseded after alice saw a release)
    const { supersedeReview } = await import("../../review/store.js");
    const { sampleEvaluation } =
      await import("../../evaluator/__tests__/fixtures.js");
    const { writeReports } = await import("../../evaluator/report-write.js");
    const w = await writeReports(await sampleEvaluation({}), {
      outDir: env.root,
      evaluator: {
        provider: "scripted mock",
        scripted: true,
        rubricHash: "h1",
        variant: "v1",
      },
    });
    await supersedeReview(env.dir, w.dir, { by: "kamal", now: fixedClock() });
    expect(
      await submitSelfRatings({
        ...ctx(env),
        ratings: [{ criterion: a, level: 3 }],
      }),
    ).toEqual({ kind: "closed" });
  });

  it("a release that lands between the caller's earlier read and the lock gives closed, never unavailable", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    // the caller read the open form, then the facilitator released before the submit took the lock
    await release(env, "alice");
    expect(
      await submitSelfRatings({
        ...ctx(env),
        ratings: [{ criterion: a, level: 3 }],
      }),
    ).toEqual({ kind: "closed" });
  });

  it("a 1,501-character note is invalid", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    const len = await logLen(env);
    expect(
      await submitSelfRatings({
        ...ctx(env),
        ratings: [{ criterion: a, level: 3, note: "x".repeat(1501) }],
      }),
    ).toEqual({ kind: "invalid" });
    expect(
      await submitSelfRatings({
        ...ctx(env),
        ratings: [{ criterion: a, level: 3, note: "x".repeat(1500) }],
      }),
    ).toEqual({ kind: "ok", wrote: 1 });
    expect(await logLen(env)).toBeGreaterThan(len);
  });

  it("a note that grows past 1,500 characters when scrubbed is invalid and keeps the earlier note", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    await submitSelfRatings({
      ...ctx(env),
      ratings: [{ criterion: a, level: 3, note: "keep me" }],
    });
    const len = await logLen(env);
    const note = "abc " + "x".repeat(1495 - 4 - 4) + " abc";
    expect(note.length).toBe(1495);
    expect(
      await submitSelfRatings({
        ...ctx(env, "alice", ["abc"]),
        ratings: [{ criterion: a, level: 3, note }],
      }),
    ).toEqual({ kind: "invalid" });
    expect(await logLen(env)).toBe(len);
    expect((await sv(env)).criteria.find((x) => x.id === a)!.self!.note).toBe(
      "keep me",
    );
  });

  it("an empty or all-hidden note is absent and the rating is still written", async () => {
    env = await liveReview();
    const [a, b] = await crits(env);
    expect(
      await submitSelfRatings({
        ...ctx(env),
        ratings: [
          { criterion: a, level: 3, note: "   " },
          { criterion: b, level: 2, note: "​‮" },
        ],
      }),
    ).toEqual({ kind: "ok", wrote: 2 });
    const s = await sv(env);
    expect(s.criteria.find((x) => x.id === a)!.self!.note).toBeUndefined();
    expect(s.criteria.find((x) => x.id === b)!.self!.note).toBeUndefined();
  });

  it("too_many when the role would pass 10 x criteria self.rated events", async () => {
    env = await liveReview();
    const ids = await crits(env);
    const cap = 10 * ids.length;
    // alternate the level on one criterion; each submit is one self.rated event
    for (let i = 0; i < cap; i++)
      expect(
        await submitSelfRatings({
          ...ctx(env),
          ratings: [{ criterion: ids[0], level: i % 2 === 0 ? 1 : 2 }],
        }),
      ).toEqual({ kind: "ok", wrote: 1 });
    const len = await logLen(env);
    expect(
      await submitSelfRatings({
        ...ctx(env),
        ratings: [{ criterion: ids[0], level: 4 }],
      }),
    ).toEqual({ kind: "too_many" });
    expect(await logLen(env)).toBe(len);
  });

  it("an unchanged resubmit is ok with wrote 0 even when CLI-attested writes already pushed the role past the cap", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    expect(
      await submitSelfRatings({ ...ctx(env), ratings: [{ criterion: a, level: 2 }] }),
    ).toEqual({ kind: "ok", wrote: 1 });
    const cap = 10 * (await crits(env)).length;
    const { events, tailHash } = await readReview(env.dir);
    const rated = events.find((e) => e.type === "self.rated")!;
    // cap more identical events (as the CLI would write them): the role now has cap + 1.
    const entries = Array.from({ length: cap }, () => ({ actor: rated.actor, body: rated }));
    await writeEvents(env.dir, sealEntries(events, tailHash, entries, fixedClock(1_900_000_001_000)));
    const len = await logLen(env);
    expect(
      await submitSelfRatings({ ...ctx(env), ratings: [{ criterion: a, level: 2 }] }),
    ).toEqual({ kind: "ok", wrote: 0 });
    expect(await logLen(env)).toBe(len);
    // A real change is still refused over the cap.
    expect(
      await submitSelfRatings({ ...ctx(env), ratings: [{ criterion: a, level: 4 }] }),
    ).toEqual({ kind: "too_many" });
  });

  it("old_schema in a /1 review", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    const l = await loadReview(env.dir);
    const events = makeFold(l.drafts, { schema: "acr.review/1" }).log();
    await writeFile(
      path.join(env.dir, REVIEW_FILE),
      events.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
    const len = await logLen(env);
    expect(
      await submitSelfRatings({
        ...ctx(env),
        ratings: [{ criterion: a, level: 3 }],
      }),
    ).toEqual({ kind: "old_schema" });
    expect(await logLen(env)).toBe(len);
  });

  it("busy when review.lock is held (and nothing written)", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    const len = await logLen(env);
    const r = await withReviewLock(env.dir, () =>
      submitSelfRatings({
        ...ctx(env!),
        ratings: [{ criterion: a, level: 3 }],
      }),
    );
    expect(r).toEqual({ kind: "busy" });
    expect(await logLen(env)).toBe(len);
  });

  it("none for an unknown role, an AI role and a missing review", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    for (const role of ["nobody", "npc1", "group", "../x"])
      expect(
        await submitSelfRatings({
          ...ctx(env, role),
          ratings: [{ criterion: a, level: 3 }],
        }),
      ).toEqual({ kind: "none" });
    expect(
      await submitSelfRatings({
        ...ctx(env),
        sessionId: "no-such-session",
        ratings: [{ criterion: a, level: 3 }],
      }),
    ).toEqual({ kind: "none" });
  });

  it("events carry actor participant_session v:1 with the given role and credentialId", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    await submitSelfRatings({
      ...ctx(env),
      ratings: [{ criterion: a, level: 3 }],
    });
    const ev = (await loadReview(env.dir)).events.at(-1) as any;
    expect(ev.type).toBe("self.rated");
    expect(ev.actor).toEqual({
      kind: "participant_session",
      v: 1,
      role: "alice",
      credentialId: "AAAAAAAAAAA",
    });
  });

  it("secrets and hidden characters are scrubbed from notes", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    await submitSelfRatings({
      ...ctx(env, "alice", ["hunter2-secret"]),
      ratings: [{ criterion: a, level: 3, note: "pw hunter2-secret ok​‮" }],
    });
    const note = (await sv(env)).criteria.find((x) => x.id === a)!.self!.note!;
    expect(note).not.toContain("hunter2-secret");
    expect(note).not.toMatch(/[​‮]/);
  });
});

describe("submitResponse", () => {
  it("writes one response with the dispute flag", async () => {
    env = await liveReview();
    const [a] = await crits(env);
    await release(env, "alice");
    expect(
      await submitResponse({
        ...ctx(env),
        criterion: a,
        text: "I disagree",
        dispute: true,
      }),
    ).toEqual({ kind: "ok", wrote: true });
    const r = (await sv(env)).responses.at(-1)!;
    expect(r).toMatchObject({
      role: "alice",
      criterion: a,
      text: "I disagree",
      dispute: true,
    });
    const ev = (await loadReview(env.dir)).events.at(-1) as any;
    expect(ev.actor).toEqual({
      kind: "participant_session",
      v: 1,
      role: "alice",
      credentialId: "AAAAAAAAAAA",
    });
  });

  it("refused before release (not_released) and when withdrawn", async () => {
    env = await liveReview();
    const len = await logLen(env);
    expect(await submitResponse({ ...ctx(env), text: "hi" })).toEqual({
      kind: "not_released",
    });
    expect(await logLen(env)).toBe(len);
    await release(env, "alice", "bob");
    await env.run([
      "withdraw",
      env.rel,
      "bob",
      "--reason",
      "x",
      "--by",
      "kamal",
    ]);
    expect(await submitResponse({ ...ctx(env, "bob"), text: "hi" })).toEqual({
      kind: "withdrawn",
    });
  });

  it("allowed while amending", async () => {
    env = await liveReview();
    await release(env, "alice");
    expect(
      (
        await env.run([
          "amend",
          env.rel,
          "alice",
          "--reason",
          "x",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect((await sv(env)).state).toBe("amending");
    expect(await submitResponse({ ...ctx(env), text: "hi" })).toEqual({
      kind: "ok",
      wrote: true,
    });
  });

  it("the 51st is too_many", async () => {
    env = await liveReview();
    await release(env, "alice");
    for (let i = 0; i < 50; i++)
      expect(await submitResponse({ ...ctx(env), text: `r${i}` })).toEqual({
        kind: "ok",
        wrote: true,
      });
    expect(await submitResponse({ ...ctx(env), text: "r51" })).toEqual({
      kind: "too_many",
    });
    expect((await sv(env)).responses.length).toBe(50);
  });

  it("an unknown criterion is invalid", async () => {
    env = await liveReview();
    await release(env, "alice");
    expect(
      await submitResponse({ ...ctx(env), criterion: "nope", text: "hi" }),
    ).toEqual({ kind: "invalid" });
  });

  it("an identical second submit after the first returns ok and writes nothing (Review Focus 2, the sequential half; the concurrent half is tested in Task 7 through control's retry)", async () => {
    env = await liveReview();
    await release(env, "alice");
    await submitResponse({ ...ctx(env), text: "same" });
    const len = await logLen(env);
    expect(await submitResponse({ ...ctx(env), text: "same" })).toEqual({
      kind: "ok",
      wrote: false,
    });
    expect(await logLen(env)).toBe(len);
  });

  it("a duplicate compares the cleaned text", async () => {
    env = await liveReview();
    await release(env, "alice");
    await submitResponse({ ...ctx(env), text: "same" });
    expect(await submitResponse({ ...ctx(env), text: "  same​ \r\n" })).toEqual(
      { kind: "ok", wrote: false },
    );
    expect((await sv(env)).responses.length).toBe(1);
  });

  it("only the most recent response counts for a duplicate", async () => {
    env = await liveReview();
    await release(env, "alice");
    await submitResponse({ ...ctx(env), text: "a" });
    await submitResponse({ ...ctx(env), text: "b" });
    expect(await submitResponse({ ...ctx(env), text: "a" })).toEqual({
      kind: "ok",
      wrote: true,
    });
  });

  it("empty text and text over 1,500 characters are invalid, not unavailable", async () => {
    env = await liveReview();
    await release(env, "alice");
    expect(await submitResponse({ ...ctx(env), text: "  ​ " })).toEqual({
      kind: "invalid",
    });
    expect(
      await submitResponse({ ...ctx(env), text: "x".repeat(1501) }),
    ).toEqual({ kind: "invalid" });
    expect(
      await submitResponse({ ...ctx(env), text: "x".repeat(1500) }),
    ).toEqual({ kind: "ok", wrote: true });
  });

  it("a different dispute flag is not a duplicate", async () => {
    env = await liveReview();
    await release(env, "alice");
    await submitResponse({ ...ctx(env), text: "same" });
    expect(
      await submitResponse({ ...ctx(env), text: "same", dispute: true }),
    ).toEqual({ kind: "ok", wrote: true });
  });

  it("busy and old_schema as above", async () => {
    env = await liveReview();
    await release(env, "alice");
    const len = await logLen(env);
    expect(
      await withReviewLock(env.dir, () =>
        submitResponse({ ...ctx(env!), text: "hi" }),
      ),
    ).toEqual({ kind: "busy" });
    expect(await logLen(env)).toBe(len);
    const l = await loadReview(env.dir);
    const events = makeFold(l.drafts, { schema: "acr.review/1" }).log();
    await writeFile(
      path.join(env.dir, REVIEW_FILE),
      events.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
    expect(await submitResponse({ ...ctx(env), text: "hi" })).toEqual({
      kind: "old_schema",
    });
  });

  it("none for an unknown role or a missing review", async () => {
    env = await liveReview();
    expect(await submitResponse({ ...ctx(env, "nobody"), text: "hi" })).toEqual(
      {
        kind: "none",
      },
    );
    expect(
      await submitResponse({ ...ctx(env), sessionId: "nope", text: "hi" }),
    ).toEqual({ kind: "none" });
  });
});
