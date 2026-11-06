/**
 * How many criteria each human player has rated, for the facilitator (EPIC-0002, slice 2c-2). Read-only, no lock. All roles share
 * one log, so a log that cannot be read (for example a torn last line) is `unavailable` for the whole call.
 */
import { reviewStatus } from "../reports/index.js";
import { loadReview } from "../review/store.js";
import type { ProgressResult, ProgressRow } from "./types.js";

export async function selfRatingProgress(
  reportsDir: string,
  sessionId: string,
): Promise<ProgressResult> {
  try {
    const st = await reviewStatus(reportsDir, sessionId);
    if (st.kind !== "found") return { kind: st.kind };
    const l = await loadReview(st.dir);
    if (l.view.opened.session.id !== sessionId) return { kind: "unavailable" };
    const rows: ProgressRow[] = [];
    for (const sv of l.view.subjects.values()) {
      if (sv.kind !== "participant" || sv.state !== "draft") continue;
      rows.push({
        role: sv.id,
        rated: sv.criteria.filter((c) => c.self).length,
        total: sv.criteria.length,
      });
    }
    rows.sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
    return { kind: "ok", rows };
  } catch {
    return { kind: "unavailable" };
  }
}
