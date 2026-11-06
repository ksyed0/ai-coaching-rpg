import { afterEach, describe, expect, it } from "vitest";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { ReviewRefusedError, ReviewUsageError } from "../../review/errors.js";
import { loadReview } from "../../review/store.js";
import { REVIEW_FILE } from "../../review/types.js";
import {
  acceptCriterion,
  acceptSummary,
  amendSubject,
  commentOn,
  exportReport,
  releaseSubjects,
  resolveDispute,
  toModResult,
  withdrawSubject,
} from "../index.js";
import { openedReview, type Env } from "./helpers.js";

let env: Env | undefined;
afterEach(async () => {
  if (env) await rm(env.root, { recursive: true, force: true });
  env = undefined;
});
const base = (e: Env, secrets: string[] = []) => ({
  dir: e.dir,
  by: "priya-console",
  now: e.now,
  secrets,
});
const bytes = (e: Env) => readFile(path.join(e.dir, REVIEW_FILE));
const events = async (e: Env) => (await loadReview(e.dir)).events;
const fail = (p: Promise<unknown>) => p.then(() => null).catch((x) => x);

/** Accepts every open criterion and a stale summary of a subject, through the module. */
async function ready(e: Env, subject: string): Promise<void> {
  const sv = (await loadReview(e.dir)).view.subjects.get(subject)!;
  for (const c of sv.criteria.filter((x) => x.status === "needs_review"))
    await acceptCriterion({ ...base(e), subject, criterion: c.id });
  if ((await loadReview(e.dir)).view.subjects.get(subject)!.summaryStale)
    await acceptSummary({ ...base(e), subject });
}

describe("moderation writes, part B: release", () => {
  it("releaseSubjects with an empty list is a ReviewUsageError and writes nothing", async () => {
    env = await openedReview();
    const before = await bytes(env);
    const e = await fail(releaseSubjects({ ...base(env), subjects: [] }));
    expect(e).toBeInstanceOf(ReviewUsageError);
    expect(
      await toModResult(() => releaseSubjects({ ...base(env!), subjects: [] })),
    ).toEqual({
      ok: false,
      code: "invalid",
    });
    expect(await bytes(env)).toEqual(before);
  });

  it("with an open criterion it throws code blocked with that subject id and the log bytes are unchanged", async () => {
    env = await openedReview();
    await ready(env, "bob");
    const before = await bytes(env);
    const e = await fail(
      releaseSubjects({ ...base(env), subjects: ["alice", "bob"] }),
    );
    expect(e).toBeInstanceOf(ReviewRefusedError);
    expect((e as ReviewRefusedError).code).toBe("blocked");
    expect((e as ReviewRefusedError).detail).toEqual(["alice"]);
    expect((e as Error).message).toMatch(/^nothing was released:\n {2}alice: /);
    expect(
      await toModResult(() =>
        releaseSubjects({ ...base(env!), subjects: ["alice", "bob"] }),
      ),
    ).toEqual({ ok: false, code: "blocked", detail: ["alice"] });
    expect(await bytes(env)).toEqual(before);
  });

  it("an unknown subject throws unknown_subject and an already released one not_editable", async () => {
    env = await openedReview();
    await ready(env, "bob");
    await releaseSubjects({ ...base(env), subjects: ["bob"] });
    const before = await bytes(env);
    const u = await fail(
      releaseSubjects({ ...base(env), subjects: ["nobody", "alice"] }),
    );
    expect((u as ReviewRefusedError).code).toBe("unknown_subject");
    expect((u as ReviewRefusedError).detail).toBeUndefined();
    const n = await fail(releaseSubjects({ ...base(env), subjects: ["bob"] }));
    expect((n as ReviewRefusedError).code).toBe("not_editable");
    expect((n as Error).message).toContain("bob: is released");
    expect(await bytes(env)).toEqual(before);
  });

  it("releases two subjects atomically and reports groupTableStale", async () => {
    env = await openedReview();
    for (const s of ["alice", "bob", "group"]) await ready(env, s);
    expect(
      await releaseSubjects({ ...base(env), subjects: ["group"] }),
    ).toEqual({ released: ["group"], groupTableStale: false });
    // players released after the group: the group's frozen table is now out of date
    const n = (await events(env)).length;
    const r = await releaseSubjects({
      ...base(env),
      subjects: ["alice", "bob", "alice"],
    });
    expect(r).toEqual({ released: ["alice", "bob"], groupTableStale: true });
    const ev = await events(env);
    expect(ev.length).toBe(n + 1);
    expect(ev.at(-1)).toMatchObject({
      type: "report.released",
      subjects: ["alice", "bob"],
      actor: { kind: "facilitator", by: "priya-console" },
    });
  });
});

