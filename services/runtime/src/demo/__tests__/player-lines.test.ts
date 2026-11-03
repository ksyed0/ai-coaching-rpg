import { describe, expect, it } from "vitest";
import { PlayerLines, playerSource } from "../player-lines.js";

describe("PlayerLines", () => {
  it("matches utterances to records in send order, also for identical texts, and forgets a dropped line", () => {
    const lines = new PlayerLines();
    const read = lines.reader();
    const a = lines.add({ role: "r", text: "same", source: "generated", verbatim: false, cut: false, intent: "i", scene: null });
    const b = lines.add({ role: "r", text: "same", source: "scripted", verbatim: false, cut: false, reason: "x", intent: "i", scene: null });
    const c = lines.add({ role: "r", text: "gone", source: "generated", verbatim: false, cut: false, intent: "i", scene: null });
    lines.drop(c); lines.drop(c);
    expect(read("r", "same")).toBe(a);
    expect(read("r", "same")).toBe(b);
    expect(read("r", "same")).toBeUndefined();
    expect(read("r", "gone")).toBeUndefined();
    expect(read("other", "same")).toBeUndefined();
    expect(playerSource(a)).toBe("generated");
    expect(playerSource(b)).toBe("scripted");
    expect(playerSource(undefined)).toBe("scripted");
  });
});
