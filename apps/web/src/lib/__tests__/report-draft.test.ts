// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDraft, loadDraft, saveDraft } from "../report-draft";

afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

describe("report draft", () => {
  it("round-trips under the fixed key", () => {
    saveDraft({ ratings: { a: { level: 3, note: "n" }, b: { level: "na", note: "" }, c: { level: null, note: "" } } });
    expect(sessionStorage.getItem("scenecoach-report-draft")).not.toBeNull();
    expect(loadDraft()).toEqual({ ratings: { a: { level: 3, note: "n" }, b: { level: "na", note: "" }, c: { level: null, note: "" } } });
    clearDraft();
    expect(loadDraft()).toBeNull();
  });
  it("junk in storage reads as no draft", () => {
    for (const junk of ["{", "[]", '{"ratings":5}', '{"ratings":{"a":{"level":9,"note":""}}}', '{"ratings":{"a":{"level":1,"note":3}}}']) {
      sessionStorage.setItem("scenecoach-report-draft", junk);
      expect(loadDraft()).toBeNull();
    }
  });
  it("every call survives blocked storage", () => {
    const boom = () => { throw new Error("blocked"); };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(boom);
    expect(loadDraft()).toBeNull();
    expect(() => saveDraft({ ratings: {} })).not.toThrow();
    expect(() => clearDraft()).not.toThrow();
  });
});
