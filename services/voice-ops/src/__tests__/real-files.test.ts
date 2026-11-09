import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateTmp } from "./helpers/ops-harness.js";
import { assertUnchanged, digestFiles } from "./helpers/real-files.js";

// US-0072 (review B2 F2): the guard the process tests put around the REAL worktree's package.json, pnpm-lock.yaml and .env keeps only
// sha256 digests and fails naming the changed files, never printing a byte of their contents (the owner's real .env may hold secrets).

let tmp: ReturnType<typeof privateTmp>;
beforeAll(() => { tmp = privateTmp("acr-voice-ops-real-files-"); });
afterAll(() => tmp.restore());

const MARKER = "marker-real-env-secret-0123456789abcdef";

describe("the real-files guard", () => {
  it("keeps digests only, and a changed file fails naming the file without printing its contents", () => {
    const dir = mkdtempSync(path.join(tmp.root, "r-"));
    const files = ["package.json", ".env", "absent.yaml"].map((f) => path.join(dir, f));
    writeFileSync(files[0]!, '{"name":"x"}\n');
    writeFileSync(files[1]!, `LIVEKIT_API_SECRET=${MARKER}\n`);
    const before = digestFiles(files);
    expect(JSON.stringify(before)).not.toContain(MARKER);
    expect(JSON.stringify(before)).not.toContain(Buffer.from(MARKER).toString("base64").slice(0, 12));
    expect(before.map((d) => d.digest === null)).toEqual([false, false, true]);
    expect(() => assertUnchanged(before, digestFiles(files))).not.toThrow();

    writeFileSync(files[1]!, `LIVEKIT_API_SECRET=${MARKER}-changed\n`);
    let message = "";
    try { assertUnchanged(before, digestFiles(files)); } catch (err) { message = String((err as Error).message) + String((err as Error).stack); }
    expect(message).toContain(".env");
    expect(message).not.toContain(MARKER);
    expect(message).not.toContain("LIVEKIT_API_SECRET");
    expect(message).not.toContain(Buffer.from(MARKER).toString("base64").slice(0, 12));
  });
});
