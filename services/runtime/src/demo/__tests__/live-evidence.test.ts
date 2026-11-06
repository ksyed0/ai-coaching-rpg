import type { SessionEvent } from "@acr/events";
import { loadScenario, type NpcRole, type Scenario } from "@acr/script";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../main.js";
import { collectLiveEvidence, countText } from "../live-evidence.js";

let scenario: Scenario;
let npc: NpcRole;
beforeAll(async () => {
  scenario = await loadScenario(path.join(REPO_ROOT, "scenarios", "friday-escalation"));
  npc = Object.values(scenario.roles).find((r): r is NpcRole => r.type === "npc")!;
});
let seq = 0;
const say = (roleId: string, text: string, fallback?: true): SessionEvent => ({ seq: ++seq, ts: 0, sessionId: "s", type: "utterance", roleId, text, channel: "text", ...(fallback ? { fallback } : {}) } as SessionEvent);

describe("collectLiveEvidence (US-0023): the demo's limit, warning and narration line", () => {
  it("a fallback line without a limit is a warning, with the narration line", () => {
    seq = 0;
    const ev = collectLiveEvidence([say(npc.id, "real"), say(npc.id, npc.fallback_line, true), say(npc.id, npc.fallback_line)], scenario, { maxFallbacks: null, secrets: [] });
    expect(ev).toMatchObject({ npcReplies: 3, fallbackReplies: 1, maxFallbacks: null });
    expect(ev).not.toHaveProperty("scenesEndedByGm");
    expect(countText(ev)).toBe("1 canned fallback line of 3 AI replies");
    expect(ev.warnings).toEqual(["1 of 3 AI replies were canned fallback lines (use --max-fallbacks <n> to turn this into a failure)"]);
  });
  it("a run without fallbacks has no warning, and a limit replaces the warning", () => {
    seq = 0;
    const clean = collectLiveEvidence([say(npc.id, "a"), say(npc.id, "b")], scenario, { maxFallbacks: null, secrets: [] });
    expect(clean).toMatchObject({ npcReplies: 2, fallbackReplies: 0, warnings: [], maxFallbacks: null });
    expect(countText(clean)).toBe("0 canned fallback lines of 2 AI replies");
    expect(collectLiveEvidence([say(npc.id, "a", true)], scenario, { maxFallbacks: 0, secrets: [] })).toMatchObject({ fallbackReplies: 1, maxFallbacks: 0, warnings: [] });
  });
});
