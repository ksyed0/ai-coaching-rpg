import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, type NpcRole, type Scenario } from "@acr/script";
import type { ChatRequest, ModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { MockModelProvider } from "@acr/adapters";
import { SessionHost } from "../../host/session-host.js";
import { GM_EVERY_N_UTTERANCES } from "../game-master.js";
import { MAX_CONSECUTIVE_SILENT_TURNS, NpcAgent, SILENCE_NOT_ALLOWED_REASK, type SilentTurn } from "../npc-agent.js";
import { stripSilentMarker } from "../npc-reply.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");

/** The minimal scenario plus a second, more senior AI character (cfo) in both scenes. */
async function twoNpcScenario(): Promise<Scenario> {
  const s = await loadScenario(fixture);
  const guest = s.roles.guest as NpcRole;
  guest.seniority = 2;
  s.roles.cfo = { ...guest, id: "cfo", name: "Helena Brandt", title: "CFO", seniority: 5, fallback_line: "CFO fallback." };
  for (const sc of s.script.scenes) sc.participants.push("cfo");
  return s;
}
let scenario: Scenario; let engine: SessionEngine; let cfo: NpcRole;
beforeEach(async () => {
  scenario = await twoNpcScenario();
  cfo = scenario.roles.cfo as NpcRole;
  engine = new SessionEngine({ scenario, log: new MemoryEventLog("s"), clock: new FakeClock(0) });
  await engine.start({ host: "p1" });
  await engine.say("host", "Hello");
});
const peers = () => Object.values(scenario.roles).filter((r): r is NpcRole => r.type === "npc");
const seq = (...replies: string[]): ModelProvider & { calls: ChatRequest[] } => {
  const calls: ChatRequest[] = [];
  return { name: "seq", calls, async *stream(req: ChatRequest) { calls.push(req); yield replies[Math.min(calls.length - 1, replies.length - 1)]!; } };
};
const events = () => { const e: string[] = []; engine.subscribe((x) => { e.push(x.type); }); return e; };
const mk = (p: ModelProvider, role = cfo, silent: SilentTurn[] = []) => new NpcAgent({ role, engine, provider: p, peers: peers(), onSilent: (t) => silent.push(t) });
const said = () => engine.state.transcript.filter((u) => u.roleId === "cfo").map((u) => u.text);
const nudge = () => engine.say("host", "And?");

describe("stripSilentMarker", () => {
  it.each(["<silent/>", "  <silent/>\n", "<SILENT/>", "<Silent />", "<silent>", '"<silent/>"', "'<silent/>'"])("%j is silence", (t) => {
    expect(stripSilentMarker(t)).toMatchObject({ marker: true, silent: true });
  });
  it("strips the marker from a longer reply and keeps the rest", () => {
    expect(stripSilentMarker("<silent/> Not now.")).toEqual({ text: "Not now.", marker: true, silent: false });
    expect(stripSilentMarker('She said "<silent/>" and left.').text).toBe('She said "" and left.');
    expect(stripSilentMarker("A <silent/> b <SILENT/> c").text).toBe("A b c");
  });
  it("leaves ordinary text alone", () => {
    expect(stripSilentMarker("I am silent about it.")).toEqual({ text: "I am silent about it.", marker: false, silent: false });
  });
});

