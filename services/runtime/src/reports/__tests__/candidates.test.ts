import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, rm, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { listDraftCandidates } from "../index.js";
import { makeDraftDir, makeRunner } from "../../review/__tests__/fixtures.js";

let root: string, dir: string, id: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  id = path.basename(dir);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listDraftCandidates", () => {
  it("lists <id> and <id>-2 but not <id>-100, a symlink or another session", async () => {
    await cp(dir, path.join(root, `${id}-2`), { recursive: true });
    await cp(dir, path.join(root, `${id}-100`), { recursive: true });
    await cp(dir, path.join(root, `${id}x`), { recursive: true });
    await cp(dir, path.join(root, "other"), { recursive: true });
    await symlink(dir, path.join(root, `${id}-3`));
    const r = await listDraftCandidates(root, id);
    expect(r.map((c) => c.name)).toEqual([id, `${id}-2`]);
    expect(r[0]!.dir).toBe(path.join(root, id));
  });

  it("an evaluated, unopened draft is complete with hasReview false", async () => {
    const r = await listDraftCandidates(root, id);
    expect(r).toEqual([
      { name: id, dir, hasReview: false, complete: true },
    ]);
  });

  it("a folder with a missing draft file is complete false", async () => {
    await unlink(path.join(dir, "group.json"));
    const r = await listDraftCandidates(root, id);
    expect(r).toHaveLength(1);
    expect(r[0]!.complete).toBe(false);
  });

  it("an opened review has hasReview true", async () => {
    const run = makeRunner(root);
    await run(["open", path.relative(root, dir), "--by", "kamal"]);
    const r = await listDraftCandidates(root, id);
    expect(r[0]!.hasReview).toBe(true);
    expect(r[0]!.complete).toBe(true);
  });

  it("never throws: a missing reports dir or invalid id is an empty list", async () => {
    expect(await listDraftCandidates(path.join(root, "nope"), id)).toEqual([]);
    expect(await listDraftCandidates(root, "../x")).toEqual([]);
  });
});
