import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../main.js";
import { MAX_NOTICE_CHARS, loadConsentNotice } from "../consent-notice.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-notice-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const SECRET = "SECRET-NOTICE-9c1e";

describe("loadConsentNotice (US-0053)", () => {
  it("reads notice-<version>.md and returns its version and text", async () => {
    await writeFile(path.join(dir, "notice-v7.md"), "Line one.\n\tLine two.\n");
    expect(loadConsentNotice(dir, "v7")).toEqual({ version: "v7", text: "Line one.\n\tLine two.\n" });
  });

  it("the shipped notice-v1.md loads, stays under 1,500 characters and names what the brief requires", () => {
    const n = loadConsentNotice(path.join(REPO_ROOT, "consent"), "v1");
    expect(n.version).toBe("v1");
    expect(n.text.length).toBeLessThan(1_500);
    expect(n.text).toMatch(/record/i);
    expect(n.text).toMatch(/facilitator/i);
    expect(n.text).toMatch(/\bAI\b/);
    expect(n.text).toMatch(/leave/i);
  });

  it("refuses a missing file, a bad version, an over-long text and control characters without quoting the file", async () => {
    expect(() => loadConsentNotice(dir, "v1")).toThrow(/notice-v1\.md was not found/);
    for (const bad of ["", "a".repeat(33), "../x", "v 1", "v1/..", "é"]) expect(() => loadConsentNotice(dir, bad)).toThrow(/version/);
    await writeFile(path.join(dir, "notice-long.md"), SECRET + "x".repeat(MAX_NOTICE_CHARS));
    await writeFile(path.join(dir, "notice-ctl.md"), `${SECRET}\u0007`);
    await writeFile(path.join(dir, "notice-cr.md"), `${SECRET}\r\n`);
    const reasons: Record<string, RegExp> = { long: /longer than 4000 characters/, ctl: /control characters/, cr: /control characters/ };
    for (const [v, reason] of Object.entries(reasons)) {
      let msg = "";
      try { loadConsentNotice(dir, v); } catch (err) { msg = (err as Error).message; }
      expect(msg, v).toMatch(reason);
      expect(msg, v).not.toContain(SECRET);
    }
  });

  it("refuses a symbolic link and a directory", async () => {
    await writeFile(path.join(dir, "real.md"), "ok");
    await symlink(path.join(dir, "real.md"), path.join(dir, "notice-link.md"));
    expect(() => loadConsentNotice(dir, "link")).toThrow(/symbolic link/);
    await (await import("node:fs/promises")).mkdir(path.join(dir, "notice-d.md"));
    expect(() => loadConsentNotice(dir, "d")).toThrow(/not a regular file/);
  });

  it("refuses invalid UTF-8, an empty file and a file over the byte limit, without quoting it (regression guard)", async () => {
    await writeFile(path.join(dir, "notice-utf.md"), Buffer.concat([Buffer.from(SECRET), Buffer.from([0xc3, 0x28])]));
    await writeFile(path.join(dir, "notice-empty.md"), " \n");
    await writeFile(path.join(dir, "notice-big.md"), SECRET + "x".repeat(MAX_NOTICE_CHARS * 4));
    const reasons: Record<string, RegExp> = { utf: /not valid UTF-8/, empty: /is empty/, big: /longer than 4000 characters/ };
    for (const [v, reason] of Object.entries(reasons)) {
      let msg = "";
      try { loadConsentNotice(dir, v); } catch (err) { msg = (err as Error).message; }
      expect(msg, v).toMatch(reason);
      expect(msg, v).not.toContain(SECRET);
    }
  });

  // A FIFO must be refused at once, not block the start waiting for a writer (Linux has mkfifo; other platforms skip).
  it.runIf(process.platform === "linux")("refuses a FIFO without blocking", () => {
    execFileSync("mkfifo", [path.join(dir, "notice-fifo.md")]);
    expect(() => loadConsentNotice(dir, "fifo")).toThrow(/not a regular file/);
  });
});
