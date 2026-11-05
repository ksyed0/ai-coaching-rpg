import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { FakeClock } from "../clock.js";
import { MemoryEventLog } from "../event-log.js";
import { SessionEngine } from "../session-engine.js";

// US-0061: how a start records the group-score option in session.started.
let fri: Scenario;
beforeEach(async () => { fri = await loadScenario(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation")); });
const fresh = (log: MemoryEventLog) => new SessionEngine({ scenario: fri, log, clock: new FakeClock(1_000_000) });
const assign = () => Object.fromEntries(Object.values(fri.roles).filter((r) => r.type === "player").map((r) => [r.id, `p_${r.id}`]));
const first = async (log: MemoryEventLog) => (await log.all())[0]! as Record<string, unknown>;

describe("session.started and includeInGroup (US-0061)", () => {
  it("start with aiRoles [tech_lead] and includeInGroup false writes logFormat 3, aiRoles [tech_lead], includeInGroup false", async () => {
    const log = new MemoryEventLog("f");
    await fresh(log).start(assign(), { aiRoles: ["tech_lead"], includeInGroup: false });
    const e = await first(log);
    expect(e).toMatchObject({ logFormat: 3, aiRoles: ["tech_lead"], includeInGroup: false });
    const keys = Object.keys(e);
    expect(keys.indexOf("includeInGroup")).toBe(keys.indexOf("aiRoles") + 1);
  });
  it("start with aiRoles and no includeInGroup writes includeInGroup true", async () => {
    const log = new MemoryEventLog("f");
    await fresh(log).start(assign(), { aiRoles: ["tech_lead"] });
    expect(await first(log)).toMatchObject({ logFormat: 3, aiRoles: ["tech_lead"], includeInGroup: true });
  });
  it("start without aiRoles and includeInGroup false writes neither field and logFormat 2", async () => {
    const plain = new MemoryEventLog("a");
    await fresh(plain).start(assign());
    for (const x of [{ includeInGroup: false }, { aiRoles: [], includeInGroup: false }]) {
      const log = new MemoryEventLog("b");
      await fresh(log).start(assign(), x);
      const e = await first(log);
      expect(e).toMatchObject({ logFormat: 2 });
      expect(Object.hasOwn(e, "aiRoles")).toBe(false);
      expect(Object.hasOwn(e, "includeInGroup")).toBe(false);
      expect(Object.keys(e)).toEqual(Object.keys(await first(plain)));
    }
  });
  it.each([["\"no\"", "no"], ["0", 0], ["null", null]])("includeInGroup %s is refused bad_ai_roles and nothing is logged", async (_n, v) => {
    const log = new MemoryEventLog("f");
    const err = await fresh(log).start(assign(), { aiRoles: ["tech_lead"], includeInGroup: v as unknown as boolean }).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: "bad_ai_roles" });
    expect((await log.all()).length).toBe(0);
  });
});
