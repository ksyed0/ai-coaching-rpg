import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendDeletedLines, isDeletedLine, type DeletedIndexLine } from "../protocol.js";

/** US-0075 (voice A2b-1b, Task 1): the `deleted` index line, its guard and its one-write append, shared by control (writer) and speech (reader). */
let root: string;
let file: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "acr-deleted-line-")); file = path.join(root, "index.jsonl"); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

const OP = "0123456789abcdef";
const line = (segment: string, extra: Partial<DeletedIndexLine> = {}): DeletedIndexLine => ({ v: 1, kind: "deleted", segment, op: OP, ts: 1000, ...extra });
const linesOf = (f: string): unknown[] => readFileSync(f, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as unknown);

describe("isDeletedLine", () => {
  it("accepts a valid line", () => {
    expect(isDeletedLine(line("seg1"))).toBe(true);
    expect(isDeletedLine(line("seg1", { ts: 0 }))).toBe(true);
  });
  it.each<[string, unknown]>([
    ["wrong v", { ...line("seg1"), v: 2 }],
    ["wrong kind", { ...line("seg1"), kind: "segment" }],
    ["a segment with a slash", line("a/b")],
    ["a segment of ..", line("..")],
    ["an empty segment", line("")],
    ["a 15-hex op", line("seg1", { op: "0123456789abcde" })],
    ["a 17-hex op", line("seg1", { op: "0123456789abcdef0" })],
    ["an upper-case op", line("seg1", { op: "0123456789ABCDEF" })],
    ["a negative ts", line("seg1", { ts: -1 })],
    ["a NaN ts", line("seg1", { ts: NaN })],
    ["an infinite ts", line("seg1", { ts: Infinity })],
    ["a string ts", { ...line("seg1"), ts: "1" }],
    ["null", null],
    ["an array", []],
    ["a string", "x"],
  ])("rejects %s", (_name, x) => { expect(isDeletedLine(x)).toBe(false); });
});

describe("appendDeletedLines", () => {
  it("writes N lines in ONE write call and one fsync-bearing append", () => {
    writeFileSync(file, '{"v":1,"kind":"segment"}\n');
    const calls: number[] = [];
    const seam = (fd: number, buf: Buffer, off: number, len: number): number => { calls.push(len); return writeSync(fd, buf, off, len); };
    appendDeletedLines(file, [line("a"), line("b"), line("c")], seam);
    expect(calls).toHaveLength(1);
    expect(linesOf(file).slice(1)).toEqual([line("a"), line("b"), line("c")]);
  });
  it("starts the first line on its own line when the file ends without a newline", () => {
    writeFileSync(file, '{"v":1,"kind":"segm');
    appendDeletedLines(file, [line("a")]);
    const text = readFileSync(file, "utf8");
    expect(text).toBe(`{"v":1,"kind":"segm\n${JSON.stringify(line("a"))}\n`);
  });
  it("adds no blank line when the file already ends with a newline", () => {
    writeFileSync(file, '{"x":1}\n');
    appendDeletedLines(file, [line("a")]);
    expect(readFileSync(file, "utf8")).toBe(`{"x":1}\n${JSON.stringify(line("a"))}\n`);
  });
  it("writes nothing and succeeds for an empty list", () => {
    writeFileSync(file, "");
    appendDeletedLines(file, []);
    expect(readFileSync(file, "utf8")).toBe("");
  });
  it("refuses a symlink and leaves its target alone", () => {
    const target = path.join(root, "target.jsonl");
    writeFileSync(target, "");
    symlinkSync(target, file);
    expect(() => appendDeletedLines(file, [line("a")])).toThrow(/ELOOP/);
    expect(readFileSync(target, "utf8")).toBe("");
  });
  it("refuses a non-regular file (a directory)", () => {
    mkdirSync(file);
    expect(() => appendDeletedLines(file, [line("a")])).toThrow();
  });
  it("refuses a file of another user (stubbed uid, a real foreign file cannot be arranged)", () => {
    writeFileSync(file, "");
    vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
    expect(() => appendDeletedLines(file, [line("a")])).toThrow(/not owned/);
    expect(readFileSync(file, "utf8")).toBe("");
  });
  it("never creates a missing file", () => {
    expect(() => appendDeletedLines(file, [line("a")])).toThrow(/ENOENT/);
    expect(existsSync(file)).toBe(false);
  });
  it("continues a short write until every byte is written", () => {
    writeFileSync(file, "");
    const sizes: number[] = [];
    const short = (fd: number, buf: Buffer, off: number, len: number): number => { const n = writeSync(fd, buf, off, Math.min(len, 7)); sizes.push(n); return n; };
    appendDeletedLines(file, [line("a"), line("b")], short);
    expect(sizes.length).toBeGreaterThan(3);
    expect(linesOf(file)).toEqual([line("a"), line("b")]);
  });
  it("a write that makes no progress throws code short_write, and the message never has the path", () => {
    writeFileSync(file, "");
    let err: unknown;
    try { appendDeletedLines(file, [line("a")], () => 0); } catch (e) { err = e; }
    expect((err as NodeJS.ErrnoException).code).toBe("short_write");
    expect((err as Error).message).not.toContain(root);
    expect((err as Error).message).not.toContain("index.jsonl");
  });
  it("an open failure carries the errno code only, never the path", () => {
    let err: unknown;
    try { appendDeletedLines(file, [line("a")]); } catch (e) { err = e; }
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect((err as Error).message).not.toContain(root);
  });
});
