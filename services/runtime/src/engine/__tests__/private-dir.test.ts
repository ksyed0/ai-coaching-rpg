import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Seam: makes fchmodSync fail like a directory owned by someone else (a bind mount). Passthrough by default.
const hooks = vi.hoisted(() => ({ fchmod: null as null | (() => void) }));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return { ...actual, fchmodSync: (fd: number, mode: number) => (hooks.fchmod ? hooks.fchmod() : actual.fchmodSync(fd, mode)) };
});
const { ensurePrivateDir } = await import("../log-files.js");

const isPosix = process.platform !== "win32";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-privdir-")); });
afterEach(async () => { hooks.fchmod = null; await rm(dir, { recursive: true, force: true }); });

describe("M7: a data directory others can write to is refused when it cannot be made private", () => {
  it.skipIf(!isPosix)("group/other WRITABLE and not fixable: refused (EUNSAFE); only readable: a warning", async () => {
    hooks.fchmod = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
    const w = path.join(dir, "w"); await mkdir(w); await chmod(w, 0o777);
    expect(() => ensurePrivateDir(w)).toThrow(expect.objectContaining({ code: "EUNSAFE", message: expect.stringMatching(/writable by other users.*chmod 700/) }));
    const r = path.join(dir, "r"); await mkdir(r); await chmod(r, 0o755);
    expect(ensurePrivateDir(r)).toMatch(/readable by other users/);
    expect((await stat(r)).mode & 0o777).toBe(0o755);
    await chmod(w, 0o700);
  });
});
