import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JoinCodeRecordError, JoinCodes } from "../join-codes.js";
import { codesFileName, readJoinCodesFile, removeJoinCodesFile, writeJoinCodesFile } from "../join-code-file.js";

const isPosix = process.platform !== "win32";
const BIND = { sessionId: "s", scenarioSha256: "c".repeat(64) };
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-codes-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const file = () => path.join(dir, codesFileName("s"));

describe("join codes file (US-0033)", () => {
  it("test_codesFile_missing_reads_as_null", () => {
    expect(readJoinCodesFile(dir, "s")).toBeNull();
  });

  it.skipIf(!isPosix)("test_codesFile_write_then_read_round_trips_owner_only_with_hashes_only_and_no_temp_left", async () => {
    const { codes, plain } = JoinCodes.issue(["a", "b"], BIND);
    let committed = 0;
    writeJoinCodesFile(dir, "s", codes, () => { committed++; });
    expect(committed).toBe(1);
    expect(await readdir(dir)).toEqual([codesFileName("s")]);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    const text = await readFile(file(), "utf8");
    for (const c of Object.values(plain)) expect(text).not.toContain(c.replace(/-/g, ""));
    const back = readJoinCodesFile(dir, "s")!;
    expect(back.verify("a", plain.a)).toBe(true);
    expect(back.verify("b", plain.a)).toBe(false);
  });

  it("test_codesFile_rewrite_replaces_the_old_codes", () => {
    const one = JoinCodes.issue(["a"], BIND); const two = JoinCodes.issue(["a"], BIND);
    writeJoinCodesFile(dir, "s", one.codes);
    writeJoinCodesFile(dir, "s", two.codes);
    const back = readJoinCodesFile(dir, "s")!;
    expect(back.verify("a", two.plain.a)).toBe(true);
    expect(back.verify("a", one.plain.a)).toBe(false);
  });

  it("test_codesFile_a_failing_commit_check_leaves_the_old_file_and_no_temp", async () => {
    const one = JoinCodes.issue(["a"], BIND); const two = JoinCodes.issue(["a"], BIND);
    writeJoinCodesFile(dir, "s", one.codes);
    expect(() => writeJoinCodesFile(dir, "s", two.codes, () => { throw new Error("lock lost"); })).toThrow("lock lost");
    expect(await readdir(dir)).toEqual([codesFileName("s")]);
    expect(readJoinCodesFile(dir, "s")!.verify("a", one.plain.a)).toBe(true);
  });

  it("test_codesFile_malformed_or_foreign_content_is_refused_without_quoting_it", async () => {
    for (const body of ["not json {", JSON.stringify({ v: 1 }), JSON.stringify({ hello: "LEAKY-VALUE" }), "[]"]) {
      await writeFile(file(), body, { mode: 0o600 });
      let err: unknown;
      try { readJoinCodesFile(dir, "s"); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(JoinCodeRecordError);
      expect((err as Error).message).not.toContain("LEAKY-VALUE");
    }
  });

  it("test_codesFile_oversized_file_is_refused", async () => {
    await writeFile(file(), " ".repeat(64 * 1024 + 1), { mode: 0o600 });
    expect(() => readJoinCodesFile(dir, "s")).toThrow(/too large/);
  });

  it.skipIf(!isPosix)("test_codesFile_symlink_hardlink_or_directory_is_refused", async () => {
    const { codes } = JoinCodes.issue(["a"], BIND);
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "acr-codes-other-"));
    try {
      writeJoinCodesFile(elsewhere, "s", codes);
      await symlink(path.join(elsewhere, codesFileName("s")), file());
      expect(() => readJoinCodesFile(dir, "s")).toThrow(/symbolic link/);
      await rm(file());
      await link(path.join(elsewhere, codesFileName("s")), file());
      expect(() => readJoinCodesFile(dir, "s")).toThrow(/hard links/);
      await rm(file());
      await mkdir(file());
      expect(() => readJoinCodesFile(dir, "s")).toThrow(/not a regular file/);
    } finally { await rm(elsewhere, { recursive: true, force: true }); }
  });

  it.skipIf(!isPosix)("test_codesFile_a_wider_file_is_narrowed_to_0600_when_read", async () => {
    const { codes } = JoinCodes.issue(["a"], BIND);
    writeJoinCodesFile(dir, "s", codes);
    await chmod(file(), 0o644);
    readJoinCodesFile(dir, "s");
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  });

  it("test_codesFile_remove_is_idempotent", async () => {
    const { codes } = JoinCodes.issue(["a"], BIND);
    writeJoinCodesFile(dir, "s", codes);
    removeJoinCodesFile(dir, "s");
    removeJoinCodesFile(dir, "s");
    expect(await readdir(dir)).toEqual([]);
  });
});
