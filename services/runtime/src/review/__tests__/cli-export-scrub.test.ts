import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { releaseRefusal } from "../cli.js";
import { makeDraftDir, makeRunner } from "./fixtures.js";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("export scrubs as strictly as show", () => {
  it("home path, tmp path and hidden characters are gone from both files; the JSON still parses", async () => {
    let dir: string;
    ({ root, dir } = await makeDraftDir());
    const f = path.join(dir, "alice.json");
    const j = JSON.parse(await readFile(f, "utf8"));
    const dirty = `see ${os.homedir()}/private/x and ${os.tmpdir()}/scratch/y‮HIDDEN​END`;
    j.criteria[0].rationale = dirty;
    j.summary = { ...j.summary, strengths: [dirty] };
    await writeFile(f, JSON.stringify(j, null, 2));
    const run = makeRunner(root);
    const rel = path.relative(root, dir);
    expect((await run(["open", rel, "--by", "kamal"])).code).toBe(0);
    const l = await run(["status", rel]);
    expect(l.code).toBe(0);
    const { loadReview } = await import("../store.js");
    for (const c of (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.filter((x) => x.status === "needs_review"))
      await run(["accept", rel, "alice", c.id, "--by", "kamal"]);
    await run(["accept", rel, "alice", "--summary", "--by", "kamal"]);
    expect((await run(["release", rel, "alice", "--by", "kamal"])).code).toBe(
      0,
    );
    expect(
      (
        await run([
          "export",
          rel,
          "alice",
          "--for",
          "facilitator",
          "--to",
          "out/s",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    const md = await readFile(path.join(root, "out/s/alice.md"), "utf8");
    const js = await readFile(path.join(root, "out/s/alice.json"), "utf8");
    for (const t of [md, js]) {
      expect(t).toContain("HIDDENEND");
      expect(t).not.toContain(os.homedir() + "/private");
      expect(t).not.toContain(os.tmpdir() + "/scratch");
      expect(t).not.toMatch(/[‮​]/);
    }
    expect(JSON.parse(js).schema).toBe("acr.view/1");
    expect(md).toMatch(/^\|.*\|$/m); // table rows survive
  });
});

describe("releaseRefusal", () => {
  it("keeps whole lines and says how many were left out", () => {
    const problems = Array.from(
      { length: 30 },
      (_, i) => `s${i}: needs review (accept or edit): a, b, c`,
    );
    const t = releaseRefusal(problems);
    expect(t).toMatch(/\.\.\. and \d+ more; run status for the full list$/);
    expect(t.length).toBeLessThan(400);
    expect(
      t
        .split("\n")
        .slice(1, -1)
        .every((x) => /^ {2}s\d+:/.test(x)),
    ).toBe(true);
    expect(releaseRefusal(["a: x"])).not.toMatch(/more/);
  });
});
