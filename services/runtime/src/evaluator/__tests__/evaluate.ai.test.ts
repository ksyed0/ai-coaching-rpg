import { describe, expect, it } from "vitest";
import type { ChatRequest } from "@acr/adapters";
import type { EventBody, SessionEvent } from "@acr/events";
import { evaluateSession, EvaluatorInputError } from "../evaluate.js";
import { parseEvalConfig } from "../config.js";
import { build, sampleEvents, sampleRubrics, sampleScenario } from "./fixtures.js";

const cfgParsed = parseEvalConfig({});
if (!cfgParsed.ok) throw new Error("config");
const config = cfgParsed;
const NONCE = "abc123";

const crit = (id: string, score: unknown, seq: number, quote: string) => ({ id, score, rationale: `Because ${id}.`, confidence: "high", evidence: [{ seq, quote }] });
const aliceReply = JSON.stringify({
  criteria: [crit("discovery", 3, 3, "what Finance really needs"), crit("listening", 4, 5, "Have I got that right?"), crit("negotiation", 2, 11, "phased module for 48 thousand")],
  strengths: ["s"], development_points: ["d"], next_actions: [{ lo: "LO2", action: "State two options." }],
});
const bobQuoteGroup = JSON.stringify({
  criteria: [crit("shared_understanding", 3, 6, "a phased module costs about three person-weeks")],
  talking_points: ["Compare."], notable_moments: [{ seq: 6, quote: "a phased module costs about three person-weeks", note: "bob" }, { seq: 11, quote: "phased module for 48 thousand", note: "alice" }],
});

function recorder(replies: { alice?: string; group?: string }) {
  const calls: ChatRequest[] = [];
  return {
    name: "rec", calls,
    async *stream(req: ChatRequest): AsyncIterable<string> {
      calls.push(req);
      const who = /score only the participant with role id "(\w+)"/i.exec(req.system)?.[1];
      yield (who === "alice" ? replies.alice : who === undefined ? replies.group : undefined) ?? "no answer";
    },
  };
}

const withStarted = (events: SessionEvent[], over: Record<string, unknown>): SessionEvent[] => {
  const evs = events.map((e) => ({ ...e })) as SessionEvent[];
  Object.assign(evs[0] as unknown as Record<string, unknown>, over);
  return evs;
};
const aiEvents = (over: Record<string, unknown> = {}, aiRoles: string[] = ["bob"]) => withStarted(sampleEvents(), { logFormat: 3, aiRoles, ...over });
const run = (provider: ReturnType<typeof recorder>, events: SessionEvent[]) =>
  evaluateSession({ events, scenario: sampleScenario(), rubrics: sampleRubrics(), provider, config, nonce: NONCE });
const AI_SENTENCE = 'In rationales and talking points, name an AI player as "<id> (AI player)"; when AI players are not included, never credit their lines to the team.';

