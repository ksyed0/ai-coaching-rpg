import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelProviderError, type ChatRequest, type ModelProvider } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import { loadScenario, type Scenario } from "@acr/script";
import { REPO_ROOT } from "../../main.js";
import { PlayerBotGenerator } from "../player-bot.js";
import { PlayerLines, playerSource } from "../player-lines.js";
import { buildPlayerRequest, roleLabel, viewFromEvents } from "../player-prompt.js";
import { showcaseMarkers } from "../showcase.js";
import { MAX_LINE_CHARS } from "../showcase-script.js";

const DIR = path.join(REPO_ROOT, "scenarios", "friday-escalation-extended");
let scenarioP: Promise<Scenario> | undefined;
const scenario = () => (scenarioP ??= loadScenario(DIR));
const env = (seq: number) => ({ seq, ts: seq, sessionId: "s" });
const scene = async (id: string) => (await scenario()).script.scenes.find((s) => s.id === id)!;
const ev = (...e: Array<Record<string, unknown>>): SessionEvent[] => e.map((x, i) => ({ ...env(i + 1), ...x }) as SessionEvent);

/** A scripted provider: each call returns the next item (a string, or a function that throws / stalls). */
const provider = (...replies: Array<string | (() => AsyncIterable<string>)>): ModelProvider & { calls: ChatRequest[] } => {
  const calls: ChatRequest[] = [];
  return {
    name: "fake", calls,
    stream(req: ChatRequest, signal?: AbortSignal) {
      calls.push(req);
      const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      if (typeof r === "function") return r();
      return (async function* () { for (const w of r.split(" ")) { if (signal?.aborted) return; yield `${w} `; } })();
    },
  };
};
const gen = async (p: ModelProvider, o: { firstTokenTimeoutMs?: number; replyTimeoutMs?: number; signal?: AbortSignal } = {}) =>
  new PlayerBotGenerator({ provider: p, scenario: await scenario(), firstTokenTimeoutMs: o.firstTokenTimeoutMs ?? 1_000, replyTimeoutMs: o.replyTimeoutMs ?? 2_000, maxTokens: 300, signal: o.signal });
const speak = async (g: PlayerBotGenerator, scripted = "We offer a phased module after go-live.", roleId = "delivery_lead") =>
  g.speak({ roleId, scene: await scene("s2_priya_call"), scripted, joined: { brief: "BRIEF of the role", privateFacts: ["fact one"] }, events: [] });

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

