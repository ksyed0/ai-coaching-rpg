import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readRegularCapped } from "../read-regular.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acr-rr-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readRegularCapped", () => {
  it("reads a regular file within the cap", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello");
    expect(await readRegularCapped(path.join(dir, "a.txt"), 10)).toBe("hello");
  });
  it("rejects a file over the cap, a directory and a missing file", async () => {
    await writeFile(path.join(dir, "big.txt"), "x".repeat(11));
    await expect(
      readRegularCapped(path.join(dir, "big.txt"), 10),
    ).rejects.toThrow();
    await mkdir(path.join(dir, "d"));
    await expect(readRegularCapped(path.join(dir, "d"), 10)).rejects.toThrow();
    await expect(
      readRegularCapped(path.join(dir, "none"), 10),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not follow a symbolic link", async () => {
    await writeFile(path.join(dir, "real.txt"), "secret");
    await symlink(path.join(dir, "real.txt"), path.join(dir, "link.txt"));
    await expect(
      readRegularCapped(path.join(dir, "link.txt"), 100),
    ).rejects.toThrow();
  });
});
