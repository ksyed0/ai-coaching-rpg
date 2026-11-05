import os from "node:os";
import { describe, expect, it } from "vitest";
import { buildReport, exitCodeFor, formatChecklist, scrubText, type CheckResult } from "../report.js";

const r = (id: string, status: CheckResult["status"], details = "d"): CheckResult => ({ id, title: `title ${id}`, status, details, durationMs: 3 });
const base = { tool: "acr-demo", version: "1.2.3", mode: "mock" as const, startedAt: "2030-01-01T00:00:00.000Z", durationMs: 1234 };
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

describe("buildReport", () => {
  it("has the documented shape and correct summary counts", () => {
    const rep = buildReport({ ...base, results: [r("F-01", "passed"), r("F-02", "failed", "boom"), r("F-03", "skipped", "skipped (live mode)"), r("F-04", "passed")] });
    expect(rep).toEqual({
      tool: "acr-demo", version: "1.2.3", mode: "mock", startedAt: "2030-01-01T00:00:00.000Z", durationMs: 1234,
      summary: { passed: 2, failed: 1, skipped: 1 },
      results: [
        { id: "F-01", title: "title F-01", status: "passed", details: "d", durationMs: 3 },
        { id: "F-02", title: "title F-02", status: "failed", details: "boom", durationMs: 3 },
        { id: "F-03", title: "title F-03", status: "skipped", details: "skipped (live mode)", durationMs: 3 },
        { id: "F-04", title: "title F-04", status: "passed", details: "d", durationMs: 3 },
      ],
    });
    expect(Object.keys(rep)).toEqual(["tool", "version", "mode", "startedAt", "durationMs", "summary", "results"]);
  });
  it("sanitizes server-supplied text and strips home and temp paths", () => {
    const home = os.homedir();
    const rep = buildReport({ ...base, results: [r("F-01", "failed", `bad \u001b[31m${home}/secret/file and ${os.tmpdir()}/acr-demo-xyz/a.jsonl\nforged`)] });
    const d = rep.results[0]!.details;
    expect(d).not.toMatch(CONTROL);
    expect(d).not.toContain(home);
    expect(d).not.toContain(os.tmpdir());
    expect(d).toContain("~/secret/file");
    expect(JSON.stringify(rep)).not.toContain(home);
  });
  it("redacts values the caller declares secret", () => {
    const rep = buildReport({ ...base, secrets: ["sk-ant-SECRET-123456"], results: [r("F-01", "failed", "leaked sk-ant-SECRET-123456 here")] });
    expect(JSON.stringify(rep)).not.toContain("SECRET");
  });
});

describe("scrubText", () => {
  it("leaves ordinary text alone", () => { expect(scrubText("hello world")).toBe("hello world"); });
  it("ignores empty secrets", () => { expect(scrubText("abc", [""])).toBe("abc"); });
});

describe("exitCodeFor", () => {
  it("is 0 when everything executed passed (skips allowed)", () => {
    expect(exitCodeFor(buildReport({ ...base, results: [r("a", "passed"), r("b", "skipped")] }), false)).toBe(0);
  });
  it("is 1 on any failure", () => {
    expect(exitCodeFor(buildReport({ ...base, results: [r("a", "passed"), r("b", "failed")] }), false)).toBe(1);
  });
  it("is 1 on an unexpected error even with no failed check", () => {
    expect(exitCodeFor(buildReport({ ...base, results: [r("a", "passed")] }), true)).toBe(1);
  });
  it("is 1 when nothing passed at all (an empty run proves nothing)", () => {
    expect(exitCodeFor(buildReport({ ...base, results: [] }), false)).toBe(1);
    expect(exitCodeFor(buildReport({ ...base, results: [r("a", "skipped")] }), false)).toBe(1);
  });
});

describe("formatChecklist", () => {
  it("marks passed, failed and skipped, with evidence and a summary line, without colour codes when off", () => {
    const lines = formatChecklist(buildReport({ ...base, results: [r("F-01", "passed", "joined"), r("F-02", "failed", "nope"), r("F-03", "skipped", "skipped (live mode)")] }), false);
    const text = lines.join("\n");
    expect(text).toContain("✓ F-01");
    expect(text).toContain("✗ F-02");
    expect(text).toContain("– F-03");
    expect(text).toContain("joined");
    expect(text).toContain("1 passed, 1 failed, 1 skipped");
    expect(text).not.toContain("\u001b");
    for (const l of lines) expect(l).not.toMatch(CONTROL);
  });
  it("colours only when asked", () => {
    expect(formatChecklist(buildReport({ ...base, results: [r("F-01", "passed")] }), true).join("\n")).toContain("\u001b[");
  });
});