describe("moderation writes, part B: amend, withdraw, resolve", () => {
  it("withdraw and amend require a reason", async () => {
    env = await openedReview();
    await ready(env, "alice");
    await releaseSubjects({ ...base(env), subjects: ["alice"] });
    const before = await bytes(env);
    for (const op of [amendSubject, withdrawSubject])
      for (const reason of ["", "   "])
        expect(
          await fail(op({ ...base(env), subject: "alice", reason })),
        ).toBeInstanceOf(ReviewUsageError);
    expect(await bytes(env)).toEqual(before);
    await amendSubject({ ...base(env), subject: "alice", reason: "fix it" });
    expect((await events(env)).at(-1)).toMatchObject({
      type: "report.amended",
      subject: "alice",
      reason: "fix it",
    });
    await releaseSubjects({ ...base(env), subjects: ["alice"] });
    expect(
      await withdrawSubject({ ...base(env), subject: "alice", reason: "gone" }),
    ).toEqual({ groupTableStale: false });
    expect((await events(env)).at(-1)).toMatchObject({
      type: "report.withdrawn",
      subject: "alice",
      reason: "gone",
    });
    // a draft cannot be amended or withdrawn; an unknown subject has its own code
    const d = await fail(
      amendSubject({ ...base(env), subject: "bob", reason: "x" }),
    );
    expect((d as ReviewRefusedError).code).toBe("not_editable");
    const w = await fail(
      withdrawSubject({ ...base(env), subject: "bob", reason: "x" }),
    );
    expect((w as ReviewRefusedError).code).toBe("not_editable");
    const u = await fail(
      withdrawSubject({ ...base(env), subject: "nobody", reason: "x" }),
    );
    expect((u as ReviewRefusedError).code).toBe("unknown_subject");
  });

  it("withdrawing a player after the group was released reports groupTableStale", async () => {
    env = await openedReview();
    for (const s of ["alice", "group"]) await ready(env, s);
    await releaseSubjects({ ...base(env), subjects: ["alice", "group"] });
    expect(
      await withdrawSubject({ ...base(env), subject: "alice", reason: "gone" }),
    ).toEqual({ groupTableStale: true });
  });

  it("resolveDispute amended before an amend throws needs_amend", async () => {
    env = await openedReview();
    await ready(env, "alice");
    await releaseSubjects({ ...base(env), subjects: ["alice"] });
    const r = await env.run([
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
    expect(r.code).toBe(0);
    const seq = (await events(env)).at(-1)!.seq;
    const before = await bytes(env);
    const e = await fail(
      resolveDispute({
        ...base(env),
        seq,
        outcome: "amended",
        reason: "changed",
      }),
    );
    expect((e as ReviewRefusedError).code).toBe("needs_amend");
    expect((e as Error).message).toContain("run amend");
    expect(await bytes(env)).toEqual(before);
    await resolveDispute({
      ...base(env),
      seq,
      outcome: "declined",
      reason: "the evidence stands",
    });
    expect((await events(env)).at(-1)).toMatchObject({
      type: "dispute.resolved",
      response: seq,
      outcome: "declined",
      reason: "the evidence stands",
    });
  });
});

describe("moderation writes, part B: export", () => {
  it("exportReport of a draft subject throws not_released and appends no event", async () => {
    env = await openedReview();
    const before = await bytes(env);
    const e = await fail(
      exportReport({ ...base(env), subject: "alice", audience: "facilitator" }),
    );
    expect((e as ReviewRefusedError).code).toBe("not_released");
    const p = await fail(
      exportReport({
        ...base(env),
        subject: "alice",
        audience: "participant:alice",
      }),
    );
    expect((p as ReviewRefusedError).code).toBe("not_released");
    expect(await bytes(env)).toEqual(before);
  });

  it("of an amending subject for the facilitator is refused", async () => {
    env = await openedReview();
    await ready(env, "alice");
    await releaseSubjects({ ...base(env), subjects: ["alice"] });
    await amendSubject({ ...base(env), subject: "alice", reason: "fix" });
    const before = await bytes(env);
    const e = await fail(
      exportReport({ ...base(env), subject: "alice", audience: "facilitator" }),
    );
    expect(e).toBeInstanceOf(ReviewRefusedError);
    expect((e as ReviewRefusedError).code).toBe("not_released");
    expect(await bytes(env)).toEqual(before);
  });

  it("for participant:<other role> on a personal report is refused", async () => {
    env = await openedReview();
    await ready(env, "alice");
    await releaseSubjects({ ...base(env), subjects: ["alice"] });
    const before = await bytes(env);
    const e = await fail(
      exportReport({
        ...base(env),
        subject: "alice",
        audience: "participant:bob",
      }),
    );
    expect(e).toBeInstanceOf(ReviewRefusedError);
    expect(
      await toModResult(() =>
        exportReport({
          ...base(env!),
          subject: "alice",
          audience: "participant:bob",
        }),
      ),
    ).toEqual({ ok: false, code: "refused" });
    // an unsafe subject or an unknown audience is a usage error
    expect(
      await fail(
        exportReport({
          ...base(env),
          subject: "../x",
          audience: "facilitator",
        }),
      ),
    ).toBeInstanceOf(ReviewUsageError);
    expect(
      await fail(
        exportReport({
          ...base(env),
          subject: "alice",
          audience: "hr" as "facilitator",
        }),
      ),
    ).toBeInstanceOf(ReviewUsageError);
    expect(await bytes(env)).toEqual(before);
  });

  it("appends exactly one export event with destination console-download, then returns the audience's Markdown with no facilitator-only text for a participant audience", async () => {
    env = await openedReview();
    await ready(env, "alice");
    await ready(env, "group");
    await commentOn({
      ...base(env),
      subject: "alice",
      text: "INTERNAL-NOTE-ONLY-FOR-FACILITATOR",
    });
    await releaseSubjects({ ...base(env), subjects: ["alice", "group"] });
    const n = (await events(env)).length;
    const p = await exportReport({
      ...base(env),
      subject: "alice",
      audience: "participant:alice",
    });
    expect(p.fileName).toBe("report-alice.md");
    expect(p.markdown).not.toContain("INTERNAL-NOTE-ONLY-FOR-FACILITATOR");
    expect(p.markdown).toContain("Visibility: you and the facilitator");
    expect(p.markdown.endsWith("\n")).toBe(true);
    const ev = await events(env);
    expect(ev.length).toBe(n + 1);
    const last = ev.at(-1)!;
    expect(last).toMatchObject({
      type: "report.exported",
      subject: "alice",
      principal: "participant:alice",
      destination: "console-download",
      actor: { kind: "facilitator", by: "priya-console" },
    });
    const version = (await loadReview(env.dir)).view.subjects
      .get("alice")!
      .versions.at(-1);
    expect(last).toMatchObject({ version });
    const f = await exportReport({
      ...base(env),
      subject: "alice",
      audience: "facilitator",
    });
    expect(f.markdown).toContain("INTERNAL-NOTE-ONLY-FOR-FACILITATOR");
    const i = await exportReport({
      ...base(env),
      subject: "index",
      audience: "facilitator",
    });
    expect(i.fileName).toBe("report-index.md");
    expect((await events(env)).at(-1)).toMatchObject({
      type: "report.exported",
      subject: "group",
      destination: "console-download",
    });
  });

  it("the reports directory listing is unchanged apart from review.jsonl", async () => {
    env = await openedReview();
    await ready(env, "alice");
    await releaseSubjects({ ...base(env), subjects: ["alice"] });
    const list = async () => ({
      dir: (await readdir(env!.dir)).sort(),
      root: (await readdir(env!.root)).sort(),
    });
    const before = await list();
    const logBefore = await bytes(env);
    await exportReport({
      ...base(env),
      subject: "alice",
      audience: "facilitator",
    });
    expect(await list()).toEqual(before);
    expect(before.dir).toContain(REVIEW_FILE);
    expect((await bytes(env)).equals(logBefore)).toBe(false);
  });
});
