import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionState } from "@acr/events";
import { consoleEvent, consoleRoster, consoleState } from "../facilitator-copies";

const state = (): SessionState => ({
  status: "running", lastSeq: 9, scenarioId: "sc", version: "1",
  roles: { lead: { kind: "player", participantId: "P-SECRET" }, npc: { kind: "npc" } },
  currentScene: { id: "a", enteredAt: 1, participants: ["lead"], pausedMs: 0 }, sceneHistory: [{ id: "a", participants: ["lead"] }],
  paused: false, pausedSince: null, transcript: [{ seq: 2, ts: 2, sceneId: "a", roleId: "lead", text: "hi", channel: "text" }],
  injectsFired: ["i1"], npcs: { npc: { goals: ["GOAL-SECRET"], knowledge: ["KNOW-SECRET"], released: ["REL-SECRET"] } },
  advanceRequested: true, gmVerdicts: { c: true }, factsEarned: { npc: [1] }, talk: { lead: { words: 1, lines: 1 } },
});

describe("console copies", () => {
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
    const utt = { type: "utterance", seq: 5, ts: 5, sessionId: "s", roleId: "lead", text: "hello", channel: "text" } as SessionEvent;
    expect(consoleEvent(utt)).toBe(utt);
  });

  it("consoleRoster keeps only the listed entry fields", () => {
    expect(consoleRoster([{ roleId: "a", name: "Ann", joined: true, consented: false, connected: true, credential: "C" } as never]))
      .toEqual([{ roleId: "a", name: "Ann", joined: true, consented: false, connected: true }]);
  });
});
