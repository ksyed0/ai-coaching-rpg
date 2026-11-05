import { describe, expect, it } from "vitest";
import { parseAiAnswer, setAiRoles } from "../console-ai";
import { fakeFetch, ok } from "./fakes";

describe("setAiRoles / parseAiAnswer: the group-score option", () => {
  it("posts both fields, always, even when the option is on", async () => {
    const f = fakeFetch(() => ({ status: 200, body: ok({ roles: [], includeInGroup: true, codes: [] }) }));
    await setAiRoles("s1", ["tech_lead"], true, f.fetch);
    await setAiRoles("s1", [], false, f.fetch);
    expect(f.calls.map((c) => c.body)).toEqual([
      { roles: ["tech_lead"], includeInGroup: true },
      { roles: [], includeInGroup: false },
    ]);
  });

  it("reads the option from the answer and says null when it is missing or not a boolean", () => {
    expect(parseAiAnswer({ roles: ["tech_lead"], includeInGroup: false, codes: [] }).includeInGroup).toBe(false);
    expect(parseAiAnswer({ roles: [], includeInGroup: true, codes: [] }).includeInGroup).toBe(true);
    expect(parseAiAnswer({ roles: [], codes: [] }).includeInGroup).toBeNull();
    expect(parseAiAnswer({ roles: [], includeInGroup: "no", codes: [] }).includeInGroup).toBeNull();
    expect(parseAiAnswer(null).includeInGroup).toBeNull();
  });
});