describe("PlayerBotGenerator", () => {
  it("returns the cleaned, single-line model text as generated, with the request recorded", async () => {
    const p = provider("  Hi Priya,\nwe can phase it after go-live. ");
    const g = await gen(p);
    const r = await speak(g);
    expect(r).toEqual({ text: "Hi Priya, we can phase it after go-live.", source: "generated", verbatim: false, cut: false });
    expect(g.calls).toHaveLength(1);
    expect(g.callRoles).toEqual(["delivery_lead"]);
    expect(g.calls[0]!.system).toContain("BRIEF of the role");
    expect(p.calls[0]!.system).toContain("We offer a phased module after go-live.");
    expect(p.calls[0]!.messages.at(-1)!.content).not.toContain("We offer a phased module");
  });

  it("flags a verbatim repeat of the scripted line (ignoring case and spacing)", async () => {
    const r = await speak(await gen(provider("we OFFER a phased   module after go-live.")));
    expect(r).toMatchObject({ source: "generated", verbatim: true });
  });

  it("cannot speak for others: a leading own tag is dropped and lines written for other speakers are cut", async () => {
    const r = await speak(await gen(provider("[delivery_lead]: Fine with me. [client_sponsor]: Great, thanks.")));
    expect(r).toEqual({ text: "Fine with me.", source: "generated", verbatim: false, cut: true });
    const r2 = await speak(await gen(provider("Sounds right.\nPriya Raman: Agreed.\n[cfo]: Fine.")));
    expect(r2).toMatchObject({ text: "Sounds right.", cut: true });
    const r3 = await speak(await gen(provider("tech lead: I agree.")), "x", "tech_lead");
    expect(r3.text).toBe("I agree.");
  });

  it("drops inline thinking", async () => {
    expect((await speak(await gen(provider("<think>plan the answer</think>Let us phase it.")))).text).toBe("Let us phase it.");
  });

  it.each([["", "empty reply"], ["...", "empty reply"], ["[client_sponsor]: I said so.", "the reply held only lines for other speakers"]])("falls back to the scripted line for %j (%s)", async (reply, why) => {
    const r = await speak(await gen(provider(reply)));
    expect(r).toEqual({ text: "We offer a phased module after go-live.", source: "scripted", verbatim: false, cut: false, reason: why });
  });

  it("falls back when the reply is longer than the server accepts", async () => {
    const r = await speak(await gen(provider("a".repeat(MAX_LINE_CHARS + 1))));
    expect(r.source).toBe("scripted");
    expect(r.reason).toBe(`reply longer than ${MAX_LINE_CHARS} characters`);
    const ok = await speak(await gen(provider("a".repeat(MAX_LINE_CHARS))));
    expect(ok.source).toBe("generated");
  });

  it("falls back on a model error with the sanitized, classified reason", async () => {
    const err = new ModelProviderError("the server is overloaded", { kind: "overloaded", transient: true, status: 529, attempts: 3 });
    const r = await speak(await gen(provider(() => (async function* () { throw err; })())));
    expect(r.source).toBe("scripted");
    expect(r.reason).toBe("model error after 3 attempts (overloaded): the server is overloaded");
    const plain = await speak(await gen(provider(() => (async function* () { throw new Error("boom"); })())));
    expect(plain.reason).toBe("model error: boom");
  });

  it("falls back on a first-token timeout and on the overall deadline, aborting the model call", async () => {
    let aborted = 0;
    const stall = () => (async function* () { await new Promise<void>(() => undefined); yield "x"; })();
    const never: ModelProvider = { name: "never", stream(_r, signal) { signal?.addEventListener("abort", () => { aborted++; }); return stall(); } };
    const r = await speak(await gen(never, { firstTokenTimeoutMs: 30, replyTimeoutMs: 60 }));
    expect(r).toMatchObject({ source: "scripted", reason: "no first token within timeout" });
    expect(aborted).toBe(1);
    const trickle: ModelProvider = { name: "t", stream: () => (async function* () { yield "Hello "; await new Promise<void>(() => undefined); })() };
    const r2 = await speak(await gen(trickle, { firstTokenTimeoutMs: 30, replyTimeoutMs: 80 }));
    expect(r2).toMatchObject({ source: "scripted", reason: "reply did not finish within the overall deadline" });
  });

  it("respects the run's abort: already aborted makes no model call; an abort mid-call stops it", async () => {
    const p = provider("hello");
    const ac = new AbortController(); ac.abort();
    const r = await speak(await gen(p, { signal: ac.signal }));
    expect(r).toMatchObject({ source: "scripted", reason: "run aborted" });
    expect(p.calls).toHaveLength(0);
    const ac2 = new AbortController();
    let sawAbort = false;
    const hang: ModelProvider = { name: "h", stream(_r, signal) { signal?.addEventListener("abort", () => { sawAbort = true; }); return (async function* () { await new Promise<void>(() => undefined); yield "x"; })(); } };
    const pending = speak(await gen(hang, { firstTokenTimeoutMs: 5_000, replyTimeoutMs: 5_000, signal: ac2.signal }));
    setTimeout(() => ac2.abort(), 20);
    expect(await pending).toMatchObject({ source: "scripted", reason: "run aborted" });
    expect(sawAbort).toBe(true);
  });
});

