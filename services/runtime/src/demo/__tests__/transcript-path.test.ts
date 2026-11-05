import { constants } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTranscriptTarget, sameFile, writeTranscriptFile } from "../transcript-path.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const tmp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), "acr-tpath-")); dirs.push(d); return d; };

describe("sameFile", () => {
  it("is true for the same path spelled differently, a symlink to it, and a hard link; false for others and for paths that do not exist yet", async () => {
    const d = await tmp();
    await writeFile(path.join(d, "a.json"), "x");
    await symlink(path.join(d, "a.json"), path.join(d, "sym.json"));
    await link(path.join(d, "a.json"), path.join(d, "hard.json"));
    await writeFile(path.join(d, "b.json"), "x");
    expect(await sameFile(path.join(d, "a.json"), path.join(d, ".", "a.json"))).toBe(true);
    expect(await sameFile(path.join(d, "a.json"), path.join(d, "sym.json"))).toBe(true);
    expect(await sameFile(path.join(d, "a.json"), path.join(d, "hard.json"))).toBe(true);
    expect(await sameFile(path.join(d, "a.json"), path.join(d, "b.json"))).toBe(false);
    expect(await sameFile(path.join(d, "new.md"), path.join(d, "new.md"))).toBe(true);
    expect(await sameFile(path.join(d, "new.md"), path.join(d, "other.md"))).toBe(false);
  });
  it("compares through a symlinked parent directory for files that do not exist yet", async () => {
    const d = await tmp();
    await mkdir(path.join(d, "real"));
    await symlink(path.join(d, "real"), path.join(d, "alias"));
    expect(await sameFile(path.join(d, "real", "t.md"), path.join(d, "alias", "t.md"))).toBe(true);
  });
});

describe("checkTranscriptTarget", () => {
  const base = async () => { const d = await tmp(); return { base: d, repoRoot: d, jsonPath: undefined as string | undefined }; };
  it("accepts a new file, an existing regular file, and creatable parents under the base", async () => {
    const o = await base();
    expect(await checkTranscriptTarget(path.join(o.base, "a.md"), o)).toBeNull();
    await writeFile(path.join(o.base, "old.md"), "x");
    expect(await checkTranscriptTarget(path.join(o.base, "old.md"), o)).toBeNull();
    expect(await checkTranscriptTarget(path.join(o.base, "x", "y", "z.md"), o)).toBeNull();
  });
  it("refuses a symlinked file, a symlinked parent directory (anywhere below the anchor), a directory and the --json file", async () => {
    const o = await base();
    await mkdir(path.join(o.base, "real"));
    await writeFile(path.join(o.base, "real", "f.md"), "x");
    await symlink(path.join(o.base, "real", "f.md"), path.join(o.base, "link.md"));
    await symlink(path.join(o.base, "real"), path.join(o.base, "alias"));
    await mkdir(path.join(o.base, "d"));
    expect(await checkTranscriptTarget(path.join(o.base, "link.md"), o)).toBe("that path is a symbolic link");
    expect(await checkTranscriptTarget(path.join(o.base, "alias", "t.md"), o)).toBe("a folder on that path is a symbolic link");
    expect(await checkTranscriptTarget(path.join(o.base, "alias", "deeper", "t.md"), o)).toBe("a folder on that path is a symbolic link");
    expect(await checkTranscriptTarget(path.join(o.base, "d"), o)).toBe("that path is a directory");
    await writeFile(path.join(o.base, "r.json"), "{}");
    await link(path.join(o.base, "r.json"), path.join(o.base, "same.md"));
    expect(await checkTranscriptTarget(path.join(o.base, "same.md"), { ...o, jsonPath: path.join(o.base, "r.json") })).toBe("that is the same file as --json");
    expect(await checkTranscriptTarget(path.join(o.base, "r.json"), { ...o, jsonPath: path.join(o.base, ".", "r.json") })).toBe("that is the same file as --json");
  });
});

describe("writeTranscriptFile", () => {
  it("writes, overwrites a regular file, and creates missing parents", async () => {
    const d = await tmp();
    await writeTranscriptFile(path.join(d, "a", "b", "t.md"), "one");
    await writeTranscriptFile(path.join(d, "a", "b", "t.md"), "two");
    expect(await readFile(path.join(d, "a", "b", "t.md"), "utf8")).toBe("two");
  });
  it("does not follow a symlink that appeared after the start-up check (O_NOFOLLOW): the victim file is untouched", async () => {
    const d = await tmp();
    await writeFile(path.join(d, "victim"), "precious");
    await symlink(path.join(d, "victim"), path.join(d, "t.md")); // swapped in after the check
    await expect(writeTranscriptFile(path.join(d, "t.md"), "pwned")).rejects.toMatchObject({ code: expect.stringMatching(/ELOOP|EMLINK/) });
    expect(await readFile(path.join(d, "victim"), "utf8")).toBe("precious");
    expect(constants.O_NOFOLLOW).toBeGreaterThan(0);
  });
  it("refuses a parent directory that became a symlink after the check", async () => {
    const d = await tmp();
    await mkdir(path.join(d, "real"));
    await symlink(path.join(d, "real"), path.join(d, "alias"));
    await expect(writeTranscriptFile(path.join(d, "alias", "t.md"), "x", { anchors: [d] })).rejects.toThrow(/symbolic link/);
  });
});
