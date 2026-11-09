import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { END_TARGET_P95_MS, START_TARGET_P95_MS, TIMINGS_MAX_BYTES, parseTimingLines, readTimingFile, summarise, voiceTimings } from "../timings.js";

/** US-0072 (EPIC-0003 voice A1c, Task 12): `pnpm voice:timings <file>`. Private temp folders; no real time. */
const ID = "a".repeat(32);
const line = (end: number, start: number, id = ID) => `session ${id} voice line timing end_to_append_ms=${end} start_to_append_ms=${start}`;
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "vo-timings-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parseTimingLines (US-0072, A1c Task 12)", () => {
  it("parses only well-formed lines", () => {
    const text = [
      line(750, 3250), line(0, 100), `${line(12, 34)}\r`,
      // Not the record's shape: ignored.
      "control service listening on 127.0.0.1:4100", `${line(1, 2)} extra`, line(1, 2).replace("session ", "session  "),
      line(-1, 2), line(1, -2), line(1.5, 2), line(1, 2).replace("end_to_append_ms", "end_to_append"), line(1, 2).replace("voice line", "voice  line"),
      `session  voice line timing end_to_append_ms=1 start_to_append_ms=2`, line(1, 2).replace("=1 ", "= "), line(1, 2).replace("=2", "=2x"),
      line(1, 2).replace("=1", "=01"), line(1, 2).replace("=1", "=1e3"), line(1, 2).replace("=1", `=${"9".repeat(16)}`), "", "   ",
      `${line(5, 6)} text=We ship in May`,
    ].join("\n");
    expect(parseTimingLines(text)).toEqual({ endToAppend: [750, 0, 12], startToAppend: [3250, 100, 34] });
  });
});

describe("summarise (US-0072, A1c Task 12)", () => {
  it("p50 and p95 by nearest rank (a fixed 20-value table)", () => {
    const values = [120, 950, 300, 40, 700, 610, 220, 1500, 80, 450, 330, 860, 90, 410, 510, 260, 180, 1020, 640, 2400];
    // Sorted: 40 80 90 120 180 220 260 300 330 410 | 450 510 610 640 700 860 950 1020 1500 2400
    expect(summarise(values)).toEqual({ count: 20, p50: 410, p95: 1500, max: 2400 });
    expect(values[0]).toBe(120); // not sorted in place
  });

  it("one value, two values, equal values", () => {
    expect(summarise([7])).toEqual({ count: 1, p50: 7, p95: 7, max: 7 });
    expect(summarise([9, 1])).toEqual({ count: 2, p50: 1, p95: 9, max: 9 });
    expect(summarise([5, 5, 5])).toEqual({ count: 3, p50: 5, p95: 5, max: 5 });
    expect(summarise([])).toBeNull();
  });
});

describe("voiceTimings (US-0072, A1c Task 12)", () => {
  const run = (args: string[], o: { initCwd?: string; cwd?: string } = {}) => {
    const out: string[] = [];
    const code = voiceTimings({ args, out: (l) => out.push(l), cwd: o.cwd ?? "/nonexistent-cwd", ...(o.initCwd !== undefined ? { initCwd: o.initCwd } : {}) });
    return { code, out };
  };

  it("prints both summaries with the targets and the reading guide, and nothing of the file but numbers", () => {
    const file = path.join(dir, "voice-timing.log");
    const lines = Array.from({ length: 20 }, (_, i) => line(100 * (i + 1), 1000 + 100 * (i + 1)));
    writeFileSync(file, `${lines.join("\n")}\nsome other line naming /secret/path and We ship in May\n`, { mode: 0o600 });
    const r = run([file]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      "voice:timings: end of speech to line (end_to_append_ms): count 20, p50 1000 ms, p95 1900 ms, max 2000 ms (target p95 at most 1000 ms: NOT met)",
      "voice:timings: first word to line, approximated by start_to_append_ms: count 20, p50 2000 ms, p95 2900 ms, max 3000 ms (target p95 at most 3000 ms: met)",
      "voice:timings: reading guide: end of speech to line: target p95 at most 1000 ms; first word to line: target p95 at most 3000 ms, approximated by start_to_append (the segment's first speech frame to the log append)",
    ]);
    expect(END_TARGET_P95_MS).toBe(1000);
    expect(START_TARGET_P95_MS).toBe(3000);
    const all = r.out.join("\n");
    for (const bad of [ID, dir, "secret", "May"]) expect(all).not.toContain(bad);
  });

  it("an empty log says no voice lines (exit 1)", () => {
    const file = path.join(dir, "empty.log");
    writeFileSync(file, "control service listening on 127.0.0.1:4100\n");
    expect(run([file])).toEqual({ code: 1, out: ["voice:timings: no voice lines in the timing record"] });
    writeFileSync(file, "");
    expect(run([file]).code).toBe(1);
  });

  it("a relative path is read from where the command was typed (INIT_CWD), else the working folder", () => {
    mkdirSync(path.join(dir, "logs"));
    writeFileSync(path.join(dir, "logs", "t.log"), `${line(10, 20)}\n`);
    expect(run(["logs/t.log"], { initCwd: dir }).code).toBe(0);
    expect(run(["logs/t.log"], { cwd: dir }).code).toBe(0);
    expect(run(["logs/t.log"], { initCwd: "relative", cwd: dir }).code).toBe(0); // a relative INIT_CWD is not trusted
  });

  it("usage and file problems exit 2 with a fixed sentence that names no path", () => {
    expect(run([]).code).toBe(2);
    expect(run(["a", "b"]).code).toBe(2);
    expect(run([""]).code).toBe(2);
    const missing = run([path.join(dir, "nope.log")]);
    expect(missing).toEqual({ code: 2, out: ["voice:timings: the file does not exist (control writes voice-timing.log in CONTROL_LOG_DIR when VOICE_TIMING_LOG=1)"] });
    const target = path.join(dir, "real.log");
    writeFileSync(target, `${line(1, 2)}\n`);
    symlinkSync(target, path.join(dir, "link.log"));
    expect(run([path.join(dir, "link.log")])).toEqual({ code: 2, out: ["voice:timings: the file is not a regular file (a link or a folder is not read)"] });
    expect(run([dir]).code).toBe(2);
    for (const r of [missing, run([path.join(dir, "link.log")]), run([dir])]) expect(r.out.join("\n")).not.toContain(dir);
  });
});

describe("readTimingFile (US-0072, A1c Task 12)", () => {
  it("refuses a file over the bound without reading it", () => {
    expect(TIMINGS_MAX_BYTES).toBe(4 * 1024 * 1024);
    const file = path.join(dir, "big.log");
    writeFileSync(file, "x".repeat(101));
    expect(readTimingFile(file, 100)).toEqual({ ok: false, why: "too_large" });
    expect(readTimingFile(file, 101)).toMatchObject({ ok: true });
  });

  it.skipIf(process.getuid?.() === 0)("an unreadable file is unreadable (non-root only: root reads anything)", () => {
    const file = path.join(dir, "locked.log");
    writeFileSync(file, "x");
    chmodSync(file, 0o000);
    expect(readTimingFile(file)).toEqual({ ok: false, why: "unreadable" });
  });
});
