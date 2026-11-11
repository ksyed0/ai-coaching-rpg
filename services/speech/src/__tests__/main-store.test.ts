import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_LOCK_STALE_MS, SessionLock, SessionLockError } from "@acr/runtime/files";
import type { WorkerMessage } from "../protocol.js";
import { afterStoreWait, openStore } from "../store/store-setup.js";

/** US-0073 (A2a Task 7c): the store and lock wiring of the worker process, against fakes (and once a real lock). */
const ID = "0123456789abcdef0123456789abcdef";
let root: string; let audio: string; let sessions: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "acr-mainstore-")); audio = path.join(root, "audio"); sessions = path.join(root, "sessions"); mkdirSync(sessions, { mode: 0o700 }); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const cfg = () => ({ audioDir: audio, minFreeMb: 512, logIdentity: ID, sessionsDir: sessions });
const seg = { roleId: "coach", participantId: "p1", segmentId: "s1", startMs: 0, endMs: 10, pcm: new Int16Array(160), outcome: { kind: "no_text" as const, status: "empty" as const } };
function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: vi.fn(async (ms: number) => { t += ms; }) };
}
function fakes(acquire: (dir: string, id: string, o: { suffix?: string; onLost?: () => void }) => unknown) {
  const c = clock(); const sent: WorkerMessage[] = [];
  return { c, sent, base: { cfg: cfg(), now: c.now, send: (m: WorkerMessage) => { sent.push(m); return true; }, sleep: c.sleep, acquireLock: acquire as unknown as typeof SessionLock.acquire } };
}
const locked = () => new SessionLockError("locked", "held");
const goodLock = () => ({ lost: false, release: vi.fn() });

describe("openStore", () => {
  it("test_acquires_at_once_with_the_store_suffix_and_sends_nothing", async () => {
    const lock = goodLock(); const calls: unknown[][] = [];
    const f = fakes((...a) => { calls.push(a); return lock; });
    const r = await openStore(f.base);
    expect(r.store.stopped).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(audio); expect(calls[0]![1]).toBe(ID);
    expect((calls[0]![2] as { suffix: string }).suffix).toBe("store");
    expect(f.sent).toEqual([]); expect(f.c.sleep).not.toHaveBeenCalled(); expect(lock.release).not.toHaveBeenCalled();
  });
  it("test_retries_locked_failures_inside_the_window_then_succeeds", async () => {
    const lock = goodLock(); let n = 0;
    const f = fakes(() => { if (++n <= 3) throw locked(); return lock; });
    const r = await openStore(f.base);
    expect(n).toBe(4); expect(f.c.sleep).toHaveBeenCalledTimes(3);
    expect(r.store.stopped).toBe(false); expect(f.sent).toEqual([]);
  });
  it("test_still_locked_after_the_window_sends_store_stopped_once_and_writes_nothing", async () => {
    const f = fakes(() => { throw locked(); });
    const start = f.c.now();
    const r = await openStore(f.base);
    expect(f.c.now() - start).toBeGreaterThanOrEqual(DEFAULT_LOCK_STALE_MS + 5_000);
    expect(f.sent).toEqual([{ type: "store_stopped", reason: "write_error" }]);
    expect(r.store.stopped).toBe(true);
    expect(r.store.write(seg)).toBe("stopped");
    expect(() => r.store.markEnded()).not.toThrow();
    expect(() => r.release()).not.toThrow();
    expect(readdirSync(audio)).toEqual([]);
    expect(f.sent).toHaveLength(1);
  });
  it("test_a_non_locked_error_is_not_retried_and_sends_store_stopped_once", async () => {
    let n = 0;
    const f = fakes(() => { n++; throw new SessionLockError("not_a_file", "x"); });
    const r = await openStore(f.base);
    expect(n).toBe(1); expect(f.c.sleep).not.toHaveBeenCalled();
    expect(f.sent).toEqual([{ type: "store_stopped", reason: "write_error" }]);
    expect(r.store.write(seg)).toBe("stopped");
  });
  it("test_a_symlinked_audio_folder_is_a_store_stopped_not_a_throw", async () => {
    const f = fakes(() => goodLock());
    const real = path.join(root, "real"); mkdirSync(real, { mode: 0o700 }); symlinkSync(real, audio);
    const r = await openStore(f.base);
    expect(f.sent).toEqual([{ type: "store_stopped", reason: "write_error" }]);
    expect(r.store.stopped).toBe(true);
  });
  it("test_onLost_stops_the_store_with_write_error_once", async () => {
    let onLost: (() => void) | undefined;
    const f = fakes((_d, _i, o) => { onLost = o.onLost; return goodLock(); });
    const r = await openStore(f.base);
    onLost!(); onLost!();
    expect(r.store.stopped).toBe(true);
    expect(r.store.write(seg)).toBe("stopped");
    expect(f.sent).toEqual([{ type: "store_stopped", reason: "write_error" }]);
  });
  it("test_release_releases_once_and_only_when_asked", async () => {
    const lock = goodLock();
    const f = fakes(() => lock);
    const r = await openStore(f.base);
    r.store.markEnded();
    expect(lock.release).not.toHaveBeenCalled();
    r.release(); r.release();
    expect(lock.release).toHaveBeenCalledTimes(1);
  });
  it("test_two_real_stores_one_identity_second_waits_then_fails_then_succeeds_after_release", async () => {
    const first = await openStore({ cfg: cfg(), now: Date.now, send: () => true, sleep: async () => undefined });
    expect(first.store.stopped).toBe(false);
    const c = clock(); const sent: WorkerMessage[] = [];
    const second = await openStore({ cfg: cfg(), now: c.now, send: (m) => { sent.push(m); return true; }, sleep: c.sleep });
    expect(c.sleep).toHaveBeenCalled();
    expect(sent).toEqual([{ type: "store_stopped", reason: "write_error" }]);
    expect(second.store.stopped).toBe(true);
    first.release();
    const sent3: WorkerMessage[] = [];
    const third = await openStore({ cfg: cfg(), now: Date.now, send: (m) => { sent3.push(m); return true; }, sleep: async () => undefined });
    expect(third.store.stopped).toBe(false); expect(sent3).toEqual([]);
    third.release();
  });
});

