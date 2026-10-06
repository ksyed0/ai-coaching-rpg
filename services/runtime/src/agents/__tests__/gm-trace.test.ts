import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGmTraceWriter, parseGmTraceEnv } from "../gm-trace.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "gm-trace-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("GM trace file", () => {
  it("appends one JSON line per reply, in a file only its owner can read", () => {
    const file = path.join(tmp(), "nested", "trace.jsonl");
    const write = createGmTraceWriter(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    write({ seq: 3, sceneId: "s", condition: "c", attempt: 1, raw: "nope", parse: { ok: false, reason: "no_json" } });
    write({ seq: 3, sceneId: "s", condition: "c", attempt: 2, raw: '{"verdict":true}', parse: { ok: true, verdict: true, via: "reask" } });
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ attempt: 2, parse: { via: "reask" } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("refuses the session log, a symbolic link and a non-file; chmods an existing file; close() stops writing", () => {
    const d = tmp();
    const log = path.join(d, "s.jsonl");
    writeFileSync(log, "");
    expect(() => createGmTraceWriter(log, { forbid: [log] })).toThrow(/session log/);
    expect(() => createGmTraceWriter(path.join(d, "x", "..", "s.jsonl"), { forbid: [log] })).toThrow(/session log/);
    const link = path.join(d, "link.jsonl");
    symlinkSync(log, link);
    expect(() => createGmTraceWriter(link)).toThrow();
    expect(() => createGmTraceWriter(path.join(d, "nested", "..", "link.jsonl"), { forbid: [] })).toThrow();
    expect(readFileSync(log, "utf8")).toBe(""); // nothing was written through the link
    const own = path.join(d, "own.jsonl");
    writeFileSync(own, "", { mode: 0o644 }); chmodSync(own, 0o644);
    const w = createGmTraceWriter(own);
    expect(statSync(own).mode & 0o777).toBe(0o600);
    w({ seq: 1, sceneId: "s", condition: "c", attempt: 1, raw: "a", parse: { ok: false, reason: "empty" } });
    w.close();
    w({ seq: 2, sceneId: "s", condition: "c", attempt: 1, raw: "b", parse: { ok: false, reason: "empty" } });
    expect(readFileSync(own, "utf8").trim().split("\n")).toHaveLength(1);
  });
  it("fails at creation, not later, when the path cannot be created", () => {
    const d = tmp();
    expect(() => createGmTraceWriter(d)).toThrow(); // a directory
  });
  it("GM_TRACE_FILE: unset or blank is off, relative paths resolve under the base directory, control characters are refused", () => {
    expect(parseGmTraceEnv(undefined, "/data")).toEqual({ ok: true, file: undefined });
    expect(parseGmTraceEnv("  ", "/data")).toEqual({ ok: true, file: undefined });
    expect(parseGmTraceEnv("gm.jsonl", "/data")).toEqual({ ok: true, file: "/data/gm.jsonl" });
    expect(parseGmTraceEnv("/tmp/x.jsonl", "/data")).toEqual({ ok: true, file: "/tmp/x.jsonl" });
    expect(parseGmTraceEnv("a\u0007b", "/data")).toMatchObject({ ok: false });
  });
});
