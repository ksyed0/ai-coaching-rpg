// The console's share of one session runtime's per-address connection cap. Every facilitator socket the BFF opens carries the same
// reserved X-Forwarded-For value, so the runtime counts them all under one key; this budget keeps that key below the runtime's cap
// (CHILD_WS_MAX_CONNECTIONS_PER_IP = 8) by limiting what one session can hold: long-lived live-view tabs and short request sockets.

/** The reserved X-Forwarded-For value of every facilitator socket. Not an address: requestAddress turns it into null, so no player can send it. */
export const FACILITATOR_FORWARD_KEY = "scenecoach-console";
export const LIVE_TABS_PER_SESSION = 4;
export const SHORT_SOCKETS_PER_SESSION = 3;

export type SocketKind = "live" | "short";

const LIMITS: Record<SocketKind, number> = {
  live: LIVE_TABS_PER_SESSION,
  short: SHORT_SOCKETS_PER_SESSION,
};

export class FacilitatorBudget {
  private readonly counts = new Map<string, number>();

  /** A release function (idempotent), or null when this session already holds its share of `kind`. */
  tryAcquire(sessionId: string, kind: SocketKind): (() => void) | null {
    const key = `${kind}:${sessionId}`;
    const n = this.counts.get(key) ?? 0;
    if (n >= LIMITS[kind]) return null;
    this.counts.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.counts.get(key) ?? 1) - 1;
      if (left <= 0) this.counts.delete(key);
      else this.counts.set(key, left);
    };
  }

  inUse(sessionId: string, kind: SocketKind): number {
    return this.counts.get(`${kind}:${sessionId}`) ?? 0;
  }
}
