import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Seam: makes fchmodSync fail like a directory owned by someone else (a bind mount). Passthrough by default.
const hooks = vi.hoisted(() => ({ fchmod: null as null | (() => void), foreignUid: false }));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    fchmodSync: (fd: number, mode: number) => (hooks.fchmod ? hooks.fchmod() : actual.fchmodSync(fd, mode)),
    fstatSync: ((fd: number, o?: unknown) => { const st = actual.fstatSync(fd, o as never); if (hooks.foreignUid && st && typeof process.getuid === "function") Object.assign(st, { uid: process.getuid() + 1 }); return st; }) as typeof actual.fstatSync,
  };
});
const { SessionLock, ensurePrivateDir } = await import("../log-files.js");

const isPosix = process.platform !== "win32";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-privdir-")); });
afterEach(async () => { hooks.fchmod = null; hooks.foreignUid = false; await rm(dir, { recursive: true, force: true }); });

describe("M7: a data directory others can write to is refused when it cannot be made private", () => {
  it.skipIf(!isPosix)("group/other WRITABLE and not fixable: refused (EUNSAFE); only readable: a warning", async () => {
    hooks.fchmod = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
    const w = path.join(dir, "w"); await mkdir(w); await chmod(w, 0o777);
    expect(() => ensurePrivateDir(w)).toThrow(expect.objectContaining({ code: "EUNSAFE", message: expect.stringMatching(/writable by other users.*chown it to the server's user \(or chmod 700 it as its owner\)/) }));
    const r = path.join(dir, "r"); await mkdir(r); await chmod(r, 0o755);
    expect(ensurePrivateDir(r)).toMatch(/readable by other users/);
    expect((await stat(r)).mode & 0o777).toBe(0o755);
    await chmod(w, 0o700);
  });
});

describe("Minor 5: a lock owned by another user", () => {
  it.skipIf(typeof process.getuid !== "function")("is refused with an actionable message that does not suggest SESSION_START=fresh", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "s.lock"), "{}");
    hooks.foreignUid = true;
    let msg = "";
    try { SessionLock.acquire(dir, "s"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/belongs to another user; chown it to the server's user, or remove the leftover lock after confirming that no server runs/);
    expect(msg).not.toMatch(/SESSION_START/);
  });
});
