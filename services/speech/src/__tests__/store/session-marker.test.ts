import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nodeStoreFs, type StoreFs } from "../../store/audio-store.js";
import { writeSessionMarker } from "../../store/session-marker.js";

/** US-0074 (voice A2b-1a, Task 1): the marker writer on its own. */
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "acr-marker-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("writeSessionMarker", () => {
  it("writes { v: 1, sessionId } as a private file and leaves no temp file", () => {
    writeSessionMarker(dir, "sess-1");
    expect(JSON.parse(readFileSync(path.join(dir, "session.json"), "utf8"))).toEqual({ v: 1, sessionId: "sess-1" });
    expect(lstatSync(path.join(dir, "session.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["session.json"]);
  });
  it("calls fsync of the file, rename, then fsync of the folder, in that order", () => {
    const calls: string[] = [];
    const fs = Object.fromEntries(Object.entries(nodeStoreFs).map(([k, f]) => [k, (...a: unknown[]) => { calls.push(k); return (f as (...x: unknown[]) => unknown)(...a); }])) as unknown as StoreFs;
    writeSessionMarker(dir, "sess-1", fs);
    expect(calls.filter((c) => ["fsyncSync", "renameSync", "fsyncDir"].includes(c))).toEqual(["fsyncSync", "renameSync", "fsyncDir"]);
  });
  it("replaces an older marker whole", () => {
    writeSessionMarker(dir, "sess-1");
    writeSessionMarker(dir, "sess-2");
    expect(JSON.parse(readFileSync(path.join(dir, "session.json"), "utf8")).sessionId).toBe("sess-2");
  });
});
