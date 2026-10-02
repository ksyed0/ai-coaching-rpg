import { describe, expect, it } from "vitest";
import { dueInjects, evaluateExit, nextSceneId, type Scene, type Script } from "../index.js";

const scene: Scene = {
  id: "s1", title: "t", goal: "g", participants: ["a"], time_box_minutes: 2,
  injects: [
    { id: "i1", at_minute: 1, to: ["a"], content: "one" },
    { id: "i0", to: ["a"], content: "manual only" },
  ],
  exit_when: { any_of: ["time_box_elapsed", "facilitator_advance", { gm_detects: "done" }] },
};
const script: Script = { scenes: [scene, { ...scene, id: "s2" }] };

describe("evaluateExit", () => {
  it("returns null while nothing has happened", () => {
    expect(evaluateExit(scene, { elapsedMs: 10_000, facilitatorAdvance: false, gmVerdicts: {} })).toBeNull();
  });
  it("exits on the time box", () => {
    expect(evaluateExit(scene, { elapsedMs: 120_000, facilitatorAdvance: false, gmVerdicts: {} })).toBe("time_box_elapsed");
  });
  it("exits on facilitator advance", () => {
    expect(evaluateExit(scene, { elapsedMs: 0, facilitatorAdvance: true, gmVerdicts: {} })).toBe("facilitator_advance");
  });
  it("exits on a true GM verdict for its own condition", () => {
    expect(evaluateExit(scene, { elapsedMs: 0, facilitatorAdvance: false, gmVerdicts: { done: true } })).toBe("gm_detects");
    expect(evaluateExit(scene, { elapsedMs: 0, facilitatorAdvance: false, gmVerdicts: { other: true } })).toBeNull();
  });
  it("ignores a time box when the scene does not list it", () => {
    const s = { ...scene, exit_when: { any_of: ["facilitator_advance" as const] } };
    expect(evaluateExit(s, { elapsedMs: 999_999, facilitatorAdvance: false, gmVerdicts: {} })).toBeNull();
  });
});

describe("nextSceneId", () => {
  it("walks the script in order and ends with null", () => {
    expect(nextSceneId(script, "s1")).toBe("s2");
    expect(nextSceneId(script, "s2")).toBeNull();
  });
});

describe("dueInjects", () => {
  it("returns timed injects whose minute has passed and were not fired", () => {
    expect(dueInjects(scene, 59_000, []).map((i) => i.id)).toEqual([]);
    expect(dueInjects(scene, 60_000, []).map((i) => i.id)).toEqual(["i1"]);
    expect(dueInjects(scene, 60_000, ["i1"]).map((i) => i.id)).toEqual([]);
  });
  it("never returns injects with no at_minute", () => {
    expect(dueInjects(scene, 999_999, []).map((i) => i.id)).not.toContain("i0");
  });
});
