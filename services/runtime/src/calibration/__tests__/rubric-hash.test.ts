import { describe, expect, it } from "vitest";
import type { Rubric } from "@acr/script";
import { rubricHash } from "../rubric-hash.js";

const rubric = (desc: string) => ({ id: "individual", scope: "individual", criteria: [{ id: "discovery", name: "Discovery", levels: { 1: desc } }] }) as unknown as Rubric;

describe("rubricHash", () => {
  it("is 16 hex characters, stable for the same content and different when the content changes", () => {
    const h = rubricHash([rubric("asks nothing")]);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(rubricHash([rubric("asks nothing")])).toBe(h);
    expect(rubricHash([rubric("asks one question")])).not.toBe(h);
    expect(rubricHash([])).toMatch(/^[0-9a-f]{16}$/);
    expect(rubricHash([])).not.toBe(h);
  });
});
