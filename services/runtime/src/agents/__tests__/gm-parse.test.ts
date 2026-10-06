import { describe, expect, it } from "vitest";
import { parseGmReply } from "../gm-parse.js";

const ok = (verdict: boolean, via: "strict" | "tolerant", reasoning = "") => ({ ok: true, verdict, reasoning, via });
const no = (reason: string) => ({ ok: false, reason });

describe("parseGmReply", () => {
  it.each([
    ["strict JSON", '{"reasoning": "both said hi", "verdict": true}', ok(true, "strict", "both said hi")],
    ["strict JSON, verdict first, with whitespace", '  {"verdict": false, "reasoning": "open"}\n', ok(false, "strict", "open")],
    ["a code fence", '```json\n{"verdict": true, "reasoning": "r"}\n```', ok(true, "tolerant", "r")],
    ["a bare fence without a language", '```\n{"verdict": false}\n```', ok(false, "tolerant")],
    ["prose around the JSON", 'Sure! Here you go: {"verdict": true, "reasoning": "done"} Hope that helps.', ok(true, "tolerant", "done")],
    ["prose with braces after the JSON", '{"verdict": true, "reasoning": "x"}\nNote: {not json} and {braces}', ok(true, "tolerant", "x")],
    ["two objects: the last usable one wins", '{"verdict": false, "reasoning": "first"} then {"verdict": true, "reasoning": "second"}', ok(true, "tolerant", "second")],
    ["an echoed schema example is not valid JSON and is ignored", 'Format: {"reasoning": "...", "verdict": true or false}\n{"reasoning": "ok", "verdict": false}', ok(false, "tolerant", "ok")],
    ["a string boolean", '{"verdict": "true", "reasoning": "s"}', ok(true, "strict", "s")],
    ["a string boolean in any case", '{"verdict": " FALSE "}', ok(false, "strict")],
    ["braces and quotes inside strings", 'x {"reasoning": "he said \\"}\\" and {", "verdict": true} y', ok(true, "tolerant", 'he said "}" and {')],
    ["a <think> block before the answer", '<think>maybe {"verdict": false}? no, it is true</think>{"verdict": true, "reasoning": "r"}', ok(true, "tolerant", "r")],
    ["a verdict inside a <think> block only is not read", '<think>{"verdict": true}</think>', no("reasoning_only")],
    ["verdict: true as plain text", "My answer.\nverdict: true\nreasoning: none", ok(true, "tolerant")],
    ["verdict = False as plain text, the last one wins", "verdict: true ... on reflection verdict = False", ok(false, "tolerant")],
    ["a reply that is exactly true", " True ", ok(true, "tolerant")],
    ["a reply that is exactly false", "false", ok(false, "tolerant")],
    ["a verdict key cut mid-reasoning (verdict first)", '{"verdict": true, "reasoning": "the team agre', ok(true, "tolerant")],
  ])("reads %s", (_name, text, expected) => { expect(parseGmReply(text)).toEqual(expected); });

  it.each([
    ["empty", "", "empty"],
    ["blank", " \n\t", "empty"],
    ["prose with no JSON", "I am not able to decide right now, sorry.", "no_json"],
    ["an object without a verdict is not a verdict", '{"reasoning": "x"}', "no_json"],
    ["a number is not a verdict", '{"verdict": 1}', "bad_verdict"],
    ["yes is not a verdict", '{"verdict": "yes"}', "bad_verdict"],
    ["null is not a verdict", '{"verdict": null}', "bad_verdict"],
    ["an array", "[true]", "no_json"],
    ["truncated before the verdict", '{"reasoning": "the team has aired concerns but', "truncated"],
    ["truncated inside the verdict", '{"verdict": tr', "truncated"],
    ["reasoning only (the thinking was cut off)", "<think>I need to decide whether", "reasoning_only"],
    ["prose that mentions the word verdict without a value", "Verdict: pending", "bad_verdict"],
  ])("gives no verdict for %s", (_name, text, reason) => { expect(parseGmReply(text)).toEqual(no(reason)); });

  it("never reads a verdict out of the reasoning text", () => {
    expect(parseGmReply('{"reasoning": "the verdict: true would be wrong", "verdict": "maybe"}')).toEqual(no("bad_verdict"));
  });

  it("never throws and is fast, whatever the input (fuzz)", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const alphabet = ['{', '}', '"', ':', ',', 'verdict', 'true', 'false', '<think>', '</think>', '```', '\\', ' ', '\n', 'reasoning', '[', ']', '\u0000', 'é', '1'];
    for (let i = 0; i < 2_000; i++) {
      let s = ""; const n = Math.floor(rnd() * 40);
      for (let j = 0; j < n; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const r = parseGmReply(s);
      expect(typeof r.ok).toBe("boolean");
    }
    const hostile = '{"'.repeat(30_000);
    const t0 = Date.now();
    expect(parseGmReply(hostile).ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(parseGmReply(undefined as unknown as string)).toEqual(no("empty"));
  });
});