describe("PlayerLines", () => {
  it("matches utterances to records in send order, also for identical texts, and forgets a dropped line", () => {
    const lines = new PlayerLines();
    const read = lines.reader();
    const a = lines.add({ role: "r", text: "same", source: "generated", verbatim: false, cut: false, intent: "i", scene: null });
    const b = lines.add({ role: "r", text: "same", source: "scripted", verbatim: false, cut: false, reason: "x", intent: "i", scene: null });
    const c = lines.add({ role: "r", text: "gone", source: "generated", verbatim: false, cut: false, intent: "i", scene: null });
    lines.drop(c); lines.drop(c);
    expect(read("r", "same")).toBe(a);
    expect(read("r", "same")).toBe(b);
    expect(read("r", "same")).toBeUndefined();
    expect(read("r", "gone")).toBeUndefined();
    expect(read("other", "same")).toBeUndefined();
    expect(playerSource(a)).toBe("generated");
    expect(playerSource(b)).toBe("scripted");
    expect(playerSource(undefined)).toBe("scripted");
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

describe("PlayerBotGenerator: echoed note and control characters", () => {
  it.each([
    "[note to you only, not spoken]: What you want to get across in this turn (do not quote it): We phase it. Then ship.",
    "Note: We phase it. Then ship.",
    "  [ Note ]:   We phase it. Then ship.",
    "NOTE : What you want to get across in this turn (do not quote it): We phase it. Then ship.",
  ])("drops a leading echo of the private note: %j", async (reply) => {
    const r = await speak(await gen(provider(reply)));
    expect(r.text).not.toMatch(/note/i);
    expect(r.text).not.toMatch(/get across/i);
    expect(r).toMatchObject({ source: "generated" });
    expect(r.text.endsWith("Then ship.")).toBe(true);
  });
  it("falls back when only the note prefix is left", async () => {
    expect(await speak(await gen(provider("[note to you only, not spoken]:")))).toMatchObject({ source: "scripted", reason: "empty reply" });
  });
  it("strips C0/C1 and bidi control characters but keeps text and turns line breaks into spaces", async () => {
    const r = await speak(await gen(provider("Hi\u001b[31m there\u0007‮ evil⁦ x‏\u0085 y\nnext\ttab\u007f")));
    // eslint-disable-next-line no-control-regex
    expect(r.text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/);
    expect(r.text).toBe("Hi[31m there evil x y next tab");
    expect(r.source).toBe("generated");
  });
});

describe("PlayerBotGenerator: the model explaining its intent (observed with a real model)", () => {
  const OBSERVED = [
    ["What if we propose this as a phase two deliverable, properly scoped and priced? *** I want to suggest a compromise where the module is moved to a second phase and priced separately.", "What if we propose this as a phase two deliverable, properly scoped and priced?"],
    ["Okay, I hear you.\n\n---\nMy intent is to calm things down.", "Okay, I hear you."],
    ["We can do 45k. ___ Intent: close the price.", "We can do 45k."],
    ["Fine by me. === done", "Fine by me."],
    ["Fine by me.\n(Note: this restates the intent)", "Fine by me."],
    ["Fine by me.\nIntent: agree", "Fine by me."],
    ["Fine by me.\n[Note to self: agree]", "Fine by me."],
    ["Fine by me.\n\nMy intent was to agree.", "Fine by me."],
    ["Fine by me.\n(Intent - agree)", "Fine by me."],
  ] as const;
  it.each(OBSERVED)("cuts %j down to the spoken words", async (raw, spoken) => {
    const r = await speak(await gen(provider(raw)));
    expect(r).toMatchObject({ text: spoken, source: "generated", verbatim: false });
    expect(r.text).not.toMatch(/intent|\*\*\*|---|___|===|note/i);
  });
  it("keeps legitimate text: a dash, an em dash, **bold**, -- and 5*3", async () => {
    const t = "Two-week plan \u2014 not **ten**; ok -- but 5*3 is 15 - fine, a note: yes";
    expect((await speak(await gen(provider(t)))).text).toBe(t);
  });
  it("falls back to the scripted line when only a separator or commentary remains, and a cut line equal to the script still counts as a verbatim repeat", async () => {
    expect(await speak(await gen(provider("*** my own explanation")))).toMatchObject({ source: "scripted", reason: "empty reply" });
    expect(await speak(await gen(provider("(Note: nothing else)")))).toMatchObject({ source: "scripted" });
    const r = await speak(await gen(provider("We offer a phased module after go-live. *** I wanted to say the same.")));
    expect(r).toMatchObject({ source: "generated", verbatim: true, text: "We offer a phased module after go-live." });
  });
});
