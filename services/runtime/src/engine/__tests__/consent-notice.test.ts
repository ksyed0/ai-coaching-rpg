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
    expect(() => loadConsentNotice(dir, "v1")).toThrow(/notice-v1\.md/);
    for (const bad of ["", "a".repeat(33), "../x", "v 1", "v1/..", "é"]) expect(() => loadConsentNotice(dir, bad)).toThrow(/version/);
    await writeFile(path.join(dir, "notice-long.md"), SECRET + "x".repeat(MAX_NOTICE_CHARS));
    await writeFile(path.join(dir, "notice-ctl.md"), `${SECRET}\u0007`);
    await writeFile(path.join(dir, "notice-cr.md"), `${SECRET}\r\n`);
    for (const v of ["long", "ctl", "cr"]) {
      let msg = "";
      try { loadConsentNotice(dir, v); } catch (err) { msg = (err as Error).message; }
      expect(msg, v).not.toBe("");
      expect(msg, v).not.toContain(SECRET);
    }
  });

  it("refuses a symbolic link and a directory", async () => {
    await writeFile(path.join(dir, "real.md"), "ok");
    await symlink(path.join(dir, "real.md"), path.join(dir, "notice-link.md"));
    expect(() => loadConsentNotice(dir, "link")).toThrow(/notice/);
    await (await import("node:fs/promises")).mkdir(path.join(dir, "notice-d.md"));
    expect(() => loadConsentNotice(dir, "d")).toThrow(/notice/);
  });
});
