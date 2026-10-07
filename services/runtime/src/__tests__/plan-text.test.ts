import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** US-0020 / AC-0063: the Slice 1 plan's self-review must describe the engine as built (`alert()`, not a public `emit`). */
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFile(path.join(here, rel), "utf8");

describe("the Slice 1 plan text matches the engine (US-0020)", () => {
  it("the engine keeps emit and log private and offers alert() as the public way for an agent to raise a facilitator alert", async () => {
    const engine = await read("../engine/session-engine.ts");
    expect(engine).toMatch(/private async emit\(/);
    expect(engine).toMatch(/private readonly log: EventLog/);
    expect(engine).toMatch(/\n  alert\(message: string, level:/);
    expect(engine).not.toMatch(/\n  (async )?emit\(/);
  });

  it("the plan no longer claims emit or log was made public, and says alert() replaced the planned public emit", async () => {
    const plan = await read("../../../../docs/superpowers/plans/2026-10-01-slice-1-script-and-text-runtime.md");
    expect(plan).not.toMatch(/- \*\*Interfaces\.\*\* `SessionEngine\.emit` is made public in Task 7 and `log` in Task 8; both are referenced consistently afterwards\./);
    const selfReview = plan.slice(plan.indexOf("## Self-review notes"), plan.indexOf("## Revision notes"));
    expect(selfReview).toContain("`SessionEngine.alert(message, level, { expectSceneId })`");
    expect(selfReview).toContain("replaced the planned public `emit`");
    expect(plan).toContain("## Revision notes: where later rulings changed this plan");
  });

  it("the revision notes name each ruling's story, and every story named exists in the release plan", async () => {
    const plan = await read("../../../../docs/superpowers/plans/2026-10-01-slice-1-script-and-text-runtime.md");
    const release = await read("../../../../docs/RELEASE_PLAN.md");
    const notes = plan.slice(plan.indexOf("## Revision notes"));
    const stories = new Set(notes.match(/US-\d{4}/g) ?? []);
    expect(stories.size).toBeGreaterThanOrEqual(8);
    for (const us of stories) expect(release, us).toMatch(new RegExp(`^${us} \\(EPIC-\\d{4}\\)`, "m"));
  });
});
