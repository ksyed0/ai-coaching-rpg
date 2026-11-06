import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { loadReview } from "../store.js";
import { makeDraftDir, makeRunner } from "./fixtures.js";

let root: string, dir: string, run: ReturnType<typeof makeRunner>, rel: string;
const NOTE = "see [n](http://evil.example/n) and ![n-img](http://evil.example/n.png) and [n-ref][nref]";
const RESP = "see [r](http://evil.example/r) and ![r-img](http://evil.example/r.png) and [r-ref][rref]";
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  run = makeRunner(root);
  rel = path.relative(root, dir);
  await run(["open", rel, "--by", "kamal"]);
  for (const s of ["alice", "bob", "group"])
    for (const c of (await loadReview(dir)).view.subjects
      .get(s)!
      .criteria.filter((x) => x.status === "needs_review"))
      await run(["accept", rel, s, c.id, "--by", "kamal"]);
  expect(
    (
      await run([
        "self-assess", rel, "--role", "alice", "--rate", "listening=3",
        "--note", NOTE, "--by", "kamal",
      ])
    ).code,
  ).toBe(0);
  expect((await run(["release", rel, "--all", "--by", "kamal"])).code).toBe(0);
  expect(
    (
      await run([
        "respond", rel, "--role", "alice", "--criterion", "listening",
        "--text", RESP, "--by", "kamal",
      ])
    ).code,
  ).toBe(0);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const exportAlice = async (to: string) => {
  expect(
    (
      await run([
        "export", rel, "alice", "--for", "participant:alice", "--to", to, "--by", "kamal",
      ])
    ).code,
  ).toBe(0);
  return readFile(path.join(root, to, "alice.md"), "utf8");
};

describe("export of participant text", () => {
  it("export neutralises [x](url), ![x](url) and [x][ref] in notes and responses", async () => {
    const md = await exportAlice("o/a");
    expect(md).toContain("n-img");
    expect(md).toContain("r-img");
    // no live link syntax survives: every bracket is escaped, so no unescaped `[..](` / `![..](` / `[..][..]`
    expect(md).not.toMatch(/(^|[^\\])\[[^\]]*\]\(/);
    expect(md).not.toMatch(/(^|[^\\])\[[^\]]*\]\[/);
    expect(md).not.toMatch(/(^|[^\\])!\[/);
    expect(md).not.toMatch(/(^|[^\\])\[n/);
    expect(md).not.toMatch(/(^|[^\\])\[r/);
    expect(md).toContain("\\[n\\]");
    expect(md).toContain("\\[r\\]");
    // a URL is broken so an auto-linker will not link it
    expect(md).not.toContain("http://evil.example");
  });
  it("no double escaping on a second render", async () => {
    const a = await exportAlice("o/a");
    const b = await exportAlice("o/b");
    expect(b).toBe(a);
    expect(b).not.toContain("\\\\[");
    expect(b).not.toContain("\\\\!");
  });
});