describe("evaluateSession with AI players", () => {
  it("no request scores bob and result.participants has alice only", async () => {
    const p = recorder({ alice: aliceReply, group: bobQuoteGroup });
    const r = await run(p, aiEvents());
    expect(r.participants.map((x) => x.roleId)).toEqual(["alice"]);
    expect(p.calls.some((c) => /role id "bob"/.test(c.system))).toBe(false);
    expect(r.ai).toEqual({ roles: ["bob"], includeInGroup: true });
  });

  it("provider calls are 2 (alice and the group) when both reply well", async () => {
    const p = recorder({ alice: aliceReply, group: bobQuoteGroup });
    const r = await run(p, aiEvents());
    expect(p.calls).toHaveLength(2);
    expect(r.modelCalls).toBe(2);
  });

  it('on: the group request names "the AI players (bob)" and a quote from bob survives with ai: true', async () => {
    const p = recorder({ alice: aliceReply, group: bobQuoteGroup });
    const r = await run(p, aiEvents({ includeInGroup: true }));
    const g = p.calls[1]!.system;
    expect(g).toContain("the AI players (bob)");
    expect(g).toContain('YOUR TASK: score the team formed by the players (alice) and the AI players (bob) using the whole transcript. Evidence for a team criterion may be a quote from any player or AI player (lines labelled "(player)" or "(AI player)"); never quote an AI character, an inject or the Game Master as evidence.');
    expect(g).toContain("from a player's or AI player's line");
    expect(r.group.criteria[0]!.evidence[0]).toMatchObject({ seq: 6, roleId: "bob", ai: true });
    expect(r.group.notable_moments.map((m) => m.seq)).toEqual([6, 11]);
  });

  it("off: the group request says bob's lines are context only, and a criterion quote and a notable moment quoting bob are dropped", async () => {
    const p = recorder({ alice: aliceReply, group: bobQuoteGroup });
    const r = await run(p, aiEvents({ includeInGroup: false }));
    const g = p.calls[1]!.system;
    expect(g).toContain('YOUR TASK: score the team formed by the players (alice) using the whole transcript. The AI players (bob, lines labelled "(AI player)") are not part of the scored team: their lines are context only, like an AI character\'s. Evidence for a team criterion may be a quote from any player; never quote an AI player, an AI character, an inject or the Game Master as evidence.');
    expect(g).toContain("from a player's line");
    expect(g).not.toContain("player's or AI player's line");
    expect(r.group.criteria[0]!.evidence).toEqual([]);
    expect(r.group.criteria[0]!.droppedQuotes).toBe(1);
    expect(r.group.notable_moments.map((m) => m.seq)).toEqual([11]);
    expect(r.ai).toEqual({ roles: ["bob"], includeInGroup: false });
  });

  for (const include of [true, false]) {
    it(`${include ? "on" : "off"} with alice silent and bob speaking 5 lines: the group is insufficient evidence "the human players spoke 0 time(s)" and no group call is made`, async () => {
      const evs = build([
        [0, { type: "session.started", scenarioId: "mini-01", version: "1.0", logFormat: 3, aiRoles: ["bob"], includeInGroup: include, roles: { alice: { kind: "player" }, bob: { kind: "player" }, npc1: { kind: "npc" } } }],
        [1, { type: "scene.entered", sceneId: "s1", participants: ["alice", "bob"] }],
        ...[1, 2, 3, 4, 5].map((n): [number, EventBody] => [10 * n, { type: "utterance", roleId: "bob", text: `Line number ${n} from the AI player.`, channel: "text" }]),
      ] as unknown as [number, EventBody][]);
      const p = recorder({ alice: aliceReply, group: bobQuoteGroup });
      const r = await run(p, evs);
      expect(r.group.status).toBe("insufficient_evidence");
      expect(r.group.reason).toBe("insufficient evidence: the human players spoke 0 time(s)");
      expect(p.calls).toHaveLength(0);
    });
  }

  it("a 3b log (aiRoles [bob], no includeInGroup) is evaluated with the option on", async () => {
    const p = recorder({ alice: aliceReply, group: bobQuoteGroup });
    const r = await run(p, aiEvents());
    expect(r.ai?.includeInGroup).toBe(true);
    expect(p.calls[1]!.system).toContain("and the AI players (bob)");
  });

  it('includeInGroup "no" throws the input error', async () => {
    const p = recorder({});
    await expect(run(p, aiEvents({ includeInGroup: "no" }))).rejects.toThrow(new EvaluatorInputError("the log's session.started.includeInGroup is not true or false"));
    expect(p.calls).toHaveLength(0);
  });

  it('aiRoles [bob] with e.roles bob npc throws "the log\'s session.started.aiRoles is not a list of distinct player roles" and sends no request', async () => {
    const p = recorder({});
    const evs = aiEvents({ roles: { alice: { kind: "player" }, bob: { kind: "npc" }, npc1: { kind: "npc" } } });
    await expect(run(p, evs)).rejects.toThrow("the log's session.started.aiRoles is not a list of distinct player roles");
    expect(p.calls).toHaveLength(0);
  });

  it("both AI variants contain the rationale sentence and a request without AI roles does not", async () => {
    for (const include of [true, false]) {
      const p = recorder({ alice: aliceReply, group: bobQuoteGroup });
      await run(p, aiEvents({ includeInGroup: include }));
      expect(p.calls[1]!.system).toContain(AI_SENTENCE);
    }
    const plain = recorder({ alice: aliceReply, group: bobQuoteGroup });
    await run(plain, sampleEvents());
    for (const c of plain.calls) expect(c.system).not.toContain("(AI player)");
    expect(plain.calls.some((c) => c.system.includes("In rationales and talking points"))).toBe(false);
  });

  it('aiRoles [alice, bob] throws "every player role ..."', async () => {
    const p = recorder({});
    await expect(run(p, aiEvents({}, ["alice", "bob"]))).rejects.toThrow(new EvaluatorInputError("every player role in this session is an AI player: there is no one to score"));
    expect(p.calls).toHaveLength(0);
  });

  it("a log with a prompt_ai command and a bot alert sends no text of either to the provider", async () => {
    const evs = build([
      [0, { type: "session.started", scenarioId: "mini-01", version: "1.0", logFormat: 3, aiRoles: ["bob"], roles: { alice: { kind: "player" }, bob: { kind: "player" }, npc1: { kind: "npc" } } }],
      [1, { type: "scene.entered", sceneId: "s1", participants: ["alice", "bob"] }],
      [2, { type: "facilitator.command", command: "prompt_ai", roleId: "bob", text: "SECRETPROMPTTEXT" }],
      [3, { type: "facilitator.alert", level: "info", message: "SECRETALERTTEXT bob" }],
      [10, { type: "utterance", roleId: "alice", text: "Let me understand what Finance really needs before we answer.", channel: "text" }],
      [20, { type: "utterance", roleId: "bob", text: "I worry about the ingestion layer and the go-live date.", channel: "text" }],
      [30, { type: "utterance", roleId: "alice", text: "So the need is tie-out of daily loads. Have I got that right?", channel: "text" }],
    ] as unknown as [number, EventBody][]);
    const p = recorder({ alice: aliceReply, group: bobQuoteGroup });
    await run(p, evs);
    expect(p.calls.length).toBeGreaterThan(0);
    const all = JSON.stringify(p.calls);
    expect(all).not.toContain("SECRETPROMPTTEXT");
    expect(all).not.toContain("SECRETALERTTEXT");
    expect(all).not.toContain("prompt_ai");
  });

  it("the participant request for alice is byte-identical with and without bob being AI except for the transcript lines that name bob", async () => {
    const a = recorder({ alice: aliceReply, group: bobQuoteGroup });
    const b = recorder({ alice: aliceReply, group: bobQuoteGroup });
    await run(a, sampleEvents());
    await run(b, aiEvents());
    const norm = (c: ChatRequest) => JSON.stringify(c).replace(/bob \((AI )?player\)/g, "bob");
    const aliceOf = (p: ReturnType<typeof recorder>) => p.calls.find((c) => /role id "alice"/.test(c.system))!;
    expect(norm(aliceOf(b))).toBe(norm(aliceOf(a)));
    expect(aliceOf(b).system).toBe(aliceOf(a).system);
  });
});

describe("evaluateSession when session.started is not the first event (F1)", () => {
  const body = (e: SessionEvent) => { const { seq: _s, ts: _t, sessionId: _i, ...b } = e as unknown as Record<string, unknown>; void _s; void _t; void _i; return [0, b] as const; };
  it("scores alice only and honours the option when session.started (aiRoles bob, off) is at seq 2", async () => {
    const base = withStarted(sampleEvents(), { logFormat: 3, aiRoles: ["bob"], includeInGroup: false });
    const events = build([[0, { type: "facilitator.alert", level: "info", message: "x" }], ...base.map(body)] as never);
    const p = recorder({ alice: aliceReply, group: bobQuoteGroup });
    const r = await run(p, events);
    expect(r.participants.map((x) => x.roleId)).toEqual(["alice"]);
    expect(p.calls.some((c) => /role id "bob"/.test(c.system))).toBe(false);
    expect(r.ai).toEqual({ roles: ["bob"], includeInGroup: false });
  });
  it("refuses a log with two session.started events", async () => {
    const base = aiEvents();
    const events = build([...base.map(body), body(base[0]!)] as never);
    await expect(run(recorder({}), events)).rejects.toBeInstanceOf(EvaluatorInputError);
  });
});

