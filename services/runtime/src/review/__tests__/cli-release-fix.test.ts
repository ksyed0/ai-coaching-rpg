import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadReview } from "../store.js";
import { viewReport } from "../view.js";
import { makeDraftDir, makeRunner } from "./fixtures.js";

let root: string, dir: string, run: ReturnType<typeof makeRunner>, rel: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  run = makeRunner(root);
  rel = path.relative(root, dir);
  await run(["open", rel, "--by", "kamal"]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function resolveAll(subject: string) {
  const l = await loadReview(dir);
  for (const c of l.view.subjects
    .get(subject)!
    .criteria.filter((x) => x.status === "needs_review"))
    await run(["accept", rel, subject, c.id, "--by", "kamal"]);
  if ((await loadReview(dir)).view.subjects.get(subject)!.summaryStale)
    await run(["accept", rel, subject, "--summary", "--by", "kamal"]);
}
const release = (...s: string[]) =>
  run(["release", rel, ...s, "--by", "kamal"]);
const exp = (subject: string, to: string, env: NodeJS.ProcessEnv = {}) =>
  run(
    [
      "export",
      rel,
      subject,
      "--for",
      "facilitator",
      "--to",
      to,
      "--by",
      "kamal",
    ],
    env,
  );
const read = (p: string) => readFile(path.join(root, p), "utf8");

describe("exported banner and version", () => {
  it("carries the release version in both files and never says not released", async () => {
    await resolveAll("alice");
    await release("alice");
    const v = (await loadReview(dir)).view.subjects.get("alice")!.versions[0]!;
    expect((await exp("alice", "out/a")).code).toBe(0);
    for (const f of ["out/a/alice.md", "out/a/alice.json"]) {
      const t = await read(f);
      expect(t).toContain(`version ${v}`);
      expect(t).not.toMatch(/not released|IN REVIEW/);
    }
  });
});

describe("comments are frozen at release", () => {
  it("exports comments made before the release and not those made after (internal or feedback)", async () => {
    await resolveAll("alice");
    await run([
      "comment",
      rel,
      "alice",
      "--text",
      "BEFORE-INTERNAL",
      "--by",
      "kamal",
    ]);
    await run([
      "comment",
      rel,
      "alice",
      "--text",
      "BEFORE-FEEDBACK",
      "--feedback",
      "--by",
      "kamal",
    ]);
    await release("alice");
    await run([
      "comment",
      rel,
      "alice",
      "--text",
      "AFTER-INTERNAL",
      "--by",
      "kamal",
    ]);
    await run([
      "comment",
      rel,
      "alice",
      "--text",
      "AFTER-FEEDBACK",
      "--feedback",
      "--by",
      "kamal",
    ]);
    expect((await exp("alice", "out/c")).code).toBe(0);
    for (const f of ["out/c/alice.md", "out/c/alice.json"]) {
      const t = await read(f);
      expect(t).toContain("BEFORE-INTERNAL");
      expect(t).toContain("BEFORE-FEEDBACK");
      expect(t).not.toContain("AFTER-");
    }
  });
});

describe("per-role table out of date is surfaced", () => {
  it("shows in status, show group, the group export and the release and withdraw output", async () => {
    await resolveAll("group");
    await resolveAll("alice");
    await resolveAll("bob");
    expect((await release("group")).out).not.toMatch(/out of date/);
    const r = await release("alice");
    expect(r.out).toMatch(/per-role table is now out of date/);
    expect((await run(["status", rel])).out).toMatch(
      /group: released.*per-role table out of date \(amend and re-release the group\)/,
    );
    expect((await run(["show", rel, "group"])).out).toMatch(
      /Per-role table out of date/,
    );
    expect((await exp("group", "out/g")).code).toBe(0);
    expect(await read("out/g/group.md")).toMatch(/Per-role table out of date/);
    expect(await read("out/g/group.json")).toMatch(
      /Per-role table out of date/,
    );
    // already stale: no repeated hint; a withdrawal of a stale-free state does hint
    expect((await release("bob")).out).not.toMatch(/out of date/);
    await run(["amend", rel, "group", "--reason", "refresh", "--by", "kamal"]);
    expect((await release("group")).code).toBe(0);
    expect((await run(["status", rel])).out).not.toMatch(/table out of date/);
    const w = await run([
      "withdraw",
      rel,
      "bob",
      "--reason",
      "wrong",
      "--by",
      "kamal",
    ]);
    expect(w.out).toMatch(/per-role table is now out of date/);
  });
});

describe("group export is frozen", () => {
  it("keeps the released per-role values after a player is amended and edited", async () => {
    for (const s of ["alice", "bob", "group"]) await resolveAll(s);
    expect((await release("alice", "bob", "group")).code).toBe(0);
    expect((await exp("group", "out/g1")).code).toBe(0);
    const before = JSON.parse(await read("out/g1/group.json"));
    await run(["amend", rel, "alice", "--reason", "r", "--by", "kamal"]);
    const l0 = await loadReview(dir);
    for (const c of l0.view.subjects.get("alice")!.criteria) {
      await run([
        "edit",
        rel,
        "alice",
        c.id,
        "--level",
        c.current === 1 ? "4" : "1",
        "--reason",
        "r",
        "--by",
        "kamal",
      ]);
    }
    const l = await loadReview(dir);
    const live = viewReport(
      l.drafts.subjects.get("group")!.raw as never,
      l.view,
      "group",
      { audience: "facilitator" },
    ) as { lo_coverage: unknown };
    expect(JSON.stringify(live.lo_coverage)).not.toBe(
      JSON.stringify(before.lo_coverage),
    ); // the test would be vacuous otherwise
    expect((await exp("group", "out/g2")).code).toBe(0);
    const after = JSON.parse(await read("out/g2/group.json"));
    expect(after.lo_coverage).toEqual(before.lo_coverage);
  });
});

describe("export directory handling", () => {
  beforeEach(async () => {
    await resolveAll("alice");
    await release("alice");
  });
  it("exports into an existing directory and never touches what is already there", async () => {
    const out = path.join(root, "out/keep");
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "keep.txt"), "mine");
    expect((await exp("alice", "out/keep")).code).toBe(0);
    expect(await readFile(path.join(out, "keep.txt"), "utf8")).toBe("mine");
  });
  it.skipIf(process.getuid?.() === 0)(
    "a failed write into an existing directory deletes none of its content",
    async () => {
      const out = path.join(root, "out/ro");
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, "keep.txt"), "mine");
      const { chmod } = await import("node:fs/promises");
      await chmod(out, 0o500);
      const r = await exp("alice", "out/ro");
      await chmod(out, 0o700);
      expect(r.code).toBe(2);
      expect(await readdir(out)).toEqual(["keep.txt"]);
    },
  );
  it("redacts secret values in the exported JSON like the Markdown", async () => {
    const plain = await exp("alice", "out/p");
    expect(plain.code).toBe(0);
    expect(await read("out/p/alice.json")).toContain("scripted mock");
    expect(
      (await exp("alice", "out/s", { MY_API_KEY: "scripted mock" })).code,
    ).toBe(0);
    expect(await read("out/s/alice.json")).not.toContain("scripted mock");
    expect(await read("out/s/alice.md")).not.toContain("scripted mock");
  });
});

describe("release refusal list", () => {
  it("is not silently cut: every subject is named or the count of the rest is given", async () => {
    const r = await release("alice", "bob", "group");
    expect(r.code).toBe(1);
    const all = ["alice", "bob", "group"].every((s) => r.err.includes(`${s}:`));
    expect(all || /and \d+ more; run status/.test(r.err)).toBe(true);
  });
});
