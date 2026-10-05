import type { SessionEvent } from "@acr/events";
import { describe, expect, it } from "vitest";
import { TAGS, classifyGmDecision, classifyNpcReply, isFallbackReply } from "../provenance.js";

const alert = (message: string): SessionEvent => ({ type: "facilitator.alert", seq: 1, ts: 0, sessionId: "s", level: "warning", message });
const FB = "Say that again?";

describe("isFallbackReply", () => {
  it("needs both the fallback text and the fallback alert right before it", () => {
    expect(isFallbackReply(FB, { text: FB }, alert("NPC bot: empty reply; used fallback line"))).toBe(true);
    expect(isFallbackReply(FB, { text: FB }, alert("NPC bot: no first token within timeout; used fallback line"))).toBe(true);
  });
  it("is false for the same text without the alert (a model that happens to say it), or after an unrelated alert", () => {
    expect(isFallbackReply(FB, { text: FB }, undefined)).toBe(false);
    expect(isFallbackReply(FB, { text: FB }, alert("GM: no usable verdict for \"x\""))).toBe(false);
    expect(isFallbackReply(FB, { text: FB }, { type: "utterance", seq: 1, ts: 0, sessionId: "s", roleId: "pa", text: "hi", channel: "text" })).toBe(false);
  });
  it("is false when the text differs from the fallback line", () => {
    expect(isFallbackReply(FB, { text: "Something else" }, alert("NPC bot: empty reply; used fallback line"))).toBe(false);
  });
});

describe("classification", () => {
  it("labels live replies GENERATED, mock replies SCRIPTED and fallbacks FALLBACK in every mode, never GENERATED", () => {
    expect(classifyNpcReply("live", false)).toBe("generated");
    expect(classifyNpcReply("mock", false)).toBe("scripted");
    expect(classifyNpcReply("live", true)).toBe("fallback");
    expect(classifyNpcReply("mock", true)).toBe("fallback");
    expect(classifyGmDecision("live")).toBe("generated");
    expect(classifyGmDecision("mock")).toBe("scripted");
  });
  it("has the four stable tags", () => {
    expect(TAGS).toEqual({ scripted: "[SCRIPTED]", generated: "[GENERATED]", fallback: "[FALLBACK]", system: "[SYSTEM]" });
  });
});
