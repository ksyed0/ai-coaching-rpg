import { describe, expect, it } from "vitest";
import { cleanConsoleName, MAX_CONSOLE_NAME_CODE_POINTS } from "../display-name.js";

describe("display_name", () => {
  it("trims and keeps an ordinary name", () => {
    expect(cleanConsoleName("  Dana Reyes  ")).toBe("Dana Reyes");
  });
  it("removes hidden and control characters", () => {
    expect(cleanConsoleName("Da​na‮\u0007")).toBe("Dana");
  });
  it("returns null when nothing visible is left", () => {
    expect(cleanConsoleName("​ ⁠\t")).toBeNull();
    expect(cleanConsoleName("")).toBeNull();
  });
  it("cuts at 60 code points without splitting a surrogate pair", () => {
    const out = cleanConsoleName("\u{1F600}".repeat(80))!;
    expect([...out]).toHaveLength(MAX_CONSOLE_NAME_CODE_POINTS);
  });
});
