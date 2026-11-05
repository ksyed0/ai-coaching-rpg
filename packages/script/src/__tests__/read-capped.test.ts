import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileTooLargeError, readCapped, readTextCapped } from "../read-capped.js";

describe("readCapped", () => {
  const withDir = async (fn: (d: string) => Promise<void>) => {
    const d = await mkdtemp(path.join(os.tmpdir(), "acr-cap-"));
    try { await fn(d); } finally { await rm(d, { recursive: true, force: true }); }
  };
  it("reads a file below the cap, an empty file and a file exactly at the cap", async () => withDir(async (d) => {
    await writeFile(path.join(d, "a"), "hello");
    await writeFile(path.join(d, "e"), "");
    await writeFile(path.join(d, "x"), "x".repeat(100));
    expect((await readCapped(path.join(d, "a"), 100)).toString()).toBe("hello");
    expect((await readCapped(path.join(d, "e"), 100)).length).toBe(0);
    expect((await readTextCapped(path.join(d, "x"), 100)).length).toBe(100);
  }));
  it("rejects a file one byte over the cap and a much larger one", async () => withDir(async (d) => {
    await writeFile(path.join(d, "x"), "x".repeat(101));
    await writeFile(path.join(d, "big"), "x".repeat(100_000));
    await expect(readCapped(path.join(d, "x"), 100)).rejects.toBeInstanceOf(FileTooLargeError);
    await expect(readCapped(path.join(d, "big"), 100)).rejects.toThrow(/larger than 100 bytes/);
  }));
  it("rejects a missing file and a directory with the fs error", async () => withDir(async (d) => {
    await expect(readCapped(path.join(d, "none"), 10)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readCapped(d, 10)).rejects.toBeTruthy();
  }));
});
