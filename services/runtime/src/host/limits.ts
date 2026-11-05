import type { Scenario } from "@acr/script";

/** US-0060: how many player roles of a session may be AI players. */
export const MAX_AI_ROLES = 8;
/** US-0060: how many player roles a managed (control-service) session may have. */
export const MAX_MANAGED_PLAYER_ROLES = 12;

/** The refusal of a managed bootstrap of a scenario with too many player roles, or null when it is within the cap. */
export function playerRoleCapError(scenario: Scenario): string | null {
  const n = Object.values(scenario.roles).filter((r) => r.type === "player").length;
  return n > MAX_MANAGED_PLAYER_ROLES ? `a managed session allows at most ${MAX_MANAGED_PLAYER_ROLES} player roles (this scenario has ${n})` : null;
}

/** Whether a consent notice version names AI players: `v<N>` with N >= 2 (v1 predates AI players). */
export function noticeNamesAiPlayers(version: string): boolean {
  const m = /^v(\d+)$/.exec(version);
  return m !== null && Number(m[1]) >= 2;
}
