import { describe, expect, it } from "vitest";
import { DEFAULT_GM_TEMPERATURE, DEFAULT_NPC_TEMPERATURE, DEFAULT_PLAYER_TEMPERATURE, parseTemperatures } from "../temperatures.js";

describe("parseTemperatures", () => {
  it("defaults to 0.8 / 0.9 / 0.2 when unset or blank", () => {
    expect(parseTemperatures({})).toEqual({ ok: true, npcTemperature: DEFAULT_NPC_TEMPERATURE, playerTemperature: DEFAULT_PLAYER_TEMPERATURE, gmTemperature: DEFAULT_GM_TEMPERATURE });
    expect(DEFAULT_NPC_TEMPERATURE).toBe(0.8); expect(DEFAULT_PLAYER_TEMPERATURE).toBe(0.9); expect(DEFAULT_GM_TEMPERATURE).toBe(0.2);
    expect(parseTemperatures({ NPC_TEMPERATURE: "  ", GM_TEMPERATURE: "" })).toMatchObject({ ok: true, npcTemperature: 0.8, gmTemperature: 0.2 });
  });
  it.each([["0", 0], ["2", 2], ["1.25", 1.25], [" 0.5 ", 0.5], ["02", 2]])("accepts %j", (raw, v) => {
    expect(parseTemperatures({ NPC_TEMPERATURE: raw, PLAYER_TEMPERATURE: raw, GM_TEMPERATURE: raw })).toEqual({ ok: true, npcTemperature: v, playerTemperature: v, gmTemperature: v });
  });
  it.each(["2.01", "3", "-1", "1e1", "abc", ".5", "1.", "0x1", "1,5", "NaN"])("rejects %j with a clear error naming the variable", (raw) => {
    const r = parseTemperatures({ PLAYER_TEMPERATURE: raw });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors).toHaveLength(1); expect(r.errors[0]).toMatch(/^PLAYER_TEMPERATURE ".*" is (invalid|out of range): use a number from 0 to 2/); }
  });
  it("reports every bad variable", () => {
    const r = parseTemperatures({ NPC_TEMPERATURE: "x", GM_TEMPERATURE: "9" });
    expect(r.ok ? [] : r.errors).toHaveLength(2);
  });
});
