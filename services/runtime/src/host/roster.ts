import type { Seats } from "../engine/seats.js";
import type { VoiceState } from "./voice.js";

/**
 * What the facilitator sees of a seat. US-0071 (K6): `voice` (the seat's voice state) and `speaking` (present only while its holder is
 * speaking) exist only when voice is enabled for the session; a player's roster never carries either.
 */
export type FacilitatorRosterEntry = { roleId: string; name?: string; joined: boolean; consented: boolean; connected: boolean; ai?: true; voice?: VoiceState; speaking?: true };
/** What a player sees of another seat: the name and whether it is ready, nothing about consent or connection. */
export type PeerRosterEntry = { roleId: string; name?: string; ready: boolean; ai?: true };

/**
 * US-0055: who sits where. Entries follow the scenario's player role order and never include an AI character. A name comes only from
 * the credentials record (a terminal player has none). `ready` needs the SAME participant to hold the seat and to have consented.
 * US-0060: an AI seat (`ai: true`, absent otherwise) never consents; it is ready as soon as its bot holds it.
 */
export function buildRoster(input: { playerRoles: string[]; assignments: Record<string, string>; connected: ReadonlySet<string>; seats?: Seats; aiRoles?: ReadonlySet<string>; voice?: { stateOf: (roleId: string) => VoiceState; speaking: ReadonlySet<string> } }): { facilitator: FacilitatorRosterEntry[]; peers: PeerRosterEntry[] } {
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
    const voiceFields = input.voice ? { voice: input.voice.stateOf(roleId), ...(input.voice.speaking.has(roleId) ? { speaking: true as const } : {}) } : {};
    facilitator.push({ roleId, ...nameField, joined, consented, connected: input.connected.has(roleId), ...aiField, ...voiceFields });
    peers.push({ roleId, ...nameField, ready: ai ? joined : joined && consented, ...aiField });
  }
  return { facilitator, peers };
}
