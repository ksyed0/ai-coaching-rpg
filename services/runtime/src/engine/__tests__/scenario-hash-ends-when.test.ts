import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { REPO_ROOT } from "../../main.js";
import { scenarioHash } from "../scenario-hash.js";

// US-0080 (AC-0461): adding the optional scene field `ends_when` must not change the canonical hash of a scenario that does not use it,
// or every session in progress would refuse to resume (`scenario_mismatch`). The hashes below were computed BEFORE the schema change
// (commit 089d33bf, the base of US-0080) with the same `scenarioHash`.
const MINIMAL = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const BEFORE = {
  minimal: "20dac41903317e68c2c4de953bcf1a8ad6b34bf314f45488fa275675ccb30d5c",
  "friday-escalation": "cc43b68ffac2dabf35cbcb2988f6ec0777767d236a1f547f1b771168f833b67e",
  "friday-escalation-extended": "a23c62314085cdd0fb4a084e46c8f985a6a16124a1d124df473359c2894e0d21",
} as const;

/** The opening injects US-0080 added to the shipped scenarios, by scene: removed again to rebuild the scenario as it was before. */
const ADDED_OPENINGS: Record<keyof typeof BEFORE, Record<string, string>> = {
  minimal: {},
  "friday-escalation": { s2_client_call: "call_opens", s3_internal_wrap: "wrap_opens" },
  "friday-escalation-extended": { s2_priya_call: "call_opens", s3_internal_huddle: "huddle_opens" },
};

/** The US-0080 content edits undone: every `ends_when` and the added opening injects (an injects list that only held one goes too). */
function withoutUs0080(s: Scenario, name: keyof typeof BEFORE): Scenario {
  const copy = structuredClone(s);
  for (const scene of copy.script.scenes) {
    delete scene.ends_when;
    const added = ADDED_OPENINGS[name][scene.id];
    if (added === undefined) continue;
    expect(scene.opening_inject, scene.id).toBe(added);
    delete scene.opening_inject;
    scene.injects = (scene.injects ?? []).filter((i) => i.id !== added);
    if (scene.injects.length === 0) delete scene.injects;
  }
  return copy;
}

describe("scenario hash and ends_when (US-0080)", () => {
  it("test_scenarioHash_unchanged_for_a_scenario_without_ends_when", async () => {
    const s = await loadScenario(MINIMAL);
    expect(s.script.scenes.some((x) => Object.hasOwn(x, "ends_when"))).toBe(false);
    expect(scenarioHash(s)).toBe(BEFORE.minimal);
  });

  it("test_scenarioHash_an_absent_ends_when_key_and_an_undefined_one_hash_the_same", async () => {
    const s = await loadScenario(MINIMAL);
    const c = structuredClone(s);
    for (const scene of c.script.scenes) scene.ends_when = undefined;
    expect(scenarioHash(c)).toBe(BEFORE.minimal);
  });

  it("test_scenarioHash_a_present_ends_when_changes_the_hash", async () => {
    const c = structuredClone(await loadScenario(MINIMAL));
    c.script.scenes[0]!.ends_when = "both have said hello";
    expect(scenarioHash(c)).not.toBe(BEFORE.minimal);
  });

  it.each(["friday-escalation", "friday-escalation-extended"] as const)("test_scenarioHash_%s_with_the_US0080_edits_undone_matches_the_hash_before", async (name) => {
    const now = await loadScenario(path.join(REPO_ROOT, "scenarios", name));
    // The content edit is real: the shipped scenario's hash moved (a Friday session in progress at deploy time does not resume).
    expect(scenarioHash(now)).not.toBe(BEFORE[name]);
    // Undoing exactly the US-0080 edits gives the old hash back: the schema change itself moved nothing, and nothing else was edited.
    expect(scenarioHash(withoutUs0080(now, name))).toBe(BEFORE[name]);
  });
});
