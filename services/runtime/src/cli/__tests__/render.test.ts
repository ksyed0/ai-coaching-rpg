import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@acr/events";
import { renderEvent, sanitizeText, renderJoined, renderError, MAX_DISPLAY_CHARS } from "../render.js";

const env = { seq: 1, ts: 0, sessionId: "s" };
// eslint-disable-next-line no-control-regex
const INVISIBLE = new RegExp("[\\u202a-\\u202e\\u2066-\\u2069\\u200b-\\u200f\\u2028\\u2029\\ufeff]");
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

describe("renderEvent", () => {
  it("renders utterances with the speaker, marking mine", () => {
    expect(renderEvent({ ...env, type: "utterance", roleId: "guest", text: "Hi", channel: "text" }, "host")).toBe("guest: Hi");
    expect(renderEvent({ ...env, type: "utterance", roleId: "host", text: "Yo", channel: "text" }, "host")).toBe("you: Yo");
  });
  it("renders scene changes and injects", () => {
    expect(renderEvent({ ...env, type: "scene.entered", sceneId: "s2", participants: ["host"] }, "host")).toBe("--- scene s2 ---");
    expect(renderEvent({ ...env, type: "scene.exited", sceneId: "s2", reason: "time_box_elapsed" }, "host")).toBe("--- scene s2 ended (time_box_elapsed) ---");
    expect(renderEvent({ ...env, type: "inject.fired", injectId: "i", sceneId: "s", to: ["host"], content: "An email arrives." }, "host")).toBe("[inject] An email arrives.");
  });
  it("renders nothing for GM decisions to players and the decision for the facilitator", () => {
    const d = { ...env, type: "gm.decision" as const, sceneId: "s", condition: "c", verdict: true, reasoning: "r" };
    expect(renderEvent(d, "host")).toBeNull();
    expect(renderEvent(d, "facilitator")).toBe("[gm] c => true (r)");
  });
  it("renders alerts, npc updates, whispers and session lifecycle", () => {
    expect(renderEvent({ ...env, type: "facilitator.alert", level: "warning", message: "slow" }, "facilitator")).toBe("[alert] slow");
    expect(renderEvent({ ...env, type: "facilitator.alert", level: "warning", message: "slow" }, "host")).toBeNull();
    expect(renderEvent({ ...env, type: "npc.updated", roleId: "cto", goals: ["a", "b"], knowledge: [] }, "facilitator")).toBe("[npc cto] goals: a; b");
    expect(renderEvent({ ...env, type: "npc.updated", roleId: "cto", goals: ["a"], knowledge: [] }, "host")).toBeNull();
    expect(renderEvent({ ...env, type: "facilitator.command", command: "whisper", roleId: "host", text: "psst" }, "host")).toBe("[whisper] psst");
    expect(renderEvent({ ...env, type: "facilitator.command", command: "pause" }, "host")).toBe("[facilitator] pause");
    expect(renderEvent({ ...env, type: "session.started", scenarioId: "sc", version: "1", roles: {} }, "host")).toBe("session started: sc v1");
    expect(renderEvent({ ...env, type: "session.ended", reason: "script_complete" }, "host")).toBe("=== session ended (script_complete) ===");
  });
  it("renders nothing for unknown event types instead of crashing", () => {
    expect(renderEvent({ ...env, type: "something.new" } as unknown as SessionEvent, "host")).toBeNull();
  });
});

describe("sanitizeText (R26)", () => {
  it("neutralises ANSI CSI, OSC title and carriage-return overwrite", () => {
    expect(CONTROL.test(sanitizeText("a\x1b[2Jb"))).toBe(false);
    const osc = sanitizeText("x\x1b]0;pwned\x07y");
    expect(CONTROL.test(osc)).toBe(false);
    expect(osc).not.toContain("\x1b");
    const cr = sanitizeText("real text\rfake: overwrite");
    expect(cr).not.toContain("\r");
  });
  it("keeps a message from forging a new line", () => {
    const out = sanitizeText("hello\n[facilitator]: forged line");
    expect(out).not.toContain("\n");
    expect(out).toContain("⏎");
    expect(sanitizeText("a\r\nb")).toBe("a ⏎ b");
  });
  it("strips bidi, zero-width, line separators, NUL, DEL and C1", () => {
    for (const ch of ["\u202e", "\u202a", "\u2066", "\u2069", "\u200b", "\u200f", "\ufeff"]) expect(sanitizeText(`a${ch}b`)).toBe("ab");
    expect(sanitizeText("a\u2028b\u2029c")).toBe("a ⏎ b ⏎ c");
    expect(CONTROL.test(sanitizeText("a\x00b\x7fc\x85d\x9be"))).toBe(false);
  });
  it("keeps ordinary text, tabs become spaces, unicode survives", () => {
    expect(sanitizeText("héllo 世界 🙂")).toBe("héllo 世界 🙂");
    expect(sanitizeText("a\tb")).toBe("a b");
  });
  it("caps very long input with a truncation marker", () => {
    const out = sanitizeText("x".repeat(100_000));
    expect(out.length).toBeLessThanOrEqual(MAX_DISPLAY_CHARS + 20);
    expect(out.endsWith("[truncated]")).toBe(true);
  });
  it("tolerates non-string input", () => {
    expect(sanitizeText(undefined as unknown as string)).toBe("");
    expect(sanitizeText(42 as unknown as string)).toBe("42");
  });
});

