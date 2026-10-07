import { appendFile, chmod, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonlEventLog, LogCorruptError, MAX_EVENT_LINE_BYTES } from "../event-log.js";

const body = { type: "session.ended", reason: "script_complete" } as const;
const line = (seq: number, id = "s", extra: Record<string, unknown> = {}) => JSON.stringify({ ...body, seq, ts: seq, sessionId: id, ...extra });
const isPosix = process.platform !== "win32";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-evlog-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe("JsonlEventLog at rest (US-0018)", () => {
  it.skipIf(!isPosix)("creates the log 0600 in a 0700 directory and narrows an older, wider log to 0600", async () => {
    const sub = path.join(dir, "sessions");
    const log = new JsonlEventLog("s", sub);
    await log.append(body, 1);
    expect((await stat(sub)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(sub, "s.jsonl"))).mode & 0o777).toBe(0o600);
    await log.close();
    await writeFile(path.join(dir, "w.jsonl"), line(1, "w") + "\n");
    await chmod(path.join(dir, "w.jsonl"), 0o644);
    const w = new JsonlEventLog("w", dir);
    await w.append(body, 2);
    expect((await stat(path.join(dir, "w.jsonl"))).mode & 0o777).toBe(0o600);
    await w.close();
  });

  it("syncs (fdatasync) after every append by default, and not with sync: false", async () => {
    const probe = await open(path.join(dir, "probe"), "w");
    const proto = Object.getPrototypeOf(probe) as { datasync: () => Promise<void> };
    await probe.close();
    const spy = vi.spyOn(proto, "datasync");
    const log = new JsonlEventLog("s", dir);
    await log.append(body, 1); await log.append(body, 2);
    expect(spy).toHaveBeenCalledTimes(2);
    await log.close();
    const quick = new JsonlEventLog("q", dir, { sync: false });
    await quick.append(body, 1);
    expect(spy).toHaveBeenCalledTimes(2);
    await quick.close();
  });

  it("keeps ONE handle for appends and refuses appends after close (reads still work)", async () => {
    const log = new JsonlEventLog("s", dir);
    for (let i = 0; i < 5; i++) await log.append(body, i);
    await log.close();
    await expect(log.append(body, 9)).rejects.toMatchObject({ code: "ECLOSED" });
    expect((await log.all()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("runs the guard before every append: a lost lock makes the log fail-stop (nothing appended, then or later)", async () => {
    let ok = true;
    const log = new JsonlEventLog("s", dir, { guard: () => { if (!ok) throw new Error("lock lost"); } });
    await log.append(body, 1);
    ok = false;
    await expect(log.append(body, 2)).rejects.toMatchObject({ code: "log_failed", message: expect.stringMatching(/session lock was lost.*Restart the server/) });
    ok = true;
    await expect(log.append(body, 3)).rejects.toMatchObject({ code: "log_failed" });
    expect((await log.all()).map((e) => e.seq)).toEqual([1]);
    expect(log.failure).toMatch(/lock was lost/);
  });

  it("a guard refusal coded 'closed' (the session was closed) only refuses that append", async () => {
    let closed = true;
    const log = new JsonlEventLog("s", dir, { guard: () => { if (closed) throw Object.assign(new Error("closed"), { code: "closed" }); } });
    await expect(log.append(body, 1)).rejects.toMatchObject({ code: "closed" });
    closed = false;
    expect((await log.append(body, 2)).seq).toBe(1);
    expect(log.failure).toBeNull();
    await log.close();
  });

  it.skipIf(!isPosix)("never follows a symbolic link at the log path, for reading or appending", async () => {
    await writeFile(path.join(dir, "target"), line(1) + "\n");
    await symlink(path.join(dir, "target"), path.join(dir, "s.jsonl"));
    const log = new JsonlEventLog("s", dir);
    await expect(log.all()).rejects.toMatchObject({ code: expect.stringMatching(/ELOOP|EMLINK/) });
    await expect(log.append(body, 1)).rejects.toMatchObject({ code: expect.stringMatching(/ELOOP|EMLINK/) });
    expect(await readFile(path.join(dir, "target"), "utf8")).toBe(line(1) + "\n");
  });
});

describe("JsonlEventLog validation (fail closed)", () => {
  const write = (text: string) => writeFile(path.join(dir, "s.jsonl"), text, "utf8");
  const reads = () => new JsonlEventLog("s", dir).all();

  it.each([
    ["a seq gap", [line(1), line(3)], /line 2: seq 3 where 2 was expected/],
    ["a duplicated seq", [line(1), line(1)], /line 2: seq 1 where 2 was expected/],
    ["out-of-order seqs", [line(2), line(1)], /line 1: seq 2 where 1 was expected/],
    ["a non-integer seq", [line(1), JSON.stringify({ ...body, seq: "2", ts: 2, sessionId: "s" })], /line 2: seq 2 where/],
    ["no numeric ts", [line(1), JSON.stringify({ ...body, seq: 2, sessionId: "s" })], /line 2: no numeric ts/],
    ["another session's event", [line(1), line(2, "other")], /line 2: it belongs to another session/],
    ["an unknown event type", [line(1), line(2, "s", { type: "session.teleported" })], /line 2: unknown event type/],
    ["a JSON value that is not an object", [line(1), "[1,2]"], /line 2: not an object/],
    ["a newline-terminated garbage last line", [line(1), "{oops"], /malformed event in s\.jsonl at line 2/],
  ])("refuses %s", async (_what, lines, msg) => {
    await write(lines.join("\n") + "\n");
    await expect(reads()).rejects.toThrow(msg);
    await expect(reads()).rejects.toBeInstanceOf(LogCorruptError);
    const log = new JsonlEventLog("s", dir);
    const before = await readFile(path.join(dir, "s.jsonl"), "utf8");
    await expect(log.append(body, 1)).rejects.toThrow(msg); // and never appends to (or rewrites) such a log
    expect(await readFile(path.join(dir, "s.jsonl"), "utf8")).toBe(before);
  });

  it("does not trust non-monotonic timestamps less (it accepts them; the engine clamps new ones)", async () => {
    await write([line(1, "s", { ts: 50 }), line(2, "s", { ts: 10 })].join("\n") + "\n");
    expect((await reads()).map((e) => e.ts)).toEqual([50, 10]);
  });

  it("skips blank lines", async () => {
    await write(line(1) + "\n\n  \n" + line(2) + "\n");
    expect((await reads()).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("refuses a log over the size cap without reading it", async () => {
    await write(Array.from({ length: 50 }, (_, i) => line(i + 1)).join("\n") + "\n");
    await expect(new JsonlEventLog("s", dir, { maxBytes: 1_000 }).all()).rejects.toThrow(/larger than/);
  });

  it("refuses a line longer than the per-line cap (bounded memory even without newlines)", async () => {
    await write(line(1) + "\n" + "x".repeat(MAX_EVENT_LINE_BYTES + 10));
    await expect(reads()).rejects.toThrow(/longer than/);
  });
});

describe("JsonlEventLog streaming reads", () => {
  it("reads a multi-chunk log with lines and multi-byte characters split across chunk boundaries", async () => {
    const text = "é😀".repeat(400); // 2 + 4 bytes each: a 64 KiB chunk boundary falls inside a character somewhere
    const lines = Array.from({ length: 120 }, (_, i) => JSON.stringify({ type: "utterance", roleId: "r", text, channel: "text", seq: i + 1, ts: i, sessionId: "s" }));
    await writeFile(path.join(dir, "s.jsonl"), lines.join("\n") + "\n");
    expect((await stat(path.join(dir, "s.jsonl"))).size).toBeGreaterThan(3 * 64 * 1024);
    const seen: number[] = [];
    const r = await new JsonlEventLog("s", dir).replay((e) => { seen.push(e.seq); expect((e as { text: string }).text).toBe(text); });
    expect(r).toEqual({ events: 120, partialTailBytes: 0 });
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
  });

  it("reports a cut-off last line on replay and cuts exactly it on the next append (never rewriting the rest)", async () => {
    const file = path.join(dir, "s.jsonl");
    await writeFile(file, line(1) + "\n" + line(2) + "\n" + '{"seq":3,"t');
    const log = new JsonlEventLog("s", dir);
    expect(await log.replay(() => undefined)).toEqual({ events: 2, partialTailBytes: 11 });
    await log.append(body, 3);
    expect((await readFile(file, "utf8")).split("\n").filter(Boolean)).toEqual([line(1), line(2), JSON.stringify({ ...body, seq: 3, ts: 3, sessionId: "s" })]);
    await log.close();
  });

  it("a crash between appends (a partial write left by another writer) is repaired after the failed append re-scans", async () => {
    const file = path.join(dir, "s.jsonl");
    const log = new JsonlEventLog("s", dir);
    await log.append(body, 1);
    await appendFile(file, '{"partial');
    (log as unknown as { seq: number | null }).seq = null;
    await log.append(body, 2);
    expect((await log.all()).map((e) => e.seq)).toEqual([1, 2]);
    await log.close();
  });

  it("a directory or other non-file at the log path is an error, not an empty log", async () => {
    await mkdir(path.join(dir, "s.jsonl"));
    await expect(new JsonlEventLog("s", dir).replay(() => undefined)).rejects.toMatchObject({ code: "EISDIR" });
  });
});
