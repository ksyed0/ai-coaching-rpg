import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, type NpcRole, type Scenario } from "@acr/script";
import { MockModelProvider, type ChatRequest, type ModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { SessionHost } from "../../host/session-host.js";
import { addressedOrder } from "../../host/addressing.js";
import { NpcAgent } from "../npc-agent.js";
import { buildNpcRequest } from "../npc-prompt.js";
import { ADDRESS_RULE, addressCandidates, addressOfReply, addressSection, labelFrom } from "../address-prompt.js";

// US-0082 (AC-0488 to AC-0493): addressing in the AI character prompts and replies, the thinking hook, and the reply order.

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");

/** The minimal scenario (host, guest "Sam") plus a second human player `peer` and a senior AI character `cfo` in every scene. */
async function scenarioWith(o: { cfo?: boolean; peer?: boolean } = {}): Promise<Scenario> {
  const s = await loadScenario(fixture);
  const guest = s.roles.guest as NpcRole;
  guest.seniority = 2;
  if (o.cfo) { s.roles.cfo = { ...guest, id: "cfo", name: "Helena Brandt", title: "CFO", seniority: 5, fallback_line: "CFO fallback." }; for (const sc of s.script.scenes) sc.participants.push("cfo"); }
  if (o.peer) { s.roles.peer = { ...s.roles.host!, id: "peer" } as Scenario["roles"][string]; for (const sc of s.script.scenes) sc.participants.push("peer"); }
  return s;
}
const scripted = (...replies: (string | Error)[]): ModelProvider & { calls: ChatRequest[] } => {
  const calls: ChatRequest[] = [];
  return { name: "seq", calls, async *stream(req: ChatRequest) { calls.push(req); const r = replies[Math.min(calls.length - 1, replies.length - 1)]!; if (r instanceof Error) throw r; yield r; } };
};

describe("address prompt helpers", () => {
  it("test_address_section_names_the_addressee_or_you", () => {
    const label = labelFrom({ guest: "Sam" });
    expect(addressSection([{ roleId: "host", text: "hi", to: "guest" }], "guest", label)).toEqual(["", "## Who the last line was for", "The last line was addressed to you (by host): answer it first, directly."]);
    expect(addressSection([{ roleId: "host", text: "hi", to: "tech_lead" }], "guest", label)[2]).toBe("The last line was addressed to tech lead (by host): let them answer; speak only if you have something only you can add.");
    expect(addressSection([{ roleId: "guest", text: "hi", to: "host" }], "guest", label)).toEqual([]); // its own line
    expect(addressSection([{ roleId: "host", text: "hi" }], "guest", label)).toEqual([]);
    expect(addressSection([], "guest", label)).toEqual([]);
  });
  it("test_address_reply_parsing_only_accepts_scene_roles", () => {
    const c = addressCandidates(["host", "guest", "peer"], "guest", { guest: "Sam" });
    expect(c.map((x) => x.id)).toEqual(["host", "peer"]);
    expect(addressOfReply("@host can you confirm?", c)).toEqual({ text: "can you confirm?", to: "host" });
    expect(addressOfReply("@guest me?", c)).toEqual({ text: "@guest me?" }); // itself: never
    expect(addressOfReply("@cfo invented", c)).toEqual({ text: "@cfo invented" });
  });
  it("test_address_npc_prompt_carries_the_rule_and_the_addressee", async () => {
    const s = await scenarioWith();
    const engine = new SessionEngine({ scenario: s, log: new MemoryEventLog("s"), clock: new FakeClock(0) });
    await engine.start({ host: "p1" });
    await engine.say("host", "Sam, can you help?", "text", { to: "guest" });
    const req = buildNpcRequest({ role: s.roles.guest as NpcRole, scene: engine.currentScene()!, state: engine.state });
    expect(req.system).toContain(ADDRESS_RULE);
    expect(req.system).toContain("The last line was addressed to you (by host)");
    // the stable, cached prefix is untouched by addressing
    expect(req.system.slice(0, req.cachePrefixChars)).not.toContain("addressed");
  });
});

describe("addressedOrder", () => {
  it("test_addressed_npc_goes_first_and_elsewhere_lets_everyone_stay_silent", () => {
    expect(addressedOrder(["guest", "cfo"], { to: "cfo", sceneId: "s1" }, "s1")).toEqual({ order: ["cfo", "guest"], addressee: "cfo", elsewhere: false });
    expect(addressedOrder(["guest", "cfo"], { to: "peer", sceneId: "s1" }, "s1")).toEqual({ order: ["guest", "cfo"], addressee: null, elsewhere: true });
    expect(addressedOrder(["guest", "cfo"], { sceneId: "s1" }, "s1")).toEqual({ order: ["guest", "cfo"], addressee: null, elsewhere: false });
    expect(addressedOrder(["guest"], { to: "guest", sceneId: "old" }, "s1")).toEqual({ order: ["guest"], addressee: null, elsewhere: false });
    expect(addressedOrder(["guest"], undefined, "s1").elsewhere).toBe(false);
  });
});

describe("NpcAgent addressing and thinking", () => {
  let s: Scenario; let engine: SessionEngine;
  beforeEach(async () => {
    s = await scenarioWith({ peer: true });
    engine = new SessionEngine({ scenario: s, log: new MemoryEventLog("s"), clock: new FakeClock(0) });
    await engine.start({ host: "p1", peer: "p2" });
    await engine.say("host", "Hello");
  });
  const mk = (p: ModelProvider, seen: unknown[] = [], extra: Partial<ConstructorParameters<typeof NpcAgent>[0]> = {}) =>
    new NpcAgent({ role: s.roles.guest as NpcRole, engine, provider: p, onActivity: (a) => seen.push(a), ...extra });

  it("test_npc_leading_address_is_recorded_as_to_and_stripped", async () => {
    const e = await mk(scripted("@host, which date works for you?")).respond();
    expect(e).toMatchObject({ type: "utterance", roleId: "guest", text: "which date works for you?", to: "host" });
    const e2 = await mk(scripted("@cfo nobody by that name here")).respond();
    expect(e2).toMatchObject({ text: "@cfo nobody by that name here" });
    expect(Object.hasOwn(e2!, "to")).toBe(false);
  });
  it("test_npc_activity_spans_the_turn_with_the_fallback_outcome", async () => {
    const seen: unknown[] = [];
    await mk(scripted("Fine."), seen).respond();
    expect(seen).toEqual([{ state: "thinking" }, { state: "idle" }]);
    const failed: unknown[] = [];
    await mk(scripted(new Error("boom")), failed).respond();
    expect(failed).toEqual([{ state: "thinking" }, { state: "idle", outcome: "failed" }]);
    const slow: unknown[] = [];
    const never: ModelProvider = { name: "never", async *stream(_r, signal) { await new Promise<void>((res) => signal?.addEventListener("abort", () => res(), { once: true })); } };
    await mk(never, slow, { firstTokenTimeoutMs: 1, replyTimeoutMs: 50 }).respond();
    expect(slow).toEqual([{ state: "thinking" }, { state: "idle", outcome: "timed_out" }]);
    expect(engine.state.transcript.at(-1)!.text).toBe((s.roles.guest as NpcRole).fallback_line);
    // a turn that cannot start tells nothing
    await engine.command({ command: "pause" });
    const none: unknown[] = [];
    expect(await mk(scripted("x"), none).respond()).toBeNull();
    expect(none).toEqual([]);
  });
  it("test_npc_addressed_elsewhere_may_stay_silent_alone", async () => {
    expect(await mk(scripted("<silent/>")).respond({ addressedElsewhere: true })).toBeNull();
    const p = scripted("<silent/>", "<silent/>");
    await mk(p).respond(); // a lone character without it: not offered, re-asked, then the fallback
    expect(engine.state.transcript.at(-1)!.text).toBe((s.roles.guest as NpcRole).fallback_line);
  });
});

describe("SessionHost round with an addressed line", () => {
  it("test_round_the_addressed_character_answers_first", async () => {
    const s = await scenarioWith({ cfo: true });
    const engine = new SessionEngine({ scenario: s, log: new MemoryEventLog("s"), clock: new FakeClock(0) });
    const npcProvider: ModelProvider = { name: "who", async *stream(req) { yield req.system.includes("You are playing Helena Brandt") ? "Helena speaking." : "Sam speaking."; } };
    const host = new SessionHost({ scenario: s, engine, npcProvider, gmProvider: new MockModelProvider(), clock: new FakeClock(0), gmEveryN: 1_000 });
    await host.start();
    await host.onPlayerUtterance("host", "Helena, your call?", { to: "cfo" });
    await host.idle();
    expect(engine.state.transcript.slice(1).map((u) => u.roleId)).toEqual(["cfo", "guest"]); // seniority alone would put guest first
    expect(engine.state.transcript[0]!.to).toBe("cfo");
  });
  it("test_round_a_line_for_a_player_raises_no_silence_alert", async () => {
    const s = await scenarioWith({ peer: true });
    const engine = new SessionEngine({ scenario: s, log: new MemoryEventLog("s"), clock: new FakeClock(0) });
    const host = new SessionHost({ scenario: s, engine, npcProvider: scripted("<silent/>"), gmProvider: new MockModelProvider(), clock: new FakeClock(0), gmEveryN: 1_000 });
    await host.start();
    await host.onPlayerUtterance("host", "Over to you", { to: "peer" });
    await host.idle();
    const log = await (engine as unknown as { log: MemoryEventLog }).log.all();
    expect(log.filter((e) => e.type === "facilitator.alert")).toEqual([]);
    expect(engine.state.transcript.map((u) => u.roleId)).toEqual(["host"]);
  });
});
