import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenario, validateScenario, type NpcRole, type PlayerRole } from "@acr/script";
import { REPO_ROOT } from "../../main.js";

const DIR = path.join(REPO_ROOT, "scenarios", "friday-escalation-extended");
const load = () => loadScenario(DIR);

describe("scenarios/friday-escalation-extended", () => {
  it("loads and validates with zero errors and zero warnings", async () => {
    const s = await load();
    expect(validateScenario(s)).toEqual({ errors: [], warnings: [] });
  });

  it("has 3 player roles (same ids as Friday Escalation), 2 AI characters and 6 scenes", async () => {
    const s = await load();
    const roles = Object.values(s.roles);
    expect(roles.filter((r) => r.type === "player").map((r) => r.id).sort()).toEqual(["account_manager", "delivery_lead", "tech_lead"]);
    expect(roles.filter((r) => r.type === "npc").map((r) => r.id).sort()).toEqual(["cfo", "client_sponsor"]);
    expect(s.script.scenes.map((x) => x.id)).toEqual(["s1_huddle", "s2_priya_call", "s3_internal_huddle", "s4_escalation_call", "s5_final_terms", "s6_wrap_up"]);
    expect(s.meta.duration_minutes).toBe(50);
    expect(s.script.scenes.reduce((n, x) => n + x.time_box_minutes, 0)).toBeGreaterThanOrEqual(45);
    expect(s.script.scenes.reduce((n, x) => n + x.time_box_minutes, 0)).toBeLessThanOrEqual(55);
  });

  it("puts the AI characters in the scenes they were designed for", async () => {
    const s = await load();
    const npcsIn = (id: string) => s.script.scenes.find((x) => x.id === id)!.participants.filter((p) => s.roles[p]!.type === "npc");
    expect(npcsIn("s1_huddle")).toEqual([]);
    expect(npcsIn("s2_priya_call")).toEqual(["client_sponsor"]);
    expect(npcsIn("s3_internal_huddle")).toEqual([]);
    expect(npcsIn("s4_escalation_call")).toEqual(["client_sponsor", "cfo"]);
    expect(npcsIn("s5_final_terms")).toEqual(["client_sponsor", "cfo"]);
    expect(npcsIn("s6_wrap_up")).toEqual([]);
  });

  it("gives every scene a time-box and advance backstop, a time box and a gm_detects condition a model can judge", async () => {
    const s = await load();
    for (const scene of s.script.scenes) {
      const any = scene.exit_when.any_of;
      expect(any, scene.id).toContain("time_box_elapsed");
      expect(any, scene.id).toContain("facilitator_advance");
      const gm = any.filter((c): c is { gm_detects: string } => typeof c === "object");
      expect(gm.length, scene.id).toBeGreaterThanOrEqual(1);
      for (const g of gm) expect(g.gm_detects.trim().split(/\s+/).length, scene.id).toBeGreaterThanOrEqual(6);
      expect(scene.time_box_minutes, scene.id).toBeGreaterThan(0);
    }
  });

  it("has unique inject ids and valid inject targets (inside the scene), including an NPC-aimed and a single-player private inject", async () => {
    const s = await load();
    const all = s.script.scenes.flatMap((x) => (x.injects ?? []).map((i) => ({ scene: x, inject: i })));
    const ids = all.map((a) => a.inject.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { scene, inject } of all) {
      for (const t of inject.to) expect(scene.participants, `${inject.id} -> ${t}`).toContain(t);
      if (inject.at_minute !== undefined) expect(inject.at_minute).toBeLessThan(scene.time_box_minutes);
    }
    const npcAimed = all.filter((a) => a.inject.to.every((t) => s.roles[t]!.type === "npc") && (a.inject.effect?.goals_add || a.inject.effect?.knowledge_add));
    expect(npcAimed.length).toBeGreaterThanOrEqual(2);
    expect(npcAimed.some((a) => a.inject.to.includes("cfo"))).toBe(true);
    const privateToOnePlayer = all.filter((a) => a.inject.to.length === 1 && s.roles[a.inject.to[0]!]!.type === "player");
    expect(privateToOnePlayer.length).toBeGreaterThanOrEqual(3);
    expect(all.filter((a) => a.inject.at_minute !== undefined).length).toBeGreaterThanOrEqual(5);
  });

  it("describes the new CFO fully (persona, goals, knowledge, hidden fact, guardrails, an in-character fallback line)", async () => {
    const cfo = (await load()).roles.cfo as NpcRole;
    expect(cfo.name).toBe("Helena Brandt");
    expect(cfo.persona.length).toBeGreaterThan(80);
    for (const k of ["goals", "knowledge", "hidden", "guardrails"] as const) expect(cfo[k].length, k).toBeGreaterThanOrEqual(1);
    expect(cfo.fallback_line.length).toBeGreaterThan(10);
    expect(cfo.fallback_line).not.toBe((await load()).roles.client_sponsor && ((await load()).roles.client_sponsor as NpcRole).fallback_line);
    // Fictional and harmless: no URLs, e-mail addresses or key-like tokens anywhere in the package.
    for (const f of walk(DIR)) expect(readFileSync(f, "utf8"), f).not.toMatch(/https?:\/\/|@[a-z0-9-]+\.[a-z]{2,}|sk-[A-Za-z0-9]{8,}/i);
  });

  it("keeps each player's private facts in that player's role file only (marker uniqueness)", async () => {
    const s = await load();
    const files = walk(DIR).map((f) => ({ f, text: readFileSync(f, "utf8") }));
    for (const role of Object.values(s.roles).filter((r): r is PlayerRole => r.type === "player")) {
      expect(role.private_facts.length).toBeGreaterThanOrEqual(2);
      for (const fact of role.private_facts) {
        const holders = files.filter((x) => x.text.includes(fact)).map((x) => path.basename(x.f));
        expect(holders, `"${fact}"`).toEqual([`${role.id}.yaml`]);
      }
    }
  });

  it("holds the hidden facts of the AI characters in their own role files only", async () => {
    const s = await load();
    const files = walk(DIR).map((f) => ({ f, text: readFileSync(f, "utf8") }));
    for (const npc of Object.values(s.roles).filter((r): r is NpcRole => r.type === "npc")) {
      for (const h of npc.hidden) expect(files.filter((x) => x.text.includes(h)).map((x) => path.basename(x.f)), h).toEqual([`${npc.id}.yaml`]);
    }
  });

  it("does not touch the original Friday Escalation scenario package", () => {
    expect(readdirSync(path.join(REPO_ROOT, "scenarios", "friday-escalation")).sort()).toEqual(["roles", "scenario.yaml", "script.yaml"]);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe("scenario polish (review fixes)", () => {
  it("has no folded scalar that leaves a trailing newline (a stray ' ⏎ ' in inject text)", async () => {
    const s = await load();
    const strings: string[] = [];
    const walkValue = (v: unknown): void => {
      if (typeof v === "string") strings.push(v); else if (Array.isArray(v)) v.forEach(walkValue); else if (v && typeof v === "object") Object.values(v).forEach(walkValue);
    };
    walkValue(s);
    expect(strings.filter((x) => /\s$/.test(x))).toEqual([]);
    for (const f of walk(DIR)) expect(readFileSync(f, "utf8"), f).not.toMatch(/: >\s*$/m);
  });
  it("keeps the effort numbers consistent: the module is 6 person-weeks, the phased half is 3, and the scripted tech lead says so", async () => {
    const s = await load();
    expect((s.roles.delivery_lead as PlayerRole).private_facts.join(" ")).toContain("6 person-weeks");
    expect((s.roles.tech_lead as PlayerRole).private_facts.join(" ")).toContain("half the effort");
    const yaml = readFileSync(path.join(DIR, "showcase.yaml"), "utf8");
    expect(yaml).toContain("about three person-weeks");
    expect(yaml).not.toMatch(/three weeks of (build|two engineers)/);
  });
});
