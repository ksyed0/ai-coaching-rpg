import { describe, expect, it } from "vitest";
import { parseAiPlayerSettings } from "../index.js";

const ok = (env: NodeJS.ProcessEnv) => { const r = parseAiPlayerSettings(env); if (!r.ok) throw new Error(r.errors.join("; ")); return r.settings; };
const errs = (env: NodeJS.ProcessEnv) => { const r = parseAiPlayerSettings(env); if (r.ok) throw new Error("expected errors"); return r.errors; };

describe("parseAiPlayerSettings", () => {
  it("defaults are 15000, 90000, 10, 6000, 60 and temperature 0.9 with no model", () => {
    const s = ok({});
    expect(s.turn).toEqual({ minGapMs: 15_000, nudgeMs: 90_000, linesPerScene: 10, settleMs: 6_000 });
    expect(s.callsPerSession).toBe(60);
    expect(s.temperature).toBe(0.9);
    expect(s.model).toBeUndefined();
    expect(s.hardTimeoutMs).toBe(s.replyTimeoutMs + 5_000);
    expect(s.maxTokens).toBe(600);
  });

  it('PLAYER_MODEL "claude-x" is used and "http://x" is refused naming PLAYER_MODEL but not the value', () => {
    expect(ok({ PLAYER_MODEL: "claude-x" }).model).toBe("claude-x");
    const e = errs({ PLAYER_MODEL: "http://x" }).join("\n");
    expect(e).toContain("PLAYER_MODEL");
    expect(e).not.toContain("http://x");
  });

  it('AI_PLAYER_MIN_GAP_MS "-1", "1e3" and "700000" are refused with the variable name', () => {
    for (const v of ["-1", "1e3", "700000"]) {
      const e = errs({ AI_PLAYER_MIN_GAP_MS: v }).join("\n");
      expect(e).toContain("AI_PLAYER_MIN_GAP_MS");
      expect(e).not.toContain(v);
    }
  });

  it("reads each setting within its range and refuses outside it, never repeating the value", () => {
    expect(ok({ AI_PLAYER_MIN_GAP_MS: "0", AI_PLAYER_NUDGE_MS: "10000", AI_PLAYER_LINES_PER_SCENE: "100", AI_PLAYER_SETTLE_MS: "60000", AI_PLAYER_CALLS_PER_SESSION: "0" }))
      .toMatchObject({ turn: { minGapMs: 0, nudgeMs: 10_000, linesPerScene: 100, settleMs: 60_000 }, callsPerSession: 0 });
    for (const [name, v] of [["AI_PLAYER_NUDGE_MS", "9999"], ["AI_PLAYER_LINES_PER_SCENE", "-5"], ["AI_PLAYER_SETTLE_MS", "60001"], ["AI_PLAYER_CALLS_PER_SESSION", "1001"], ["AI_PLAYER_LINES_PER_SCENE", "sekret"]] as const) {
      const e = errs({ [name]: v }).join("\n");
      expect(e).toContain(name);
      expect(e).not.toContain(v);
    }
  });

  it("errors from the existing temperature, timeout and token parsers name the variable but not the value", () => {
    for (const [name, v] of [["PLAYER_TEMPERATURE", "hotsecret"], ["NPC_REPLY_TIMEOUT_MS", "abcsecret"], ["NPC_MAX_TOKENS", "tokensecret"]] as const) {
      const e = errs({ [name]: v }).join("\n");
      expect(e).toContain(name);
      expect(e).not.toContain(v);
    }
    const order = errs({ NPC_FIRST_TOKEN_TIMEOUT_MS: "9000", NPC_REPLY_TIMEOUT_MS: "1000" }).join("\n");
    expect(order).toContain("NPC_REPLY_TIMEOUT_MS");
    expect(order).not.toContain("9000");
    expect(order).not.toContain("1000");
  });

  it("uses the NPC reply timeout and token budget; the hard timeout is the reply timeout plus 5 s", () => {
    const s = ok({ NPC_REPLY_TIMEOUT_MS: "30000", NPC_MAX_TOKENS: "250", PLAYER_TEMPERATURE: "0.4" });
    expect(s).toMatchObject({ replyTimeoutMs: 30_000, hardTimeoutMs: 35_000, maxTokens: 250, temperature: 0.4 });
  });
});
