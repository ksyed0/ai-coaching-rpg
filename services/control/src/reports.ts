import { listReleasedRoles, readReleasedView, resolveReviewDir, type ReleasedView } from "@acr/runtime/reports";
import type { ControlConfig } from "./config.js";
import type { ReportAccessStore, ReportCredential } from "./report-access.js";
import { ControlError } from "./supervisor.js";

/** Fixed sentences: no path, id or role is ever part of them. */
export const NOT_READY = "No reports are ready for this session yet. Run evaluate, then moderate open and release, from the terminal (see the guide).";
export const NO_REPORT = "There is no released report to link for this role.";

export type ReadOutcome =
  | { status: 200; body: { state: "released"; view: ReleasedView } | { state: "not_released" } }
  | { status: 503 }
  | { status: 404 };

export type ReportService = {
  links(sessionId: string): Promise<{ ready: boolean; roles: { role: string; credential: ReportCredential | null }[] }>;
  issue(sessionId: string, role: string): Promise<{ credential: ReportCredential; token: string }>;
  reissue(sessionId: string, role: string): Promise<{ credential: ReportCredential; token: string }>;
  /** True when a credential was revoked now; false when there was nothing to revoke (idempotent, not an error). */
  revoke(sessionId: string, role: string): Promise<boolean>;
  /** The credential behind a token, or null for anything that is not a live one (one answer for every reason). */
  exchange(token: string): Promise<{ credentialId: string; sessionId: string; role: string; expiresAt: number } | null>;
  read(sessionId: string, credentialId: string): Promise<ReadOutcome>;
};

/**
 * Report links for released reports. The single `store` instance is created by the entry point (two instances on one file would lose
 * updates). Nothing here logs or echoes a token, hash, id, role, path or error message.
 */
export function createReportService(d: { config: ControlConfig; store: ReportAccessStore; secrets: string[]; now: () => number }): ReportService {
  const { config, store, secrets, now } = d;

  /** Refuses with a fixed sentence unless a live review resolves and the role has a released report in it. */
  async function requireReleased(sessionId: string, role: string): Promise<void> {
    if ((await resolveReviewDir(config.reportsDir, sessionId)) === null) throw new ControlError("conflict", NOT_READY);
    const roles = await listReleasedRoles(config.reportsDir, sessionId);
    if (roles === null) throw new ControlError("conflict", NOT_READY);
    if (!roles.includes(role)) throw new ControlError("conflict", NO_REPORT);
  }

  return {
    async links(sessionId) {
      const ready = (await resolveReviewDir(config.reportsDir, sessionId)) !== null;
      const released = ready ? ((await listReleasedRoles(config.reportsDir, sessionId)) ?? []) : [];
      const t = now();
      const liveBy = new Map<string, ReportCredential>();
      for (const c of await store.list(sessionId)) {
        if (c.revokedAt === undefined && t < c.expiresAt) liveBy.set(c.role, c);
      }
      // A role with a live link stays listed even when its report was withdrawn, so the facilitator can still revoke it.
      const roles = [...new Set([...released, ...liveBy.keys()])].sort();
      return { ready, roles: roles.map((role) => ({ role, credential: liveBy.get(role) ?? null })) };
    },
    async issue(sessionId, role) {
      await requireReleased(sessionId, role);
      return store.issue(sessionId, role);
    },
    async reissue(sessionId, role) {
      await requireReleased(sessionId, role);
      return store.reissue(sessionId, role);
    },
    revoke: (sessionId, role) => store.revoke(sessionId, role),
    async exchange(token) {
      const c = await store.verify(token);
      return c === null ? null : { credentialId: c.id, sessionId: c.sessionId, role: c.role, expiresAt: c.expiresAt };
    },
    async read(sessionId, credentialId) {
      const c = await store.check(credentialId, sessionId);
      if (c === null || c.sessionId !== sessionId) return { status: 404 };
      const r = await readReleasedView(config.reportsDir, sessionId, c.role, secrets);
      if (r.kind === "released") return { status: 200, body: { state: "released", view: r } };
      if (r.kind === "unavailable") return { status: 503 };
      return { status: 200, body: { state: "not_released" } };
    },
  };
}
