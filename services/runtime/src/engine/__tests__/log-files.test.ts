import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LOCK_STALE_MS, SessionLock, SessionLockError, ensurePrivateDir, heartbeatFor } from "../log-files.js";

const isPosix = process.platform !== "win32";
let dir: string;
const held: SessionLock[] = [];
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-lock-")); });
afterEach(async () => { for (const l of held.splice(0)) l.release(); await rm(dir, { recursive: true, force: true }); });
/** A fixed wall clock for the lock's age judgements: no test depends on how long the runner takes between two lines. */
const NOW = 1_900_000_000_000;
const take = (opts: Parameters<typeof SessionLock.acquire>[2] = {}) => {
  const l = SessionLock.acquire(dir, "s", { now: () => NOW, recheckDelay: () => Promise.resolve(), ...opts });
  held.push(l);
  return l;
};
const lockFile = () => path.join(dir, "s.lock");
/** A lock file as another process would leave it, with its mtime `ageMs` in the past. */
async function foreignLock(info: Record<string, unknown>, ageMs: number): Promise<void> {
  await writeFile(lockFile(), JSON.stringify(info) + "\n", { mode: 0o600 });
  const t = (NOW - ageMs) / 1000;
  await utimes(lockFile(), t, t);
}

describe("SessionLock", () => {
  it.skipIf(!isPosix)("creates <id>.lock owner-only with pid, host and start time, and release removes it", async () => {
    const l = take({ hostname: "h1", pid: 4242 });
    expect((await stat(lockFile())).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(lockFile(), "utf8"))).toMatchObject({ pid: 4242, host: "h1", startedAt: expect.any(String) });
    expect(l.verify()).toBe(true);
    l.release();
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a second lock on the same session in the same process", () => {
    take();
    expect(() => SessionLock.acquire(dir, "s")).toThrow(SessionLockError);
    expect(() => SessionLock.acquire(dir, "s")).toThrow(/already open in this server process/);
  });

  it("refuses while another live process holds it (fresh heartbeat), naming no path, host or pid", async () => {
    await foreignLock({ pid: 999_999, host: "other-host" }, 2_000);
    let err: unknown;
    try { take({ hostname: "me" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SessionLockError);
    expect(err).toMatchObject({ code: "locked", message: expect.stringMatching(/locked by another server process \(last heartbeat 2 s ago\).*stale after 30 s/) });
    expect((err as Error).message).not.toMatch(/other-host|999999|acr-lock/);
    expect(JSON.parse(await readFile(lockFile(), "utf8"))).toMatchObject({ host: "other-host" }); // untouched
  });

  it("takes over a lock whose heartbeat is older than the stale age", async () => {
    await foreignLock({ pid: 999_999, host: "other-host" }, DEFAULT_LOCK_STALE_MS + 1_000);
    take({ hostname: "me", pid: 7 });
    expect(JSON.parse(await readFile(lockFile(), "utf8"))).toMatchObject({ host: "me", pid: 7 });
    expect((await readdir(dir)).sort()).toEqual(["s.lock"]); // the stale one was removed, nothing left aside
  });

  it("takes over at once a lock of THIS host whose process is gone (a crash), or that names our own pid (a restarted container)", async () => {
    await foreignLock({ pid: 31_337, host: "me" }, 1_000);
    take({ hostname: "me", pid: 7, isAlive: (p) => p !== 31_337 }).release();
    held.pop();
    await foreignLock({ pid: 7, host: "me" }, 1_000);
    take({ hostname: "me", pid: 7, isAlive: () => true });
    expect(JSON.parse(await readFile(lockFile(), "utf8"))).toMatchObject({ pid: 7 });
  });

  it("does NOT take over a fresh lock of this host whose process still runs", async () => {
    await foreignLock({ pid: 31_337, host: "me" }, 1_000);
    expect(() => take({ hostname: "me", pid: 7, isAlive: () => true })).toThrow(/locked by another server process/);
  });

  it("judges a half-written or foreign lock by its age only", async () => {
    await writeFile(lockFile(), "{not json");
    const fresh = (NOW - 1_000) / 1000;
    await utimes(lockFile(), fresh, fresh);
    expect(() => take({ hostname: "me" })).toThrow(/locked/);
    const t = (NOW - 60_000) / 1000;
    await utimes(lockFile(), t, t);
    take({ hostname: "me" });
  });

  it.skipIf(!isPosix)("refuses a symbolic link or a directory in place of the lock, and leaves them alone", async () => {
    await writeFile(path.join(dir, "target"), "keep");
    await symlink(path.join(dir, "target"), lockFile());
    expect(() => take()).toThrow(/symbolic link/);
    expect(await readFile(path.join(dir, "target"), "utf8")).toBe("keep");
    await rm(lockFile());
    await mkdir(lockFile());
    expect(() => take()).toThrow(/not a regular file/);
  });

  it("refuses a dangling symlink too (O_EXCL never creates through it)", async () => {
    if (!isPosix) return;
    await symlink(path.join(dir, "nowhere"), lockFile());
    expect(() => take()).toThrow(/symbolic link/);
    expect(await readdir(dir)).toEqual(["s.lock"]);
  });

  it("the heartbeat refreshes the mtime through the held descriptor", async () => {
    let now = NOW;
    const l = take({ now: () => now });
    now += 3_600_000;
    await l.heartbeat();
    expect(Math.abs((await stat(lockFile())).mtimeMs - now)).toBeLessThan(2_000);
    expect(heartbeatFor(30_000)).toBe(5_000);
    expect(heartbeatFor(10_000)).toBe(1_666);
  });

  it("notices when the lock file is replaced or removed: lost, appends refused, onLost called once, release leaves the other file alone", async () => {
    let lostCalls = 0;
    const l = take({ onLost: () => { lostCalls++; } });
    await l.assertHeld();
    await rename(lockFile(), path.join(dir, "moved"));
    await writeFile(lockFile(), "someone else's lock");
    await l.heartbeat();
    expect(l.lost).toBe(true);
    await expect(l.assertHeld()).rejects.toThrow(/taken over/);
    await l.heartbeat();
    expect(lostCalls).toBe(1);
    l.release();
    expect(await readFile(lockFile(), "utf8")).toBe("someone else's lock");
  });

  it("after release, assertHeld refuses (code closed) without reporting a loss", async () => {
    let lostCalls = 0;
    const l = take({ onLost: () => { lostCalls++; } });
    l.release();
    await expect(l.assertHeld()).rejects.toMatchObject({ code: "closed", message: expect.stringMatching(/was closed/) });
    expect(lostCalls).toBe(0);
  });

  it("abandon() (a simulated crash) leaves the file; the next start of this host and pid takes it over", async () => {
    const l = take({ hostname: "me", pid: 7 });
    l.abandon();
    held.pop();
    expect(await readdir(dir)).toEqual(["s.lock"]);
    take({ hostname: "me", pid: 7 });
  });

  it("a takeover that finds a DIFFERENT file than the one it judged puts it back and refuses (contention)", async () => {
    await foreignLock({ pid: 1, host: "x" }, 1_000);
    const st = await stat(lockFile());
    const removeIfSame = (SessionLock as unknown as { removeIfSame(f: string, id: { dev: number; ino: number }): boolean }).removeIfSame;
    expect(removeIfSame(lockFile(), { dev: st.dev, ino: st.ino + 1 })).toBe(false);
    expect(JSON.parse(await readFile(lockFile(), "utf8"))).toMatchObject({ host: "x" });
    expect(await readdir(dir)).toEqual(["s.lock"]);
    expect(removeIfSame(lockFile(), { dev: st.dev, ino: st.ino })).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("ensurePrivateDir", () => {
  it.skipIf(!isPosix)("creates the directory 0700, removes group and other bits from an existing one, and never adds a bit", async () => {
    const fresh = path.join(dir, "a", "b");
    expect(ensurePrivateDir(fresh)).toBeNull();
    expect((await stat(fresh)).mode & 0o777).toBe(0o700);
    const wide = path.join(dir, "wide");
    await mkdir(wide); await chmod(wide, 0o755);
    expect(ensurePrivateDir(wide)).toBeNull();
    expect((await stat(wide)).mode & 0o777).toBe(0o700);
    const ro = path.join(dir, "ro");
    await mkdir(ro); await chmod(ro, 0o555);
    expect(ensurePrivateDir(ro)).toBeNull();
    expect((await stat(ro)).mode & 0o777).toBe(0o500);
    await chmod(ro, 0o700);
  });

  it("refuses a file where the directory should be", async () => {
    const f = path.join(dir, "file");
    await writeFile(f, "x");
    expect(() => ensurePrivateDir(f)).toThrow();
  });
});
