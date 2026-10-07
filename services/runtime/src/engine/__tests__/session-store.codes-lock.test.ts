import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { FakeClock } from "../clock.js";
import { SessionLock } from "../log-files.js";
import { SessionStoreError, openSession, type OpenedSession } from "../session-store.js";
import { JoinCodes } from "../join-codes.js";
import { writeJoinCodesFile } from "../join-code-file.js";

// Seam: lets a test act right after the codes record was written to its temp file, i.e. before the store's pre-rename lock check.
const hooks = vi.hoisted(() => ({ afterCodesWrite: null as null | (() => void) }));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  const writeSync = ((fd: number, buf: Buffer, ...rest: unknown[]) => {
    const n = (actual.writeSync as (...a: unknown[]) => number)(fd, buf, ...rest);
    const h = hooks.afterCodesWrite;
    if (h && Buffer.isBuffer(buf) && buf.toString("utf8").includes('"salt"')) { hooks.afterCodesWrite = null; h(); }
    return n;
  }) as typeof actual.writeSync;
  return { ...actual, writeSync };
});

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
let scenario: Scenario; let dir: string;
const opened: OpenedSession[] = [];
const rejections: unknown[] = [];
const onRejection = (r: unknown) => { rejections.push(r); };
beforeEach(async () => {
  scenario = await loadScenario(fixture); dir = await mkdtemp(path.join(os.tmpdir(), "acr-codes-lock-"));
  rejections.length = 0; process.on("unhandledRejection", onRejection);
});
afterEach(async () => {
  hooks.afterCodesWrite = null; vi.restoreAllMocks();
  for (const o of opened.splice(0)) await o.close();
  process.off("unhandledRejection", onRejection);
  await rm(dir, { recursive: true, force: true });
});
const open = async () => { const o = await openSession({ scenario, sessionId: "s", dataDir: dir, clock: new FakeClock(0), mode: "fresh", joinCodes: true }); opened.push(o); return o; };
const lockFile = () => path.join(dir, "s.lock");
const flush = () => new Promise<void>((r) => setImmediate(r));
// A lock that was removed, and one that another process put in its place (a different file at the same path).
const lose = { removed: async () => { await rm(lockFile()); }, replaced: async () => { await rm(lockFile()); await writeFile(lockFile(), "{\"pid\":4242,\"host\":\"other\"}\n", { mode: 0o600 }); } };

describe("join codes and a lost session lock (US-0033 review I-A)", () => {
  for (const [how, doLose] of Object.entries(lose)) {
    it(`test_discardIssuedCodes_with_the_lock_${how}_keeps_the_file_returns_false_and_never_rejects`, async () => {
      const o = await open();
      const asyncCheck = vi.spyOn(SessionLock.prototype, "assertHeld");
      await doLose();
      expect(o.discardIssuedCodes()).toBe(false);
      expect(await readdir(dir)).toContain("s.codes.json"); // possibly another server's file now: never touched
      expect(asyncCheck).not.toHaveBeenCalled(); // the check is synchronous: no promise can be left unhandled
      await flush();
      expect(rejections).toEqual([]);
    });

    it(`test_codes_write_with_the_lock_${how}_before_the_rename_fails_the_start_and_commits_nothing`, async () => {
      hooks.afterCodesWrite = () => { rmSync(lockFile()); if (how === "replaced") writeFileSync(lockFile(), "{\"pid\":4242}\n", { mode: 0o600 }); };
      const err = await open().then(() => null, (e: unknown) => e);
      expect(hooks.afterCodesWrite).toBeNull(); // the lock really was lost in the middle of the write
      expect(err).toBeInstanceOf(SessionStoreError);
      expect((err as SessionStoreError).message).toMatch(/cannot write the join codes file/);
      const names = await readdir(dir);
      expect(names.filter((n) => n.startsWith("s.codes.json"))).toEqual([]); // neither the codes nor a temp file
      await flush();
      expect(rejections).toEqual([]);
    });
  }

  it("test_writeJoinCodesFile_refuses_a_check_that_returns_a_promise", async () => {
    const { codes } = JoinCodes.issue(["host"], { sessionId: "s", scenarioSha256: "e".repeat(64) });
    // @ts-expect-error an async check cannot be passed: its result would be ignored
    expect(() => writeJoinCodesFile(dir, "s", codes, async () => { throw new Error("lock lost"); })).toThrow(/synchronous/);
    expect(await readdir(dir)).toEqual([]);
    await flush();
    expect(rejections).toEqual([]);
  });
});
