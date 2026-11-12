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
const { chownSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = fs;
const { AudioCatalog } = await import("../../voice/audio-catalog.js");

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
  });
});
