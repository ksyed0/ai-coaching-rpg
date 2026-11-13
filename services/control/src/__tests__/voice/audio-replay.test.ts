import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Seam: records every path-taking fs call (to prove a refusal touches nothing), tracks the WAV's descriptor (bytes read through it,
// whether it was closed) and can shrink the WAV right after its fstat. Passthrough by default.
const hooks = vi.hoisted(() => ({
  calls: null as null | string[],
  wavFd: null as null | number,
  wavBytesRead: 0,
  wavClosed: false,
  shrinkWavTo: null as null | { file: string; size: number },
  afterWavClose: null as null | (() => void),
}));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  const rec = (name: string, p: unknown) => { hooks.calls?.push(`${name} ${String(p)}`); };
  return {
    ...actual,
    openSync: ((p: string, ...rest: unknown[]) => {
      rec("openSync", p);
      const fd = (actual.openSync as (...a: unknown[]) => number)(p, ...rest);
      if (String(p).endsWith(".wav")) { hooks.wavFd = fd; hooks.wavBytesRead = 0; hooks.wavClosed = false; }
      return fd;
    }) as typeof actual.openSync,
    readdirSync: ((p: string, ...rest: unknown[]) => { rec("readdirSync", p); return (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof actual.readdirSync,
    lstatSync: ((p: string, ...rest: unknown[]) => { rec("lstatSync", p); return (actual.lstatSync as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof actual.lstatSync,
    statSync: ((p: string, ...rest: unknown[]) => { rec("statSync", p); return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof actual.statSync,
    existsSync: ((p: string) => { rec("existsSync", p); return actual.existsSync(p); }) as typeof actual.existsSync,
    accessSync: ((p: string, ...rest: unknown[]) => { rec("accessSync", p); return (actual.accessSync as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof actual.accessSync,
    readFileSync: ((p: string, ...rest: unknown[]) => { rec("readFileSync", p); return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof actual.readFileSync,
    mkdirSync: ((p: string, ...rest: unknown[]) => { rec("mkdirSync", p); return (actual.mkdirSync as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof actual.mkdirSync,
    fstatSync: ((fd: number, o?: unknown) => {
      const st = actual.fstatSync(fd, o as never);
      if (fd === hooks.wavFd && hooks.shrinkWavTo !== null) actual.truncateSync(hooks.shrinkWavTo.file, hooks.shrinkWavTo.size);
      return st;
    }) as typeof actual.fstatSync,
    readSync: ((fd: number, ...rest: unknown[]) => {
      const n = (actual.readSync as (...a: unknown[]) => number)(fd, ...rest);
      if (fd === hooks.wavFd) hooks.wavBytesRead += n;
      return n;
    }) as typeof actual.readSync,
    closeSync: ((fd: number) => {
      actual.closeSync(fd);
      if (fd !== hooks.wavFd) return;
      hooks.wavClosed = true;
      const after = hooks.afterWavClose;
      hooks.afterWavClose = null;
      after?.();
    }) as typeof actual.closeSync,
  };
});
const fs = await import("node:fs");
const { appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, renameSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = fs;
const { AuditLog } = await import("../../voice/audit-log.js");
const { MAX_WAV_BYTES, MIN_WAV_BYTES, replaySegment } = await import("../../voice/audio-replay.js");
type AuditEvent = import("../../voice/audit-log.js").AuditEvent;

const id = (n: number): string => n.toString(16).padStart(32, "0");
const A = id(0xa), B = id(0xb);
const BY = "kamal-console";
const isRoot = process.getuid?.() === 0;

let root: string, audioDir: string, outside: string;
let audit: InstanceType<typeof AuditLog>;
let spy: { append: ReturnType<typeof vi.fn<(identity: string, e: AuditEvent) => Promise<boolean>>> };
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "acr-replay-"));
  audioDir = path.join(root, "audio");
  outside = path.join(root, "outside");
  mkdirSync(audioDir, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  audit = new AuditLog({ audioDir, now: () => 1234 });
  spy = { append: vi.fn((identity: string, e: AuditEvent) => audit.append(identity, e)) };
  Object.assign(hooks, { calls: null, wavFd: null, wavBytesRead: 0, wavClosed: false, shrinkWavTo: null, afterWavClose: null });
});
afterEach(() => {
  Object.assign(hooks, { calls: null, wavFd: null, shrinkWavTo: null, afterWavClose: null });
  rmSync(root, { recursive: true, force: true });
});

const segLine = (segment: string, startMs = 0) =>
  ({ v: 1, kind: "segment", segment, participantId: `p-${segment}`, startMs, endMs: startMs + 500, status: "transcribed", raw: "secret" });
const delLine = (segment: string) => ({ v: 1, kind: "deleted", segment, op: "0123456789abcdef", ts: 1 });
const jsonl = (lines: unknown[]): string => lines.map((l) => `${JSON.stringify(l)}\n`).join("");
/** WAV-shaped bytes of `size` (a distinct pattern per seed so a mix-up between files shows). */
const wavBytes = (size: number, seed = 1): Buffer => Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + seed) & 0xff));

/** `<audioDir>/<identity>/<role>` with an index (unless null) and the given WAVs; returns the role folder. */
function mkRole(identity: string, role: string, index: unknown[] | null, wavs: Record<string, Buffer> = {}): string {
  const dir = path.join(audioDir, identity, role);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (index !== null) writeFileSync(path.join(dir, "index.jsonl"), jsonl(index), { mode: 0o600 });
  for (const [seg, bytes] of Object.entries(wavs)) writeFileSync(path.join(dir, `${seg}.wav`), bytes, { mode: 0o600 });
  return dir;
}
const play = (o: Partial<{ identities: string[]; role: string; segment: string; by: string }> = {}) =>
  replaySegment({ audioDir, identities: [A], role: "r", segment: "s1", by: BY, audit: spy, ...o });
const auditPath = (identity: string) => path.join(audioDir, `${identity}.audio-audit.jsonl`);
const auditLines = (identity: string): Record<string, unknown>[] =>
  existsSync(auditPath(identity)) ? readFileSync(auditPath(identity), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)) : [];
/** A refusal: the given code, nothing else in the result, append never called and no audit file anywhere. */
function expectRefused(r: unknown, code: string): void {
  const recording = hooks.calls;
  hooks.calls = null; // the checks below are the test's own fs calls, not the function's
  try {
    expect(r).toStrictEqual({ ok: false, code });
    expect(spy.append).not.toHaveBeenCalled();
    expect(auditLines(A)).toEqual([]);
    expect(auditLines(B)).toEqual([]);
  } finally { hooks.calls = recording; }
}

describe("replaySegment: success (US-0074, spec section 5)", () => {
  it("returns the exact bytes and writes exactly one audio.played line with role, segment and by", async () => {
    const bytes = wavBytes(1000);
    mkRole(A, "r", [segLine("s1")], { s1: bytes });
    const r = await play();
    expect(r).toStrictEqual({ ok: true, identity: A, bytes });
    expect(spy.append).toHaveBeenCalledTimes(1);
    expect(spy.append.mock.calls[0]).toStrictEqual([A, { type: "audio.played", role: "r", segment: "s1", by: BY }]);
    expect(auditLines(A)).toStrictEqual([{ v: 1, ts: 1234, type: "audio.played", role: "r", segment: "s1", by: BY }]);
    expect(hooks.wavClosed).toBe(true);
  });

  it("accepts the size limits exactly: 44 and 524288 bytes", async () => {
    expect(MIN_WAV_BYTES).toBe(44);
    expect(MAX_WAV_BYTES).toBe(524_288);
    const small = wavBytes(44, 2), big = wavBytes(524_288, 3);
    mkRole(A, "r", [segLine("s1"), segLine("s2")], { s1: small, s2: big });
    expect(await play({ segment: "s1" })).toStrictEqual({ ok: true, identity: A, bytes: small });
    expect(await play({ segment: "s2" })).toStrictEqual({ ok: true, identity: A, bytes: big });
    expect(auditLines(A)).toHaveLength(2);
  });

  it("reads the whole WAV and closes it BEFORE the audit append, and returns only after the append resolved", async () => {
    const bytes = wavBytes(5000);
    mkRole(A, "r", [segLine("s1")], { s1: bytes });
    let seen: { read: number; closed: boolean } | null = null;
    let resolveAppend!: (ok: boolean) => void;
    let appendCalled!: () => void;
    const called = new Promise<void>((res) => { appendCalled = res; });
    const ordered = {
      append: vi.fn((_i: string, _e: AuditEvent) => {
        seen = { read: hooks.wavBytesRead, closed: hooks.wavClosed };
        appendCalled();
        return new Promise<boolean>((res) => { resolveAppend = res; });
      }),
    };
    let settled = false;
    const p = replaySegment({ audioDir, identities: [A], role: "r", segment: "s1", by: BY, audit: ordered }).then((r) => { settled = true; return r; });
    await called;
    expect(seen).toStrictEqual({ read: 5000, closed: true });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(settled).toBe(false); // the bytes are held until the audit line is confirmed
    resolveAppend(true);
    expect(await p).toStrictEqual({ ok: true, identity: A, bytes });
  });

  it("two identities: the segment is found in the second, and the audit line goes to THAT identity", async () => {
    mkRole(A, "r", [segLine("other")], { other: wavBytes(100) });
    const bytes = wavBytes(200, 9);
    mkRole(B, "r", [segLine("s1")], { s1: bytes });
    expect(await play({ identities: [A, B] })).toStrictEqual({ ok: true, identity: B, bytes });
    expect(auditLines(A)).toEqual([]);
    expect(auditLines(B)).toHaveLength(1);
  });

  it("a missing identity or role folder in the first identity is the same as no entry: the second is asked", async () => {
    const bytes = wavBytes(300, 4);
    mkRole(B, "r", [segLine("s1")], { s1: bytes });
    expect(await play({ identities: [A, B] })).toStrictEqual({ ok: true, identity: B, bytes });
    mkdirSync(path.join(audioDir, A), { mode: 0o700 }); // identity present, role folder missing
    expect(await play({ identities: [A, B] })).toStrictEqual({ ok: true, identity: B, bytes });
  });

  it("the same segment id in both: the FIRST identity with an index line decides", async () => {
    const first = wavBytes(100, 1), second = wavBytes(100, 2);
    mkRole(A, "r", [segLine("s1")], { s1: first });
    mkRole(B, "r", [segLine("s1")], { s1: second });
    expect(await play({ identities: [A, B] })).toStrictEqual({ ok: true, identity: A, bytes: first });
    expect(await play({ identities: [B, A] })).toStrictEqual({ ok: true, identity: B, bytes: second });
  });

  it("returns only the typed fields (no path, no stats, no index entry)", async () => {
    mkRole(A, "r", [segLine("s1")], { s1: wavBytes(64) });
    const r = await play();
    expect(Object.keys(r).sort()).toEqual(["bytes", "identity", "ok"]);
  });
});

describe("replaySegment: the audit must be written first", () => {
  it("append resolving false: audit_unavailable and no bytes anywhere in the result", async () => {
    mkRole(A, "r", [segLine("s1")], { s1: wavBytes(500) });
    const failing = { append: vi.fn(async () => false) };
    const r = await replaySegment({ audioDir, identities: [A], role: "r", segment: "s1", by: BY, audit: failing });
    expect(r).toStrictEqual({ ok: false, code: "audit_unavailable" });
    expect(failing.append).toHaveBeenCalledTimes(1);
  });

  it("append throwing or rejecting: audit_unavailable and no bytes", async () => {
    mkRole(A, "r", [segLine("s1")], { s1: wavBytes(500) });
    const throwing = { append: vi.fn((): Promise<boolean> => { throw new Error("boom"); }) };
    expect(await replaySegment({ audioDir, identities: [A], role: "r", segment: "s1", by: BY, audit: throwing }))
      .toStrictEqual({ ok: false, code: "audit_unavailable" });
    const rejecting = { append: vi.fn(async (): Promise<boolean> => { throw new Error("boom"); }) };
    expect(await replaySegment({ audioDir, identities: [A], role: "r", segment: "s1", by: BY, audit: rejecting }))
      .toStrictEqual({ ok: false, code: "audit_unavailable" });
  });

  it("a real AuditLog that cannot write (the audit file is a directory): audit_unavailable", async () => {
    mkRole(A, "r", [segLine("s1")], { s1: wavBytes(500) });
    mkdirSync(auditPath(A), { mode: 0o700 });
    expect(await play()).toStrictEqual({ ok: false, code: "audit_unavailable" });
    expect(spy.append).toHaveBeenCalledTimes(1);
  });
});

describe("replaySegment: refusals write no audit line", () => {
  it("a WAV with no index line: not_found", async () => {
    mkRole(A, "r", [segLine("other")], { s1: wavBytes(100), other: wavBytes(100) });
    expectRefused(await play(), "not_found");
  });

  it("no index at all: not_found", async () => {
    mkRole(A, "r", null, { s1: wavBytes(100) });
    expectRefused(await play(), "not_found");
  });

  it("a deleted segment: audio_deleted (the WAV still present or not)", async () => {
    mkRole(A, "r", [segLine("s1"), delLine("s1"), segLine("s2"), delLine("s2")], { s1: wavBytes(100) });
    expectRefused(await play({ segment: "s1" }), "audio_deleted");
    expectRefused(await play({ segment: "s2" }), "audio_deleted");
  });

  it("a deleted mark in the FIRST identity stops the search even when the second has the segment available", async () => {
    mkRole(A, "r", [segLine("s1"), delLine("s1")], {});
    mkRole(B, "r", [segLine("s1")], { s1: wavBytes(100) });
    expectRefused(await play({ identities: [A, B] }), "audio_deleted");
  });

  it("an index line whose WAV is missing: not_found (the next identity is not asked)", async () => {
    mkRole(A, "r", [segLine("s1")], {});
    mkRole(B, "r", [segLine("s1")], { s1: wavBytes(100) });
    expectRefused(await play({ identities: [A, B] }), "not_found");
  });

  it("no identity at all: not_found", async () => {
    expectRefused(await play({ identities: [] }), "not_found");
    expectRefused(await play({ identities: [A, B] }), "not_found");
  });

  it("a role folder that is a symlink: store_unsafe (US-0075: an untrusted index), nothing behind the link is opened", async () => {
    const real = path.join(outside, "r");
    mkdirSync(real, { mode: 0o700 });
    writeFileSync(path.join(real, "index.jsonl"), jsonl([segLine("s1")]), { mode: 0o600 });
    writeFileSync(path.join(real, "s1.wav"), wavBytes(100), { mode: 0o600 });
    mkdirSync(path.join(audioDir, A), { mode: 0o700 });
    symlinkSync(real, path.join(audioDir, A, "r"));
    hooks.calls = [];
    expectRefused(await play(), "store_unsafe");
    expect(hooks.calls.filter((c) => c.includes("index.jsonl") || c.includes(".wav"))).toEqual([]);
  });

  it("an identity folder that is a symlink: store_unsafe (US-0075: an untrusted index)", async () => {
    const real = path.join(outside, A);
    mkdirSync(path.join(real, "r"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(real, "r", "index.jsonl"), jsonl([segLine("s1")]), { mode: 0o600 });
    writeFileSync(path.join(real, "r", "s1.wav"), wavBytes(100), { mode: 0o600 });
    symlinkSync(real, path.join(audioDir, A));
    hooks.calls = [];
    expectRefused(await play(), "store_unsafe");
    expect(hooks.calls.filter((c) => c.includes("index.jsonl") || c.includes(".wav"))).toEqual([]);
  });

  it("a WAV that is a symlink (to a file outside audioDir): not_found and the target is never read", async () => {
    const target = path.join(outside, "secret.wav");
    writeFileSync(target, wavBytes(100), { mode: 0o600 });
    const dir = mkRole(A, "r", [segLine("s1")], {});
    symlinkSync(target, path.join(dir, "s1.wav"));
    hooks.calls = [];
    expectRefused(await play(), "not_found");
    expect(hooks.calls.every((c) => c.split(" ").slice(1).join(" ").startsWith(audioDir))).toBe(true);
    expect(hooks.wavBytesRead).toBe(0);
  });

  it("a WAV with nlink 2 (hard-linked): not_found and not read", async () => {
    const dir = mkRole(A, "r", [segLine("s1")], { s1: wavBytes(100) });
    linkSync(path.join(dir, "s1.wav"), path.join(outside, "copy.wav"));
    expectRefused(await play(), "not_found");
    expect(hooks.wavBytesRead).toBe(0);
    expect(hooks.wavClosed).toBe(true);
  });

  it.each([0, 43, 524_289])("a WAV of %i bytes: not_found and not read", async (size) => {
    mkRole(A, "r", [segLine("s1")], { s1: Buffer.alloc(size, 1) });
    expectRefused(await play(), "not_found");
    expect(hooks.wavBytesRead).toBe(0);
    expect(hooks.wavClosed).toBe(true);
  });

  it("a WAV that is a directory: not_found", async () => {
    const dir = mkRole(A, "r", [segLine("s1")], {});
    mkdirSync(path.join(dir, "s1.wav"), { mode: 0o700 });
    expectRefused(await play(), "not_found");
  });

  it("a FIFO named <segment>.wav: not_found without hanging", async (ctx) => {
    const dir = mkRole(A, "r", [segLine("s1")], {});
    try { execFileSync("mkfifo", [path.join(dir, "s1.wav")]); } catch { ctx.skip(); }
    expectRefused(await play(), "not_found");
    expect(hooks.wavClosed).toBe(true);
  });

  it("a WAV that shrinks between fstat and the read: not_found (a short read is never served)", async () => {
    const dir = mkRole(A, "r", [segLine("s1")], { s1: wavBytes(4000) });
    hooks.shrinkWavTo = { file: path.join(dir, "s1.wav"), size: 1000 };
    expectRefused(await play(), "not_found");
    expect(hooks.wavClosed).toBe(true);
  });

  it("a deleted mark written while the WAV was being read: audio_deleted (the index is required again after the read)", async () => {
    const dir = mkRole(A, "r", [segLine("s1")], { s1: wavBytes(100) });
    hooks.afterWavClose = () => { appendFileSync(path.join(dir, "index.jsonl"), jsonl([delLine("s1")])); };
    expectRefused(await play(), "audio_deleted");
  });

  it("an index line gone after the read (index replaced): not_found", async () => {
    const dir = mkRole(A, "r", [segLine("s1")], { s1: wavBytes(100) });
    hooks.afterWavClose = () => { writeFileSync(path.join(dir, "index.jsonl"), jsonl([segLine("other")])); };
    expectRefused(await play(), "not_found");
  });

  it("a role folder swapped under its name during the read: not_found", async () => {
    const dir = mkRole(A, "r", [segLine("s1")], { s1: wavBytes(100) });
    hooks.afterWavClose = () => {
      renameSync(dir, `${dir}-old`);
      mkRole(A, "r", [segLine("s1")], { s1: wavBytes(100, 5) });
    };
    expectRefused(await play(), "not_found");
  });

  it("an identity folder swapped under its name during the read: not_found", async () => {
    mkRole(A, "r", [segLine("s1")], { s1: wavBytes(100) });
    const idPath = path.join(audioDir, A);
    hooks.afterWavClose = () => {
      // A new identity folder takes the name, holding the SAME role folder (same inode): only the identity re-check can see it.
      const fresh = path.join(outside, "fresh-identity");
      mkdirSync(fresh, { mode: 0o700 });
      renameSync(path.join(idPath, "r"), path.join(fresh, "r"));
      renameSync(idPath, path.join(outside, "old-identity"));
      renameSync(fresh, idPath);
    };
    expectRefused(await play(), "not_found");
  });

  it("audioDir swapped under its name during the read: not_found", async () => {
    mkRole(A, "r", [segLine("s1")], { s1: wavBytes(100) });
    hooks.afterWavClose = () => {
      // A new root takes the name, holding the SAME identity folder (same inode): only the root re-check can see it.
      const fresh = path.join(root, "fresh-audio");
      mkdirSync(fresh, { mode: 0o700 });
      renameSync(path.join(audioDir, A), path.join(fresh, A));
      renameSync(audioDir, path.join(root, "old-audio"));
      renameSync(fresh, audioDir);
    };
    expectRefused(await play(), "not_found");
  });

  it.skipIf(isRoot)("a group- or other-writable audioDir: not_found and no file under it is opened", async () => {
    mkRole(A, "r", [segLine("s1")], { s1: wavBytes(100) });
    for (const mode of [0o770, 0o702]) {
      chmodSync(audioDir, mode);
      hooks.calls = [];
      expectRefused(await play(), "not_found");
      expect(hooks.calls).toEqual([`openSync ${audioDir}`]);
    }
    chmodSync(audioDir, 0o750); // group read without write is allowed (ruling R3)
    expect(await play()).toMatchObject({ ok: true, identity: A });
  });

  it("an audioDir that is a symlink or missing: not_found", async () => {
    mkRole(A, "r", [segLine("s1")], { s1: wavBytes(100) });
    const link = path.join(root, "link");
    symlinkSync(audioDir, link);
    expect(await replaySegment({ audioDir: link, identities: [A], role: "r", segment: "s1", by: BY, audit: spy }))
      .toStrictEqual({ ok: false, code: "not_found" });
    expect(await replaySegment({ audioDir: path.join(root, "nope"), identities: [A], role: "r", segment: "s1", by: BY, audit: spy }))
      .toStrictEqual({ ok: false, code: "not_found" });
    expect(spy.append).not.toHaveBeenCalled();
  });
});

describe("replaySegment: an untrusted index fails closed (US-0075, spec section 6)", () => {
  /** An index.jsonl that is a symlink to a valid index elsewhere: the index cannot be trusted. */
  function linkIndex(identity: string, role: string, lines: unknown[]): void {
    const target = path.join(outside, `${identity}-${role}-index.jsonl`);
    writeFileSync(target, jsonl(lines), { mode: 0o600 });
    const dir = path.join(audioDir, identity, role);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    rmSync(path.join(dir, "index.jsonl"), { force: true });
    symlinkSync(target, path.join(dir, "index.jsonl"));
  }

  it("an untrusted index in the FIRST identity is store_unsafe and the next identity is never asked", async () => {
    linkIndex(A, "r", [segLine("other")]);
    mkRole(B, "r", [segLine("s1")], { s1: wavBytes(100) });
    hooks.calls = [];
    expectRefused(await play({ identities: [A, B] }), "store_unsafe");
    expect(hooks.calls.filter((c) => c.includes(B))).toEqual([]);
    expect(hooks.wavBytesRead).toBe(0);
  });

  it("an untrusted index hides even a deleted mark it may hold: store_unsafe, never the other identity's copy", async () => {
    linkIndex(A, "r", [segLine("s1"), delLine("s1")]);
    mkRole(B, "r", [segLine("s1")], { s1: wavBytes(100) });
    expectRefused(await play({ identities: [A, B] }), "store_unsafe");
  });

  it.each([
    ["over the cap (sparse)", (dir: string) => fs.truncateSync(path.join(dir, "index.jsonl"), 64 * 1024 * 1024 + 1)],
    ["a directory", (dir: string) => { rmSync(path.join(dir, "index.jsonl")); mkdirSync(path.join(dir, "index.jsonl")); }],
  ])("an index that is %s: store_unsafe", async (_l, spoil) => {
    const dir = mkRole(A, "r", [segLine("s1")], { s1: wavBytes(100) });
    spoil(dir);
    expectRefused(await play(), "store_unsafe");
  }, 30_000);

  it("the second read (after the WAV) untrusted is store_unsafe, not not_found", async () => {
    const dir = mkRole(A, "r", [segLine("s1")], { s1: wavBytes(100) });
    hooks.afterWavClose = () => {
      const target = path.join(outside, "moved-index.jsonl");
      renameSync(path.join(dir, "index.jsonl"), target);
      symlinkSync(target, path.join(dir, "index.jsonl"));
    };
    expectRefused(await play(), "store_unsafe");
  });

  it("a deleted mark still answers audio_deleted (trusted index)", async () => {
    mkRole(A, "r", [segLine("s1"), delLine("s1")], { s1: wavBytes(100) });
    expectRefused(await play(), "audio_deleted");
  });

  it("a missing role folder in the first identity is still a trusted empty index: the second is asked", async () => {
    mkdirSync(path.join(audioDir, A), { mode: 0o700 });
    const bytes = wavBytes(100, 3);
    mkRole(B, "r", [segLine("s1")], { s1: bytes });
    expect(await play({ identities: [A, B] })).toStrictEqual({ ok: true, identity: B, bytes });
  });
});

describe("replaySegment: a delete that lands while the audit append is awaited (US-0075)", () => {
  /** An audit whose append blocks until released (the bytes are already read when it is called). */
  function blockingAudit() {
    let release!: (ok: boolean) => void;
    let called!: () => void;
    const appendCalled = new Promise<void>((res) => { called = res; });
    const append = vi.fn((_i: string, _e: AuditEvent) => {
      called();
      return new Promise<boolean>((res) => { release = res; });
    });
    return { audit: { append }, appendCalled, release: (ok: boolean) => release(ok) };
  }

  it("a deleted line written while the append is blocked: audio_deleted and zero bytes", async () => {
    const dir = mkRole(A, "r", [segLine("s1")], { s1: wavBytes(4000) });
    const b = blockingAudit();
    const p = replaySegment({ audioDir, identities: [A], role: "r", segment: "s1", by: BY, audit: b.audit });
    await b.appendCalled;
    appendFileSync(path.join(dir, "index.jsonl"), jsonl([delLine("s1")])); // a facilitator delete marks it meanwhile
    b.release(true);
    const r = await p;
    expect(r).toStrictEqual({ ok: false, code: "audio_deleted" });
    expect("bytes" in r).toBe(false);
    expect(b.audit.append).toHaveBeenCalledTimes(1); // the audit line over-reports: the recorded audit-first residual
  });

  it("the index made untrusted while the append is blocked: store_unsafe and zero bytes", async () => {
    const dir = mkRole(A, "r", [segLine("s1")], { s1: wavBytes(4000) });
    const b = blockingAudit();
    const p = replaySegment({ audioDir, identities: [A], role: "r", segment: "s1", by: BY, audit: b.audit });
    await b.appendCalled;
    const target = path.join(outside, "moved-index.jsonl");
    renameSync(path.join(dir, "index.jsonl"), target);
    symlinkSync(target, path.join(dir, "index.jsonl"));
    b.release(true);
    expect(await p).toStrictEqual({ ok: false, code: "store_unsafe" });
  });

  it("the index line gone while the append is blocked: not_found and zero bytes", async () => {
    const dir = mkRole(A, "r", [segLine("s1")], { s1: wavBytes(4000) });
    const b = blockingAudit();
    const p = replaySegment({ audioDir, identities: [A], role: "r", segment: "s1", by: BY, audit: b.audit });
    await b.appendCalled;
    writeFileSync(path.join(dir, "index.jsonl"), jsonl([segLine("other")]));
    b.release(true);
    expect(await p).toStrictEqual({ ok: false, code: "not_found" });
  });

  it("nothing changed while the append is blocked: the bytes are returned", async () => {
    const bytes = wavBytes(4000);
    mkRole(A, "r", [segLine("s1")], { s1: bytes });
    const b = blockingAudit();
    const p = replaySegment({ audioDir, identities: [A], role: "r", segment: "s1", by: BY, audit: b.audit });
    await b.appendCalled;
    b.release(true);
    expect(await p).toStrictEqual({ ok: true, identity: A, bytes });
  });
});

describe("replaySegment: bad ids make no file call", () => {
  const bad = ["../x", "A", "a".repeat(65), "a\0b", "", "a/b", ".", "..", " s1"];
  it.each(bad)("role %j: not_found with zero fs calls", async (role) => {
    mkRole(A, "r", [segLine("s1")], { s1: wavBytes(100) });
    hooks.calls = [];
    expectRefused(await play({ role }), "not_found");
    expect(hooks.calls).toEqual([]);
  });
  it.each(bad)("segment %j: not_found with zero fs calls", async (segment) => {
    mkRole(A, "r", [segLine("s1")], { s1: wavBytes(100) });
    hooks.calls = [];
    expectRefused(await play({ segment }), "not_found");
    expect(hooks.calls).toEqual([]);
  });
  it.each(["../x", A.toUpperCase(), A.slice(1), `${A}0`, "", `${A.slice(0, 31)}/`, `${A.slice(0, 31)}\0`])(
    "identity %j (even after a good one): not_found with zero fs calls", async (identity) => {
      mkRole(A, "r", [segLine("s1")], { s1: wavBytes(100) });
      hooks.calls = [];
      expectRefused(await play({ identities: [A, identity] }), "not_found");
      expect(hooks.calls).toEqual([]);
    });
  it("non-string ids (past the type system): not_found with zero fs calls", async () => {
    hooks.calls = [];
    expectRefused(await play({ role: undefined as unknown as string }), "not_found");
    expectRefused(await play({ identities: [null as unknown as string] }), "not_found");
    expectRefused(await play({ identities: "x" as unknown as string[] }), "not_found");
    expect(hooks.calls).toEqual([]);
  });
});
