import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SessionEvent, SessionState } from "@acr/events";
import { entryOf } from "../console-roster";
import { consoleCharacters, consoleEvent, consoleFactTexts, consoleRoster, consoleScenes, consoleState, VOICE_ALERT_SENTENCES_COPY } from "../facilitator-copies";

// US-0071 (A1b Task 13): the runtime's fixed voice alert sentences, read from host/voice.ts (no host dependencies; never session-host.ts).
// Loaded by a computed path so tsc does not type-check the runtime's sources under this app's settings.
const RUNTIME_VOICE = fileURLToPath(new URL("../../../../../services/runtime/src/host/voice.ts", import.meta.url));
if (!existsSync(RUNTIME_VOICE)) throw new Error(`facilitator-copies.test.ts needs the runtime's host/voice.ts at ${RUNTIME_VOICE}; it moved: update the path`);

const state = (): SessionState => ({
  status: "running", lastSeq: 9, scenarioId: "sc", version: "1",
  roles: { lead: { kind: "player", participantId: "P-SECRET" }, npc: { kind: "npc" } },
  currentScene: { id: "a", enteredAt: 1, participants: ["lead"], pausedMs: 0 }, sceneHistory: [{ id: "a", participants: ["lead"] }],
  paused: false, pausedSince: null, transcript: [{ seq: 2, ts: 2, sceneId: "a", roleId: "lead", text: "hi", channel: "text" }],
  injectsFired: ["i1"], npcs: { npc: { goals: ["GOAL-SECRET"], knowledge: ["KNOW-SECRET"], released: ["REL-SECRET"] } },
  advanceRequested: true, gmVerdicts: { c: true }, factsEarned: { npc: [1] }, talk: { lead: { words: 1, lines: 1 } }, aiRoles: [], whispers: {}, whisperFloor: {},
});

