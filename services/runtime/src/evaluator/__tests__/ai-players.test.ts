import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@acr/events";
import { aiOptionOf, aiRolesOf } from "../ai-players.js";
import { sampleScenario, T0 } from "./fixtures.js";

const started = (over: Record<string, unknown> = {}, seq = 1): SessionEvent[] => [{
  type: "session.started", seq, ts: T0, sessionId: "s", scenarioId: "mini-01", version: "1.0",
  roles: { alice: { kind: "player" }, bob: { kind: "player" }, npc1: { kind: "npc" } }, ...over,
} as unknown as SessionEvent];
const sc = sampleScenario();

describe("aiRolesOf", () => {
  it("is [] for a format-2 log and [bob] for aiRoles [bob]", () => {
    expect(aiRolesOf(started({ logFormat: 2 }), sc)).toEqual([]);
    expect(aiRolesOf(started({ logFormat: 3, aiRoles: ["bob"] }), sc)).toEqual(["bob"]);
    expect(aiRolesOf([], sc)).toEqual([]);
  });
  it("is in scenario order", () => {
    expect(aiRolesOf(started({ logFormat: 3, aiRoles: ["bob", "alice"] }), sc)).toEqual(["alice", "bob"]);
  });
  it('is "invalid" for npc1, an unknown role, a duplicate, a non-string, aiRoles in a format-2 log, includeInGroup without aiRoles, and an e.roles marking bob npc while the scenario says player', () => {
    const bad = (over: Record<string, unknown>) => expect(aiRolesOf(started(over), sc)).toBe("invalid");
    bad({ logFormat: 3, aiRoles: ["npc1"] });
    bad({ logFormat: 3, aiRoles: ["zed"] });
    bad({ logFormat: 3, aiRoles: ["bob", "bob"] });
    bad({ logFormat: 3, aiRoles: [5] });
    bad({ logFormat: 3, aiRoles: "bob" });
    bad({ logFormat: 2, aiRoles: ["bob"] });
    bad({ aiRoles: ["bob"] });
    bad({ logFormat: 3, includeInGroup: false });
    bad({ logFormat: 3, aiRoles: ["bob"], roles: { alice: { kind: "player" }, bob: { kind: "npc" }, npc1: { kind: "npc" } } });
  });
  it("of a log whose first seq is 5 still answers", () => {
    expect(aiRolesOf(started({ logFormat: 3, aiRoles: ["bob"] }, 5), sc)).toEqual(["bob"]);
  });
});

describe("aiRolesOf when session.started is not events[0] (F1)", () => {
  const alert = { type: "facilitator.alert", seq: 1, ts: T0, sessionId: "s", level: "info", message: "x" } as unknown as SessionEvent;
  it("finds the AI roles of a session.started at seq 2", () => {
    const [st] = started({ logFormat: 3, aiRoles: ["bob"], includeInGroup: false }, 2);
    expect(aiRolesOf([alert, st!], sc)).toEqual(["bob"]);
    expect(aiOptionOf([alert, st!])).toBe(false);
  });
  it('is "invalid" when a second session.started exists, for the roles and the option', () => {
    const [a] = started({ logFormat: 3, aiRoles: ["bob"] }, 1);
    const [b] = started({ logFormat: 3, aiRoles: [] }, 2);
    expect(aiRolesOf([a!, b!], sc)).toBe("invalid");
    expect(aiOptionOf([a!, b!])).toBe("invalid");
  });
});

describe("aiOptionOf", () => {
  it('is true without the field, false for false, "invalid" for "false"', () => {
    expect(aiOptionOf(started({ logFormat: 3, aiRoles: ["bob"] }))).toBe(true);
    expect(aiOptionOf(started({ logFormat: 3, aiRoles: ["bob"], includeInGroup: false }))).toBe(false);
    expect(aiOptionOf(started({ logFormat: 3, aiRoles: ["bob"], includeInGroup: "false" }))).toBe("invalid");
  });
});
