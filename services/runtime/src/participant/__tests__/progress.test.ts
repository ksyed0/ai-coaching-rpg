import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { listDraftPlayerRoles, selfRatingProgress } from "../index.js";
import { loadReview } from "../../review/store.js";
import { withReviewLock } from "../../review/review-log.js";
import { REVIEW_FILE } from "../../review/types.js";
import { liveReview, type Env } from "./helpers.js";

let env: Env | undefined;
afterEach(async () => {
  if (env) await rm(env.root, { recursive: true, force: true });
  env = undefined;
});
const rate = (e: Env, role: string, spec: string) =>
  e.run([
    "self-assess",
    e.rel,
    "--role",
    role,
    "--rate",
    spec,
    "--by",
    "kamal",
  ]);

describe("selfRatingProgress", () => {
  it("progress: counts rated criteria out of total per draft human role, omits released roles and AI roles", async () => {
    env = await liveReview();
    const l = await loadReview(env.dir);
    const aliceTotal = l.view.subjects.get("alice")!.criteria.length;
    const bobTotal = l.view.subjects.get("bob")!.criteria.length;
    await rate(env, "alice", "listening=3");
    await rate(env, "alice", "discovery=na");
    await rate(env, "alice", "listening=2"); // a re-rate is still one rated criterion
    expect(await selfRatingProgress(env.root, env.sessionId)).toEqual({
      kind: "ok",
      rows: [
        { role: "alice", rated: 2, total: aliceTotal },
        { role: "bob", rated: 0, total: bobTotal },
      ],
    });
    // release alice: she drops out; npc1 (an AI role) and the group never appear
    for (const s of ["alice", "bob", "group"])
      for (const c of (await loadReview(env.dir)).view.subjects
        .get(s)!
        .criteria.filter((x) => x.status === "needs_review"))
        await env.run(["accept", env.rel, s, c.id, "--by", "kamal"]);
    expect(
      (await env.run(["release", env.rel, "alice", "--by", "kamal"])).code,
    ).toBe(0);
    expect(await selfRatingProgress(env.root, env.sessionId)).toEqual({
      kind: "ok",
      rows: [{ role: "bob", rated: 0, total: bobTotal }],
    });
  });

  it("progress: a torn last log line gives unavailable and never throws", async () => {
    env = await liveReview();
    const f = path.join(env.dir, REVIEW_FILE);
    await writeFile(f, (await readFile(f, "utf8")) + '{"seq":99,"ts"');
    expect(await selfRatingProgress(env.root, env.sessionId)).toEqual({
      kind: "unavailable",
    });
  });

  it("progress: none for a session with no live review or an invalid id", async () => {
    env = await liveReview();
    expect(await selfRatingProgress(env.root, "no-such-session")).toEqual({
      kind: "none",
    });
    expect(await selfRatingProgress(env.root, "../x")).toEqual({
      kind: "none",
    });
  });

  it("progress: takes no lock", async () => {
    env = await liveReview();
    await rate(env, "alice", "listening=3");
    await withReviewLock(env.dir, async () => {
      const r = await selfRatingProgress(env!.root, env!.sessionId);
      expect(r.kind).toBe("ok");
    });
  });
});

describe("listDraftPlayerRoles", () => {
  it("lists the draft human roles, sorted, and null when nothing resolves", async () => {
    env = await liveReview();
    expect(await listDraftPlayerRoles(env.root, env.sessionId)).toEqual(["alice", "bob"]);
    expect(await listDraftPlayerRoles(env.root, "other-session")).toBeNull();
  });
});