describe("console copies", () => {
  it("consoleEvent copies prompt_ai with roleId and by only (US-0060)", () => {
    const e = { type: "facilitator.command", seq: 4, ts: 5, sessionId: "x", command: "prompt_ai", roleId: "tech_lead", by: "Sam", hint: "LEAK-HINT", extra: "LEAK-X" } as unknown as SessionEvent;
    expect(consoleEvent(e)).toEqual({ type: "facilitator.command", seq: 4, ts: 5, sessionId: "x", command: "prompt_ai", roleId: "tech_lead", by: "Sam" });
    expect(JSON.stringify(consoleEvent(e))).not.toMatch(/LEAK/);
    const bare = { type: "facilitator.command", seq: 4, ts: 5, sessionId: "x", command: "prompt_ai", roleId: "tech_lead" } as unknown as SessionEvent;
    expect(Object.hasOwn(consoleEvent(bare), "by")).toBe(false);
  });
  it("the console state has no participantId, npcs is empty and every other key equals the input", () => {
    const s = state();
    const c = consoleState(s);
    expect(c.roles).toEqual({ lead: { kind: "player" }, npc: { kind: "npc" } });
    expect(c.npcs).toEqual({});
    expect(JSON.stringify(c)).not.toMatch(/P-SECRET|GOAL-SECRET|KNOW-SECRET|REL-SECRET/);
    const { roles: _r, npcs: _n, ...rest } = c;
    const { roles: _r2, npcs: _n2, ...expected } = s;
    expect(rest).toEqual(expected);
    expect(s.roles.lead.participantId).toBe("P-SECRET"); // the input is not mutated
  });

  it("session.started loses logIdentity, scenarioHash and participantIds; npc.updated keeps its seq and roleId with no goal, knowledge or released text; other events pass whole", () => {
    const started = { type: "session.started", seq: 1, ts: 1, sessionId: "s", scenarioId: "sc", version: "1", logFormat: 2, scenarioHash: "HASH", logIdentity: "LOGID",
      roles: { lead: { kind: "player", participantId: "P-SECRET" } }, consents: { lead: { noticeVersion: "v1", at: 3 } }, names: { lead: "Ann" } } as unknown as SessionEvent;
    expect(consoleEvent(started)).toEqual({ type: "session.started", seq: 1, ts: 1, sessionId: "s", scenarioId: "sc", version: "1",
      roles: { lead: { kind: "player" } }, consents: { lead: { noticeVersion: "v1", at: 3 } }, names: { lead: "Ann" } });
    const npc = { type: "npc.updated", seq: 4, ts: 4, sessionId: "s", roleId: "npc", goals: ["GOAL-SECRET"], knowledge: ["KNOW-SECRET"], released: ["REL-SECRET"], extra: "X" } as unknown as SessionEvent;
    expect(consoleEvent(npc)).toEqual({ type: "npc.updated", seq: 4, ts: 4, sessionId: "s", roleId: "npc", goals: [], knowledge: [], released: [] });
    const alert = { type: "facilitator.alert", seq: 6, ts: 6, sessionId: "s", level: "warning", message: "Bearer SECRET" } as SessionEvent;
    expect(JSON.stringify(consoleEvent(alert))).not.toContain("SECRET");
    const utt = { type: "utterance", seq: 5, ts: 5, sessionId: "s", roleId: "lead", text: "hello", channel: "text" } as SessionEvent;
    expect(consoleEvent(utt)).toEqual(utt);
  });

  it("BUG-0023: consoleState does not carry the per-role whisper lists (the console has them as events)", () => {
    const c = consoleState({ ...state(), whispers: { lead: [{ seq: 5, sceneId: "a", text: "WHISPER-SECRET" }] } });
    expect(c.whispers).toEqual({});
    expect(JSON.stringify(c)).not.toContain("WHISPER-SECRET");
  });
  it("consoleState carries aiRoles and consoleEvent copies them only when non-empty, dropping non-strings", () => {
    const s = { ...state(), aiRoles: ["lead", 3] } as unknown as SessionState;
    expect(consoleState(s).aiRoles).toEqual(["lead"]);
    expect(consoleState(s).aiRoles).not.toBe(s.aiRoles);
    const base = { type: "session.started", seq: 1, ts: 1, sessionId: "s", scenarioId: "sc", version: "1", roles: { lead: { kind: "player" } } };
    expect(consoleEvent({ ...base, aiRoles: ["lead", 3] } as unknown as SessionEvent)).toMatchObject({ aiRoles: ["lead"] });
    expect(Object.hasOwn(consoleEvent({ ...base, aiRoles: [] } as unknown as SessionEvent), "aiRoles")).toBe(false);
    expect(Object.hasOwn(consoleEvent({ ...base, aiRoles: [3] } as unknown as SessionEvent), "aiRoles")).toBe(false);
    expect(Object.hasOwn(consoleEvent(base as unknown as SessionEvent), "aiRoles")).toBe(false);
  });

  it("consoleRoster keeps only the listed entry fields", () => {
    expect(consoleRoster([{ roleId: "a", name: "Ann", joined: true, consented: false, connected: true, credential: "C" } as never]))
      .toEqual([{ roleId: "a", name: "Ann", joined: true, consented: false, connected: true }]);
  });

  it("consoleRoster keeps ai true and drops ai \"yes\"", () => {
    const e = { roleId: "a", joined: true, consented: false, connected: true };
    expect(consoleRoster([{ ...e, ai: true } as never])).toEqual([{ ...e, ai: true }]);
    for (const bad of ["yes", 1, false, {}, null]) expect(Object.hasOwn(consoleRoster([{ ...e, ai: bad } as never])[0]!, "ai")).toBe(false);
    expect(Object.hasOwn(consoleRoster([e as never])[0]!, "ai")).toBe(false);
  });

  it("consoleScenes keeps scene and inject fields and nothing else", () => {
    const raw = [
      { id: "a", title: "T", goal: "G", timeBoxMinutes: 5, hiddenFacts: ["SCENE-HIDDEN"], knowledge: ["K"], injects: [
        { id: "i1", to: ["lead", 7, "npc"], content: "Hello", atMinute: 3, secret: "INJ-SECRET" },
        { id: "i2", to: [], content: "No minute", atMinute: Number.NaN },
        { id: "i3", to: "lead", content: "to not an array" },
        { id: 4, to: ["lead"], content: "numeric id" },
        { id: "i5", to: ["lead"], content: 9 },
        null, "text",
      ] },
      { id: "b", title: "U", goal: "H", timeBoxMinutes: 1 },
      { id: "c", title: "no goal", timeBoxMinutes: 1 },
      { id: "d", title: "t", goal: "g", timeBoxMinutes: Number.POSITIVE_INFINITY },
      null,
    ];
    const out = consoleScenes(raw);
    expect(out).toEqual([
      { id: "a", title: "T", goal: "G", timeBoxMinutes: 5, injects: [{ id: "i1", to: ["lead", "npc"], content: "Hello", atMinute: 3 }, { id: "i2", to: [], content: "No minute" }] },
      { id: "b", title: "U", goal: "H", timeBoxMinutes: 1, injects: [] },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/SCENE-HIDDEN|INJ-SECRET|knowledge/);
    expect(consoleScenes(undefined)).toEqual([]);
    expect(consoleScenes({ id: "a" })).toEqual([]);
  });

  it("consoleCharacters numbers facts, marks released by text, carries no fact text, never carries knowledge or a released text that is not a hidden fact, treats a \"__proto__\" role as an ordinary entry and drops non-string goals", () => {
    const npcs = JSON.parse('{"npc":{"goals":["g1",5,null,"g2"],"knowledge":["K-SECRET"],"released":["F2","NOT-A-FACT",7]},"__proto__":{"goals":["pg"],"released":[]},"other":{"goals":"nope","released":"nope"}}');
    const hidden = JSON.parse('{"npc":["F1","F2","F3"],"__proto__":["P1"],"ghost":["G1"]}');
    const out = consoleCharacters(hidden, npcs);
    expect(out.map((c) => c.roleId)).toEqual(["npc", "__proto__", "other"]);
    expect(out[0]).toEqual({ roleId: "npc", goals: ["g1", "g2"], facts: [{ n: 1, released: false }, { n: 2, released: true }, { n: 3, released: false }] });
    expect(out[1]).toEqual({ roleId: "__proto__", goals: ["pg"], facts: [{ n: 1, released: false }] });
    expect(out[2]).toEqual({ roleId: "other", goals: [], facts: [] });
    expect(Object.getPrototypeOf(out[1]!)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).goals).toBeUndefined();
    const text = JSON.stringify(out);
    for (const bad of ["F1", "F2", "F3", "P1", "G1", "K-SECRET", "NOT-A-FACT", "knowledge"]) expect(text).not.toContain(bad);
    expect(consoleCharacters(undefined, { a: { goals: ["x"], released: [] } })).toEqual([{ roleId: "a", goals: ["x"], facts: [] }]);
    expect(consoleCharacters({}, {})).toEqual([]);
    // an inherited name is no hidden fact list: "toString" and "constructor" are not roles of hiddenFacts
    expect(consoleCharacters({}, { toString: { goals: [], released: [] } })[0]!.facts).toEqual([]);
  });

  it("consoleFactTexts numbers facts from 1 and drops non-string entries", () => {
    const hidden = JSON.parse('{"npc":["A",5,"B",null,"C"],"__proto__":["P"],"bad":"not a list","empty":[]}');
    expect(consoleFactTexts(hidden)).toEqual([
      { roleId: "npc", facts: [{ n: 1, text: "A" }, { n: 2, text: "B" }, { n: 3, text: "C" }] },
      { roleId: "__proto__", facts: [{ n: 1, text: "P" }] },
      { roleId: "bad", facts: [] },
      { roleId: "empty", facts: [] },
    ]);
    expect(consoleFactTexts(undefined)).toEqual([]);
  });
});

