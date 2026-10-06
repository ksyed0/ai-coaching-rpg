import { describe, expect, it } from "vitest";
import { parseEvalConfig } from "../config.js";

describe("parseEvalConfig", () => {
  it("has defaults", () => {
    expect(parseEvalConfig({})).toEqual({ ok: true, model: undefined, maxTokens: 3000, temperature: 0.2, timeoutMs: 180_000, firstTokenTimeoutMs: 60_000, transcriptChars: 60_000 });
  });
  it("reads every variable", () => {
    const c = parseEvalConfig({ EVAL_MODEL: " claude-x/1 ", EVAL_MAX_TOKENS: "4000", EVAL_TEMPERATURE: "0.5", EVAL_TIMEOUT_MS: "90000", EVAL_TRANSCRIPT_CHARS: "10000" });
    expect(c).toMatchObject({ ok: true, model: "claude-x/1", maxTokens: 4000, temperature: 0.5, timeoutMs: 90_000, transcriptChars: 10_000 });
  });
  it("never lets the evaluator deadline be below the NPC reply timeout", () => {
    const c = parseEvalConfig({ EVAL_TIMEOUT_MS: "5000", NPC_REPLY_TIMEOUT_MS: "120000", NPC_FIRST_TOKEN_TIMEOUT_MS: "100000" });
    expect(c).toMatchObject({ ok: true, timeoutMs: 120_000, firstTokenTimeoutMs: 100_000 });
  });
  it("has no floor other than the NPC reply timeout (exactly max(EVAL_TIMEOUT_MS, NPC_REPLY_TIMEOUT_MS))", () => {
    expect(parseEvalConfig({ EVAL_TIMEOUT_MS: "5000", NPC_REPLY_TIMEOUT_MS: "5000", NPC_FIRST_TOKEN_TIMEOUT_MS: "1000" })).toMatchObject({ ok: true, timeoutMs: 5000 });
    expect(parseEvalConfig({ EVAL_TIMEOUT_MS: "5000", NPC_REPLY_TIMEOUT_MS: "8000", NPC_FIRST_TOKEN_TIMEOUT_MS: "1000" })).toMatchObject({ ok: true, timeoutMs: 8000 });
  });
  it("the first-token wait never exceeds the deadline", () => {
    const c = parseEvalConfig({ EVAL_TIMEOUT_MS: "30000" });
    expect(c).toMatchObject({ ok: true });
    if (c.ok) expect(c.firstTokenTimeoutMs).toBeLessThanOrEqual(c.timeoutMs);
  });
  it.each([
    [{ EVAL_MAX_TOKENS: "199" }, /EVAL_MAX_TOKENS/], [{ EVAL_MAX_TOKENS: "8001" }, /EVAL_MAX_TOKENS/], [{ EVAL_MAX_TOKENS: "1e3" }, /EVAL_MAX_TOKENS/],
    [{ EVAL_TEMPERATURE: "3" }, /EVAL_TEMPERATURE/], [{ EVAL_TEMPERATURE: "-1" }, /EVAL_TEMPERATURE/],
    [{ EVAL_TIMEOUT_MS: "100" }, /EVAL_TIMEOUT_MS/], [{ EVAL_TIMEOUT_MS: "9999999" }, /EVAL_TIMEOUT_MS/], [{ EVAL_TIMEOUT_MS: "3s" }, /EVAL_TIMEOUT_MS/],
    [{ EVAL_MODEL: "https://x.example/model" }, /EVAL_MODEL/], [{ EVAL_MODEL: "a b" }, /EVAL_MODEL/], [{ EVAL_TRANSCRIPT_CHARS: "10" }, /EVAL_TRANSCRIPT_CHARS/],
    [{ NPC_REPLY_TIMEOUT_MS: "x" }, /NPC_REPLY_TIMEOUT_MS/],
  ])("rejects %j", (env, re) => {
    const c = parseEvalConfig(env);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.errors.join(" ")).toMatch(re);
  });
});
