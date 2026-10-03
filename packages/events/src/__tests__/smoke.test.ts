import { describe, expect, it } from "vitest";
import { EVENTS_PACKAGE } from "../index.js";

describe("workspace smoke", () => {
  it("resolves the package", () => {
    expect(EVENTS_PACKAGE).toBe("@acr/events");
  });
});
