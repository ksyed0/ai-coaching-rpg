import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentityMutex, acquireStoreLock, type StoreLockResult } from "../../voice/store-lock.js";
import { SWEEP_LOCK_FAILED, makeAcquireLock } from "../../voice/sweep.js";

const id = (n: number): string => n.toString(16).padStart(32, "0");
const A = id(0xa), B = id(0xb);

let root: string;
const opened: StoreLockResult[] = [];
const take = (dir: string, sid: string, mutex: IdentityMutex): StoreLockResult => { const r = acquireStoreLock(dir, sid, mutex); opened.push(r); return r; };
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "acr-store-lock-")); });
afterEach(() => {
  for (const r of opened.splice(0)) if (r.kind === "held") r.release();
  rmSync(root, { recursive: true, force: true });
});

describe("IdentityMutex", () => {
  it("refuses a second take of one identity until it is released, and the release is idempotent", () => {
    const m = new IdentityMutex();
    const rel = m.tryTake(A);
    expect(rel).toBeTypeOf("function");
    expect(m.tryTake(A)).toBeNull();
    const relB = m.tryTake(B); // another identity is independent
    expect(relB).toBeTypeOf("function");
    rel!();
    rel!(); // a second release must not free a later holder's take
    const again = m.tryTake(A);
    expect(again).toBeTypeOf("function");
    rel!();
    expect(m.tryTake(A)).toBeNull();
    again!(); relB!();
  });
});

describe("acquireStoreLock", () => {
  it("holds the store lock, then reports locked_here for the same id and mutex", () => {
    const m = new IdentityMutex();
    const first = take(root, A, m);
    expect(first.kind).toBe("held");
    expect(readdirSync(root)).toContain(`${A}.store.lock`);
    expect(take(root, A, m).kind).toBe("locked_here");
  });

  it("reports locked_other when another acquirer (a different mutex) holds the real lock, and frees its own mutex", () => {
    const other = new IdentityMutex();
    expect(take(root, A, other).kind).toBe("held");
    const m = new IdentityMutex();
    expect(take(root, A, m).kind).toBe("locked_other");
    const probe = m.tryTake(A); // the refused acquire left the mutex free
    expect(probe).toBeTypeOf("function");
    probe!();
  });

  it("reports error when the directory does not exist, and frees the mutex", () => {
    const m = new IdentityMutex();
    expect(take(path.join(root, "missing"), A, m).kind).toBe("error");
    const probe = m.tryTake(A);
    expect(probe).toBeTypeOf("function");
    probe!();
  });

  it("reports unsafe when the lock file is a symbolic link, and frees the mutex", () => {
    symlinkSync(path.join(root, "nowhere"), path.join(root, `${A}.store.lock`));
    const m = new IdentityMutex();
    expect(take(root, A, m).kind).toBe("unsafe");
    const probe = m.tryTake(A);
    expect(probe).toBeTypeOf("function");
    probe!();
  });

  it("release() frees both locks, never throws, and is safe to call twice", () => {
    const m = new IdentityMutex();
    const first = take(root, A, m);
    if (first.kind !== "held") throw new Error("expected held");
    first.release();
    expect(() => first.release()).not.toThrow();
    expect(readdirSync(root)).not.toContain(`${A}.store.lock`);
    const second = take(root, A, m);
    expect(second.kind).toBe("held");
    first.release(); // a stale release must not free the new holder's mutex
    expect(take(root, A, m).kind).toBe("locked_here");
  });

  it("assertHeld() verifies now: true while held, false once the lock file is gone or after release", async () => {
    const m = new IdentityMutex();
    const r = take(root, A, m);
    if (r.kind !== "held") throw new Error("expected held");
    expect(await r.assertHeld()).toBe(true);
    unlinkSync(path.join(root, `${A}.store.lock`)); // removed behind our back: the heartbeat has not run yet
    expect(await r.assertHeld()).toBe(false);
    r.release();
    expect(await r.assertHeld()).toBe(false);
    const fresh = take(root, A, m);
    if (fresh.kind !== "held") throw new Error("expected held");
    fresh.release();
    expect(await fresh.assertHeld()).toBe(false);
  });
});

describe("makeAcquireLock on the typed acquirer", () => {
  it("folds to null for locked_here and locked_other without logging, and logs the fixed sentence for unsafe and error", () => {
    const logs: string[] = [];
    const m = new IdentityMutex();
    const acq = makeAcquireLock((s) => logs.push(s), m);
    const held = acq(root, A);
    expect(held).not.toBeNull();
    expect(acq(root, A)).toBeNull(); // locked_here
    expect(makeAcquireLock((s) => logs.push(s))(root, A)).toBeNull(); // locked_other (a private mutex)
    expect(logs).toEqual([]);
    symlinkSync(path.join(root, "nowhere"), path.join(root, `${B}.store.lock`));
    expect(acq(root, B)).toBeNull(); // unsafe
    expect(acq(path.join(root, "missing"), id(0xc))).toBeNull(); // error (an id whose mutex is free)
    expect(logs).toEqual([SWEEP_LOCK_FAILED, SWEEP_LOCK_FAILED]);
    held!.release();
    const next = acq(root, A);
    expect(next).not.toBeNull();
    next!.release();
  });
});

describe("store-lock is the only store-lock acquirer in control", () => {
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "__tests__") return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : e.name.endsWith(".ts") ? [p] : [];
  });

  it("only store-lock.ts takes a store lock, and every other SessionLock.acquire is the audit log's", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(10);
    const callers = files.filter((f) => /SessionLock\s*\.\s*acquire\s*\(/.test(readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f)).sort();
    const storeCallers = callers.filter((f) => /["'`]store["'`]/.test(readFileSync(path.join(SRC, f), "utf8")));
    expect(storeCallers).toEqual([path.join("voice", "store-lock.ts")]);
    // The audit log takes its own `audio-audit` lock; any other new caller must be reviewed against the store-lock rule.
    expect(callers).toEqual([path.join("voice", "audit-log.ts"), path.join("voice", "store-lock.ts")]);
  });
});
