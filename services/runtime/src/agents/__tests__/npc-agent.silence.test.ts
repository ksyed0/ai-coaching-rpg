import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { expectLinear } from "../../__tests__/scaling.js";
import { cleanReplyWithSilence, isSilenceInWords } from "../npc-reply.js";

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

const ROLE = { id: "cfo", name: "Helena Brandt" };
const OTHERS = [{ id: "client_sponsor", name: "Priya Raman" }];
const parse = (raw: string) => cleanReplyWithSilence(raw, ROLE, OTHERS);

describe("silence markers", () => {
  it.each([
    "<silent/>", "  <silent/>\n", "<SILENT/>", "<Silent />", "<silent>", "<silent></silent>", "</silent>", "<silence/>", "< silent / >",
    '"<silent/>"', "'<silent/>'", "<si\u200Blent/>", "<silent\u2060/>", "\uFF1Csilent\uFF0F\uFF1E", "\uFF1Csilent\uFF1E", "[cfo]: <silent/>", "<silent/><silent/>",
    "(silent)", "[silent]", "*stays silent*", "*silent*", "(stays silent)", "...", "\u2026", ". . .",
  ])("%j is silence: nothing is left to say", (raw) => {
    expect(parse(raw)).toMatchObject({ text: "", silent: true });
  });
  it("strips the marker from a longer reply and keeps (and cleans) the rest", () => {
    expect(parse("<silent/> Not now.")).toMatchObject({ text: "Not now.", silent: false });
    expect(parse("<silent/> [cfo]: Fixed price.")).toEqual({ text: "Fixed price.", cut: false, silent: false });
    expect(parse("Fixed price. <silent/>").text).toBe("Fixed price.");
    expect(parse("A <silent/> b <SILENT/> c").text).toBe("A b c");
    expect(parse("A \uFF1Csilent\uFF0F\uFF1E b").text).toBe("A b");
    expect(parse("A <si\u200Blent/> b").text).toBe("A b");
    expect(parse("Fine.\npriya raman: invented <silent/>")).toMatchObject({ text: "Fine.", cut: true });
  });
  it("never lets any form of the marker through in the spoken text", () => {
    for (const raw of ["x <silent/>", "x <SILENCE />", "x </silent>", "x <silent></silent> y", "x \uFF1C silent \uFF0F \uFF1E y"]) expect(parse(raw).text).not.toMatch(/silen|[<>\uFF1C\uFF1E]/i);
  });
  it("leaves ordinary text alone, including the word silent", () => {
    for (const t of ["I am silent about it.", "The silent partner signs.", "Silence is not an answer, here is mine: no."]) expect(parse(t)).toMatchObject({ text: t, silent: false });
    expect(isSilenceInWords("(silent) but then more words")).toBe(false);
  });
  it("is linear on abusive input: huge, repeated and padded markers (8x the input costs far less than 64x; no absolute time bound)", () => {
    const n = (full: number, s: number) => Math.round((full * s) / 8); // the sizes are the full workload at scale 8
    expectLinear((s) => {
      const big = parse("<silent/>".repeat(n(20_000, s))); expect(big.silent).toBe(true);
      expect(parse(`<${" ".repeat(n(200_000, s))}silent/>`).silent).toBe(false); // not a marker (too much padding), and it must not hang
      expect(parse("<".repeat(n(100_000, s))).silent).toBe(false);
      expect(parse(`${"a ".repeat(n(50_000, s))}<silent/>`).text.length).toBeGreaterThan(n(90_000, s));
      expect(parse("\u200B".repeat(n(100_000, s)) + "<silent/>").silent).toBe(true);
    });
  }, 120_000);
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

  it("ties are broken by the scene's participant order (a stable sort)", async () => {
    const { host, eng } = await build(byName(), (s) => { (s.roles.guest as NpcRole).seniority = 5; });
    await host.onPlayerUtterance("host", "Hi"); await host.idle();
    expect(eng.state.transcript.map((u) => u.roleId)).toEqual(["host", "guest", "cfo"]);
    const rev = await build(byName(), (s) => { (s.roles.guest as NpcRole).seniority = 5; for (const sc of s.script.scenes) sc.participants.reverse(); });
    await rev.host.onPlayerUtterance("host", "Hi"); await rev.host.idle();
    expect(rev.eng.state.transcript.map((u) => u.roleId)).toEqual(["host", "cfo", "guest"]);
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

describe("SessionHost: a round never goes entirely unanswered (US-0032 fix round)", () => {
  const build = async (npcProvider: ModelProvider, extra: { maxSilencesKept?: number } = {}) => {
    const s = await twoNpcScenario();
    const eng = new SessionEngine({ scenario: s, log: new MemoryEventLog("m"), clock: new FakeClock(0) });
    const host = new SessionHost({ scenario: s, engine: eng, npcProvider, gmProvider: new MockModelProvider(['{"verdict": false, "reasoning": "x"}']), clock: new FakeClock(0), ...extra });
    host.join("host", "p1"); await host.start();
    const alerts: string[] = []; eng.subscribe((e) => { if (e.type === "facilitator.alert") alerts.push(`${e.level}:${e.message}`); });
    return { host, eng, alerts };
  };
  const round = async (h: { host: SessionHost }, text: string) => { await h.host.onPlayerUtterance("host", text); await h.host.idle(); };
  const prompts: ChatRequest[] = [];
  const bothSilent: ModelProvider = { name: "both-silent", async *stream(req) { prompts.push(req); yield "<silent/>"; } };

  it("when both characters want silence the last (senior) one is not offered silence, is re-asked, and the round still gets an answer", async () => {
    prompts.length = 0;
    const h = await build(bothSilent);
    await round(h, "Hi");
    const seniorCalls = prompts.filter((r) => r.system.includes("You are playing Helena Brandt"));
    expect(seniorCalls).toHaveLength(2); // the first answer and one re-ask
    expect(seniorCalls.every((r) => !r.system.includes("reply with exactly <silent/>"))).toBe(true);
    expect(h.eng.state.transcript.map((u) => u.roleId)).toEqual(["host", "cfo"]); // the junior stayed silent, the senior fell back (never silent)
    expect(h.eng.state.transcript.at(-1)).toMatchObject({ roleId: "cfo", text: "CFO fallback." });
    expect(h.host.silentTurns().map((t) => t.roleId)).toEqual(["guest"]);
  });

  it("does not force the last character to speak when someone already answered", async () => {
    const p: ModelProvider = { name: "p", async *stream(req) { yield req.system.includes("You are playing Helena Brandt") ? "<silent/>" : "Junior says this."; } };
    const h = await build(p);
    await round(h, "Hi");
    expect(h.eng.state.transcript.map((u) => u.roleId)).toEqual(["host", "guest"]);
    expect(h.host.silentTurns().map((t) => t.roleId)).toEqual(["cfo"]);
    expect(h.alerts).toEqual([]);
  });

  it("raises a facilitator warning when a round ends with nobody having spoken", async () => {
    const h = await build({ name: "x", async *stream() { yield "ok"; } });
    const spy = vi.spyOn(NpcAgent.prototype, "respond").mockResolvedValue(null);
    await round(h, "Hi");
    spy.mockRestore();
    expect(h.alerts).toContain("warning:every AI character stayed silent for this line");
  });

  it("the per-character cap still holds with the forced turn: a junior silent twice is offered silence no more on the third turn", async () => {
    prompts.length = 0;
    const p: ModelProvider = { name: "p", async *stream(req) { prompts.push(req); yield "<silent/>"; } };
    const h = await build(p);
    for (let i = 0; i < 3; i++) await round(h, `Line ${i}`);
    const guestName = (h.eng as unknown as { scenario: Scenario }).scenario.roles.guest as NpcRole;
    const guestCalls = prompts.filter((r) => r.system.includes(`You are playing ${guestName.name}`));
    const offered = guestCalls.map((r) => r.system.includes("reply with exactly <silent/>"));
    expect(offered.slice(0, 2)).toEqual([true, true]);
    expect(offered[2]).toBe(false); // third turn in a row: not offered
  });

  it("silentRun resets when the scene changes: silence is offered again in the next scene", async () => {
    prompts.length = 0;
    const s = await twoNpcScenario();
    const eng = new SessionEngine({ scenario: s, log: new MemoryEventLog("r"), clock: new FakeClock(0) });
    await eng.start({ host: "p1" }); await eng.say("host", "Hi");
    const p = seq("<silent/>");
    const agent = new NpcAgent({ role: s.roles.cfo as NpcRole, engine: eng, provider: p, peers: Object.values(s.roles).filter((r): r is NpcRole => r.type === "npc") });
    await agent.respond(); await eng.say("host", "x"); await agent.respond(); await eng.say("host", "y");
    expect(agent.silentTurns).toBe(2);
    await eng.command({ command: "advance" }); await eng.tick();
    expect(eng.currentScene()?.id).toBe("s2_close");
    await eng.say("host", "new scene");
    await agent.respond();
    expect(p.calls.at(-1)!.system).toContain("reply with exactly <silent/>");
    expect(agent.silentTurns).toBe(3);
  });

  it("keeps only the most recent silent turns (bounded memory)", async () => {
    const p: ModelProvider = { name: "p", async *stream(req) { yield req.system.includes("You are playing Helena Brandt") ? "<silent/>" : "Junior line."; } };
    const h = await build(p, { maxSilencesKept: 2 });
    for (let i = 0; i < 4; i++) await round(h, `Line ${i}`);
    const kept = h.host.silentTurns();
    expect(kept).toHaveLength(2);
    expect(kept[1]!.afterSeq).toBeGreaterThan(kept[0]!.afterSeq);
    expect(kept[1]!.afterSeq).toBe(Math.max(...kept.map((k) => k.afterSeq)));
  });
});