describe("openStore with an abort signal", () => {
  it("test_an_already_aborted_signal_ends_at_once_with_no_message_no_acquire", async () => {
    const ac = new AbortController(); ac.abort();
    let n = 0;
    const f = fakes(() => { n++; return goodLock(); });
    const r = await openStore({ ...f.base, signal: ac.signal });
    expect(n).toBe(0); expect(f.sent).toEqual([]);
    expect(r.store.stopped).toBe(true); expect(r.store.write(seg)).toBe("stopped");
  });
  it("test_abort_mid_wait_stops_the_retries_promptly_and_sends_nothing", async () => {
    const ac = new AbortController(); let n = 0;
    const f = fakes(() => { n++; throw locked(); });
    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => { if (n >= 3) ac.abort(); if (signal?.aborted) throw new Error("aborted"); });
    const r = await openStore({ ...f.base, sleep, signal: ac.signal });
    expect(n).toBe(3); expect(sleep.mock.calls[0]![1]).toBe(ac.signal);
    expect(f.sent).toEqual([]); expect(r.store.stopped).toBe(true);
    expect(readdirSync(audio)).toEqual([]);
  });
});

describe("afterStoreWait", () => {
  const mk = (connected: boolean, aborted: boolean) => { const release = vi.fn(); const exit = vi.fn(); return { release, exit, run: () => afterStoreWait({ connected, aborted, release, exit }) }; };
  it("test_parent_gone_releases_and_exits_0", () => {
    for (const [c, a] of [[false, false], [true, true]] as const) {
      const m = mk(c, a); expect(m.run()).toBe(true);
      expect(m.release).toHaveBeenCalledTimes(1); expect(m.exit).toHaveBeenCalledWith(0);
    }
  });
  it("test_parent_present_continues_without_release_or_exit", () => {
    const m = mk(true, false); expect(m.run()).toBe(false);
    expect(m.release).not.toHaveBeenCalled(); expect(m.exit).not.toHaveBeenCalled();
  });
});
