import { describe, expect, it } from "vitest";
import { initPlayerView, initialState } from "@acr/events";

describe("web scaffold", () => {
  it("the web package imports the shared player view", () => {
    const view = initPlayerView(initialState());
    expect(view.lastSeq).toBe(0);
    expect(view.transcript).toEqual([]);
  });
});
