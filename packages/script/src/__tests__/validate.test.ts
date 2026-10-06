import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadScenario, validateScenario } from "../index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("validateScenario", () => {
  it("passes the minimal fixture with no errors", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    expect(validateScenario(s).errors).toEqual([]);
  });

  it("errors on a scene participant that is not a role", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.script.scenes[0].participants.push("ghost");
    expect(validateScenario(s).errors).toContain("scene s1_open: participant 'ghost' is not a role");
  });

  it("errors on the reserved role id 'facilitator'", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    const first = Object.values(s.roles)[0]!;
    s.roles["facilitator"] = { ...first, id: "facilitator" };
    expect(validateScenario(s).errors).toContain("role id 'facilitator' is reserved for the facilitator connection");
  });

  it("errors on duplicate inject ids across scenes", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.script.scenes[1].injects = [{ ...s.script.scenes[0].injects![0] }];
    expect(validateScenario(s).errors).toContain("inject id 'late_inject' is used more than once");
  });

  it("warns when an inject fires after the scene time box", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.script.scenes[0].injects![0].at_minute = 5;
    expect(validateScenario(s).warnings).toContain("scene s1_open: inject 'late_inject' at minute 5 is after the 2 minute time box");
  });

  it("warns on a learning objective with no rubric criteria", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.meta.learning_objectives[0].rubric_criteria = [];
    expect(validateScenario(s).warnings).toContain("learning objective LO1 maps to no rubric criteria");
  });

  it("errors when an inject id equals a scene id", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.script.scenes[0].injects![0].id = "s2_close";
    expect(validateScenario(s).errors).toContain("id 's2_close' is used by both a scene and an inject");
  });

  it("errors when a scene id equals a role id", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.script.scenes[1].id = "guest";
    expect(validateScenario(s).errors).toContain("id 'guest' is used by both a role and a scene");
  });

  it("errors when the scenario id equals a role id", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.meta.id = "guest";
    expect(validateScenario(s).errors).toContain("id 'guest' is used by both the scenario and a role");
  });
});

describe("AI character voice fields (US-0032)", () => {
  const npcOf = async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    const npc = Object.values(s.roles).find((r) => r.type === "npc")!;
    return { s, npc: npc as Extract<typeof npc, { type: "npc" }> };
  };
  it("defaults: seniority 3 and empty lists", async () => {
    const { npc } = await npcOf();
    expect(npc).toMatchObject({ seniority: 3, responds_with: [], only_you_say: [], defer_to: [] });
  });
  it("accepts valid fields", async () => {
    const { s, npc } = await npcOf();
    npc.seniority = 5; npc.responds_with = ["a ruling"]; npc.only_you_say = ["price"];
    expect(validateScenario(s).errors).toEqual([]);
  });
  it("rejects an out-of-range seniority, too many or too long items", async () => {
    const { RoleSchema } = await import("../schema.js");
    const base = { id: "x", type: "npc", name: "X", persona: "p", goals: [] };
    expect(RoleSchema.safeParse({ ...base, seniority: 6 }).success).toBe(false);
    expect(RoleSchema.safeParse({ ...base, seniority: 0 }).success).toBe(false);
    expect(RoleSchema.safeParse({ ...base, seniority: 2.5 }).success).toBe(false);
    expect(RoleSchema.safeParse({ ...base, responds_with: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
    expect(RoleSchema.safeParse({ ...base, only_you_say: ["x".repeat(161)] }).success).toBe(false);
    expect(RoleSchema.safeParse({ ...base, only_you_say: [""] }).success).toBe(false);
    expect(RoleSchema.safeParse({ ...base, seniority: 4, responds_with: ["a"] }).success).toBe(true);
  });
  it("errors on defer_to naming an unknown role, a player role, itself or a duplicate", async () => {
    const { s, npc } = await npcOf();
    const player = Object.values(s.roles).find((r) => r.type === "player")!;
    npc.defer_to = ["ghost", player.id, npc.id];
    const errs = validateScenario(s).errors;
    expect(errs).toContain(`role ${npc.id}: defer_to 'ghost' is not a role`);
    expect(errs).toContain(`role ${npc.id}: defer_to '${player.id}' is not an AI character (npc) role`);
    expect(errs).toContain(`role ${npc.id}: defer_to cannot name the role itself`);
    npc.defer_to = [player.id, player.id];
    expect(validateScenario(s).errors.some((e) => e.includes("more than once"))).toBe(true);
  });
});

describe("shipped scenarios carry the voice fields (US-0032)", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../scenarios");
  it("extended: Helena (5) outranks Priya (3), who defers to her; both validate", async () => {
    const s = await loadScenario(path.join(root, "friday-escalation-extended"));
    expect(validateScenario(s).errors).toEqual([]);
    const cfo = s.roles.cfo as { seniority: number; responds_with: string[]; only_you_say: string[] };
    const priya = s.roles.client_sponsor as { seniority: number; defer_to: string[]; responds_with: string[] };
    expect(cfo.seniority).toBe(5); expect(priya.seniority).toBe(3);
    expect(priya.defer_to).toEqual(["cfo"]);
    expect(cfo.responds_with.length).toBeGreaterThan(0); expect(cfo.only_you_say.length).toBeGreaterThan(0);
  });
  it("plain: Priya has the fields and no defer_to (there is no CFO role)", async () => {
    const s = await loadScenario(path.join(root, "friday-escalation"));
    expect(validateScenario(s).errors).toEqual([]);
    expect(s.roles.client_sponsor).toMatchObject({ seniority: 3, defer_to: [] });
  });
});

describe("defer_to warnings and defers_text (US-0032 fix round)", () => {
  it("warns when defer_to names a less senior role, and when two roles defer to each other", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    const guest = Object.values(s.roles).find((r) => r.type === "npc")! as Extract<(typeof s.roles)[string], { type: "npc" }>;
    s.roles.other = { ...guest, id: "other", name: "Other", seniority: 1, defer_to: [guest.id] };
    guest.seniority = 4; guest.defer_to = ["other"];
    const w = validateScenario(s).warnings;
    expect(w).toContain(`role ${guest.id}: defer_to 'other' is less senior (1) than ${guest.id} (4)`);
    expect(w).toContain(`roles ${guest.id} and other defer to each other`);
    expect(validateScenario(s).errors).toEqual([]);
  });
  it("defers_text is optional and at most 200 characters", async () => {
    const { RoleSchema } = await import("../schema.js");
    const base = { id: "x", type: "npc", name: "X", persona: "p", goals: [] };
    expect(RoleSchema.safeParse(base).success).toBe(true);
    expect(RoleSchema.safeParse({ ...base, defers_text: "Let her decide." }).success).toBe(true);
    expect(RoleSchema.safeParse({ ...base, defers_text: "x".repeat(201) }).success).toBe(false);
  });
});
