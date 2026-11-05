import type { Seats } from "../engine/seats.js";

/** What the facilitator sees of a seat. */
export type FacilitatorRosterEntry = { roleId: string; name?: string; joined: boolean; consented: boolean; connected: boolean; ai?: true };
/** What a player sees of another seat: the name and whether it is ready, nothing about consent or connection. */
export type PeerRosterEntry = { roleId: string; name?: string; ready: boolean; ai?: true };

/**
 * US-0055: who sits where. Entries follow the scenario's player role order and never include an AI character. A name comes only from
 * the credentials record (a terminal player has none). `ready` needs the SAME participant to hold the seat and to have consented.
 * US-0060: an AI seat (`ai: true`, absent otherwise) never consents; it is ready as soon as its bot holds it.
 */
export function buildRoster(input: { playerRoles: string[]; assignments: Record<string, string>; connected: ReadonlySet<string>; seats?: Seats; aiRoles?: ReadonlySet<string> }): { facilitator: FacilitatorRosterEntry[]; peers: PeerRosterEntry[] } {
  const facilitator: FacilitatorRosterEntry[] = [];
  const peers: PeerRosterEntry[] = [];
  for (const roleId of input.playerRoles) {
    const holder = Object.hasOwn(input.assignments, roleId) ? input.assignments[roleId] : undefined;
    const joined = holder !== undefined;
    const ai = input.aiRoles?.has(roleId) === true;
    const consented = !ai && joined && (input.seats?.consent.has(roleId, holder) ?? false);
    const aiField = ai ? { ai: true as const } : {};
    const name = input.seats?.credentials.nameOf(roleId);
    const nameField = name !== undefined ? { name } : {};
    facilitator.push({ roleId, ...nameField, joined, consented, connected: input.connected.has(roleId), ...aiField });
    peers.push({ roleId, ...nameField, ready: ai ? joined : joined && consented, ...aiField });
  }
  return { facilitator, peers };
}
