import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VOICE_CHECKS, runVoiceDemo } from "../../demo/voice-demo.js";

/**
 * US-0070 (AC-0404): the offline voice demo end to end (real control service in-process, real runtime and speech worker children, file
 * ingest, the fake STT script, the mock models). Whole-demo test: a generous explicit limit, no elapsed-time assertion; a private TMPDIR,
 * so the check that the demo removed its tree cannot see anyone else's.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let own: string;
let saved: string | undefined;
beforeAll(() => { saved = process.env.TMPDIR; own = mkdtempSync(path.join(tmpdir(), "acr-voice-demo-test-")); process.env.TMPDIR = own; });
afterAll(() => { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; rmSync(own, { recursive: true, force: true }); });

describe("pnpm demo --voice (runVoiceDemo)", () => {
  it("runVoiceDemo returns 0 and prints V-01 to V-08 as passed, and leaves no temp tree behind", async () => {
    const out: string[] = []; const err: string[] = [];
    const code = await runVoiceDemo({ stdout: { write: (s: string) => { out.push(s); } }, stderr: { write: (s: string) => { err.push(s); } }, env: { PATH: process.env.PATH, NO_COLOR: "1" } });
    const text = out.join("");
    expect(err.join(""), text).toBe("");
    expect(code, text).toBe(0);
    expect(VOICE_CHECKS.map((c) => c.id)).toEqual(["V-01", "V-02", "V-03", "V-04", "V-05", "V-06", "V-07", "V-08"]);
    for (const c of VOICE_CHECKS) expect(text).toMatch(new RegExp(`PASS +${c.id}`));
    expect(text).toContain("8 of 8 checks passed");
    expect(readdirSync(own)).toEqual([]);
  });
});
