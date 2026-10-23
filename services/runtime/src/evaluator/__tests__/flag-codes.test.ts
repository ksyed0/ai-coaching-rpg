import { describe, expect, it } from "vitest";
import { flagCodesOf } from "../report-model.js";
import { normaliseCriteria } from "../parse.js";
import { sampleRubrics } from "./fixtures.js";

describe("flagCodesOf", () => {
  it("maps every flag text parse.ts can produce to a specific code, never other", () => {
    const rubric = sampleRubrics()[0]!.criteria;
    const verify = () => null; // nothing verifies: drops quotes, caps scores
    const cases: unknown[] = [
      [
        {
          id: rubric[0]!.id,
          score: 4,
          rationale: "r",
          evidence: [{ seq: 1, quote: "a quote that does not exist" }],
        },
      ],
      [{ id: rubric[0]!.id, score: 2, rationale: "r", evidence: [] }],
      [{ id: rubric[0]!.id, score: 3, rationale: "", evidence: [] }],
      [{ id: rubric[0]!.id, score: 9 }],
      [],
    ];
    const seen = new Set<string>();
    for (const raw of cases)
      for (const c of normaliseCriteria(raw, rubric, verify as never).criteria)
        for (const code of flagCodesOf(c.flags)) seen.add(code);
    expect(seen.has("other")).toBe(false);
    expect([...seen]).toEqual(
      expect.arrayContaining([
        "quotes_dropped",
        "capped_no_quote",
        "no_quote",
        "no_rationale",
        "invalid_score",
        "not_reported",
      ]),
    );
  });
  it("maps the remaining texts and unknown text to other", () => {
    expect(
      flagCodesOf([
        "capped from 3 to 2: no verified quote of at least 15 characters and 3 words",
      ]),
    ).toEqual(["capped_weak_quote"]);
    expect(
      flagCodesOf(["only short quotes (they can support a 1 or 2 only)"]),
    ).toEqual(["short_quotes_only"]);
    expect(
      flagCodesOf(["a quote contains rating language: read it with care"]),
    ).toEqual(["rating_language"]);
    expect(flagCodesOf(["evaluation failed"])).toEqual(["evaluation_failed"]);
    expect(flagCodesOf(["something new"])).toEqual(["other"]);
    expect(flagCodesOf([])).toEqual([]);
  });
});
