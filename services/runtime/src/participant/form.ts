/**
 * The blind self-assessment form (EPIC-0002, slice 2c-2). It reads from the review ONLY each criterion's id and name, the generic
 * scale and the role's own earlier self-ratings; no evaluator field (level, score, rationale, evidence, comment, confidence) is
 * read into the result. It takes no lock and writes nothing. Every expected state is a fixed result kind, never an exception.
 */
import { isFileSafeId } from "@acr/events";
import { buildMethod } from "../evaluator/method.js";
import { reviewStatus } from "../reports/index.js";
import { loadReview } from "../review/store.js";
import { REVIEW_SCHEMA } from "../review/types.js";
import type { FormResult } from "./types.js";

export async function readSelfAssessForm(
  reportsDir: string,
  sessionId: string,
  role: string,
): Promise<FormResult> {
  try {
    const st = await reviewStatus(reportsDir, sessionId);
    if (st.kind !== "found") return { kind: st.kind };
    if (typeof role !== "string" || !isFileSafeId(role))
      return { kind: "none" };
    const l = await loadReview(st.dir);
    if (l.view.opened.session.id !== sessionId) return { kind: "unavailable" };
    if (l.view.superseded !== null) return { kind: "none" };
    // AI roles and the group are never subjects of a self-rating: only a human participant has a subject here.
    const sv = l.view.subjects.get(role);
    if (!sv || sv.kind !== "participant") return { kind: "none" };
    if (l.view.opened.schema !== REVIEW_SCHEMA) return { kind: "old_schema" };
    if (sv.state === "withdrawn") return { kind: "withdrawn" };
    if (sv.state !== "draft" || sv.versions.length > 0 || sv.selfClosed)
      return { kind: "closed" };
    const existing: Extract<FormResult, { kind: "form" }>["existing"] = {};
    for (const c of sv.criteria)
      if (c.self)
        existing[c.id] = {
          level: c.self.level,
          ...(c.self.note !== undefined ? { note: c.self.note } : {}),
        };
    return {
      kind: "form",
      criteria: sv.criteria.map((c) => ({ id: c.id, name: c.name })),
      scale: buildMethod().scale.map((s) => ({ ...s })),
      existing,
    };
  } catch {
    return { kind: "unavailable" };
  }
}
