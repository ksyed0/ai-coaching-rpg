import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runReviewCheck } from "../demo-check.js";
import { fixedClock, makeDraftDir } from "./fixtures.js";

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runReviewCheck", () => {
  it("drives a scripted review end to end and reports what it verified", async () => {
    const detail = await runReviewCheck(dir, { now: fixedClock() });
    expect(detail).toMatch(/3 subjects/);
    expect(detail).toMatch(/access matrix/);
    expect(detail).toMatch(/peer/);
  });
  it("leaves the reports directory untouched (no review.jsonl, no lock)", async () => {
    const before = (await readdir(dir)).sort();
    await runReviewCheck(dir, { now: fixedClock() });
    expect((await readdir(dir)).sort()).toEqual(before);
  });
  it("removes its private temp directory, also when it fails", async () => {
    // os.tmpdir() follows TMPDIR, so a private one makes the check's own directories visible (parallel test files cannot interfere).
    const prev = process.env.TMPDIR;
    const priv = await mkdtemp(path.join(os.tmpdir(), "acr-s17-priv-"));
    process.env.TMPDIR = priv;
    try {
      await runReviewCheck(dir, { now: fixedClock() });
      expect(await readdir(priv)).toEqual([]);
      const empty = await mkdtemp(path.join(priv, "empty-"));
      await expect(
        runReviewCheck(empty, { now: fixedClock() }),
      ).rejects.toThrow(/review check/);
      expect(await readdir(priv)).toEqual([path.basename(empty)]);
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
      await rm(priv, { recursive: true, force: true });
    }
  });
  it("does not treat free text in a draft as a structural leak (a tampered group.json)", async () => {
    const f = path.join(dir, "group.json");
    const j = JSON.parse(await readFile(f, "utf8"));
    j.facilitator_notes = "bob scored 1.5"; // text, not structure: redaction empties it
    await writeFile(f, JSON.stringify(j));
    await expect(
      runReviewCheck(dir, { now: fixedClock() }),
    ).resolves.toBeTruthy();
  });
});
