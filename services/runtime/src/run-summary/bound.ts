import type { SessionEvent } from "@acr/events";
import type { Rubric, Scenario } from "@acr/script";
import { aiRolesOf } from "../evaluator/ai-players.js";

/**
 * The most model calls an evaluation of this session can make: each scored unit gets one call and at most one re-ask
 * (`evaluate.ts`), so `2 x (human players + 1 when the group rubric has criteria)`. AI-filled player roles are not scored. A log whose
 * AI roles are inconsistent counts every player role (the evaluator would refuse it before any call). `rubrics` are the scenario's
 * loaded rubrics; without them the group call is assumed, which can only raise the bound.
 */
export function evaluationCallBound(events: SessionEvent[], scenario: Scenario, rubrics?: readonly Pick<Rubric, "scope" | "criteria">[]): number {
  const ai = aiRolesOf(events, scenario);
  const aiRoles = ai === "invalid" ? [] : ai;
  const humans = Object.values(scenario.roles).filter((r) => r.type === "player" && !aiRoles.includes(r.id)).length;
  const group = rubrics === undefined || rubrics.some((r) => r.scope === "group" && r.criteria.length > 0) ? 1 : 0;
  return 2 * (humans + group);
}
