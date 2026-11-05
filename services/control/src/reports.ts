import { listReleasedRoles, readReleasedView, reviewStatus, type ReleasedView } from "@acr/runtime/reports";
import type { ControlConfig } from "./config.js";
import type { ReportAccessStore, ReportCredential } from "./report-access.js";
import { ControlError } from "./supervisor.js";

/** Fixed sentences: no path, id or role is ever part of them. */
export const NOT_READY = "No reports are ready for this session yet. Run evaluate, then moderate open and release, from the terminal (see the guide).";
export const NO_REPORT = "There is no released report to link for this role.";
export const REPORTS_UNREADABLE = "The reports for this session cannot be read. Check them with moderate status.";
export const REPORT_UNAVAILABLE = "The report is unavailable. Try again.";

const LOG_EVERY_MS = 60_000;

export type ReadOutcome =
  | { status: 200; body: { state: "released"; view: ReleasedView } | { state: "not_released" } }
  | { status: 503 }
  | { status: 404 };

export type LinksState = "ready" | "not_ready" | "unavailable";

export type ReportService = {
  /** `state`: ready (a live review resolves), not_ready (nothing to find yet) or unavailable (the reports cannot be read). */
  links(sessionId: string): Promise<{ state: LinksState; roles: { role: string; credential: ReportCredential | null }[] }>;
  issue(sessionId: string, role: string): Promise<{ credential: ReportCredential; token: string }>;
  reissue(sessionId: string, role: string): Promise<{ credential: ReportCredential; token: string }>;
  /** True when a credential was revoked now; false when there was nothing to revoke (idempotent, not an error). */
  revoke(sessionId: string, role: string): Promise<boolean>;
  /** The credential behind a token, or null for anything that is not a live one (one answer for every reason). Throws `unavailable` when the store cannot be read. */
  exchange(token: string): Promise<{ credentialId: string; sessionId: string; role: string; expiresAt: number } | null>;
  read(sessionId: string, credentialId: string): Promise<ReadOutcome>;
};

/**
 * Report links for released reports. The single `store` instance is created by the entry point (two instances on one file would lose
 * updates). Nothing here logs or echoes a token, hash, id, role, path or error message; a storage problem logs one fixed line, at most
 * once a minute.
 */
export function createReportService(d: { config: ControlConfig; store: ReportAccessStore; secrets: string[]; now: () => number; log?: (m: string) => void }): ReportService {
  const { config, store, secrets, now } = d;
  let lastLog = -Infinity;
  const warn = (m: string): void => {
    const t = now();
    if (!d.log || t - lastLog < LOG_EVERY_MS) return;
    lastLog = t;
    d.log(m);
  };
  const storeDown = (): ControlError => { warn("report-access store unreadable"); return new ControlError("unavailable", REPORT_UNAVAILABLE); };
  const reportsDown = (): ControlError => { warn("report reader unavailable"); return new ControlError("unavailable", REPORTS_UNREADABLE); };
  /** Runs a store call; an `unavailable` failure is logged once a minute and rethrown unchanged. */
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) { if (e instanceof ControlError && e.code === "unavailable") warn("report-access store unreadable"); throw e; }
  };

  /** Refuses with a fixed sentence unless a live review resolves and the role has a released report in it. */
  async function requireReleased(sessionId: string, role: string): Promise<void> {
    const st = await reviewStatus(config.reportsDir, sessionId);
    if (st.kind === "none") throw new ControlError("conflict", NOT_READY);
    if (st.kind === "unavailable") throw reportsDown();
    const roles = await listReleasedRoles(config.reportsDir, sessionId);
    if (roles === null) throw reportsDown();
    if (!roles.includes(role)) throw new ControlError("conflict", NO_REPORT);
  }

  return {
    async links(sessionId) {
      const st = await reviewStatus(config.reportsDir, sessionId);
      let state: LinksState = st.kind === "found" ? "ready" : st.kind === "none" ? "not_ready" : "unavailable";
      let released: string[] = [];
      if (st.kind === "found") {
        const r = await listReleasedRoles(config.reportsDir, sessionId);
        if (r === null) state = "unavailable"; else released = r;
      }
      if (state === "unavailable") warn("report reader unavailable");
      const t = now();
      const liveBy = new Map<string, ReportCredential>();
      for (const c of await guarded(() => store.list(sessionId))) {
        if (c.revokedAt === undefined && t < c.expiresAt) liveBy.set(c.role, c);
      }
      // A role with a live link stays listed even when its report was withdrawn, so the facilitator can still revoke it.
      const roles = [...new Set([...released, ...liveBy.keys()])].sort();
      return { state, roles: roles.map((role) => ({ role, credential: liveBy.get(role) ?? null })) };
    },
    async issue(sessionId, role) {
      await requireReleased(sessionId, role);
      return guarded(() => store.issue(sessionId, role));
    },
    async reissue(sessionId, role) {
      await requireReleased(sessionId, role);
      return guarded(() => store.reissue(sessionId, role));
    },
    revoke: (sessionId, role) => guarded(() => store.revoke(sessionId, role)),
    async exchange(token) {
      const r = await store.verifyResult(token);
      if (r.kind === "unavailable") throw storeDown();
      return r.kind === "refused" ? null : { credentialId: r.credential.id, sessionId: r.credential.sessionId, role: r.credential.role, expiresAt: r.credential.expiresAt };
    },
    async read(sessionId, credentialId) {
      const l = await store.checkResult(credentialId, sessionId);
      if (l.kind === "unavailable") { warn("report-access store unreadable"); return { status: 503 }; }
      if (l.kind === "refused" || l.credential.sessionId !== sessionId) return { status: 404 };
      const r = await readReleasedView(config.reportsDir, sessionId, l.credential.role, secrets);
      if (r.kind === "released") return { status: 200, body: { state: "released", view: r } };
      if (r.kind === "unavailable") { warn("report reader unavailable"); return { status: 503 }; }
      return { status: 200, body: { state: "not_released" } };
    },
  };
}
