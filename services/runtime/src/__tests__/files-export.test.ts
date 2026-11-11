import { mkdtempSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as LogFiles from "../engine/log-files.js";
import * as Files from "../files/index.js";

// US-0073 (EPIC-0003 voice A2a, Task 1): the speech worker and control share the runtime's single-writer lock through `@acr/runtime/files`.
const ID = "0123456789abcdef0123456789abcdef";
let dir: string;
const held: LogFiles.SessionLock[] = [];
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "acr-files-export-")); });
afterEach(() => { for (const l of held.splice(0)) l.release(); rmSync(dir, { recursive: true, force: true }); });
const take = (id: string, suffix?: string, o: LogFiles.LockOptions = {}) => { const l = LogFiles.SessionLock.acquire(dir, id, { ...o, ...(suffix === undefined ? {} : { suffix }) }); held.push(l); return l; };

describe("@acr/runtime/files", () => {
  it("test_files_reexports_the_same_SessionLock", () => {
    expect(Files.SessionLock).toBe(LogFiles.SessionLock);
    expect(Files.SessionLockError).toBe(LogFiles.SessionLockError);
    expect(Files.assertInside).toBe(LogFiles.assertInside);
    expect(Files.ensurePrivateDir).toBe(LogFiles.ensurePrivateDir);
    expect(Files.fsyncDirSync).toBe(LogFiles.fsyncDirSync);
    expect(Files.DEFAULT_LOCK_STALE_MS).toBe(LogFiles.DEFAULT_LOCK_STALE_MS);
    const opts: Files.LockOptions = { staleMs: 10_000 }; // the type is exported too
    expect(opts.staleMs).toBe(10_000);
  });
});

describe("SessionLock suffix option", () => {
  it("test_default_lock_name_unchanged", () => {
    expect(path.basename(take(ID).file)).toBe(`${ID}.lock`);
  });

  it("test_two_suffixes_for_one_id_coexist", () => {
    const store = take(ID, "store");
    const audit = take(ID, "audio-audit");
    expect(path.basename(store.file)).toBe(`${ID}.store.lock`);
    expect(path.basename(audit.file)).toBe(`${ID}.audio-audit.lock`);
    expect(() => take(ID, "store")).toThrow(expect.objectContaining({ code: "locked" }));
    expect(() => take(ID)).not.toThrow(); // the plain lock is a third file
    for (const bad of ["a/b", "..", "a.b", "A", "", "x".repeat(65), "a\0b"]) expect(() => take(ID, bad), JSON.stringify(bad)).toThrow();
  });

  it("a suffixed lock is released, and a stale one is taken over, under its own file name", () => {
    const l = take(ID, "store");
    const file = l.file;
    l.release();
    expect(existsSync(file)).toBe(false);
    const crashed = take(ID, "store", { pid: 999_001, hostname: "h" });
    crashed.abandon();
    expect(existsSync(file)).toBe(true);
    const again = take(ID, "store", { pid: 999_002, hostname: "h", isAlive: () => false });
    expect(path.basename(again.file)).toBe(`${ID}.store.lock`);
    expect(existsSync(`${file}.stale-x`)).toBe(false);
  });
});
