import type { SessionEvent } from "@acr/events";
import { describe, expect, it } from "vitest";
import { TAGS, classifyGmDecision, classifyNpcReply, fallbackReason, isFallbackReply, type ProviderKind } from "../provenance.js";

const alert = (message: string): SessionEvent => ({ type: "facilitator.alert", seq: 1, ts: 0, sessionId: "s", level: "warning", message });
const bot = { id: "bot", fallback_line: "Say that again?" };
const FB = bot.fallback_line;

describe("isFallbackReply", () => {
  it("is exactly the marker the NPC agent sets, wherever the alert is", () => {
    expect(isFallbackReply(bot, { text: FB, fallback: true }, undefined, { legacy: false })).toBe(true);
    expect(isFallbackReply(bot, { text: "anything", fallback: true }, undefined, { legacy: false })).toBe(true);
  });
  it("stays false for a model that says the fallback text itself, even right after a fallback alert (in-process runs)", () => {
    const a = alert("NPC bot: empty reply; used fallback line");
    expect(isFallbackReply(bot, { text: FB }, a, { legacy: false })).toBe(false);
    expect(isFallbackReply(bot, { text: FB }, undefined, { legacy: false })).toBe(false);
  });
  it("legacy (remote servers without the marker): the character's own alert right before, multi-line reasons included, role matched", () => {
    expect(isFallbackReply(bot, { text: FB }, alert("NPC bot: empty reply; used fallback line"), { legacy: true })).toBe(true);
    expect(isFallbackReply(bot, { text: FB }, alert("NPC bot: model error: a\nb; used fallback line"), { legacy: true })).toBe(true);
    expect(isFallbackReply(bot, { text: FB }, alert("NPC other: empty reply; used fallback line"), { legacy: true })).toBe(false);
    expect(isFallbackReply(bot, { text: FB }, alert('GM: no usable verdict for "x"'), { legacy: true })).toBe(false);
    expect(isFallbackReply(bot, { text: FB }, undefined, { legacy: true })).toBe(false);
    expect(isFallbackReply(bot, { text: "other" }, alert("NPC bot: empty reply; used fallback line"), { legacy: true })).toBe(false);
  });
});

describe("the retry-era alert wording (US-0022) is still recognised", () => {
  const retried = "NPC bot: model error after 3 attempts (overloaded): Upstream error from Nvidia: Service temporarily overloaded; used fallback line";
  it("the legacy remote-server rule matches the attempt-count wording for the right character only", () => {
    expect(isFallbackReply(bot, { text: FB }, alert(retried), { legacy: true })).toBe(true);
    expect(isFallbackReply(bot, { text: FB }, alert("NPC bot: model error after 1 attempt (auth): HTTP 401; used fallback line"), { legacy: true })).toBe(true);
    expect(isFallbackReply(bot, { text: FB }, alert("NPC bot: model error (network): reset; used fallback line"), { legacy: true })).toBe(true);
    expect(isFallbackReply(bot, { text: FB }, alert(retried.replace("NPC bot", "NPC other")), { legacy: true })).toBe(false);
    expect(isFallbackReply(bot, { text: FB }, alert(retried), { legacy: false })).toBe(false);
  });
  it("fallbackReason carries an exhausted reasoning budget through to the narration", () => {
    expect(fallbackReason("NPC guest: empty reply: reasoning budget exhausted after 3 attempts (reasoning_budget): local: raise NPC_MAX_TOKENS; used fallback line"))
      .toBe("empty reply: reasoning budget exhausted after 3 attempts (reasoning_budget): local: raise NPC_MAX_TOKENS");
  });

  it("fallbackReason returns the whole reason, attempt count and kind included", () => {
    expect(fallbackReason(retried)).toBe("model error after 3 attempts (overloaded): Upstream error from Nvidia: Service temporarily overloaded");
    expect(fallbackReason(retried, "bot")).toBe(fallbackReason(retried));
  });
});

describe("fallbackReason", () => {
  it("extracts the reason, optionally for one character", () => {
    expect(fallbackReason("NPC bot: empty reply; used fallback line")).toBe("empty reply");
    expect(fallbackReason("NPC bot: empty reply; used fallback line", "bot")).toBe("empty reply");
    expect(fallbackReason("NPC bot: empty reply; used fallback line", "bo")).toBeNull();
    expect(fallbackReason("something else")).toBeNull();
  });
});

describe("the mode x source -> tag table", () => {
  // rows: how the run is set up; columns: who produced the line
  const table: Record<string, { provider: ProviderKind; npc: string; gm: string }> = {
    "default mock run": { provider: "mock", npc: "scripted", gm: "scripted" },
    "mock side room": { provider: "mock", npc: "scripted", gm: "scripted" },
    "showcase mock": { provider: "mock", npc: "scripted", gm: "scripted" },
    "live, in-process": { provider: "live", npc: "generated", gm: "generated" },
    "--url": { provider: "remote", npc: "unverified", gm: "unverified" },
    "--url --live": { provider: "remote", npc: "unverified", gm: "unverified" },
  };
  it.each(Object.entries(table))("%s", (_row, t) => {
    expect(classifyNpcReply(t.provider, false)).toBe(t.npc);
    expect(classifyGmDecision(t.provider)).toBe(t.gm);
    expect(classifyNpcReply(t.provider, true)).toBe("fallback"); // a fallback is a fallback everywhere
  });
  it("only a live in-process real provider can ever produce GENERATED (property over every kind and flag)", () => {
    const kinds: ProviderKind[] = ["mock", "live", "remote"];
    for (const k of kinds) for (const fb of [false, true]) {
      expect(classifyNpcReply(k, fb) === "generated", `npc ${k}/${fb}`).toBe(k === "live" && !fb);
      expect(classifyGmDecision(k) === "generated", `gm ${k}`).toBe(k === "live");
    }
    expect(classifyNpcReply("live", true)).not.toBe("generated");
  });
  it("has the five stable tags", () => {
    expect(TAGS).toEqual({ scripted: "[SCRIPTED]", generated: "[GENERATED]", fallback: "[FALLBACK]", unverified: "[UNVERIFIED]", system: "[SYSTEM]" });
  });
});