const HOSTILE = ["\x1b[2J\x1b[H", "\x1b]0;pwned\x07", "a\rb", "x\n[facilitator]: forged", "\u202eevil", "n\x00ul", "\x9b31m", "\x1bc"];
describe("renderEvent never emits control characters for hostile input", () => {
  for (const h of HOSTILE) {
    it(JSON.stringify(h), () => {
      const evs: SessionEvent[] = [
        { ...env, type: "utterance", roleId: h, text: h, channel: "text" },
        { ...env, type: "inject.fired", injectId: h, sceneId: h, to: [], content: h },
        { ...env, type: "facilitator.command", command: "whisper", roleId: h, text: h },
        { ...env, type: "facilitator.alert", level: "info", message: h },
        { ...env, type: "gm.decision", sceneId: h, condition: h, verdict: false, reasoning: h },
        { ...env, type: "npc.updated", roleId: h, goals: [h], knowledge: [] },
        { ...env, type: "scene.entered", sceneId: h, participants: [] },
        { ...env, type: "scene.exited", sceneId: h, reason: h as never },
        { ...env, type: "session.started", scenarioId: h, version: h, roles: {} },
        { ...env, type: "session.ended", reason: h as never },
      ];
      for (const e of evs) {
        const line = renderEvent(e, "facilitator");
        expect(line).not.toBeNull();
        expect(CONTROL.test(line!)).toBe(false);
        expect(line).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2028\u2029\ufeff]/);
      }
    });
    it(`error/joined: ${JSON.stringify(h)}`, () => {
      expect(CONTROL.test(renderError(h, h))).toBe(false);
      const j = renderJoined({ type: "joined", roleId: h, brief: h, privateFacts: [h, h], state: {} as never });
      expect(j.some((l) => CONTROL.test(l))).toBe(false);
    });
  }
});

describe("renderJoined / renderError", () => {
  it("shows role, brief and facts but never the token", () => {
    const lines = renderJoined({ type: "joined", roleId: "guest", brief: "Be kind", privateFacts: ["f1"], reconnectToken: "SECRET-TOKEN", state: {} as never });
    expect(lines.join("\n")).toContain("joined as guest");
    expect(lines.join("\n")).toContain("Be kind");
    expect(lines.join("\n")).toContain("- f1");
    expect(lines.join("\n")).not.toContain("SECRET-TOKEN");
  });
  it("omits the brief block when there is none", () => {
    expect(renderJoined({ type: "joined", roleId: "facilitator", state: {} as never })).toEqual(["joined as facilitator"]);
  });
  it("prints a friendly hint for not_started", () => {
    expect(renderError("not_started", "x")).toMatch(/waiting for the facilitator to \/start/);
    expect(renderError("role_taken", "role_taken")).toBe("error: role_taken: role_taken");
  });
});

describe("renderJoined transcript (M3)", () => {
  const u = (seq: number, roleId: string, text: string) => ({ seq, ts: 0, sceneId: "s1", roleId, text, channel: "text" as const });
  const joinedWith = (transcript: ReturnType<typeof u>[]) => renderJoined({ type: "joined", roleId: "host", brief: "b", privateFacts: [], state: { transcript } as never });
  it("prints the visible history one line per utterance, marking my own lines", () => {
    const lines = joinedWith([u(1, "host", "Hello"), u(2, "guest", "Hi back")]);
    expect(lines.slice(-3)).toEqual(["--- history ---", "you: Hello", "guest: Hi back"]);
  });
  it("sanitizes hostile text and cannot forge a line", () => {
    const lines = joinedWith([u(1, "guest", "x\n[facilitator]: pwn \u001b[31m red \u202e")]);
    const hist = lines.slice(lines.indexOf("--- history ---") + 1);
    expect(hist).toHaveLength(1);
    expect(hist[0]).not.toMatch(CONTROL);
    expect(hist[0]).not.toMatch(INVISIBLE);
    expect(hist[0]!.startsWith("guest: ")).toBe(true);
  });
  it("sanitizes hostile role ids too", () => {
    const lines = joinedWith([u(1, "ev\u001bil", "t")]);
    const hist = lines.slice(lines.indexOf("--- history ---") + 1);
    expect(hist).toHaveLength(1);
    expect(hist[0]).not.toMatch(CONTROL);
  });
  it("caps the history at the last 50 lines with an earlier-lines marker", () => {
    const lines = joinedWith(Array.from({ length: 60 }, (_, i) => u(i + 1, "guest", `line ${i + 1}`)));
    expect(lines).toContain("(+10 earlier lines)");
    expect(lines).toContain("guest: line 60");
    expect(lines).not.toContain("guest: line 10");
    expect(lines).toContain("guest: line 11");
  });
  it("prints no history section when there is nothing to show", () => {
    expect(joinedWith([])).not.toContain("--- history ---");
  });
});

describe("renderError for the token and rate limits (US-0017)", () => {
  it("explains unauthorized and rate_limited without echoing anything from the server", () => {
    expect(renderError("unauthorized", "x\x1b[2Jsecret")).toMatch(/needs the facilitator token/);
    expect(renderError("unauthorized", "x\x1b[2Jsecret")).not.toContain("secret");
    expect(renderError("rate_limited", "whatever")).toMatch(/slow down/);
  });
});
