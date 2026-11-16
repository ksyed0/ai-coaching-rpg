import { describe, expect, it } from "vitest";
import { joinClips } from "../console-audio-join";
import type { AudioSegment } from "../launcher-client";

const seg = (o: Partial<AudioSegment> = {}): AudioSegment => ({
  role: "alice", segment: "seg-1", participantId: "p-secret-1", startMs: 1000, endMs: 2000, status: "transcribed", seq: 7, audio: "available", ...o,
});
const line = (o: Partial<{ seq: number; roleId: string; text: string }> = {}) => ({ seq: 7, roleId: "alice", text: "Hello there", ...o });

describe("joinClips", () => {
  it("joins a transcribed clip to the line with its seq", () => {
    expect(joinClips([seg()], [line()])).toEqual([
      { role: "alice", segment: "seg-1", startMs: 1000, endMs: 2000, status: "transcribed", audio: "available", text: "Hello there" },
    ]);
  });

  it("drops the text when the line's roleId is another seat's", () => {
    const [c] = joinClips([seg()], [line({ roleId: "bob" })]);
    expect(c).not.toHaveProperty("text");
  });

  it("no text for status empty, stt_failed and refused:no-consent", () => {
    for (const status of ["empty", "stt_failed", "refused:no-consent"]) {
      const [c] = joinClips([seg({ status })], [line()]);
      expect(c, status).not.toHaveProperty("text");
    }
  });

  it("no text for a clip without seq or without a matching line", () => {
    const { seq: _s, ...noSeq } = seg();
    expect(joinClips([noSeq], [line()])[0]).not.toHaveProperty("text");
    expect(joinClips([seg({ seq: 8 })], [line()])[0]).not.toHaveProperty("text");
    expect(joinClips([seg()], [])[0]).not.toHaveProperty("text");
  });

  it("joins by seq, not by position", () => {
    const out = joinClips(
      [seg({ segment: "a", seq: 2, startMs: 1 }), seg({ segment: "b", seq: 1, startMs: 2 })],
      [line({ seq: 1, text: "one" }), line({ seq: 2, text: "two" })],
    );
    expect(out.map((c) => c.text)).toEqual(["two", "one"]);
  });

  it("ordered by startMs", () => {
    const out = joinClips([seg({ segment: "late", startMs: 9000, endMs: 9500, seq: 1 }), seg({ segment: "early", startMs: 100, endMs: 200, seq: 2 })], []);
    expect(out.map((c) => c.segment)).toEqual(["early", "late"]);
  });

  it("output has no participantId, seq or identity key", () => {
    const out = joinClips([seg()], [line()]);
    for (const c of out) {
      expect(Object.keys(c).sort()).toEqual(["audio", "endMs", "role", "segment", "startMs", "status", "text"]);
    }
    expect(JSON.stringify(out)).not.toContain("p-secret-1");
    const plain = joinClips([seg({ status: "empty" })], []);
    expect(Object.keys(plain[0]!).sort()).toEqual(["audio", "endMs", "role", "segment", "startMs", "status"]);
  });
});
