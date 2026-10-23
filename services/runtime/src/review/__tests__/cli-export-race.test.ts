import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

// The destination appears (with someone else's file in it) between the preflight and the exclusive mkdir.
vi.mock("node:fs/promises", async (orig) => {
  const m = await orig<typeof import("node:fs/promises")>();
  return {
    ...m,
    mkdir: async (p: string, o?: { recursive?: boolean }) => {
      if (String(p).endsWith("racedest") && !o?.recursive) {
        await m.mkdir(p, { recursive: true });
        await m.writeFile(path.join(String(p), "theirs.txt"), "theirs");
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      return m.mkdir(p, o as never);
    },
  };
});
const { loadReview } = await import("../store.js");
const { makeDraftDir, makeRunner } = await import("./fixtures.js");

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("EEXIST on the destination: exit 2, the event is recorded, the other party's directory and file are untouched", async () => {
  const run = makeRunner(root);
  const rel = path.relative(root, dir);
  await run(["open", rel, "--by", "kamal"]);
  const l = await loadReview(dir);
  for (const c of l.view.subjects
    .get("alice")!
    .criteria.filter((x) => x.status === "needs_review"))
    await run(["accept", rel, "alice", c.id, "--by", "kamal"]);
  await run(["accept", rel, "alice", "--summary", "--by", "kamal"]);
  expect((await run(["release", rel, "alice", "--by", "kamal"])).code).toBe(0);
  const r = await run([
    "export",
    rel,
    "alice",
    "--for",
    "facilitator",
    "--to",
    "racedest",
    "--by",
    "kamal",
  ]);
  expect(r.code).toBe(2);
  expect(r.err).toMatch(/no files were produced/);
  expect(await readdir(path.join(root, "racedest"))).toEqual(["theirs.txt"]);
  expect(await readFile(path.join(root, "racedest/theirs.txt"), "utf8")).toBe(
    "theirs",
  );
  expect(
    (await loadReview(dir)).events.filter((e) => e.type === "report.exported"),
  ).toHaveLength(1);
});
