import type { ReissueDeps } from "./reissue.js";
import { CLOSE_AI_FILLED, CLOSE_REISSUED, type ServerHandle } from "./ws-server.js";

/** What setAiRoles works on: the reissue wiring, and a server that can also re-send the roster. */
export type AiRolesDeps = Omit<ReissueDeps, "server"> & { server: Pick<ServerHandle, "kickRole" | "broadcastRoster"> };

/** The fixed reasons a switch is refused with (never a path, a role list or an Error message). */
export const AI_ROLES_REFUSED = {
  started: "AI roles can only be changed before the start",
  invalid: "not a player role of this session",
  noHuman: "at least one player role must stay human",
  failed: "the AI roles could not be changed",
} as const;

/** A refused switch. Nothing was changed. */
export class AiRolesRefusedError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.name = "AiRolesRefusedError"; this.reason = reason; }
}

/**
 * US-0060: sets which player roles an AI plays, before the start. Only the control service can ask (fork() IPC). Mirrors reissueRole.
 *
 * 0. Refusals first, nothing changed: the start begun, in flight or done (`started`); an unknown, AI-character, reserved, non-string or
 *    duplicate role (`invalid`); every player role AI (`noHuman`); no AI-role set on the seats (`failed`).
 * 1. `changed` is the symmetric difference of the current and the wanted set, in the scenario's player-role order. None: return [] and
 *    write nothing (the same request again is a no-op).
 * 2. Every changed role gets a NEW code, written FIRST: a revoked credential reopens the seat to its old code, so a switched-out human
 *    could walk into the AI seat unconsented, and a bot's code would reopen a seat handed back to a human. If this write fails nothing
 *    else was touched.
 * 3. Revoke each changed role's credential, withdraw its consent, replace the AI set, persist (credentials, consent, AI-role file). A
 *    failure restores all three in memory, puts the old codes file back, re-persists once (best effort: the disk may still hold the
 *    revoked credential and consent, which only makes a role "human without credential", never "AI with a human's credential") and rethrows.
 * 4. Kick each changed role (to AI: CLOSE_AI_FILLED; back to human: CLOSE_REISSUED), swap the codes in, re-send the roster (a role nobody
 *    held sends nothing from the kick). A kick that throws is reported, not rethrown: the caller must still receive the codes.
 * Nothing is appended to the log (the start refuses a log that has events).
 */
export async function setAiRoles(d: AiRolesDeps, roles: string[]): Promise<{ roleId: string; code: string }[]> {
  const aiSet = d.seats.aiRoles;
  if (!aiSet) throw new AiRolesRefusedError(AI_ROLES_REFUSED.failed);
  if (d.host.hasStarted || d.host.isStarting || d.host.engine.state.status !== "idle") throw new AiRolesRefusedError(AI_ROLES_REFUSED.started);
  if (!Array.isArray(roles)) throw new AiRolesRefusedError(AI_ROLES_REFUSED.invalid);
  const wanted = new Set<string>();
  for (const r of roles as unknown[]) {
    if (typeof r !== "string" || !d.host.hasPlayerRole(r) || wanted.has(r)) throw new AiRolesRefusedError(AI_ROLES_REFUSED.invalid);
    wanted.add(r);
  }
  const players = d.host.playerRoleIds();
  if (players.length === 0) throw new AiRolesRefusedError(AI_ROLES_REFUSED.failed);
  if (players.every((r) => wanted.has(r))) throw new AiRolesRefusedError(AI_ROLES_REFUSED.noHuman);
  const changed = players.filter((r) => aiSet.has(r) !== wanted.has(r));
  if (changed.length === 0) return [];

  const old = d.codes();
  let codes = old;
  const plain: Record<string, string> = {};
  for (const r of changed) { const next = codes.withRole(r); codes = next.codes; plain[r] = next.plain; } // throws when the codes hold no entry for a role
  d.writeCodes(codes);

  const credBefore = changed.map((r) => d.seats.credentials.snapshotRole(r));
  const consentBefore = changed.map((r) => d.seats.consent.entryOf(r));
  const aiBefore = aiSet.list();
  try {
    for (const r of changed) { d.seats.credentials.revoke(r); d.seats.consent.withdraw(r); }
    aiSet.replace(players.filter((r) => wanted.has(r)), players);
    d.seats.persist();
  } catch (err) {
    // Memory first (so no old code can open a seat whose holder is still connected), then the old codes file, then one best-effort re-persist.
    changed.forEach((r, i) => { d.seats.credentials.restoreRole(r, credBefore[i]); d.seats.consent.restoreEntry(r, consentBefore[i]); });
    aiSet.replace(aiBefore, players);
    try { d.writeCodes(old); } catch (restoreErr) { d.report?.("restoring the join codes file after a failed AI-role change", restoreErr); }
    try { d.seats.persist(); } catch (persistErr) { d.report?.("re-persisting the seats after a failed AI-role change", persistErr); }
    throw err;
  }
  try {
    for (const r of changed) {
      try { d.server.kickRole(d.sessionId, r, aiSet.has(r) ? CLOSE_AI_FILLED : CLOSE_REISSUED); }
      catch (kickErr) { d.report?.("kicking the socket of a role whose AI flag changed", kickErr); }
    }
  } finally { d.setCodes(codes); }
  try { d.server.broadcastRoster(d.sessionId); } catch (rosterErr) { d.report?.("re-sending the roster after an AI-role change", rosterErr); }
  return changed.map((r) => ({ roleId: r, code: plain[r]! }));
}
