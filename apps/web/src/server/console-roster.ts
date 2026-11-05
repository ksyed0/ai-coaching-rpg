import type { FacilitatorRosterEntry } from "./wire";

// One seat as the console may see it, picked field by field (the name is capped). Imports nothing but a type, so both the session API
// and the live-view copies can use it without a cycle.

const MAX_NAME_CODE_POINTS = 60;
const cap = (name: string) => [...name].slice(0, MAX_NAME_CODE_POINTS).join("");

export const entryOf = (e: FacilitatorRosterEntry): FacilitatorRosterEntry => ({
  roleId: e.roleId,
  ...(typeof e.name === "string" && { name: cap(e.name) }),
  joined: e.joined === true,
  consented: e.consented === true,
  connected: e.connected === true,
  // Default-deny: only the literal boolean true marks an AI seat; any other value is dropped.
  ...(e.ai === true && { ai: true as const }),
});
