import { FACILITATOR_FORWARD_KEY } from "./facilitator-budget";
import type { Deps } from "./handlers";
import { RuntimeError, type RuntimeConnection } from "./runtime-connection";
import type { FacilitatorRosterEntry, SessionStatus } from "./wire";

// A facilitator's socket to one session's runtime. The control service hands out `{ port, token }` as a pair for the child's current
// start, so both are fetched together, every time. A refused token means the pair went stale (the child restarted): a FRESH pair is
// fetched once and tried once; the same token is never sent twice and there is never a third attempt. Every facilitator socket carries the
// reserved X-Forwarded-For FACILITATOR_FORWARD_KEY: the runtime charges a refused facilitator login to one scope per address, so
// it must be a key no player can send (requestAddress never yields it), and never a player's address or the BFF's loopback. Each
// call holds one "short" budget slot of its session, from before the first launcher call until its last socket has closed.

export type FacilitatorJoin = {
  roster: FacilitatorRosterEntry[];
  status: SessionStatus;
};

/** The socket could not be had. `reason` is a fixed word; no token, port or URL is ever in it. */
export class FacilitatorSocketError extends Error {
  constructor(readonly reason: "unavailable" | "unauthorized" | "busy") {
    super(`facilitator socket: ${reason}`);
    this.name = "FacilitatorSocketError";
  }
}

/**
 * Opens a facilitator connection to `sessionId`, runs `fn` with it and the join result, and ALWAYS closes it. A LauncherError from the
 * lookups propagates unchanged; any socket failure is a FacilitatorSocketError.
 */
export async function withFacilitatorSocket<T>(
  deps: Deps,
  sessionId: string,
  fn: (conn: RuntimeConnection, joined: FacilitatorJoin) => Promise<T>,
): Promise<T> {
  const launcher = deps.launcher;
  if (!launcher) throw new FacilitatorSocketError("unavailable");
  const release = deps.facilitatorBudget.tryAcquire(sessionId, "short");
  if (release === null) throw new FacilitatorSocketError("busy");
  // The slot is freed once, when every connection made has reported close (at once when none was made).
  let open = 0;
  let finished = false;
  const maybeRelease = () => {
    if (finished && open === 0) release();
  };
  const track = (conn: RuntimeConnection) => {
    open++;
    conn.onClose(() => {
      open--;
      maybeRelease();
    });
  };
  try {
    let refusedToken: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { port, token } = await launcher.facilitator(sessionId);
      // A "fresh" pair with the token that was just refused is the same start of the child: sending it again cannot succeed.
      if (token === refusedToken) break;
      let conn: RuntimeConnection;
      try {
        conn = await deps.connect(`ws://127.0.0.1:${port}`, FACILITATOR_FORWARD_KEY);
      } catch {
        throw new FacilitatorSocketError("unavailable");
      }
      track(conn);
      let joined: FacilitatorJoin;
      try {
        joined = await conn.joinFacilitator(sessionId, token);
      } catch (err) {
        conn.close();
        if (err instanceof RuntimeError && err.code === "unauthorized") {
          refusedToken = token;
          continue;
        }
        throw new FacilitatorSocketError("unavailable");
      }
      try {
        return await fn(conn, joined);
      } finally {
        conn.close();
      }
    }
    throw new FacilitatorSocketError("unauthorized");
  } finally {
    finished = true;
    maybeRelease();
  }
}
