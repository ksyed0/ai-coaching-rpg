import os from "node:os";
import { sanitizeText } from "../cli/render.js";
import { paint } from "./narrator.js";
import type { ShowcaseReport } from "./showcase-report.js";

export type CheckStatus = "passed" | "failed" | "skipped";
export type CheckResult = { id: string; title: string; status: CheckStatus; details: string; durationMs: number };
export type DemoMode = "mock" | "live" | "url" | "url+live";
export type Report = {
  tool: string; version: string; mode: DemoMode; startedAt: string; durationMs: number;
  summary: { passed: number; failed: number; skipped: number };
  results: CheckResult[];
  /** Present for --showcase runs only. */
  showcase?: ShowcaseReport;
};

/** Sanitizes server-influenced text and removes anything that identifies the user's machine or a secret. */
export function scrubText(text: string, secrets: string[] = []): string {
  let out = sanitizeText(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join("[redacted]");
  const tmp = os.tmpdir();
  const home = os.homedir();
  // Longest first: the temp dir is often inside the home dir (macOS: /var/folders/... is not, but be safe).
  for (const [dir, label] of [[tmp, "<tmp>"], [home, "~"]] as const) if (dir && dir !== "/" ) out = out.split(dir).join(label);
  return out;
}

/** A copy of `value` with every string scrubbed (control characters, secrets, temp and home paths). */
export function scrubDeep<T>(value: T, secrets: string[] = []): T {
  if (typeof value === "string") return scrubText(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, secrets)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, secrets)])) as T;
  return value;
}

export function buildReport(i: { tool: string; version: string; mode: DemoMode; startedAt: string; durationMs: number; results: CheckResult[]; secrets?: string[]; showcase?: ShowcaseReport }): Report {
  const results = i.results.map((r) => ({
    id: scrubText(r.id), title: scrubText(r.title, i.secrets), status: r.status, details: scrubText(r.details, i.secrets), durationMs: Math.round(r.durationMs),
  }));
  const count = (status: CheckStatus) => results.filter((r) => r.status === status).length;
  return {
    tool: i.tool, version: i.version, mode: i.mode, startedAt: i.startedAt, durationMs: Math.round(i.durationMs),
    summary: { passed: count("passed"), failed: count("failed"), skipped: count("skipped") },
    results,
    ...(i.showcase ? { showcase: scrubDeep(i.showcase, i.secrets) } : {}),
  };
}

/** 0 when every executed check passed (skips are fine) and at least one check passed; 1 otherwise. Usage errors (2) never reach here. */
export function exitCodeFor(report: Report, unexpectedError: boolean): 0 | 1 {
  if (unexpectedError || report.summary.failed > 0 || report.summary.passed === 0) return 1;
  return 0;
}

/** The final checklist: one line per feature plus a summary line. Report text is already scrubbed. */
export function formatChecklist(report: Report, color: boolean): string[] {
  const lines = [paint("Checklist", "bold", color)];
  for (const r of report.results) {
    const [mark, style] = r.status === "passed" ? ["✓", "green"] as const : r.status === "failed" ? ["✗", "red"] as const : ["–", "yellow"] as const;
    lines.push(`  ${paint(mark, style, color)} ${r.id}  ${r.title}`);
    if (r.details) lines.push(`      ${paint(r.details, "dim", color)}`);
  }
  const { passed, failed, skipped } = report.summary;
  lines.push("", `${paint("Summary:", "bold", color)} ${passed} passed, ${failed} failed, ${skipped} skipped (${report.mode} mode, ${(report.durationMs / 1000).toFixed(1)} s)`);
  return lines;
}
