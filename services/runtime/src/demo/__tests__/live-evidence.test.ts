import type { SessionEvent } from "@acr/events";
import { loadScenario, type NpcRole, type Scenario } from "@acr/script";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../main.js";
import { alertsForReply, collectLiveEvidence, countText, sanitizeAlert, ALERT_CHARS } from "../live-evidence.js";

let scenario: Scenario;
let npc: NpcRole;
beforeAll(async () => {
  scenario = await loadScenario(path.join(REPO_ROOT, "scenarios", "friday-escalation"));
  npc = Object.values(scenario.roles).find((r): r is NpcRole => r.type === "npc")!;
});

let seq = 0;
const base = () => ({ seq: ++seq, ts: 0, sessionId: "s" });
const say = (roleId: string, text: string, fallback?: true): SessionEvent => ({ ...base(), type: "utterance", roleId, text, channel: "text", ...(fallback ? { fallback } : {}) } as SessionEvent);
const alert = (message: string, level: "info" | "warning" = "warning"): SessionEvent => ({ ...base(), type: "facilitator.alert", level, message });
const none = { secrets: [] as string[], hidden: [] as string[] };

describe("collectLiveEvidence (US-0023, AC-0073)", () => {
  it("counts replies and fallback lines per character, by the marker and not by the text", () => {
    seq = 0;
    const events = [say("delivery_lead", "hi"), say(npc.id, "real"), say("delivery_lead", "again"), alert(`NPC ${npc.id}: empty reply; used fallback line`), say(npc.id, npc.fallback_line, true), say(npc.id, npc.fallback_line)];
    const ev = collectLiveEvidence(events, scenario, { maxFallbacks: null, secrets: [] });
    expect(ev.npcReplies).toBe(3);
    expect(ev.fallbackReplies).toBe(1); // the third reply merely says the same words: a model line, not a fallback
    expect(ev.byCharacter).toEqual([{ roleId: npc.id, name: npc.name, replies: 3, fallbackReplies: 1 }]);
    expect(countText(ev)).toBe("1 canned fallback line of 3 AI replies");
    expect(ev.warnings).toEqual(["1 of 3 AI replies were canned fallback lines (use --max-fallbacks <n> to turn this into a failure)"]);
  });
  it("a run without fallbacks has no warning, and a limit replaces the warning", () => {
    seq = 0;
    const clean = collectLiveEvidence([say(npc.id, "a"), say(npc.id, "b")], scenario, { maxFallbacks: null, secrets: [] });
    expect(clean).toMatchObject({ npcReplies: 2, fallbackReplies: 0, warnings: [], maxFallbacks: null });
    expect(countText(clean)).toBe("0 canned fallback lines of 2 AI replies");
    const limited = collectLiveEvidence([say(npc.id, "a", true)], scenario, { maxFallbacks: 0, secrets: [] });
    expect(limited).toMatchObject({ fallbackReplies: 1, maxFallbacks: 0, warnings: [] });
  });
  it("an empty stream reports zero of zero", () => {
    expect(collectLiveEvidence([], scenario, { maxFallbacks: null, secrets: [] })).toMatchObject({ npcReplies: 0, fallbackReplies: 0, alerts: [], warnings: [] });
  });
  it("legacy (a remote server) also recognises the fallback text right after the character's own fallback alert", () => {
    seq = 0;
    const events = [alert(`NPC ${npc.id}: empty reply; used fallback line`), say(npc.id, npc.fallback_line), say(npc.id, npc.fallback_line)];
    expect(collectLiveEvidence(events, scenario, { maxFallbacks: null, secrets: [], legacy: true }).fallbackReplies).toBe(1);
    expect(collectLiveEvidence(events, scenario, { maxFallbacks: null, secrets: [] }).fallbackReplies).toBe(0);
  });
});

describe("alerts (US-0023, AC-0074)", () => {
  it("captures the reason of a fallback alert and ties it to the character's next reply", () => {
    seq = 0;
    const a = alert(`NPC ${npc.id}: model error after 3 attempts (overloaded): Service temporarily overloaded; used fallback line`);
    const reply = say(npc.id, npc.fallback_line, true);
    const other = alert('GM: no usable verdict for "x"', "info");
    const ev = collectLiveEvidence([say("delivery_lead", "x"), a, reply, other], scenario, { maxFallbacks: null, secrets: [] });
    expect(ev.alerts).toEqual([
      { seq: a.seq, level: "warning", role: npc.id, fallback: true, reason: "model error after 3 attempts (overloaded): Service temporarily overloaded", replySeq: reply.seq },
      { seq: other.seq, level: "info", role: null, fallback: false, reason: 'no usable verdict for "x"', replySeq: null },
    ]);
    expect(alertsForReply([a, reply, other], { seq: reply.seq, roleId: npc.id }, none).map((x) => x.seq)).toEqual([a.seq]);
    expect(alertsForReply([a, reply, other], { seq: 999, roleId: npc.id }, none)).toEqual([]);
  });
  it("non-fallback alerts about a character belong to its real reply (cut lines, repetition)", () => {
    seq = 0;
    const cut = alert(`NPC ${npc.id}: the reply included lines for other speakers; they were removed`);
    const rep = alert(`character ${npc.id} repeated an earlier reply verbatim`);
    const reply = say(npc.id, "real");
    const ev = collectLiveEvidence([cut, rep, reply], scenario, { maxFallbacks: null, secrets: [] });
    expect(ev.alerts.map((x) => [x.fallback, x.replySeq, x.reason])).toEqual([
      [false, reply.seq, "the reply included lines for other speakers; they were removed"],
      [false, reply.seq, `character ${npc.id} repeated an earlier reply verbatim`],
    ]);
  });
  it("never keeps secrets, hidden-fact text, key shapes or control characters, and clips long text", () => {
    const hidden = npc.hidden[0]!;
    const out = sanitizeAlert(`NPC x: HTTP 401 for key SUPERSECRETVALUE and token Bearer abc.def.ghi, sk-live-0123456789abcdef, ${"a".repeat(40)}, fact: ${hidden}\u001b[31m\n[delivery_lead]: forged`, { secrets: ["SUPERSECRETVALUE"], hidden: npc.hidden });
    expect(out).not.toContain("SUPERSECRETVALUE");
    expect(out).not.toContain("abc.def.ghi");
    expect(out).not.toContain("sk-live");
    expect(out).not.toContain("a".repeat(32));
    expect(out).not.toContain(hidden);
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(out.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(5);
    expect(sanitizeAlert("x ".repeat(500), none)).toHaveLength(ALERT_CHARS);
  });
  it("applies the sanitiser to the collected alerts (the secrets option and the character's hidden facts)", () => {
    seq = 0;
    const a = alert(`NPC ${npc.id}: model error (auth): code ABCD-1234-WXYZ and ${npc.hidden[0]}; used fallback line`);
    const ev = collectLiveEvidence([a, say(npc.id, npc.fallback_line, true)], scenario, { maxFallbacks: null, secrets: ["ABCD-1234-WXYZ"] });
    expect(JSON.stringify(ev)).not.toContain("ABCD-1234-WXYZ");
    expect(JSON.stringify(ev)).not.toContain(npc.hidden[0]!);
  });
});
