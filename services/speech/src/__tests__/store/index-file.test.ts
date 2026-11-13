import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendIndexLine, readIndex, writeFully, type IndexEntry } from "../../store/index-file.js";

/** US-0073 (voice A2a, Task 4): the per-role `index.jsonl`; append-only, owner-only, tolerant of a torn last line. */
let root: string;
let file: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "acr-index-")); file = path.join(root, "index.jsonl"); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const entry = (n: number, extra: Partial<IndexEntry> = {}): IndexEntry => ({ v: 1, kind: "segment", segment: `s${n}`, participantId: "p1", startMs: n * 10, endMs: n * 10 + 5, status: "transcribed", ...extra });

describe("index file", () => {
  it("test_readIndex_skips_a_deleted_line_and_keeps_the_segments (US-0075)", () => {
    appendIndexLine(file, entry(1));
    appendFileSync(file, `${JSON.stringify({ v: 1, kind: "deleted", segment: "s1", op: "0123456789abcdef", ts: 5 })}\n`);
    appendIndexLine(file, entry(2));
    expect(readIndex(file)).toEqual([entry(1), entry(2)]);
  });
  it("test_a_short_write_is_continued_until_the_whole_line_is_written", () => {
    appendIndexLine(file, entry(1));
    appendFileSync(file, '{"v":1,"kind":"segm'); // a torn line, so the prefix newline is written too
    const sizes: number[] = [];
    const short = (fd: number, buf: Buffer, off: number, len: number): number => { const n = writeSync(fd, buf, off, Math.min(len, 7)); sizes.push(n); return n; };
    const big = entry(2, { raw: "a fairly long consented line of raw text" });
    appendIndexLine(file, big, short);
    expect(sizes.length).toBeGreaterThan(3); // really written in pieces
    expect(readIndex(file)).toEqual([entry(1), big]);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });
  it("test_a_write_that_makes_no_progress_throws_a_code_only_error", () => {
    expect(() => appendIndexLine(file, entry(1), () => 0)).toThrow(/^could not write the audio index \(short_write\)$/);
    expect(() => writeFully(1, Buffer.from("x"), () => -1)).toThrow("short write");
  });
  it("test_append_then_read_round_trips", () => {
    const a = entry(1, { seq: 3, raw: "hello", timings: { vadEndMs: 4, sttMs: 9 } });
    const b = entry(2, { status: "refused:paused" });
    appendIndexLine(file, a); appendIndexLine(file, b);
    expect(readIndex(file)).toEqual([a, b]);
    expect(readFileSync(file, "utf8").split("\n")).toHaveLength(3); // two lines and the trailing newline
  });
  it("test_file_mode_is_0600", () => {
    appendIndexLine(file, entry(1));
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });
  it("test_a_missing_file_reads_as_empty", () => { expect(readIndex(file)).toEqual([]); });
  it("test_a_torn_last_line_gets_a_newline_and_is_skipped", () => {
    appendIndexLine(file, entry(1));
    appendFileSync(file, '{"v":1,"kind":"segm'); // crash mid-write
    expect(readIndex(file)).toEqual([entry(1)]);
    appendIndexLine(file, entry(2));
    expect(readIndex(file)).toEqual([entry(1), entry(2)]);
    expect(readFileSync(file, "utf8")).toContain('segm\n{');
  });
  it("test_a_torn_line_that_is_valid_json_without_newline_is_kept_and_separated", () => {
    writeFileSync(file, JSON.stringify(entry(1)), { mode: 0o600 });
    appendIndexLine(file, entry(2));
    expect(readIndex(file)).toEqual([entry(1), entry(2)]);
  });
  it("test_skips_garbage_and_wrong_shapes_without_throwing", () => {
    const good = entry(1);
    const lines = [
      "not json", "", "[]", "null", "42", '"s"',
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, kind: "deleted" }),
      JSON.stringify({ ...good, segment: 5 }),
      JSON.stringify({ ...good, startMs: "0" }),
      JSON.stringify({ ...good, status: "weird" }),
      JSON.stringify({ ...good, status: "refused:" }),
      JSON.stringify({ ...good, seq: "x" }),
      JSON.stringify({ ...good, raw: 1 }),
      JSON.stringify({ ...good, timings: { sttMs: "x" } }),
      JSON.stringify({ ...good, timings: [] }),
      JSON.stringify(good),
    ];
    writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
    expect(readIndex(file)).toEqual([good]);
  });
  it("test_accepts_every_status", () => {
    const all = (["transcribed", "empty", "stt_failed", "refused:not_in_scene"] as const).map((status, i) => entry(i, { status }));
    for (const e of all) appendIndexLine(file, e);
    expect(readIndex(file)).toEqual(all);
  });
  it("test_append_refuses_a_symlinked_index", () => {
    const target = path.join(root, "elsewhere"); writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, file);
    expect(() => appendIndexLine(file, entry(1))).toThrow();
    expect(readFileSync(target, "utf8")).toBe("");
  });
  it("test_read_refuses_a_symlinked_index_as_empty", () => {
    const target = path.join(root, "elsewhere"); writeFileSync(target, JSON.stringify(entry(1)) + "\n", { mode: 0o600 });
    symlinkSync(target, file);
    expect(readIndex(file)).toEqual([]);
  });
  it("test_append_error_does_not_leak_the_path", () => {
    const missing = path.join(root, "SECRETDIR", "index.jsonl");
    try { appendIndexLine(missing, entry(1)); throw new Error("did not throw"); } catch (e) {
      expect((e as Error).message).not.toContain("SECRETDIR");
    }
  });
});
