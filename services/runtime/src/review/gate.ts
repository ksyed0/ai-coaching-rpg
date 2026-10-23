import type { SubjectView } from "./fold.js";

/** Why this subject cannot be released yet (empty: it can). Pure. Messages carry only ids. */
export function releaseProblems(sv: SubjectView): string[] {
  const out: string[] = [];
  if (!sv.evaluationOk) {
    const todo = sv.criteria
      .filter((c) => c.status !== "edited")
      .map((c) => c.id);
    if (todo.length)
      out.push(
        `the evaluation failed; score these by hand first: ${todo.join(", ")}`,
      );
  } else {
    const open = sv.criteria
      .filter((c) => c.status === "needs_review")
      .map((c) => c.id);
    if (open.length)
      out.push(`needs review (accept or edit): ${open.join(", ")}`);
  }
  if (sv.summaryStale)
    out.push(
      "the summary may be out of date after a score change: edit it or accept it",
    );
  return out;
}
