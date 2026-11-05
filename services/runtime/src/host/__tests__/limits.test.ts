import { describe, expect, it } from "vitest";
import type { Scenario } from "@acr/script";
import { MAX_AI_ROLES, MAX_MANAGED_PLAYER_ROLES, noticeNamesAiPlayers, playerRoleCapError } from "../limits.js";

// US-0060: the runtime limits.
const withPlayers = (n: number, npcs = 2) => ({
  roles: { ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { id: `p${i}`, type: "player" }])), ...Object.fromEntries(Array.from({ length: npcs }, (_, i) => [`n${i}`, { id: `n${i}`, type: "npc" }])) },
}) as unknown as Scenario;

describe("limits (US-0060)", () => {
  it("the constants", () => { expect(MAX_AI_ROLES).toBe(8); expect(MAX_MANAGED_PLAYER_ROLES).toBe(12); });

  it("playerRoleCapError is null for 12 and names 13", () => {
    expect(playerRoleCapError(withPlayers(12))).toBeNull();
    expect(playerRoleCapError(withPlayers(1))).toBeNull();
    expect(playerRoleCapError(withPlayers(13))).toBe("a managed session allows at most 12 player roles (this scenario has 13)");
  });

  it("noticeNamesAiPlayers is v<N> with N >= 2", () => {
    for (const v of ["v1", "x2", "v", "v2x", "2"]) expect(noticeNamesAiPlayers(v)).toBe(false);
    for (const v of ["v2", "v3", "v10"]) expect(noticeNamesAiPlayers(v)).toBe(true);
  });
});
