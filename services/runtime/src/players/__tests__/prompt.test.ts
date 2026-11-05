import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@acr/events";
import { loadScenario, type Scenario } from "@acr/script";
import { REPO_ROOT } from "../../main.js";
import { showcaseMarkers } from "../../demo/showcase.js";
import { buildPlayerRequest, roleLabel, viewFromEvents } from "../index.js";

const DIR = path.join(REPO_ROOT, "scenarios", "friday-escalation-extended");
let scenarioP: Promise<Scenario> | undefined;
const scenario = () => (scenarioP ??= loadScenario(DIR));
const env = (seq: number) => ({ seq, ts: seq, sessionId: "s" });
const scene = async (id: string) => (await scenario()).script.scenes.find((s) => s.id === id)!;
const ev = (...e: Array<Record<string, unknown>>): SessionEvent[] => e.map((x, i) => ({ ...env(i + 1), ...x }) as SessionEvent);

describe("roleLabel", () => { it("reads an id as words", () => { expect(roleLabel("tech_lead")).toBe("tech lead"); expect(roleLabel("delivery-lead")).toBe("delivery lead"); }); });

describe("viewFromEvents and buildPlayerRequest", () => {
  const events = ev(
    { type: "session.started", scenarioId: "x", version: "1", roles: {} },
    { type: "scene.entered", sceneId: "s1_huddle", participants: ["delivery_lead", "tech_lead", "account_manager"] },
    { type: "inject.fired", injectId: "i1", sceneId: "s1_huddle", to: ["delivery_lead"], content: "Priya's email is in." },
    { type: "inject.fired", injectId: "i2", sceneId: "s1_huddle", to: ["tech_lead"], content: "TECH ONLY inject" },
    { type: "utterance", roleId: "delivery_lead", text: "First reactions?", channel: "text" },
    { type: "utterance", roleId: "tech_lead", text: "Ingestion worries me.", channel: "text" },
  );
  const sc = { id: "s1_huddle", title: "Huddle", goal: "Agree a position" };

  it("keeps this role's own injects of the scene and every utterance it saw", () => {
    const v = viewFromEvents({ roleId: "delivery_lead", joined: { brief: "B", privateFacts: ["f"] }, scene: sc, events });
    expect(v).toMatchObject({ roleId: "delivery_lead", brief: "B", privateFacts: ["f"], injects: ["Priya's email is in."] });
    expect(v.lines).toEqual([{ roleId: "delivery_lead", text: "First reactions?" }, { roleId: "tech_lead", text: "Ingestion worries me." }]);
    expect(viewFromEvents({ roleId: "x", joined: {}, scene: sc, events }).brief).toBe("");
  });

  it("the system prompt has the role, brief, private facts, scene and injects; the intent is a private system section, not a dialogue turn; roles are ids", () => {
    const v = viewFromEvents({ roleId: "delivery_lead", joined: { brief: "You run the programme", privateFacts: ["Contingency is thin"] }, scene: sc, events });
    const req = buildPlayerRequest({ view: v, intent: "INTENT TEXT", maxTokens: 321 });
    expect(req.system).toContain("You are playing the delivery lead (role id delivery_lead) as a human trainee");
    for (const t of ["You run the programme", "- Contingency is thin", "Huddle: Agree a position", "- Priya's email is in.", "no [role] tags", "never write a line for anyone else", "Never mention that you are an AI"]) expect(req.system).toContain(t);
    expect(req.system).not.toContain("TECH ONLY");
    expect(req.system).toContain("## Your intent for this turn (private; do not mention it)");
    expect(req.system).toMatch(/not part of the dialogue: INTENT TEXT/);
    expect(req.system).toContain("Output ONLY the words you say aloud: one to three sentences. No explanations, no notes about your intent, no headings, no separators, no asterisks, no lists");
    expect(JSON.stringify(req.messages)).not.toContain("INTENT TEXT");
    expect(JSON.stringify(req.messages)).not.toContain("[note");
    expect(req.maxTokens).toBe(321);
    expect(req.cacheSystem).toBe(false);
    expect(req.messages[0]).toEqual({ role: "user", content: "[scene]: The scene has started. Speak first if it is natural for you to." });
    expect(req.messages[1]).toEqual({ role: "assistant", content: "First reactions?" });
    const last = req.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toBe("[tech_lead]: Ingestion worries me.");
  });

  it("obeys the Messages API turn rules (first turn user, last turn user) for empty, own-last and windowed conversations", () => {
    const mk = (lines: { roleId: string; text: string }[], window?: number) =>
      buildPlayerRequest({ view: { roleId: "me", brief: "", privateFacts: [], scene: sc, injects: [], lines }, intent: "I", window }).messages;
    const empty = mk([]);
    expect(empty).toHaveLength(1);
    expect(empty[0]!.content).toMatch(/^\[scene\]: The scene has started\./);
    const ownLast = mk([{ roleId: "x", text: "a" }, { roleId: "me", text: "b" }]);
    expect(ownLast.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(ownLast.at(-1)!.content).toBe("[scene]: Continue the conversation in character.");
    const cut = mk([{ roleId: "x", text: "a" }, { roleId: "me", text: "b" }, { roleId: "x", text: "c" }], 2);
    expect(cut[0]).toEqual({ role: "user", content: "[scene]: Earlier lines of the conversation are omitted." });
    expect(cut[0]!.role).toBe("user");
    expect(cut.at(-1)!.role).toBe("user");
  });

  it("never carries NPC goals, knowledge, hidden facts, the rubric, other roles' briefs or secrets, or participant names (real scenario)", async () => {
    const sc2 = await scene("s4_escalation_call");
    const s = await scenario();
    const m = showcaseMarkers(s);
    const me = s.roles.account_manager as { brief: string; private_facts: string[] };
    const view = viewFromEvents({ roleId: "account_manager", joined: { brief: me.brief, privateFacts: me.private_facts }, scene: sc2, events: [] });
    const req = buildPlayerRequest({ view, intent: "It is a fixed fee of 48 thousand." });
    const all = `${req.system}\n${JSON.stringify(req.messages)}`;
    const others = Object.entries(m.secretsByRole).filter(([r]) => r !== "account_manager").flatMap(([, v]) => v);
    expect(others.length).toBeGreaterThan(0);
    for (const bad of [...m.rubric, ...m.hidden, ...m.npcInternals, ...others, "ZedAlphaParticipant"]) expect(all).not.toContain(bad);
    expect(all).toContain(me.brief);
    for (const f of me.private_facts) expect(all).toContain(f);
    const cfo = s.roles.cfo as { goals: string[]; hidden: string[]; knowledge: string[] };
    for (const t of [...cfo.goals, ...cfo.hidden, ...cfo.knowledge]) expect(all).not.toContain(t);
  });
});

describe("player prompt: repetition guard and sampling", () => {
  const sc = { id: "s", title: "T", goal: "G" };
  it("has the no-repeat rule and the player's own last 3 lines only (none yet: no section), bounded", () => {
    const base = { roleId: "me", brief: "", privateFacts: [], scene: sc, injects: [] };
    expect(buildPlayerRequest({ view: { ...base, lines: [{ roleId: "x", text: "hi" }] }, intent: "i" }).system).not.toContain("## Your last lines");
    const lines = [1, 2, 3, 4].flatMap((n) => [{ roleId: "me", text: `mine ${n} ${"y".repeat(300)}` }, { roleId: "x", text: `theirs ${n}` }]);
    const req = buildPlayerRequest({ view: { ...base, lines }, intent: "i", temperature: 0.9 });
    expect(req.system).toContain("Never repeat or reword anything that has already been said");
    const sect = req.system.split("## Your last lines (do not repeat or reword these)\n")[1]!.split("\n\n")[0]!.split("\n");
    expect(sect).toHaveLength(3);
    expect(sect[0]).toMatch(/^- mine 2 y+…$/);
    expect(sect.every((l) => l.length <= 202)).toBe(true);
    expect(req.system).not.toContain("theirs");
    expect(req.temperature).toBe(0.9);
    expect("temperature" in buildPlayerRequest({ view: { ...base, lines: [] }, intent: "i" })).toBe(false);
  });
});
