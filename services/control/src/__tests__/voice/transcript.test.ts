import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_LOG_BYTES, MAX_TRANSCRIPT_CHARS, readTranscript } from "../../voice/transcript.js";

const S = "session-1";
const utt = (seq: number, roleId: string, text: string, o: Record<string, unknown> = {}) =>
  ({ seq, ts: 1000 + seq, sessionId: S, type: "utterance", roleId, text, channel: "voice", ...o });
const line = (v: unknown) => `${typeof v === "string" ? v : JSON.stringify(v)}\n`;

let sessionsDir: string;
beforeEach(() => { sessionsDir = mkdtempSync(path.join(os.tmpdir(), "acr-transcript-")); });
afterEach(() => { rmSync(sessionsDir, { recursive: true, force: true }); });
const logFile = (id = S) => path.join(sessionsDir, `${id}.jsonl`);
const writeLog = (text: string, id = S) => writeFileSync(logFile(id), text, { mode: 0o600 });

describe("readTranscript (A2b-2)", () => {
  it("exports the documented caps", () => {
    expect(MAX_LOG_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_TRANSCRIPT_CHARS).toBe(1_000_000);
  });

  it("returns only utterance events as {seq, ts, roleId, text}", () => {
    writeLog(
      line({ seq: 1, ts: 1000, sessionId: S, type: "session.started" }) +
        line(utt(2, "ceo", "hello")) +
        line(utt(3, "cto", "world")) +
        line({ seq: 4, ts: 1004, sessionId: S, type: "inject.fired", injectId: "x" }),
    );
    const r = readTranscript(sessionsDir, S);
    expect(r).toEqual({
      kind: "ok",
      lines: [
        { seq: 2, ts: 1002, roleId: "ceo", text: "hello" },
        { seq: 3, ts: 1003, roleId: "cto", text: "world" },
      ],
    });
    if (r.kind === "ok") expect(Object.keys(r.lines[0]!)).not.toContain("channel");
  });

  it("skips a torn last line and an unparseable line", () => {
    writeLog(line(utt(1, "ceo", "a")) + line("not json{") + line(utt(2, "cto", "b")) + JSON.stringify(utt(3, "ceo", "c")).slice(0, 30));
    const r = readTranscript(sessionsDir, S);
    expect(r.kind === "ok" && r.lines.map((l) => l.seq)).toEqual([1, 2]);
  });

  it("skips utterances with wrongly typed fields", () => {
    writeLog(line(utt(1, "ceo", "ok")) + line(utt("2" as unknown as number, "ceo", "x")) + line(utt(3, 7 as unknown as string, "x")) + line(utt(4, "ceo", 5 as unknown as string)) + line(utt(5, "ceo", "x", { ts: "t" })));
    const r = readTranscript(sessionsDir, S);
    expect(r.kind === "ok" && r.lines.map((l) => l.seq)).toEqual([1]);
  });

  it("a log with no utterance events gives ok with no lines", () => {
    writeLog(line({ seq: 1, ts: 1, sessionId: S, type: "session.started" }));
    expect(readTranscript(sessionsDir, S)).toEqual({ kind: "ok", lines: [] });
  });

  it("a missing log is not_found; a bad session id is not_found without touching the disk", () => {
    expect(readTranscript(sessionsDir, S)).toEqual({ kind: "not_found" });
    expect(readTranscript(path.join(sessionsDir, "no-such-dir"), "../etc/passwd")).toEqual({ kind: "not_found" });
    expect(readTranscript(sessionsDir, "a/b")).toEqual({ kind: "not_found" });
  });

  it("a log over MAX_LOG_BYTES is too_large", () => {
    writeLog(line(utt(1, "ceo", "hello")));
    expect(readTranscript(sessionsDir, S, { maxBytes: 10 })).toEqual({ kind: "too_large" });
  });

  it("text over maxChars is too_large, never a partial list", () => {
    writeLog(line(utt(1, "ceo", "aaaa")) + line(utt(2, "ceo", "bbbb")) + line(utt(3, "ceo", "cccc")));
    expect(readTranscript(sessionsDir, S, { maxChars: 11 })).toEqual({ kind: "too_large" });
    expect(readTranscript(sessionsDir, S, { maxChars: 12 }).kind).toBe("ok");
  });

  it("refuses a symlinked log", () => {
    const real = path.join(sessionsDir, "real.txt");
    writeFileSync(real, line(utt(1, "ceo", "a")));
    symlinkSync(real, logFile());
    expect(readTranscript(sessionsDir, S)).toEqual({ kind: "not_found" });
  });

  it("refuses a directory", () => {
    mkdirSync(logFile());
    expect(readTranscript(sessionsDir, S)).toEqual({ kind: "not_found" });
  });

  it("keeps only lines whose sessionId equals the requested id", () => {
    writeLog(line(utt(1, "ceo", "mine")) + line(utt(2, "ceo", "theirs", { sessionId: "session-2" })) + line(utt(3, "ceo", "no id", { sessionId: undefined })));
    const r = readTranscript(sessionsDir, S);
    expect(r.kind === "ok" && r.lines.map((l) => l.text)).toEqual(["mine"]);
  });

  it("handles multi-byte text and CRLF-free blank lines", () => {
    writeLog(`\n${line(utt(1, "ceo", "héllo — 你好"))}\n`);
    const r = readTranscript(sessionsDir, S);
    expect(r.kind === "ok" && r.lines[0]!.text).toBe("héllo — 你好");
  });
});
