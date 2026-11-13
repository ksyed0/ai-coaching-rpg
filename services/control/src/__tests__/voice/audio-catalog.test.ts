import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Seam: records every path-taking fs call (to prove a refusal touches nothing) and can make fstat report a directory as owned by
// another user (by inode), so the ownership rule is tested without root. Passthrough by default.
const hooks = vi.hoisted(() => ({ calls: null as null | string[], foreignIno: new Set<number>() }));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  const rec = (name: string, p: unknown) => { hooks.calls?.push(`${name} ${String(p)}`); };
  return {
    ...actual,
    openSync: ((p: string, ...rest: unknown[]) => { rec("openSync", p); return (actual.openSync as (...a: unknown[]) => number)(p, ...rest); }) as typeof actual.openSync,
    readdirSync: ((p: string, ...rest: unknown[]) => { rec("readdirSync", p); return (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof actual.readdirSync,
    lstatSync: ((p: string, ...rest: unknown[]) => { rec("lstatSync", p); return (actual.lstatSync as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof actual.lstatSync,
    statSync: ((p: string, ...rest: unknown[]) => { rec("statSync", p); return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof actual.statSync,
    existsSync: ((p: string) => { rec("existsSync", p); return actual.existsSync(p); }) as typeof actual.existsSync,
    readFileSync: ((p: string, ...rest: unknown[]) => { rec("readFileSync", p); return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof actual.readFileSync,
    fstatSync: ((fd: number, o?: unknown) => {
      const st = actual.fstatSync(fd, o as never);
      if (st && hooks.foreignIno.has(Number(st.ino)) && typeof process.getuid === "function") Object.assign(st, { uid: process.getuid() + 1 });
      return st;
    }) as typeof actual.fstatSync,
  };
});
const fs = await import("node:fs");
const { appendFileSync, chownSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } = fs;
const { AudioCatalog, MAX_SEGMENT_INDEX_BYTES, readSegmentIndex } = await import("../../voice/audio-catalog.js");

const id = (n: number): string => n.toString(16).padStart(32, "0");
const A = id(0xa), B = id(0xb), C = id(0xc);
const S = "session-1", OTHER = "session-2";
const hasUid = typeof process.getuid === "function";
const isRoot = process.getuid?.() === 0;

let root: string, audioDir: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "acr-catalog-"));
  audioDir = path.join(root, "audio");
  mkdirSync(audioDir, { mode: 0o700 });
  hooks.calls = null;
  hooks.foreignIno.clear();
});
afterEach(() => { hooks.calls = null; hooks.foreignIno.clear(); rmSync(root, { recursive: true, force: true }); });

/** An identity folder as the worker leaves it: `<identity>/session.json` (unless `marker` is null) and a role folder with one WAV. */
function mkIdentity(identity: string, marker: unknown = { v: 1, sessionId: S }, o: { segments?: boolean } = {}): string {
  const dir = path.join(audioDir, identity);
  mkdirSync(dir, { mode: 0o700 });
  if (marker !== null) writeFileSync(path.join(dir, "session.json"), typeof marker === "string" ? marker : JSON.stringify(marker), { mode: 0o600 });
  if (o.segments !== false) {
    mkdirSync(path.join(dir, "r"), { mode: 0o700 });
    writeFileSync(path.join(dir, "r", "seg0.wav"), "RIFF....", { mode: 0o600 });
  }
  return dir;
}
const catalog = (fallbackIdentity?: (sid: string) => Promise<string | undefined>) =>
  new AudioCatalog({ audioDir, ...(fallbackIdentity ? { fallbackIdentity } : {}) });

describe("AudioCatalog.find by marker (US-0074)", () => {
  it("finds the one identity whose marker names the session", async () => {
    mkIdentity(A);
    mkIdentity(B, { v: 1, sessionId: OTHER });
    expect(await catalog().find(S)).toEqual([A]);
    expect(await catalog().find(OTHER)).toEqual([B]);
  });

  it("returns every identity of a session (a restart rotated the log), sorted", async () => {
    mkIdentity(C);
    mkIdentity(A);
    mkIdentity(B, { v: 1, sessionId: OTHER });
    expect(await catalog().find(S)).toEqual([A, C]);
  });

  it("a marker whose folder holds no segments is still returned", async () => {
    mkIdentity(A, undefined, { segments: false });
    expect(await catalog().find(S)).toEqual([A]);
  });

  it("accepts an upper-case session id the session rule allows (ruling R2)", async () => {
    mkIdentity(A, { v: 1, sessionId: "Session-X" });
    expect(await catalog().find("Session-X")).toEqual([A]);
    expect(await catalog().find("session-x")).toEqual([]);
  });

  it.each([
    ["torn JSON", '{"v":1,"sessionId":"session-1"'],
    ["v: 2", { v: 2, sessionId: S }],
    ["v as a string", { v: "1", sessionId: S }],
    ["an extra key", { v: 1, sessionId: S, extra: true }],
    ["another session", { v: 1, sessionId: OTHER }],
    ["no sessionId", { v: 1 }],
    ["an array", [1, S]],
    ["null", "null"],
    ["a bare string", JSON.stringify(S)],
    ["empty", ""],
  ])("a marker that is %s is ignored", async (_label, marker) => {
    mkIdentity(A, marker);
    mkIdentity(B);
    expect(await catalog().find(S)).toEqual([B]);
  });

  it("a marker over 4 KB is ignored, one of exactly 4 KB is read", async () => {
    const pad = (n: number) => { const base = JSON.stringify({ v: 1, sessionId: S }); return base + " ".repeat(n - base.length); };
    mkIdentity(A, pad(4097));
    mkIdentity(B, pad(4096));
    expect(await catalog().find(S)).toEqual([B]);
  });

  it("a marker that is a symlink to a valid marker elsewhere is ignored", async () => {
    const elsewhere = path.join(root, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ v: 1, sessionId: S }), { mode: 0o600 });
    const dir = mkIdentity(A, null);
    symlinkSync(elsewhere, path.join(dir, "session.json"));
    expect(await catalog().find(S)).toEqual([]);
  });

  it("a marker that is a directory (not a regular file) is ignored", async () => {
    const dir = mkIdentity(A, null);
    mkdirSync(path.join(dir, "session.json"));
    expect(await catalog().find(S)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("a FIFO as the marker or as an identity folder is ignored and never hangs the scan", async () => {
    const dir = mkIdentity(A, null);
    execFileSync("mkfifo", [path.join(dir, "session.json")]);
    execFileSync("mkfifo", [path.join(audioDir, C)]);
    mkIdentity(B);
    expect(await catalog().find(S)).toEqual([B]);
    expect(await catalog(async () => C).find(OTHER)).toEqual([]);
  }, 5_000);

  it("a valid marker in a folder whose name is not 32 lower-case hex is ignored", async () => {
    for (const name of [A.toUpperCase(), A.slice(1), `${A}0`, `${A}.deleting-0a1b`, "session-1", ".hidden"]) {
      mkdirSync(path.join(audioDir, name), { mode: 0o700 });
      writeFileSync(path.join(audioDir, name, "session.json"), JSON.stringify({ v: 1, sessionId: S }), { mode: 0o600 });
    }
    expect(await catalog().find(S)).toEqual([]);
  });

  it("an identity name that is a symlink to a folder holding a valid marker is ignored", async () => {
    const real = path.join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    writeFileSync(path.join(real, "session.json"), JSON.stringify({ v: 1, sessionId: S }), { mode: 0o600 });
    symlinkSync(real, path.join(audioDir, A));
    expect(await catalog().find(S)).toEqual([]);
  });

  it("an identity name that is a regular file is ignored", async () => {
    writeFileSync(path.join(audioDir, A), JSON.stringify({ v: 1, sessionId: S }));
    expect(await catalog().find(S)).toEqual([]);
  });

  it.skipIf(!hasUid)("a folder owned by another user is skipped (seam)", async () => {
    mkIdentity(A);
    mkIdentity(B);
    hooks.foreignIno.add(Number(fs.lstatSync(path.join(audioDir, A)).ino));
    expect(await catalog().find(S)).toEqual([B]);
  });

  it.skipIf(!hasUid)("a marker file owned by another user is ignored (seam)", async () => {
    const dir = mkIdentity(A);
    mkIdentity(B);
    hooks.foreignIno.add(Number(fs.lstatSync(path.join(dir, "session.json")).ino));
    expect(await catalog().find(S)).toEqual([B]);
  });

  it.skipIf(!isRoot)("a folder really owned by another user is skipped (only as root, which can chown)", async () => {
    const dir = mkIdentity(A);
    mkIdentity(B);
    chownSync(dir, 12345, 12345);
    expect(await catalog().find(S)).toEqual([B]);
  });

  it.skipIf(!hasUid)("an audio directory owned by another user returns [] (seam)", async () => {
    mkIdentity(A);
    hooks.foreignIno.add(Number(fs.lstatSync(audioDir).ino));
    expect(await catalog().find(S)).toEqual([]);
  });

  it("keeps no cache: a marker created after a miss is found by the next call, and a removed one is gone", async () => {
    const c = catalog();
    expect(await c.find(S)).toEqual([]);
    const dir = mkIdentity(A);
    expect(await c.find(S)).toEqual([A]);
    rmSync(path.join(dir, "session.json"));
    expect(await c.find(S)).toEqual([]);
  });

  it("a missing audio directory returns [] and never throws", async () => {
    rmSync(audioDir, { recursive: true });
    await expect(catalog().find(S)).resolves.toEqual([]);
  });

  it("an audio directory that is a symlink or a file returns []", async () => {
    const real = path.join(root, "real-audio");
    mkdirSync(real, { mode: 0o700 });
    mkdirSync(path.join(real, A), { mode: 0o700 });
    writeFileSync(path.join(real, A, "session.json"), JSON.stringify({ v: 1, sessionId: S }));
    rmSync(audioDir, { recursive: true });
    symlinkSync(real, audioDir);
    expect(await catalog().find(S)).toEqual([]);
    rmSync(audioDir);
    writeFileSync(audioDir, "x");
    expect(await catalog().find(S)).toEqual([]);
  });

  it.each(["../x", "x".repeat(65), "a\0b", "a/b", "", ".", "a b"])("an invalid session id %j returns [] without a single file call", async (bad) => {
    mkIdentity(A, { v: 1, sessionId: bad });
    const fallback = vi.fn(async () => A);
    hooks.calls = [];
    expect(await catalog(fallback).find(bad)).toEqual([]);
    expect(hooks.calls).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("a non-string session id returns [] without a file call", async () => {
    hooks.calls = [];
    for (const bad of [undefined, null, 7, ["session-1"]] as unknown[]) expect(await catalog().find(bad as string)).toEqual([]);
    expect(hooks.calls).toEqual([]);
  });

  it("never probes a path before opening it (open-then-check only)", async () => {
    mkIdentity(A);
    mkIdentity(B, { v: 1, sessionId: OTHER });
    hooks.calls = [];
    expect(await catalog(async () => C).find(S)).toEqual([A]);
    expect(hooks.calls.filter((c) => /^(lstatSync|statSync|existsSync|readFileSync) /.test(c))).toEqual([]);
    // every listing comes right after the directory was opened
    hooks.calls.forEach((c, i) => {
      if (c.startsWith("readdirSync ")) expect(hooks.calls![i - 1]).toBe(`openSync ${c.slice("readdirSync ".length)}`);
    });
  });
});

describe("AudioCatalog.find fallback (US-0074, spec section 3)", () => {
  it("is used when no marker matches and its folder is a real directory of this user", async () => {
    mkIdentity(A, null);
    mkIdentity(B, { v: 1, sessionId: OTHER });
    const fallback = vi.fn(async () => A);
    expect(await catalog(fallback).find(S)).toEqual([A]);
    expect(fallback).toHaveBeenCalledWith(S);
  });

  it("is never consulted when a marker matched", async () => {
    mkIdentity(A);
    const fallback = vi.fn(async () => B);
    mkIdentity(B, null);
    expect(await catalog(fallback).find(S)).toEqual([A]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("an undefined answer gives []", async () => {
    mkIdentity(A, null);
    expect(await catalog(async () => undefined).find(S)).toEqual([]);
  });

  it.each([["upper case", A.toUpperCase()], ["too short", A.slice(1)], ["a path", `../${A}`], ["empty", ""], ["not a string", 7 as unknown as string]])(
    "is ignored when its identity is malformed (%s)", async (_l, answer) => {
      mkIdentity(A, null);
      expect(await catalog(async () => answer).find(S)).toEqual([]);
    });

  it("is ignored when its folder is missing", async () => {
    expect(await catalog(async () => A).find(S)).toEqual([]);
  });

  it("is ignored when its folder is a symlink or a file", async () => {
    const real = path.join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, path.join(audioDir, A));
    writeFileSync(path.join(audioDir, B), "x");
    expect(await catalog(async () => A).find(S)).toEqual([]);
    expect(await catalog(async () => B).find(S)).toEqual([]);
  });

  it.skipIf(!hasUid)("is ignored when its folder is owned by another user (seam)", async () => {
    mkIdentity(A, null);
    hooks.foreignIno.add(Number(fs.lstatSync(path.join(audioDir, A)).ino));
    expect(await catalog(async () => A).find(S)).toEqual([]);
  });

  it("a rejecting or throwing fallback is treated as undefined", async () => {
    mkIdentity(A, null);
    expect(await catalog(async () => { throw new Error("log unreadable"); }).find(S)).toEqual([]);
    expect(await catalog((() => { throw new Error("sync"); }) as never).find(S)).toEqual([]);
  });

  it("is not consulted when the audio directory is missing", async () => {
    rmSync(audioDir, { recursive: true });
    const fallback = vi.fn(async () => A);
    expect(await catalog(fallback).find(S)).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([
    ["a marker for another session", { v: 1, sessionId: OTHER }],
    ["a torn marker", '{"v":1,"sessionId":'],
    ["a marker of another v", { v: 2, sessionId: S }],
    ["a marker with an extra key", { v: 1, sessionId: S, extra: 1 }],
    ["an oversized marker", JSON.stringify({ v: 1, sessionId: S }) + " ".repeat(5000)],
  ])("is refused when its folder holds %s (only a folder with NO marker is a pre-marker folder)", async (_l, marker) => {
    mkIdentity(A, marker);
    expect(await catalog(async () => A).find(S)).toEqual([]);
  });

  it("is refused when its folder's marker is a symlink (even to a valid marker of this session) or a directory", async () => {
    const elsewhere = path.join(root, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ v: 1, sessionId: S }), { mode: 0o600 });
    symlinkSync(elsewhere, path.join(mkIdentity(A, null), "session.json"));
    mkdirSync(path.join(mkIdentity(B, null), "session.json"));
    expect(await catalog(async () => A).find(S)).toEqual([]);
    expect(await catalog(async () => B).find(S)).toEqual([]);
  });
});

describe("AudioCatalog.find needs a private audio directory (ruling R3)", () => {
  it.skipIf(isRoot).each([0o770, 0o777, 0o720, 0o702])("a root with mode %o (group or other writable) returns [] even with a valid marker folder", async (mode) => {
    mkIdentity(A);
    mkIdentity(B, null);
    fs.chmodSync(audioDir, mode);
    try {
      expect(await catalog().find(S)).toEqual([]);
      expect(await catalog(async () => B).find(OTHER)).toEqual([]);
    } finally { fs.chmodSync(audioDir, 0o700); }
  });

  it.skipIf(isRoot).each([0o700, 0o750, 0o755])("a root with mode %o works as before", async (mode) => {
    mkIdentity(A);
    fs.chmodSync(audioDir, mode);
    expect(await catalog().find(S)).toEqual([A]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Task 5: list(identity) and readSegmentIndex (US-0074, spec section 4)
// ---------------------------------------------------------------------------------------------------------------------------------

const SECRET = "the secret words somebody said";
/** A `kind:"segment"` index line as the worker writes it (with `raw` and `timings`, which must never be copied out). */
const segLine = (segment: string, startMs: number, extra: Record<string, unknown> = {}) =>
  ({ v: 1, kind: "segment", segment, participantId: `p-${segment}`, startMs, endMs: startMs + 500, status: "transcribed", raw: SECRET, timings: { sttMs: 3 }, ...extra });
const delLine = (segment: string) => ({ v: 1, kind: "deleted", segment, op: "op-1", ts: 1 });
const jsonl = (lines: unknown[]): string => lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";

/** A role folder `<identity>/<role>` with an `index.jsonl` (unless `index` is null) and one small WAV per name in `wavs`. */
function mkRole(identity: string, role: string, index: unknown[] | string | null, wavs: string[] = []): string {
  const idDir = path.join(audioDir, identity);
  mkdirSync(idDir, { recursive: true, mode: 0o700 });
  const dir = path.join(idDir, role);
  mkdirSync(dir, { mode: 0o700 });
  if (index !== null) writeFileSync(path.join(dir, "index.jsonl"), typeof index === "string" ? index : jsonl(index), { mode: 0o600 });
  for (const w of wavs) writeFileSync(path.join(dir, `${w}.wav`), "RIFF....WAVE", { mode: 0o600 });
  return dir;
}
const audit = (identity: string, lines: unknown[] | string) =>
  writeFileSync(path.join(audioDir, `${identity}.audio-audit.jsonl`), typeof lines === "string" ? lines : jsonl(lines), { mode: 0o600 });
const segsOf = async (identity = A) => (await catalog().list(identity)).segments;
const keyOf = (s: { role: string; segment: string }) => `${s.role}/${s.segment}`;

describe("AudioCatalog.list (US-0074, Task 5)", () => {
  it("lists two roles with exact fields, sorted by role, start and segment, and never copies raw", async () => {
    mkRole(A, "beta", [segLine("s3", 500, { status: "refused:consent" })], ["s3"]);
    mkRole(A, "alpha", [segLine("s2", 2000, { seq: 2 }), segLine("s1", 1000, { seq: 1 }), segLine("s0", 1000, { status: "empty" })], ["s0", "s1", "s2"]);
    const r = await catalog().list(A);
    expect(r).toStrictEqual({
      recordingStopped: false,
      segments: [
        { role: "alpha", segment: "s0", participantId: "p-s0", startMs: 1000, endMs: 1500, status: "empty", audio: "available" },
        { role: "alpha", segment: "s1", participantId: "p-s1", startMs: 1000, endMs: 1500, status: "transcribed", seq: 1, audio: "available" },
        { role: "alpha", segment: "s2", participantId: "p-s2", startMs: 2000, endMs: 2500, status: "transcribed", seq: 2, audio: "available" },
        { role: "beta", segment: "s3", participantId: "p-s3", startMs: 500, endMs: 1000, status: "refused:consent", audio: "available" },
      ],
    });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain("timings");
  });

  it("a deleted line marks its segment deleted (with or without the WAV); a deleted line for an unknown segment is ignored", async () => {
    const dir = mkRole(A, "r", [segLine("s1", 1), segLine("s2", 2), segLine("s3", 3), delLine("s1"), delLine("s3"), delLine("ghost")], ["s1", "s2"]);
    expect(fs.existsSync(path.join(dir, "s3.wav"))).toBe(false);
    expect((await segsOf()).map((s) => [s.segment, s.audio])).toEqual([["s1", "deleted"], ["s2", "available"], ["s3", "deleted"]]);
  });

  it("a WAV removed on disk gives missing", async () => {
    const dir = mkRole(A, "r", [segLine("s1", 1), segLine("s2", 2)], ["s1", "s2"]);
    rmSync(path.join(dir, "s2.wav"));
    expect((await segsOf()).map((s) => [s.segment, s.audio])).toEqual([["s1", "available"], ["s2", "missing"]]);
  });

  it("a WAV with no index line yet (worker mid-write) is not listed", async () => {
    mkRole(A, "r", [segLine("s1", 1)], ["s1", "s2"]);
    expect((await segsOf()).map(keyOf)).toEqual(["r/s1"]);
  });

  it("a WAV that is a symlink, a hard link (nlink 2), a directory or a FIFO is missing", async () => {
    const dir = mkRole(A, "r", [segLine("s1", 1), segLine("s2", 2), segLine("s3", 3), segLine("s4", 4), segLine("s5", 5)], ["s1"]);
    const elsewhere = path.join(root, "elsewhere.wav");
    writeFileSync(elsewhere, "RIFF....WAVE", { mode: 0o600 });
    symlinkSync(elsewhere, path.join(dir, "s2.wav"));
    writeFileSync(path.join(dir, "s3.wav"), "RIFF....WAVE", { mode: 0o600 });
    linkSync(path.join(dir, "s3.wav"), path.join(root, "second-name.wav"));
    mkdirSync(path.join(dir, "s4.wav"));
    if (process.platform !== "win32") execFileSync("mkfifo", [path.join(dir, "s5.wav")]);
    expect((await segsOf()).map((s) => [s.segment, s.audio])).toEqual([["s1", "available"], ["s2", "missing"], ["s3", "missing"], ["s4", "missing"], ["s5", "missing"]]);
  }, 5_000);

  it.skipIf(!hasUid)("a WAV owned by another user is missing (seam)", async () => {
    const dir = mkRole(A, "r", [segLine("s1", 1)], ["s1"]);
    hooks.foreignIno.add(Number(fs.lstatSync(path.join(dir, "s1.wav")).ino));
    expect((await segsOf()).map((s) => s.audio)).toEqual(["missing"]);
  });

  it("a torn last line is skipped and the lines before it are kept", async () => {
    mkRole(A, "r", jsonl([segLine("s1", 1)]) + JSON.stringify(segLine("s2", 2)).slice(0, 40), ["s1", "s2"]);
    expect((await segsOf()).map(keyOf)).toEqual(["r/s1"]);
  });

  it.each([
    ["v: 2", segLine("x", 1, { v: 2 })],
    ["v as a string", segLine("x", 1, { v: "1" })],
    ["no v", { ...segLine("x", 1), v: undefined }],
    ["another kind", segLine("x", 1, { kind: "note" })],
    ["startMs a string", segLine("x", 1, { startMs: "1" })],
    ["endMs negative", segLine("x", 1, { endMs: -1 })],
    ["endMs missing", { ...segLine("x", 1), endMs: undefined }],
    ["seq a string", segLine("x", 1, { seq: "1" })],
    ["seq a fraction", segLine("x", 1, { seq: 1.5 })],
    ["status unknown", segLine("x", 1, { status: "great" })],
    ["status a bare refused:", segLine("x", 1, { status: "refused:" })],
    ["status a number", segLine("x", 1, { status: 1 })],
    ["participantId a number", segLine("x", 1, { participantId: 7 })],
    ["raw a number", segLine("x", 1, { raw: 7 })],
    ["timings malformed", segLine("x", 1, { timings: { sttMs: "3" } })],
    ["segment with a separator", segLine("../x", 1)],
    ["segment upper case", segLine("X", 1)],
    ["segment a number", segLine("x", 1, { segment: 7 })],
    ["an array", "[1,2]"],
    ["null", "null"],
    ["a number", "42"],
    ["garbage", "{not json"],
  ])("a line that is %s is skipped (strict shape)", async (_l, bad) => {
    mkRole(A, "r", [segLine("ok", 0), bad], ["ok", "x", "X"]);
    expect((await segsOf()).map(keyOf)).toEqual(["r/ok"]);
  });

  it("a deleted line of another v or with a bad segment marks nothing", async () => {
    mkRole(A, "r", [segLine("s1", 1), { ...delLine("s1"), v: 2 }, { ...delLine("s1"), segment: 7 }], ["s1"]);
    expect((await segsOf()).map((s) => s.audio)).toEqual(["available"]);
  });

  it("a second segment line for the same id does not duplicate it (the first wins)", async () => {
    mkRole(A, "r", [segLine("s1", 1), segLine("s1", 99)], ["s1"]);
    expect((await segsOf()).map((s) => [s.segment, s.startMs])).toEqual([["s1", 1]]);
  });

  it("a deleted line placed BEFORE its segment line still marks the segment deleted", async () => {
    mkRole(A, "r", [delLine("s1"), segLine("s1", 1), segLine("s2", 2)], ["s1", "s2"]);
    expect((await segsOf()).map((s) => [s.segment, s.audio])).toEqual([["s1", "deleted"], ["s2", "available"]]);
  });

  it("a later duplicate segment line after a deleted line does not clear the mark, and the first line's fields are kept", async () => {
    mkRole(A, "r", [segLine("s1", 1), delLine("s1"), segLine("s1", 99)], ["s1"]);
    expect((await segsOf()).map((s) => [s.segment, s.startMs, s.audio])).toEqual([["s1", 1, "deleted"]]);
  });

  it("an index over 64 MiB (sparse) contributes nothing for that role only; one of exactly 64 MiB is read", async () => {
    const big = mkRole(A, "big", [segLine("b1", 1)], ["b1"]);
    truncateSync(path.join(big, "index.jsonl"), MAX_SEGMENT_INDEX_BYTES + 1);
    const edge = mkRole(A, "edge", [segLine("e1", 1)], ["e1"]);
    truncateSync(path.join(edge, "index.jsonl"), MAX_SEGMENT_INDEX_BYTES);
    mkRole(A, "ok", [segLine("o1", 1)], ["o1"]);
    expect(MAX_SEGMENT_INDEX_BYTES).toBe(64 * 1024 * 1024);
    expect((await segsOf()).map(keyOf)).toEqual(["edge/e1", "ok/o1"]);
  }, 30_000);

  it.skipIf(isRoot)("an unreadable index (mode 000) contributes nothing and never throws", async () => {
    const dir = mkRole(A, "locked", [segLine("l1", 1)], ["l1"]);
    mkRole(A, "ok", [segLine("o1", 1)], ["o1"]);
    fs.chmodSync(path.join(dir, "index.jsonl"), 0o000);
    try { expect((await segsOf()).map(keyOf)).toEqual(["ok/o1"]); } finally { fs.chmodSync(path.join(dir, "index.jsonl"), 0o600); }
  });

  it("a missing index means no segments for that role", async () => {
    mkRole(A, "noindex", null, ["n1"]);
    mkRole(A, "ok", [segLine("o1", 1)], ["o1"]);
    expect((await segsOf()).map(keyOf)).toEqual(["ok/o1"]);
  });

  it("an index that is a symlink, a directory or a FIFO contributes nothing (and never hangs)", async () => {
    const elsewhere = path.join(root, "elsewhere.jsonl");
    writeFileSync(elsewhere, jsonl([segLine("l1", 1)]), { mode: 0o600 });
    symlinkSync(elsewhere, path.join(mkRole(A, "link", null, ["l1"]), "index.jsonl"));
    mkdirSync(path.join(mkRole(A, "dir", null, ["d1"]), "index.jsonl"));
    if (process.platform !== "win32") execFileSync("mkfifo", [path.join(mkRole(A, "fifo", null, ["f1"]), "index.jsonl")]);
    mkRole(A, "ok", [segLine("o1", 1)], ["o1"]);
    expect((await segsOf()).map(keyOf)).toEqual(["ok/o1"]);
  }, 5_000);

  it.skipIf(!hasUid)("an index owned by another user contributes nothing (seam)", async () => {
    const dir = mkRole(A, "foreign", [segLine("f1", 1)], ["f1"]);
    mkRole(A, "ok", [segLine("o1", 1)], ["o1"]);
    hooks.foreignIno.add(Number(fs.lstatSync(path.join(dir, "index.jsonl")).ino));
    expect((await segsOf()).map(keyOf)).toEqual(["ok/o1"]);
  });

  it("a role folder that is a symlink, a file, or has a name that is not file-safe is ignored", async () => {
    const real = path.join(root, "real-role");
    mkdirSync(real, { mode: 0o700 });
    writeFileSync(path.join(real, "index.jsonl"), jsonl([segLine("l1", 1)]), { mode: 0o600 });
    writeFileSync(path.join(real, "l1.wav"), "RIFF");
    mkdirSync(path.join(audioDir, A), { mode: 0o700 });
    symlinkSync(real, path.join(audioDir, A, "linked"));
    writeFileSync(path.join(audioDir, A, "afile"), jsonl([segLine("f1", 1)]));
    for (const bad of ["Upper", "has.dot", "x".repeat(65), ".hidden"]) mkRole(A, bad, [segLine("b1", 1)], ["b1"]);
    mkRole(A, "ok", [segLine("o1", 1)], ["o1"]);
    expect((await segsOf()).map(keyOf)).toEqual(["ok/o1"]);
  });

  it.skipIf(!hasUid)("a role folder owned by another user is ignored (seam)", async () => {
    const dir = mkRole(A, "foreign", [segLine("f1", 1)], ["f1"]);
    mkRole(A, "ok", [segLine("o1", 1)], ["o1"]);
    hooks.foreignIno.add(Number(fs.lstatSync(dir).ino));
    expect((await segsOf()).map(keyOf)).toEqual(["ok/o1"]);
  });

  it("a missing identity folder lists no segments; an identity folder that is a symlink lists none", async () => {
    expect(await catalog().list(A)).toEqual({ segments: [], recordingStopped: false });
    const real = path.join(root, "real-id");
    mkdirSync(path.join(real, "r"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(real, "r", "index.jsonl"), jsonl([segLine("s1", 1)]));
    symlinkSync(real, path.join(audioDir, B));
    expect((await catalog().list(B)).segments).toEqual([]);
  });

  it("lists only the asked identity's segments", async () => {
    mkRole(A, "r", [segLine("a1", 1)], ["a1"]);
    mkRole(B, "r", [segLine("b1", 1)], ["b1"]);
    expect((await segsOf(B)).map(keyOf)).toEqual(["r/b1"]);
  });

  it.each(["../x", A.toUpperCase(), A.slice(1), "", `${A}/r`])("a bad identity %j lists nothing without a single file call", async (bad) => {
    mkRole(A, "r", [segLine("s1", 1)], ["s1"]);
    hooks.calls = [];
    expect(await catalog().list(bad)).toEqual({ segments: [], recordingStopped: false });
    for (const v of [undefined, null, 7] as unknown[]) expect(await catalog().list(v as string)).toEqual({ segments: [], recordingStopped: false });
    expect(hooks.calls).toEqual([]);
  });

  it.skipIf(isRoot).each([0o770, 0o777, 0o702])("a root with mode %o (group or other writable) lists nothing", async (mode) => {
    mkRole(A, "r", [segLine("s1", 1)], ["s1"]);
    audit(A, [{ v: 1, ts: 1, type: "voice.recording_stopped", reason: "disk_low" }]);
    fs.chmodSync(audioDir, mode);
    try { expect(await catalog().list(A)).toEqual({ segments: [], recordingStopped: false }); } finally { fs.chmodSync(audioDir, 0o700); }
  });

  it("a missing or symlinked audio directory lists nothing and never throws", async () => {
    rmSync(audioDir, { recursive: true });
    await expect(catalog().list(A)).resolves.toEqual({ segments: [], recordingStopped: false });
    const real = path.join(root, "real-audio");
    mkdirSync(path.join(real, A, "r"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(real, A, "r", "index.jsonl"), jsonl([segLine("s1", 1)]));
    symlinkSync(real, audioDir);
    expect(await catalog().list(A)).toEqual({ segments: [], recordingStopped: false });
  });

  it("never probes a path before opening it (open-then-check only)", async () => {
    mkRole(A, "r", [segLine("s1", 1), segLine("s2", 2)], ["s1"]);
    mkRole(A, "q", null, ["q1"]);
    audit(A, [{ v: 1, ts: 1, type: "voice.recording_stopped", reason: "disk_low" }]);
    hooks.calls = [];
    expect((await catalog().list(A)).segments.length).toBe(2);
    expect(hooks.calls.filter((c) => /^(lstatSync|statSync|existsSync|readFileSync) /.test(c))).toEqual([]);
    hooks.calls.forEach((c, i) => {
      if (c.startsWith("readdirSync ")) expect(hooks.calls![i - 1]).toBe(`openSync ${c.slice("readdirSync ".length)}`);
    });
  });
});

describe("AudioCatalog.list recordingStopped (US-0074, Task 5)", () => {
  const stopped = { v: 1, ts: 2, type: "voice.recording_stopped", reason: "write_error" };
  const optedIn = { v: 1, ts: 1, type: "voice.opted_in", role: "r", participant: "p1", noticeVersion: "v3" };
  const rs = async (identity = A) => (await catalog().list(identity)).recordingStopped;

  it("is true when the identity's audit file has a voice.recording_stopped line, false when it has none", async () => {
    audit(A, [optedIn, stopped]);
    audit(B, [optedIn]);
    expect(await rs(A)).toBe(true);
    expect(await rs(B)).toBe(false);
    expect(await rs(C)).toBe(false); // no audit file at all
  });

  it("survives a torn last line", async () => {
    audit(A, jsonl([stopped]) + '{"v":1,"type":"voice.op');
    expect(await rs(A)).toBe(true);
  });

  it("never matches by substring", async () => {
    audit(A, [{ ...optedIn, role: "x voice.recording_stopped" }, { v: 1, ts: 3, type: "x voice.recording_stopped" }, { v: 1, note: '"type":"voice.recording_stopped"' }]);
    appendFileSync(path.join(audioDir, `${A}.audio-audit.jsonl`), 'garbage "type":"voice.recording_stopped"\n');
    expect(await rs(A)).toBe(false);
  });

  it("is false for a line of another v, a garbled file, a symlinked file or a directory", async () => {
    audit(A, [{ ...stopped, v: 2 }]);
    expect(await rs(A)).toBe(false);
    audit(B, "\u0000\u0001 not json at all");
    expect(await rs(B)).toBe(false);
    const elsewhere = path.join(root, "elsewhere-audit.jsonl");
    writeFileSync(elsewhere, jsonl([stopped]), { mode: 0o600 });
    symlinkSync(elsewhere, path.join(audioDir, `${C}.audio-audit.jsonl`));
    expect(await rs(C)).toBe(false);
    const D = id(0xd);
    mkdirSync(path.join(audioDir, `${D}.audio-audit.jsonl`));
    expect(await rs(D)).toBe(false);
  });

  it.skipIf(!hasUid)("is false when the audit file is owned by another user (seam)", async () => {
    audit(A, [stopped]);
    hooks.foreignIno.add(Number(fs.lstatSync(path.join(audioDir, `${A}.audio-audit.jsonl`)).ino));
    expect(await rs(A)).toBe(false);
  });

  it("is false when the audit file is over 64 MiB (sparse)", async () => {
    audit(A, [stopped]);
    truncateSync(path.join(audioDir, `${A}.audio-audit.jsonl`), MAX_SEGMENT_INDEX_BYTES + 1);
    expect(await rs(A)).toBe(false);
  }, 30_000);
});

describe("readSegmentIndex (US-0074, ruling R1)", () => {
  it("maps each segment to its entry (no raw, no timings) and its deleted flag", async () => {
    mkRole(A, "r", [segLine("s1", 1, { seq: 4 }), segLine("s2", 2), delLine("s2"), delLine("ghost")]);
    const m = await readSegmentIndex(audioDir, A, "r");
    expect(m).not.toBeNull();
    expect([...m!.entries()]).toStrictEqual([
      ["s1", { entry: { participantId: "p-s1", startMs: 1, endMs: 501, status: "transcribed", seq: 4 }, deleted: false }],
      ["s2", { entry: { participantId: "p-s2", startMs: 2, endMs: 502, status: "transcribed" }, deleted: true }],
    ]);
  });

  it("a missing index gives an empty Map", async () => {
    mkRole(A, "r", null, ["s1"]);
    const m = await readSegmentIndex(audioDir, A, "r");
    expect(m).toBeInstanceOf(Map);
    expect(m!.size).toBe(0);
  });

  it("an index that is a symlink, over the cap or another user's gives null", async () => {
    const elsewhere = path.join(root, "elsewhere.jsonl");
    writeFileSync(elsewhere, jsonl([segLine("s1", 1)]), { mode: 0o600 });
    symlinkSync(elsewhere, path.join(mkRole(A, "link", null), "index.jsonl"));
    expect(await readSegmentIndex(audioDir, A, "link")).toBeNull();
    const big = mkRole(A, "big", [segLine("s1", 1)]);
    truncateSync(path.join(big, "index.jsonl"), MAX_SEGMENT_INDEX_BYTES + 1);
    expect(await readSegmentIndex(audioDir, A, "big")).toBeNull();
    if (hasUid) {
      const f = mkRole(A, "foreign", [segLine("s1", 1)]);
      hooks.foreignIno.add(Number(fs.lstatSync(path.join(f, "index.jsonl")).ino));
      expect(await readSegmentIndex(audioDir, A, "foreign")).toBeNull();
    }
  }, 30_000);

  it("a missing or symlinked role or identity folder, or an unsafe root, gives null", async () => {
    mkRole(A, "r", [segLine("s1", 1)]);
    expect(await readSegmentIndex(audioDir, A, "nope")).toBeNull();
    expect(await readSegmentIndex(audioDir, B, "r")).toBeNull();
    symlinkSync(path.join(audioDir, A, "r"), path.join(audioDir, A, "linked"));
    expect(await readSegmentIndex(audioDir, A, "linked")).toBeNull();
    symlinkSync(path.join(audioDir, A), path.join(audioDir, C));
    expect(await readSegmentIndex(audioDir, C, "r")).toBeNull();
    if (!isRoot) {
      fs.chmodSync(audioDir, 0o777);
      try { expect(await readSegmentIndex(audioDir, A, "r")).toBeNull(); } finally { fs.chmodSync(audioDir, 0o700); }
    }
    expect((await readSegmentIndex(audioDir, A, "r"))!.size).toBe(1);
  });

  it.each([
    ["identity upper case", A.toUpperCase(), "r"], ["identity a path", `../${A}`, "r"], ["identity short", A.slice(1), "r"],
    ["role a path", A, "../r"], ["role upper case", A, "R"], ["role empty", A, ""], ["role too long", A, "r".repeat(65)],
    ["role not a string", A, 7 as unknown as string], ["identity not a string", null as unknown as string, "r"],
  ])("a bad id (%s) gives null without a single file call", async (_l, identity, role) => {
    mkRole(A, "r", [segLine("s1", 1)]);
    hooks.calls = [];
    expect(await readSegmentIndex(audioDir, identity, role)).toBeNull();
    expect(hooks.calls).toEqual([]);
  });
});
