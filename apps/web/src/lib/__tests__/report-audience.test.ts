import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUDIENCE_KINDS, AUDIENCE_POLICY_VERSION, audienceOf, subjectKind } from "../report-audience";

// The release dialog's audience wording mirrors the runtime's visibility policy (services/runtime/src/review/policy.ts). The web app's
// sources never import the runtime (runtime-imports.test.ts); this test does, by a computed path (as hub.runtime.test.ts), so tsc does not
// type-check the runtime's sources under this app's settings.
const POLICY_PATH = fileURLToPath(new URL("../../../../../services/runtime/src/review/policy.ts", import.meta.url));
type Policy = { version: number; personal: readonly string[]; group: readonly string[] };
const loadPolicy = async (): Promise<Policy> => ((await import(/* @vite-ignore */ POLICY_PATH)) as { POLICY: Policy }).POLICY;

/** The audiences the policy can resolve to a person today; the rest (line manager, L&D, HR, sponsor) are inert. */
const RESOLVABLE = ["facilitator", "participant"];

describe("report-audience", () => {
  it("a snapshot test that report-audience.ts equals POLICY in review/policy.ts", async () => {
    const POLICY = await loadPolicy();
    expect(AUDIENCE_POLICY_VERSION).toBe(POLICY.version);
    for (const kind of ["personal", "group"] as const) {
      expect([...AUDIENCE_KINDS[kind]].sort(), kind).toEqual(POLICY[kind].filter((a) => RESOLVABLE.includes(a)).sort());
      // the inert audiences are in the policy and never in the wording
      const inert = POLICY[kind].filter((a) => !RESOLVABLE.includes(a));
      expect(inert.length, kind).toBeGreaterThan(0);
      for (const a of inert) expect(AUDIENCE_KINDS[kind], kind).not.toContain(a);
    }
  });

  it("names that participant and the facilitator for a personal report, every participant without peers' results and the facilitator for the group", () => {
    expect(subjectKind("account_manager")).toBe("personal");
    expect(subjectKind("group")).toBe("group");
    expect(audienceOf("account_manager")).toEqual(["Account manager (the participant this report is about)", "The facilitator"]);
    expect(audienceOf("group")).toEqual(["Every participant, with the other participants' individual results removed", "The facilitator"]);
    const all = [...audienceOf("account_manager"), ...audienceOf("group")].join(" ");
    expect(all).not.toMatch(/line manager|L&D|\bHR\b|sponsor/i);
  });
});
