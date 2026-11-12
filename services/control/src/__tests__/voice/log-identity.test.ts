import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_LOG_HEAD_BYTES, makeFallbackIdentity, readLogIdentity } from "../../voice/log-identity.js";

const IDENT = "0123456789abcdef0123456789abcdef";
const S = "session-1";
const started = (o: Record<string, unknown> = {}) =>
  ({ seq: 1, ts: 1000, sessionId: S, type: "session.started", scenarioId: "sc", version: "1", roles: {}, logFormat: 3, logIdentity: IDENT, ...o });
const line = (v: unknown) => `${typeof v === "string" ? v : JSON.stringify(v)}\n`;

let sessionsDir: string;
beforeEach(() => { sessionsDir = mkdtempSync(path.join(os.tmpdir(), "acr-logid-")); });
afterEach(() => { rmSync(sessionsDir, { recursive: true, force: true }); });
const logFile = (id = S) => path.join(sessionsDir, `${id}.jsonl`);
const writeLog = (text: string, id = S) => writeFileSync(logFile(id), text, { mode: 0o600 });

describe("readLogIdentity (US-0074, the pre-marker fallback)", () => {
  it("returns the logIdentity of a session.started first line", async () => {
    writeLog(line(started()) + line({ seq: 2, ts: 1001, sessionId: S, type: "scene.entered", sceneId: "a", participants: [] }));
    expect(await readLogIdentity(sessionsDir, S)).toBe(IDENT);
  });

  it("accepts a complete first line with no newline yet", async () => {
    writeLog(JSON.stringify(started()));
    expect(await readLogIdentity(sessionsDir, S)).toBe(IDENT);
  });

  it("reads only the head: a large log with a short first line still answers", async () => {
    writeLog(line(started()));
    truncateSync(logFile(), MAX_LOG_HEAD_BYTES * 4);
    expect(await readLogIdentity(sessionsDir, S)).toBe(IDENT);
  });

  it.each([
    ["another event type first", line({ seq: 1, ts: 1, sessionId: S, type: "scene.entered", sceneId: "a", participants: [] }) + line(started({ seq: 2 }))],
    ["torn JSON", JSON.stringify(started()).slice(0, 60)],
    ["an empty file", ""],
    ["a blank first line", "\n" + line(started())],
    ["an array", line([started()])],
    ["no logIdentity", line(started({ logIdentity: undefined }))],
    ["an upper-case logIdentity", line(started({ logIdentity: IDENT.toUpperCase() }))],
    ["a short logIdentity", line(started({ logIdentity: IDENT.slice(1) }))],
    ["a numeric logIdentity", line(started({ logIdentity: 7 }))],
    ["another session's event", line(started({ sessionId: "session-2" }))],
    ["a first event that is not seq 1", line(started({ seq: 2 }))],
  ])("returns undefined for %s", async (_l, text) => {
    writeLog(text);
    expect(await readLogIdentity(sessionsDir, S)).toBeUndefined();
  });

  it("returns undefined when the first line is longer than the head it reads", async () => {
    writeLog(line(started({ pad: "x".repeat(MAX_LOG_HEAD_BYTES) })));
    expect(await readLogIdentity(sessionsDir, S)).toBeUndefined();
  });

  it("returns undefined for a missing log, a symlinked log, a directory or a FIFO (never hangs)", async () => {
    expect(await readLogIdentity(sessionsDir, S)).toBeUndefined();
    const elsewhere = path.join(sessionsDir, "elsewhere.txt");
    writeFileSync(elsewhere, line(started()));
    symlinkSync(elsewhere, logFile());
    expect(await readLogIdentity(sessionsDir, S)).toBeUndefined();
    mkdirSync(logFile("session-3"));
    expect(await readLogIdentity(sessionsDir, "session-3")).toBeUndefined();
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [logFile("session-4")]);
      expect(await readLogIdentity(sessionsDir, "session-4")).toBeUndefined();
    }
  }, 5_000);

  it.each(["../session-1", "a/b", "", "x".repeat(65), "a b"])("returns undefined for an invalid session id %j", async (bad) => {
    writeLog(line(started()));
    expect(await readLogIdentity(sessionsDir, bad)).toBeUndefined();
  });

  it("returns undefined (never throws) for a missing sessions directory", async () => {
    await expect(readLogIdentity(path.join(sessionsDir, "nope"), S)).resolves.toBeUndefined();
  });

  it("makeFallbackIdentity binds the sessions directory", async () => {
    writeLog(line(started()));
    const f = makeFallbackIdentity(sessionsDir);
    expect(await f(S)).toBe(IDENT);
    expect(await f("session-9")).toBeUndefined();
  });
});
