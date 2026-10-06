import { describe, expect, it } from "vitest";
import { cleanActions, cleanList, cleanProse, cleanQuote, extractJson, makeVerifier, normaliseCriteria, readScore, verifyAll } from "../parse.js";
import { buildTranscript } from "../transcript.js";
import { U, sampleEvents, sampleRubrics, sampleScenario } from "./fixtures.js";

describe("extractJson", () => {
  const ok = (s: string) => { const r = extractJson(s); expect(r.ok).toBe(true); return r.ok ? r.value : {}; };
  it("parses plain JSON, fenced JSON and JSON inside prose", () => {
    expect(ok('{"a":1}')).toEqual({ a: 1 });
    expect(ok('Here you go:\n```json\n{"a": {"b": [1,2]}}\n```\nHope it helps')).toEqual({ a: { b: [1, 2] } });
    expect(ok('Sure! The result is {"a":"x } y"} and that is all.')).toEqual({ a: "x } y" });
  });
  it("tolerates trailing commas and a <think> block", () => {
    expect(ok('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
    expect(ok('<think>I will output {"bad": 1} maybe</think>{"a":2}')).toEqual({ a: 2 });
    expect(ok('thinking text that never opened</think>{"a":3}')).toEqual({ a: 3 });
  });
  it("skips an invalid first object and finds a later valid one", () => { expect(ok('{oops} then {"a":4}')).toEqual({ a: 4 }); });
  it("reports why it failed, never throws", () => {
    expect(extractJson("")).toEqual({ ok: false, error: "the reply was empty" });
    expect(extractJson("no json here")).toMatchObject({ ok: false, error: "the reply held no JSON object" });
    expect(extractJson('{"a": ')).toMatchObject({ ok: false, error: expect.stringMatching(/no complete, valid JSON/) });
    expect(extractJson("[1,2]")).toMatchObject({ ok: false });
    expect(extractJson("{".repeat(50_000))).toMatchObject({ ok: false });
  });
});

describe("cleaning", () => {
  it("folds whitespace, removes links and clips", () => {
    expect(cleanProse("See https://evil.example/x?k=1 and\nwww.foo.com now", 100)).toBe("See [link removed] and [link removed] now");
    expect(cleanProse("x".repeat(50), 10)).toBe("xxxxxxxxx…");
    expect(cleanProse(5, 10)).toBe("");
  });
  it("lists are deduplicated, capped and accept objects", () => {
    expect(cleanList(["a", "a", " ", "b", { text: "c" }, "d"], 3, 50)).toEqual(["a", "b", "c"]);
    expect(cleanList("nope", 3, 10)).toEqual([]);
  });
  it("actions are tied to a known LO or to the fallback", () => {
    expect(cleanActions([{ lo: "LO2", action: "Try X" }, { lo: "LO9", action: "Try Y" }, "Try Z", { action: "Try X" }], ["LO1", "LO2"], "LO1")).toEqual([
      { lo: "LO2", action: "Try X" }, { lo: "LO1", action: "Try Y" }, { lo: "LO1", action: "Try Z" }]);
  });
  it("cleanQuote removes quote marks and ellipses at the edges", () => { expect(cleanQuote(' "…the ingestion  layer…" ')).toBe("the ingestion layer"); });
});

describe("readScore", () => {
  it("accepts whole numbers 1 to 4, numeric strings, and N/O forms", () => {
    expect([1, 2, 3, 4, "3", " 2 "].map((v) => readScore(v).score)).toEqual([1, 2, 3, 4, 3, 2]);
    for (const v of [null, undefined, "N/O", "not observed"]) expect(readScore(v)).toEqual({ score: null, rejected: null });
  });
  it("rejects fractions, out-of-range values and junk with a reason", () => {
    for (const v of [3.5, 0, 5, -1, "high", NaN, {}, "3.0", Infinity]) { const r = readScore(v); expect(r.score).toBeNull(); expect(r.rejected).toMatch(/not a whole number from 1 to 4/); }
  });
});

describe("evidence verification", () => {
  const t = buildTranscript(sampleEvents(), sampleScenario());
  const own = makeVerifier(t, (u) => u.roleId === "alice");
  it("accepts a verbatim quote from the participant's own line, with its time and scene", () => {
    const e = own({ seq: 3, quote: "what Finance really needs" })!;
    expect(e).toMatchObject({ seq: 3, roleId: "alice", quote: "what Finance really needs", time: "00:00:10", sceneNumber: 1, sceneTitle: "Huddle" });
  });
  it("ignores whitespace, quote marks and ellipses", () => {
    expect(own({ seq: 3, quote: '"Let me understand   what Finance\nreally needs…"' })?.quote).toBe("Let me understand what Finance really needs");
    expect(own({ seq: "5", quote: "Have I got that right?" })).not.toBeNull();
  });
  it("rejects a paraphrase, a quote from another speaker or the wrong seq, an unknown seq and trivial quotes", () => {
    expect(own({ seq: 3, quote: "what Finance truly needs" })).toBeNull();
    expect(own({ seq: 4, quote: "the ingestion layer" })).toBeNull(); // bob's line
    expect(own({ seq: 5, quote: "what Finance really needs" })).toBeNull(); // right words, wrong line
    expect(own({ seq: 999, quote: "what Finance really needs" })).toBeNull();
    expect(own({ seq: 3, quote: "Let me" })).toBeNull(); // too short
    expect(own({ seq: 3, quote: "????????????" })).toBeNull();
    expect(own({ seq: 1.5, quote: "what Finance really needs" })).toBeNull();
    expect(own({ seq: 3 })).toBeNull();
    expect(own("a string")).toBeNull();
    expect(own({ seq: 3, quote: "x".repeat(5000) })).toBeNull();
  });
  it("is case sensitive: a quote must be verbatim", () => { expect(own({ seq: 3, quote: "WHAT FINANCE REALLY NEEDS" })).toBeNull(); });
  it("does not credit an inject, a Game Master line or an AI character to a participant", () => {
    expect(own({ seq: 9, quote: "Priya emails." })).toBeNull();
    expect(own({ seq: 10, quote: "Can you confirm the module" })).toBeNull();
  });
  it("the group verifier accepts any player's line but not an AI character's", () => {
    const grp = makeVerifier(t, (u) => u.speaker === "player");
    expect(grp({ seq: 4, quote: "the ingestion layer" })).not.toBeNull();
    expect(grp({ seq: 10, quote: "Can you confirm the module" })).toBeNull();
  });
  it("verifyAll counts dropped quotes, dedupes and caps", () => {
    const raw = [{ seq: 3, quote: "what Finance really needs" }, { seq: 3, quote: "what Finance really needs" }, { seq: 3, quote: "made up words here" }, "junk", { seq: 5, quote: "Have I got that right?" }];
    const r = verifyAll(raw, own);
    expect(r.verified.map((e) => e.seq)).toEqual([3, 5]);
    expect(r.dropped).toBe(2);
    expect(verifyAll("nope", own)).toEqual({ verified: [], dropped: 0 });
  });
});

describe("normaliseCriteria", () => {
  const t = buildTranscript(sampleEvents(), sampleScenario());
  const verify = makeVerifier(t, (u) => u.roleId === "alice");
  const rubric = sampleRubrics()[0]!.criteria;
  const good = { id: "discovery", score: 3, rationale: "Asked about the need.", confidence: "high", evidence: [{ seq: 3, quote: "what Finance really needs" }, { seq: 5, quote: "Have I got that right?" }, { seq: 11, quote: "phased module for 48 thousand" }] };
  it("keeps a verified score, gives confidence from the quotes and the model, and returns one entry per rubric criterion in order", () => {
    const { criteria, recognised } = normaliseCriteria([good], rubric, verify);
    expect(recognised).toBe(1);
    expect(criteria.map((c) => c.id)).toEqual(["discovery", "listening", "negotiation"]);
    expect(criteria[0]).toMatchObject({ score: 3, label: "Proficient", confidence: "high", droppedQuotes: 0, flags: [] });
    expect(criteria[0]!.evidence).toHaveLength(3);
    expect(criteria[1]).toMatchObject({ score: null, label: "Not observed", flags: ["not reported by the evaluator"] });
  });
  it("ignores unknown ids and the second entry for the same id", () => {
    const { criteria, recognised } = normaliseCriteria([{ id: "made_up", score: 4 }, good, { ...good, score: 1 }], rubric, verify);
    expect(recognised).toBe(1);
    expect(criteria[0]!.score).toBe(3);
  });
  it("caps a 3 or 4 with no verified quote at 2 and flags it, with Low confidence", () => {
    const { criteria } = normaliseCriteria([{ ...good, score: 4, evidence: [{ seq: 3, quote: "invented sentence" }] }], rubric, verify);
    expect(criteria[0]).toMatchObject({ score: 2, label: "Developing", confidence: "low", droppedQuotes: 1 });
    expect(criteria[0]!.flags.join(" ")).toMatch(/capped from 4 to 2: no verified quote/);
    expect(criteria[0]!.flags.join(" ")).toMatch(/1 quote\(s\) could not be verified/);
  });
  it("keeps a 1 or 2 with no verified quote, flagged and Low", () => {
    const { criteria } = normaliseCriteria([{ ...good, score: 1, evidence: [] }], rubric, verify);
    expect(criteria[0]).toMatchObject({ score: 1, confidence: "low" });
    expect(criteria[0]!.flags).toContain("no verified quote");
  });
  it("a score that is not a whole number 1 to 4 becomes Not observed, with a flag", () => {
    const { criteria } = normaliseCriteria([{ ...good, score: 3.5 }, { id: "listening", score: 9 }], rubric, verify);
    expect(criteria[0]).toMatchObject({ score: null, label: "Not observed" });
    expect(criteria[0]!.flags.join(" ")).toMatch(/score "3.5" is not a whole number from 1 to 4/);
    expect(criteria[1]!.score).toBeNull();
  });
  it("a null score keeps its rationale, drops any evidence and has no confidence", () => {
    const { criteria } = normaliseCriteria([{ ...good, score: null, rationale: "No evidence either way." }], rubric, verify);
    expect(criteria[0]).toMatchObject({ score: null, confidence: null, rationale: "No evidence either way.", evidence: [] });
  });
  it("handles a non-array criteria value", () => { expect(normaliseCriteria("nope", rubric, verify)).toMatchObject({ recognised: 0 }); });
  it("the model cannot raise confidence above the evidence", () => {
    const { criteria } = normaliseCriteria([{ ...good, evidence: [good.evidence[0]], confidence: "high" }], rubric, verify);
    expect(criteria[0]!.confidence).toBe("low");
  });
  it("evidence texts are verbatim substrings of the recorded utterance", () => {
    const { criteria } = normaliseCriteria([good], rubric, verify);
    for (const e of criteria[0]!.evidence) expect(t.utterances.get(e.seq)!.norm).toContain(e.quote);
    expect(U.a1).toContain(criteria[0]!.evidence[0]!.quote);
  });
});
