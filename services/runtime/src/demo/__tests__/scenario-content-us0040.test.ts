import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenario, validateScenario, type NpcRole, type PlayerRole } from "@acr/script";
import { REPO_ROOT } from "../../main.js";

// US-0040 scenario content pass: both Friday Escalation scenarios share the same pricing anchor, role ownership, Priya's earned_when and rubrics.
const NAMES = ["friday-escalation", "friday-escalation-extended"] as const;
const dirOf = (n: string) => path.join(REPO_ROOT, "scenarios", n);
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const COST_FACT = "Your delivery cost is 2,400 per person-day and the margin floor on any change request is 20 percent";

describe.each(NAMES)("%s content (US-0040)", (name) => {
  it("loads and validates with zero errors and zero warnings", async () => {
    expect(validateScenario(await loadScenario(dirOf(name)))).toEqual({ errors: [], warnings: [] });
  });

  it("gives the delivery lead the pricing anchor as a PRIVATE fact only (no other file holds it, and it is in no public field)", async () => {
    const sc = await loadScenario(dirOf(name));
    expect((sc.roles.delivery_lead as PlayerRole).private_facts).toContain(COST_FACT);
    const holders = files(dirOf(name)).filter((f) => readFileSync(f, "utf8").includes(COST_FACT)).map((f) => path.basename(f));
    expect(holders).toEqual(["delivery_lead.yaml"]);
    // the numbers appear nowhere else in the package (persona, context, injects, rubrics, showcase lines)
    for (const f of files(dirOf(name)).filter((x) => !x.endsWith("delivery_lead.yaml"))) expect(readFileSync(f, "utf8"), f).not.toMatch(/2,400|margin floor/);
  });

  it("states who owns what in the briefs: plan, date and delivery commitment / price, terms and relationship / estimate and technical risk", async () => {
    const roles = (await loadScenario(dirOf(name))).roles;
    const brief = (id: string) => (roles[id] as PlayerRole).brief.replace(/\s+/g, " ");
    expect(brief("delivery_lead")).toContain("own the plan, the date and the delivery commitment");
    expect(brief("account_manager")).toContain("own price, commercial terms and the client relationship");
    expect(brief("tech_lead")).toContain("own the architecture, the estimate and the technical risk");
    // briefs stay short and hold no hidden fact
    for (const id of ["delivery_lead", "account_manager", "tech_lead"]) {
      expect(brief(id).length, id).toBeLessThan(330);
      for (const npc of Object.values(roles).filter((r): r is NpcRole => r.type === "npc")) for (const h of npc.hidden) expect(brief(id)).not.toContain(h);
    }
  });

  it("gives Priya's hidden fact 1 an earned_when condition the Game Master can judge, without putting the fact in it", async () => {
    const priya = (await loadScenario(dirOf(name))).roles.client_sponsor as NpcRole;
    expect(Object.keys(priya.earned_when ?? {})).toEqual(["1"]);
    const cond = priya.earned_when!["1"]!;
    expect(cond.split(/\s+/).length).toBeGreaterThanOrEqual(6);
    expect(cond).toMatch(/risk/);
    expect(cond).not.toContain(priya.hidden[0]!);
  });
});

describe("the two scenarios", () => {
  it("have byte-identical rubric files", () => {
    const [a, b] = NAMES.map((n) => path.join(dirOf(n), "rubrics"));
    const names = readdirSync(a!).sort();
    expect(names).toEqual(["group_collaboration_v1.yaml", "individual_delivery_v2.yaml"]);
    expect(readdirSync(b!).sort()).toEqual(names);
    for (const f of names) expect(readFileSync(path.join(a!, f)).equals(readFileSync(path.join(b!, f))), f).toBe(true);
  });

  it("carry the bumped versions and a duration that covers the scene time boxes", async () => {
    const base = await loadScenario(dirOf("friday-escalation"));
    const ext = await loadScenario(dirOf("friday-escalation-extended"));
    expect(base.meta.version).toBe("1.3");
    expect(ext.meta.version).toBe("1.1");
    expect(ext.meta.duration_minutes).toBe(55);
    const sum = (s: typeof ext) => s.script.scenes.reduce((n, x) => n + x.time_box_minutes, 0);
    expect(sum(ext)).toBe(51);
    expect(sum(ext)).toBeLessThanOrEqual(ext.meta.duration_minutes);
  });

  it("have a Game Master exit condition in every scene of the original (scene 3 gained one)", async () => {
    const base = await loadScenario(dirOf("friday-escalation"));
    for (const scene of base.script.scenes) expect(scene.exit_when.any_of.some((c) => typeof c === "object"), scene.id).toBe(true);
    expect(base.script.scenes[2]!.exit_when.any_of).toContainEqual({ gm_detects: "the team has assigned an owner and a next action for each follow-up" });
  });
});
