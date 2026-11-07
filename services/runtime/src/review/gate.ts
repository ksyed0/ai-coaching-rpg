import type { SubjectView } from "./fold.js";

/**
 * The criteria release requires to be scored by hand (edited), whatever their review status: every criterion not yet edited when the
 * evaluation failed, else each one whose level is an evaluator error (`invalid`; an acceptance does not resolve it). Pure.
 */
export function scoreByHand(sv: SubjectView): string[] {
  return sv.evaluationOk
    ? sv.criteria.filter((c) => c.current === "invalid").map((c) => c.id)
    : sv.criteria.filter((c) => c.status !== "edited").map((c) => c.id);
}

/** Why this subject cannot be released yet (empty: it can). Pure. Messages carry only ids. */
export function releaseProblems(sv: SubjectView): string[] {
  const out: string[] = [];
  if (!sv.evaluationOk) {
    const todo = scoreByHand(sv);
    if (todo.length)
      out.push(
        `the evaluation failed; score these by hand first: ${todo.join(", ")}`,
      );
  } else {
    // An evaluator error on one criterion is not a score to accept: like a failed evaluation, it is scored by hand (edit).
    const broken = scoreByHand(sv);
    if (broken.length)
      out.push(
        `the evaluator could not score these; score them by hand first (edit): ${broken.join(", ")}`,
      );
    const open = sv.criteria
      .filter((c) => c.status === "needs_review" && c.current !== "invalid")
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
