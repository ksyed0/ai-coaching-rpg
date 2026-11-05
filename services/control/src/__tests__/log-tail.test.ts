import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TAIL_BYTES, readLogStatus } from "../log-tail.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const file = (content?: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), "acr-ctl-log-")); dirs.push(d);
  const f = path.join(d, "events.jsonl");
  if (content !== undefined) writeFileSync(f, content);
  return f;
};
const line = (o: unknown): string => `${JSON.stringify(o)}\n`;

describe("readLogStatus", () => {
  it("empty for a missing or empty file", () => {
    expect(readLogStatus(file())).toBe("empty");
    expect(readLogStatus(file(""))).toBe("empty");
  });
  it("empty when there is no complete line yet", () => {
    expect(readLogStatus(file('{"type":"session.sta'))).toBe("empty");
  });
  it("ended for a complete facilitator_end log and running for one cut between the appends", () => {
    const head = line({ type: "session.started" }) + line({ type: "scene.entered" }) + line({ type: "scene.exited", reason: "facilitator_end" });
    expect(readLogStatus(file(head + line({ type: "facilitator.alert" })))).toBe("running");
    expect(readLogStatus(file(head))).toBe("running");
    expect(readLogStatus(file(head + line({ type: "facilitator.alert" }) + line({ type: "session.ended", reason: "facilitator_end" })))).toBe("ended");
  });
  it("running after a normal line", () => {
    expect(readLogStatus(file(line({ type: "session.started" })))).toBe("running");
  });
  it("ended after a session.ended last line", () => {
    expect(readLogStatus(file(line({ type: "session.started" }) + line({ type: "session.ended" })))).toBe("ended");
  });
  it("running after a cut-off tail following a normal line", () => {
    expect(readLogStatus(file(line({ type: "session.started" }) + '{"type":"session.en'))).toBe("running");
  });
  it("a cut-off tail does not hide an earlier session.ended (the last COMPLETE line decides)", () => {
    expect(readLogStatus(file(line({ type: "session.ended" }) + '{"type":"turn.'))).toBe("ended");
  });
  it("a final line without a newline that parses counts", () => {
    expect(readLogStatus(file(line({ type: "a" }) + JSON.stringify({ type: "session.ended" })))).toBe("ended");
  });
  it("blank trailing lines are ignored", () => {
    expect(readLogStatus(file(line({ type: "session.ended" }) + "\n\n"))).toBe("ended");
  });
  it("an unparseable complete last line is running, not ended or empty", () => {
    expect(readLogStatus(file(line({ type: "session.ended" }) + "garbage\n"))).toBe("running");
  });
  it("reads only the tail: a huge file with a normal tail is running; a last line over the window is running", () => {
    const big = line({ type: "x", pad: "p".repeat(200_000) });
    expect(readLogStatus(file(line({ type: "session.ended" }) + big))).toBe("running");
    expect(readLogStatus(file(big + line({ type: "session.ended" })))).toBe("ended");
  });
  it("a huge last line with no trailing newline is running (an in-progress write), never a raw error", () => {
    const ended = line({ type: "session.ended" });
    expect(readLogStatus(file(ended + "x".repeat(100_000)))).toBe("running");
    expect(readLogStatus(file(ended + '{"type":"x","pad":"' + "p".repeat(100_000)))).toBe("running");
    expect(readLogStatus(file("x".repeat(100_000)))).toBe("running");
  });
  it("a file of exactly the window size, with and without a trailing newline", () => {
    const body = (n: number): string => { const head = '{"type":"session.ended","pad":"'; return head + "p".repeat(n - head.length - 2) + '"}'; };
    const exact = body(TAIL_BYTES - 1) + "\n";
    expect(Buffer.byteLength(exact)).toBe(TAIL_BYTES);
    expect(readLogStatus(file(exact))).toBe("ended");
    const bare = body(TAIL_BYTES);
    expect(Buffer.byteLength(bare)).toBe(TAIL_BYTES);
    expect(readLogStatus(file(bare))).toBe("ended");
    expect(readLogStatus(file("a\n" + exact))).toBe("ended"); // the window starts right after a newline: the whole line counts
    expect(readLogStatus(file("a" + exact))).toBe("running"); // the line is one byte longer than the window
  });
  it("a window that starts mid-line and holds exactly one complete line", () => {
    expect(readLogStatus(file(line({ type: "x", pad: "p".repeat(100_000) }) + line({ type: "session.ended" })))).toBe("ended");
    expect(readLogStatus(file(line({ type: "session.ended", pad: "p".repeat(100_000) }) + line({ type: "turn" })))).toBe("running");
  });
  it("CRLF line endings", () => {
    expect(readLogStatus(file('{"type":"session.started"}\r\n{"type":"session.ended"}\r\n'))).toBe("ended");
    expect(readLogStatus(file('{"type":"session.ended"}\r\n{"type":"turn"}\r\n'))).toBe("running");
  });
  it("a file that cannot be read for another reason throws a plain error", () => {
    const f = file("x\n");
    const dir = path.dirname(f);
    mkdirSync(path.join(dir, "d"));
    expect(() => readLogStatus(path.join(dir, "d"))).toThrow(/session log cannot be read/);
    if ((process.getuid?.() ?? 0) !== 0) {
      chmodSync(f, 0o000);
      expect(() => readLogStatus(f)).toThrow(/session log cannot be read/);
      chmodSync(f, 0o600);
    }
  });
});