describe("NpcAgent silence", () => {
  it("<silent/> is no utterance, no alert, no fallback and no extra model call; it is counted and reported", async () => {
    const ev = events(); const silent: SilentTurn[] = [];
    const p = seq("<silent/>");
    const agent = mk(p, cfo, silent);
    expect(await agent.respond()).toBeNull();
    expect(p.calls).toHaveLength(1);
    expect(engine.state.transcript.filter((u) => u.roleId === "cfo")).toEqual([]);
    expect(ev).toEqual([]); // nothing was appended to the session
    expect(agent.silentTurns).toBe(1);
    expect(silent).toEqual([{ roleId: "cfo", sceneId: "s1_open", afterSeq: engine.state.lastSeq }]);
  });

  it("accepts the marker trimmed, in any case, after a self prefix, and inside a quote", async () => {
    for (const raw of ["  <SILENT/>  \n", "[cfo]: <silent/>", '"<silent/>"']) {
      const agent = mk(seq(raw));
      expect(await agent.respond()).toBeNull();
      expect(agent.silentTurns).toBe(1);
    }
    expect(said()).toEqual([]);
  });

  it("strips the marker from a longer reply and speaks the rest (the marker never becomes text)", async () => {
    const e = await mk(seq("<silent/> Fifty thousand, fixed, or no deal.")).respond();
    expect(e).toMatchObject({ type: "utterance", text: "Fifty thousand, fixed, or no deal." });
    expect(JSON.stringify(engine.state.transcript)).not.toMatch(/silent/i);
  });

  it("offers silence in the prompt only when another AI character is in the room", async () => {
    const p = seq("Fine.");
    await mk(p).respond();
    expect(p.calls[0]!.system).toContain("reply with exactly <silent/>");
    const alone = await loadScenario(fixture);
    const e2 = new SessionEngine({ scenario: alone, log: new MemoryEventLog("a"), clock: new FakeClock(0) });
    await e2.start({ host: "p1" }); await e2.say("host", "Hi");
    const p2 = seq("Hello.");
    await new NpcAgent({ role: alone.roles.guest as NpcRole, engine: e2, provider: p2, peers: [alone.roles.guest as NpcRole] }).respond();
    expect(p2.calls[0]!.system).not.toContain("<silent/>");
  });

  it("allows at most 2 silent turns in a row: the third turn does not offer silence, re-asks once, then falls back", async () => {
    const ev = events();
    const p = seq("<silent/>");
    const agent = mk(p);
    for (let i = 0; i < MAX_CONSECUTIVE_SILENT_TURNS; i++) { expect(await agent.respond()).toBeNull(); await nudge(); }
    expect(agent.silentTurns).toBe(2);
    p.calls.length = 0;
    const e = await agent.respond(); // third: silence is not offered; the model insists, so it is re-asked once and then falls back
    expect(p.calls).toHaveLength(2);
    expect(p.calls[0]!.system).not.toContain("<silent/>");
    expect(p.calls[1]!.system.endsWith(SILENCE_NOT_ALLOWED_REASK)).toBe(true);
    expect(e).toMatchObject({ type: "utterance", text: "CFO fallback.", fallback: true });
    expect(ev).toContain("facilitator.alert");
    expect(agent.silentTurns).toBe(2);
  });

  it("a third silent turn is answered normally when the re-ask speaks, and the run resets after speaking", async () => {
    const p = seq("<silent/>", "<silent/>", "<silent/>", "Then my answer is no.", "<silent/>");
    const agent = mk(p);
    await agent.respond(); await nudge(); await agent.respond(); await nudge();
    const e = await agent.respond(); await nudge();
    expect(e).toMatchObject({ text: "Then my answer is no." });
    expect(await agent.respond()).toBeNull(); // silence is offered again after speaking
    expect(agent.silentTurns).toBe(3);
  });

  it("a repeated reply followed by silence on the re-ask stays silent instead of repeating", async () => {
    const p = seq("My answer is no.", "My answer is no.", "<silent/>");
    const agent = mk(p);
    await agent.respond(); await nudge();
    expect(await agent.respond()).toBeNull();
    expect(said()).toEqual(["My answer is no."]);
    expect(agent.silentTurns).toBe(1);
  });

  it("a silent reply for a scene that has moved on is dropped without counting", async () => {
    const agent = new NpcAgent({ role: cfo, engine, peers: peers(), provider: { name: "adv", async *stream() { await engine.command({ command: "advance" }); await engine.tick(); yield "<silent/>"; } } });
    expect(await agent.respond()).toBeNull();
    expect(agent.silentTurns).toBe(0);
  });
});

