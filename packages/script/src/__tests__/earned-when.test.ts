import { describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_EARNED_WHEN_CHARS, NpcRoleSchema, earnedWhenOf, loadScenario, validateScenario, type NpcRole } from "../index.js";

// US-0034 (AC-0123): an optional `earned_when` condition per hidden fact, keyed by the fact's 1-based number.
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function guestBase(): Promise<Record<string, unknown>> {
  const s = await loadScenario(path.join(fixtures, "minimal"));
  return { ...(s.roles["guest"] as object) } as Record<string, unknown>;
}

describe("earned_when (scenario schema)", () => {
  it("is optional: a role without it parses WITHOUT the key, so the loaded scenario (and its hash) is unchanged", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    const guest = s.roles["guest"] as NpcRole;
    expect(Object.hasOwn(guest, "earned_when")).toBe(false);
    expect(JSON.stringify(s)).not.toContain("earned_when");
    expect(earnedWhenOf(guest)).toEqual([]);
  });

  it("accepts a condition for a fact number and trims it", async () => {
    const r = NpcRoleSchema.parse({ ...(await guestBase()), earned_when: { 1: "  a player asks whether Sam is staying  " } });
    expect(r.earned_when).toEqual({ "1": "a player asks whether Sam is staying" });
    expect(earnedWhenOf(r)).toEqual([{ fact: 1, condition: "a player asks whether Sam is staying" }]);
  });

  it("refuses an empty or over-long condition and a key that is not a fact number", async () => {
    const base = await guestBase();
    for (const bad of [{ 1: "" }, { 1: "   " }, { 1: "x".repeat(MAX_EARNED_WHEN_CHARS + 1) }, { 0: "c" }, { "01": "c" }, { one: "c" }, { "-1": "c" }, { "1.5": "c" }, { __proto__x: "c" }, { 1: 7 }]) {
      expect(NpcRoleSchema.safeParse({ ...base, earned_when: bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(NpcRoleSchema.safeParse({ ...base, earned_when: { 1: "x".repeat(MAX_EARNED_WHEN_CHARS) } }).success).toBe(true);
    expect(NpcRoleSchema.safeParse({ ...base, earned_when: ["a"] }).success).toBe(false);
  });

  it("the validator refuses a number the character has no fact for", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    (s.roles["guest"] as NpcRole).earned_when = { "1": "ok", "3": "too far" };
    expect(validateScenario(s).errors).toContain("role guest: earned_when names hidden fact 3, but the role has 1 hidden fact(s)");
    (s.roles["guest"] as NpcRole).earned_when = { "1": "ok" };
    expect(validateScenario(s).errors).toEqual([]);
  });

  it("lists conditions in fact order", () => {
    const role = { earned_when: { "10": "ten", "2": "two", "1": "one" } } as unknown as NpcRole;
    expect(earnedWhenOf(role).map((x) => x.fact)).toEqual([1, 2, 10]);
  });

  it("loads from YAML (a numeric key) and reports a bad key with its path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-earned-"));
    try {
      await cp(path.join(fixtures, "minimal"), dir, { recursive: true });
      const file = path.join(dir, "roles", "guest.yaml");
      const yaml = await readFile(file, "utf8");
      await writeFile(file, `${yaml}earned_when:\n  1: a player asks whether Sam is staying\n`);
      const s = await loadScenario(dir);
      expect(earnedWhenOf(s.roles["guest"] as NpcRole)).toEqual([{ fact: 1, condition: "a player asks whether Sam is staying" }]);
      await writeFile(file, `${yaml}earned_when:\n  first: a player asks\n`);
      await expect(loadScenario(dir)).rejects.toThrow(/roles\/guest\.yaml: earned_when\.first/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
