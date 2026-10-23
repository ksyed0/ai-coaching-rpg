import { isFileSafeId, isReservedRoleId } from "@acr/events";
import type { GroupReport } from "../evaluator/report-model.js";
import { GROUP, POLICY_VERSION } from "./types.js";

export type Principal =
  | "facilitator"
  | `participant:${string}`
  | "line_manager"
  | "ld"
  | "hr"
  | "sponsor";
export type ViewKind = "report" | "index";
export type Access = {
  allowed: boolean;
  redact: "none" | "peers";
  why: string;
};

/** The subject name of the index export (a view of the group). */
const INDEX = "index";

/** The default audience policy (PRODUCT_SPEC section 7.3), version 1. A constant: data, not a principal model. */
export const POLICY = {
  version: POLICY_VERSION,
  personal: ["participant", "line_manager", "facilitator", "ld", "hr"],
  group: ["participant", "line_manager", "facilitator", "ld", "hr", "sponsor"],
} as const;

/** Only these audiences can be resolved to a person today (facilitator token, session role). The rest are inert until EPIC-0002 supplies identities. */
const RESOLVABLE = new Set(["facilitator", "participant"]);
const INERT = new Set(["line_manager", "ld", "hr", "sponsor"]);
const PREFIX = "participant:";

/** A role id a participant principal may carry: file safe, and not a word that names something else (facilitator, group, index, prototype keys). */
const isRoleId = (id: string): boolean =>
  isFileSafeId(id) && !isReservedRoleId(id) && id !== GROUP && id !== INDEX;

/**
 * Grammar: `facilitator | line_manager | ld | hr | sponsor | participant:<file-safe-role-id>`. Exact match only: no trimming,
 * case folding or normalisation, so a lookalike never becomes a principal. Anything else is null.
 */
export function parsePrincipal(raw: string): Principal | null {
  if (typeof raw !== "string") return null;
  if (raw === "facilitator" || INERT.has(raw)) return raw as Principal;
  if (raw.startsWith(PREFIX) && isRoleId(raw.slice(PREFIX.length)))
    return raw as Principal;
  return null;
}

/** Every denial reason is a constant: nothing from the request (a role, a subject, a principal string) is ever echoed. */
const no = (why: string): Access => ({ allowed: false, redact: "none", why });

const STATES: ReadonlySet<string> = new Set([
  "draft",
  "released",
  "amending",
  "withdrawn",
]);

/**
 * Who may see one subject (a role, `group`) or the index. Pure; denial is the default: every branch that is not an explicit
 * allow returns false. The facilitator may see any well-formed subject; everyone else only a released (or amending, with a
 * released snapshot), current, unsuperseded report.
 */
export function canView(o: {
  principal: Principal;
  subject: string;
  state: "draft" | "released" | "amending" | "withdrawn";
  versions: number;
  view: ViewKind;
  superseded: boolean;
  policyVersion: number;
}): Access {
  const principal = parsePrincipal(o.principal);
  if (principal === null) return no("unknown audience");
  if (o.view !== "report" && o.view !== "index") return no("unknown view");
  if (typeof o.subject !== "string") return no("unknown subject");
  const group = o.subject === GROUP || o.subject === INDEX;
  // The index is a view of the group, and a group subject is never a single report: the two must agree.
  if (
    group ? (o.subject === INDEX) !== (o.view === "index") : o.view === "index"
  )
    return no("unknown subject");
  if (!group && !isRoleId(o.subject)) return no("unknown subject");
  if (principal === "facilitator")
    return { allowed: true, redact: "none", why: "facilitator" };
  if (o.superseded !== false) return no("this review was superseded");
  if (o.policyVersion !== POLICY.version)
    return no("recorded under another visibility policy version");
  if (typeof o.state !== "string" || !STATES.has(o.state))
    return no("not released");
  if (o.state !== "released" && o.state !== "amending")
    return no("not released");
  if (!Number.isInteger(o.versions) || o.versions < 1)
    return no("not released");
  const kind = principal.startsWith(PREFIX) ? "participant" : principal;
  if (!(group ? POLICY.group : POLICY.personal).includes(kind as never))
    return no("not in the audience");
  if (!RESOLVABLE.has(kind))
    return no("this audience cannot be identified yet");
  if (!group && o.subject !== principal.slice(PREFIX.length))
    return no("not your report");
  return { allowed: true, redact: group ? "peers" : "none", why: "audience" };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The group report for one participant: peers' individual learning-objective results are removed (not blanked); the team result
 * stays. A copy; the input is not modified. Malformed coverage fails closed (nothing of any player survives except the caller's own).
 */
export function redactGroupForParticipant(
  g: GroupReport,
  role: string,
): GroupReport {
  const out = structuredClone(g);
  const cov: unknown = out.lo_coverage;
  const players =
    isObj(cov) && Array.isArray(cov["players"]) ? cov["players"] : [];
  const objectives =
    isObj(cov) && Array.isArray(cov["objectives"]) ? cov["objectives"] : [];
  out.lo_coverage = {
    players: players.filter((p) => p === role),
    objectives: objectives.filter(isObj).map((o) => {
      const by = isObj(o["by_role"]) ? o["by_role"] : {};
      return {
        ...o,
        by_role: Object.fromEntries(
          Object.entries(by).filter(([r]) => r === role),
        ),
      };
    }),
  } as GroupReport["lo_coverage"];
  return out;
}
