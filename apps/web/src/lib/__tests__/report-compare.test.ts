import { describe, expect, it } from "vitest";
import { comparisonRows } from "../report-compare";

describe("comparisonRows", () => {
  it("pairs the evaluator level with the participant's own rating and note", () => {
    const own = {
      criteria: [
        { id: "c1", name: "Listening", score: 3, level_label: "Proficient" },
        { id: "c2", name: "Framing", score: null, level_label: "Not observed" },
      ],
      self: { c1: { level: 2, label: "Developing", note: "I rushed" } },
    };
    expect(comparisonRows(own)).toEqual([
      { criterion: "Listening", evaluator: "Proficient", yours: "Developing", note: "I rushed" },
      { criterion: "Framing", evaluator: "Not observed", yours: "Not rated" },
    ]);
  });
  it("unknown or malformed shapes yield no rows and never throw", () => {
    for (const v of [undefined, null, 5, "x", {}, { criteria: "x" }, { criteria: [null, 3, { id: 1 }] }]) expect(comparisonRows(v)).toEqual([]);
    expect(comparisonRows({ criteria: [{ id: "a", name: "A", level_label: "L" }], self: "bad" })).toEqual([{ criterion: "A", evaluator: "L", yours: "Not rated" }]);
  });
});
