import type { JoinCodes } from "../engine/join-codes.js";
import type { Seats } from "../engine/seats.js";
import type { SessionHost } from "./session-host.js";
import { CLOSE_REISSUED, type ServerHandle } from "./ws-server.js";
import { MAX_DISPLAY_NAME_CHARS, normalizeDisplayName } from "./display-name.js";

/** What reissueRole works on; main.ts supplies the real ones, tests fakes. */
export type ReissueDeps = {
  host: SessionHost;
  seats: Seats;
  /** The codes in force now (read afresh on every call: a swap changes them). */
  codes: () => JoinCodes;
  /** Makes `c` the codes in force (memory and the server's verifier). */
  setCodes(c: JoinCodes): void;
  /** Persists `c` (the atomic codes file with the session lock check); throws when it cannot. */
  writeCodes(c: JoinCodes): void;
  server: Pick<ServerHandle, "kickRole">;
  sessionId: string;
  /** Where a failure that must not fail the reissue goes (the alert append). Never receives the code. */
  report?: (what: string, err: unknown) => void;
};

/** The name a facilitator-only alert carries: cleaned, at most 60 code points, no control or hidden characters; "the facilitator" when absent or empty. */
export function reissueActor(by: string | undefined): string {
  if (by === undefined) return "the facilitator";
  const flat = by.replace(/[\r\n\t]+/g, " ");
  return normalizeDisplayName([...flat].slice(0, MAX_DISPLAY_NAME_CHARS).join("")) ?? "the facilitator";
}

/**
 * US-0058: gives ONE player role a new join code. Only the control service can ask (over the fork() IPC channel). Returns the new
 * plain code, which exists nowhere else: the caller hands it to the parent and drops it. Throws (with nothing changed, except as
 * noted at 2) for a role that is not a player role of this session.
 *
 * A code opens only a role that has no credential, so the order is fixed, and chosen so that a failed codes write changes nothing:
 *  1. Build the new codes (pure) and WRITE them to the codes file first. If this fails the old code, the credential, the consent and
 *     the socket are all untouched and the reissue fails cleanly (the plan's order revoked the seat before the write, so a failed
 *     write had already thrown a player out for nothing). The file then briefly holds a code the memory does not know yet; step 2
 *     failing restores the old file.
 *  2. Revoke the credential; before the start withdraw the consent (the person must consent again), after the start release it for a
 *     rebind (it waits for the next participant); persist the seats. If the persist fails, the old codes file is put back and the
 *     error is rethrown (the in-memory seat is already revoked and the host retries the write like any failed seat write).
 *  3. Kick the role's socket (CLOSE_REISSUED), which frees the seat synchronously; then, even if the kick threw, swap the new codes
 *     in (the file already has them, so memory must follow). Nothing in 2 and 3 awaits, so no join can run between the revoke and
 *     the swap: the credential is gone and persisted before the socket is kicked and before the new code can open anything.
 *  4. After the start only, append the facilitator-only alert (naming who reissued, never the code). Its failure is reported, not
 *     thrown: the code has already changed and the caller must still receive it. Before the start nothing may be appended: the
 *     engine refuses to start a log that already has events.
 */
export async function reissueRole(d: ReissueDeps, roleId: string, by?: string): Promise<string> {
  if (!d.host.hasPlayerRole(roleId)) throw new Error("not a player role of this session");
  if (d.host.engine.state.status === "ended") throw new Error("the session has ended");
  const old = d.codes();
  const { codes, plain } = old.withRole(roleId); // throws when the codes hold no entry for the role
  d.writeCodes(codes);
  const afterStart = d.host.hasStartedOrStarting;
  try {
    d.seats.credentials.revoke(roleId);
    if (afterStart) d.seats.consent.releaseForRebind(roleId); else d.seats.consent.withdraw(roleId);
    d.seats.persist();
  } catch (err) {
    try { d.writeCodes(old); } catch (restoreErr) { d.report?.("restoring the join codes file after a failed reissue", restoreErr); }
    throw err;
  }
  try { d.server.kickRole(d.sessionId, roleId, CLOSE_REISSUED); }
  finally { d.setCodes(codes); }
  // Before the start the log must stay EMPTY (engine.start refuses a log that has events, and a managed restart relies on an empty
  // lobby log), so there is no event to append: the console shows the reissue from the control service's own state instead.
  if (afterStart) await d.host.noteFacilitator(`consent for ${roleId} will be rebound after a code reissue by ${reissueActor(by)}`);
  return plain;
}