describe("SessionHost: reply order and silent turns", () => {
  const build = async (npcProvider: ModelProvider, mutate?: (s: Scenario) => void) => {
    const s = await twoNpcScenario(); mutate?.(s);
    const eng = new SessionEngine({ scenario: s, log: new MemoryEventLog("h"), clock: new FakeClock(0) });
    const host = new SessionHost({ scenario: s, engine: eng, npcProvider, gmProvider: new MockModelProvider(['{"verdict": false, "reasoning": "x"}']), clock: new FakeClock(0) });
    host.join("host", "p1"); await host.start();
    return { host, eng };
  };
  const byName = (): ModelProvider => ({ name: "by-name", async *stream(req) { yield req.system.includes("You are playing Helena Brandt") ? "Ruling: no." : "Sam here."; } });

  it("replies junior first (seniority ascending), whatever the order of the scene's participants", async () => {
    const { host, eng } = await build(byName());
    await host.onPlayerUtterance("host", "Hi"); await host.idle();
    expect(eng.state.transcript.map((u) => u.roleId)).toEqual(["host", "guest", "cfo"]);
    const second = await build(byName(), (s) => { for (const sc of s.script.scenes) sc.participants.reverse(); });
    await second.host.onPlayerUtterance("host", "Hi"); await second.host.idle();
    expect(second.eng.state.transcript.map((u) => u.roleId)).toEqual(["host", "guest", "cfo"]);
  });

  it("ties are broken by role id", async () => {
    const { host, eng } = await build(byName(), (s) => { (s.roles.guest as NpcRole).seniority = 5; });
    await host.onPlayerUtterance("host", "Hi"); await host.idle();
    expect(eng.state.transcript.map((u) => u.roleId)).toEqual(["host", "cfo", "guest"]);
  });

  it("the senior character's prompt already contains the junior's reply", async () => {
    const seen: string[] = [];
    const { host } = await build({ name: "spy", async *stream(req) { if (req.system.includes("You are playing Helena Brandt")) seen.push(req.messages.map((m) => m.content).join("\n")); yield req.system.includes("You are playing Helena Brandt") ? "Ruling." : "Junior says this."; } });
    await host.onPlayerUtterance("host", "Hi"); await host.idle();
    expect(seen[0]).toContain("[guest]: Junior says this.");
  });

  it("one AI character: behaviour is unchanged", async () => {
    const scn = await loadScenario(fixture);
    const eng = new SessionEngine({ scenario: scn, log: new MemoryEventLog("o"), clock: new FakeClock(0) });
    const host = new SessionHost({ scenario: scn, engine: eng, npcProvider: new MockModelProvider(["Hello there"]), gmProvider: new MockModelProvider(), clock: new FakeClock(0) });
    host.join("host", "p1"); await host.start();
    await host.onPlayerUtterance("host", "Hi"); await host.idle();
    expect(eng.state.transcript.map((u) => `${u.roleId}:${u.text}`)).toEqual(["host:Hi", "guest:Hello there"]);
  });

  it("a silent turn does not stop the round: the others still reply, the host counts it, and the GM counts only utterances", async () => {
    const { host, eng } = await build({ name: "p", async *stream(req) { yield req.system.includes("You are playing Helena Brandt") ? "<silent/>" : "Junior line."; } });
    const heard: SilentTurn[] = []; host.onSilentTurn((t) => heard.push(t));
    for (let i = 0; i < 2; i++) { await host.onPlayerUtterance("host", `Line ${i}`); await host.idle(); }
    expect(eng.state.transcript.map((u) => u.roleId)).toEqual(["host", "guest", "host", "guest"]);
    expect(host.silentTurns()).toHaveLength(2);
    expect(heard).toHaveLength(2);
    expect(eng.state.transcript.filter((u) => u.sceneId === "s1_open")).toHaveLength(4); // the GM counts these, and only these
    expect(GM_EVERY_N_UTTERANCES).toBe(3);
    expect(JSON.stringify(eng.state)).not.toMatch(/<silent/i);
  });
});
