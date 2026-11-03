import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelProviderError, type ChatRequest, type ModelProvider } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import { loadScenario, type Scenario } from "@acr/script";
import { REPO_ROOT } from "../../main.js";
import { MAX_LINE_CHARS, PlayerBotGenerator } from "../index.js";

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
    // The run aborts once the model call is under way (the stream was opened), not after a small real timer.
    const hang: ModelProvider = { name: "h", stream(_r, signal) { signal?.addEventListener("abort", () => { sawAbort = true; }); queueMicrotask(() => ac2.abort()); return (async function* () { await new Promise<void>(() => undefined); yield "x"; })(); } };
    const pending = speak(await gen(hang, { firstTokenTimeoutMs: 5_000, replyTimeoutMs: 5_000, signal: ac2.signal }));
    expect(await pending).toMatchObject({ source: "scripted", reason: "run aborted" });
    expect(sawAbort).toBe(true);
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