describe("console copies: voice (US-0071)", () => {
  const alert = (message: string, level: "info" | "warning" = "warning") => ({ type: "facilitator.alert", seq: 6, ts: 6, sessionId: "s", level, message }) as SessionEvent;
  const GENERIC = { info: "The runtime posted a notice. Details are in the facilitator log.", warning: "The runtime raised an alert. Details are in the facilitator log." };

  it("the copy list equals the runtime's VOICE_ALERT_SENTENCES values", async () => {
    const { VOICE_ALERT_SENTENCES } = (await import(RUNTIME_VOICE)) as { VOICE_ALERT_SENTENCES: Record<string, string> };
    expect([...VOICE_ALERT_SENTENCES_COPY].sort()).toEqual(Object.values(VOICE_ALERT_SENTENCES).sort());
    expect(VOICE_ALERT_SENTENCES_COPY).toHaveLength(10); // US-0072 (A1c Task 10): livekit_lost and livekit_recovered; US-0073 (A2a Task 8): disk_low and write_error
  });

  it("each voice alert sentence passes through exactly, at its level", () => {
    for (const m of VOICE_ALERT_SENTENCES_COPY) {
      expect(consoleEvent(alert(m))).toEqual({ type: "facilitator.alert", seq: 6, ts: 6, sessionId: "s", level: "warning", message: m });
      expect(consoleEvent(alert(m, "info"))).toMatchObject({ level: "info", message: m });
    }
  });

  it("a sentence with one extra character, a changed case or a prefix is replaced by the fixed line", () => {
    for (const m of VOICE_ALERT_SENTENCES_COPY) {
      for (const bad of [`${m} `, ` ${m}`, `${m}x`, m.toUpperCase(), m.slice(0, -1), `${m} key=sk-SECRET`, `SECRET ${m}`]) {
        expect(consoleEvent(alert(bad)), bad).toMatchObject({ message: GENERIC.warning });
        expect(consoleEvent(alert(bad, "info")), bad).toMatchObject({ message: GENERIC.info });
      }
    }
  });

  it("every other alert keeps the generic line per level, a non-string message included", () => {
    for (const m of ["Bearer SECRET", "The model provider failed: 401 sk-abc", "", "toString", "__proto__", "constructor"]) {
      expect(consoleEvent(alert(m))).toMatchObject({ message: GENERIC.warning });
    }
    expect(consoleEvent({ type: "facilitator.alert", seq: 6, ts: 6, sessionId: "s", level: "warning", message: ["Voice input is available again."] } as unknown as SessionEvent)).toMatchObject({ message: GENERIC.warning });
    expect(consoleEvent({ type: "facilitator.alert", seq: 6, ts: 6, sessionId: "s", level: "warning", message: 7 } as unknown as SessionEvent)).toMatchObject({ message: GENERIC.warning });
  });

  it("entryOf keeps voice and speaking and drops voice: \"loud\" and speaking: 1", () => {
    const e = { roleId: "a", joined: true, consented: true, connected: true };
    for (const voice of ["none", "voice", "text_only", "off"] as const) expect(entryOf({ ...e, voice } as never)).toEqual({ ...e, voice });
    expect(entryOf({ ...e, voice: "voice", speaking: true } as never)).toEqual({ ...e, voice: "voice", speaking: true });
    for (const bad of ["loud", "VOICE", 1, true, {}, null, "__proto__"]) expect(Object.hasOwn(entryOf({ ...e, voice: bad } as never), "voice"), String(bad)).toBe(false);
    for (const bad of [1, "true", false, {}, null]) expect(Object.hasOwn(entryOf({ ...e, voice: "voice", speaking: bad } as never), "speaking"), String(bad)).toBe(false);
  });

  it("a text-only entry (no voice fields) is unchanged: same keys as before", () => {
    const e = { roleId: "a", name: "Ann", joined: true, consented: false, connected: true };
    expect(Object.keys(consoleRoster([e as never])[0]!)).toEqual(["roleId", "name", "joined", "consented", "connected"]);
  });
});
