import { describe, expect, it } from "vitest";
import { pickVoice } from "../console-voice";

describe("pickVoice facilitatorMuted (A3A)", () => {
  it("keeps facilitatorMuted only as a boolean", () => {
    expect(pickVoice({ voice: "voice", facilitatorMuted: true })).toEqual({ voice: "voice", facilitatorMuted: true });
    expect(pickVoice({ voice: "voice", facilitatorMuted: false })).toEqual({ voice: "voice", facilitatorMuted: false });
    expect(pickVoice({ voice: "voice", facilitatorMuted: "yes" })).toEqual({ voice: "voice" });
    expect(pickVoice({ facilitatorMuted: 1 })).toEqual({});
  });
});
