import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync, linkSync, mkdirSync } from "node:fs";
import { readOnce } from "./read-once.js";
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
    write({ seq: 3, sceneId: "s", condition: "c", attempt: 1, nonce: null, raw: "nope", parse: { ok: false, reason: "no_json" } });
    write({ seq: 3, sceneId: "s", condition: "c", attempt: 2, nonce: null, raw: '{"verdict":true}', parse: { ok: true, verdict: true, via: "reask" } });
    const seen = readOnce(file); // one open: type, mode and text from the same descriptor
    expect(seen.isFile).toBe(true);
    expect(seen.mode).toBe(0o600);
    const lines = seen.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ attempt: 2, parse: { via: "reask" } });
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
    w({ seq: 1, sceneId: "s", condition: "c", attempt: 1, nonce: null, raw: "a", parse: { ok: false, reason: "empty" } });
    w.close();
    w({ seq: 2, sceneId: "s", condition: "c", attempt: 1, nonce: null, raw: "b", parse: { ok: false, reason: "empty" } });
    const after = readOnce(own);
    expect(after.mode).toBe(0o600); // an existing 0644 file was chmodded through the writer's descriptor
    expect(after.text.trim().split("\n")).toHaveLength(1);
  });
  it("refuses ANY *.jsonl in the sessions directory, and a file with several hard links", () => {
    const d = tmp();
    const sessions = path.join(d, "sessions"); mkdirSync(sessions);
    expect(() => createGmTraceWriter(path.join(sessions, "other.jsonl"), { forbidDir: sessions })).toThrow(/session log/);
    expect(() => createGmTraceWriter(path.join(sessions, "gm.txt"), { forbidDir: sessions })).not.toThrow();
    const a = path.join(d, "a.jsonl"); writeFileSync(a, "");
    linkSync(a, path.join(d, "b.jsonl"));
    expect(() => createGmTraceWriter(path.join(d, "b.jsonl"))).toThrow(/hard links/);
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
