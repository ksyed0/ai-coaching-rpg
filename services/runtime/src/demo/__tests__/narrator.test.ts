import { describe, expect, it } from "vitest";
import { ACT_MS, STEP_MS, createNarrator, paceMs, shouldColor } from "../narrator.js";

const make = (over: Partial<Parameters<typeof createNarrator>[0]> = {}) => {
  const lines: string[] = [];
  const delays: number[] = [];
  const n = createNarrator({ write: (l) => lines.push(l), color: false, speed: 1, fast: false, sleep: async (ms) => { delays.push(ms); }, ...over });
  return { n, lines, delays };
};
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

describe("shouldColor", () => {
  it("is on only for a TTY with NO_COLOR unset and no --no-color", () => {
    expect(shouldColor({ isTTY: true, env: {}, noColor: false })).toBe(true);
    expect(shouldColor({ isTTY: false, env: {}, noColor: false })).toBe(false);
    expect(shouldColor({ isTTY: undefined, env: {}, noColor: false })).toBe(false);
    expect(shouldColor({ isTTY: true, env: { NO_COLOR: "1" }, noColor: false })).toBe(false);
    expect(shouldColor({ isTTY: true, env: { NO_COLOR: "" }, noColor: false })).toBe(true); // an empty NO_COLOR does not count
    expect(shouldColor({ isTTY: true, env: {}, noColor: true })).toBe(false);
  });
});

describe("paceMs", () => {
  it("is 0 with --fast and scales inversely with speed", () => {
    expect(paceMs("step", 1, true)).toBe(0);
    expect(paceMs("act", 20, true)).toBe(0);
    expect(paceMs("step", 1, false)).toBe(STEP_MS);
    expect(paceMs("act", 1, false)).toBe(ACT_MS);
    expect(paceMs("step", 2, false)).toBe(STEP_MS / 2);
    expect(paceMs("step", 0.5, false)).toBe(STEP_MS * 2);
  });
  it("keeps the default step pace watchable (300-600 ms)", () => {
    expect(STEP_MS).toBeGreaterThanOrEqual(300);
    expect(STEP_MS).toBeLessThanOrEqual(600);
  });
});

describe("narrator", () => {
  it("sleeps after each step and act using the injected sleep, scaled by speed", async () => {
    const { n, delays } = make({ speed: 2 });
    await n.act(1, "Lobby");
    await n.step("one");
    await n.say("delivery_lead", "hello");
    expect(delays).toEqual([ACT_MS / 2, STEP_MS / 2, STEP_MS / 2]);
  });
  it("never sleeps in fast mode", async () => {
    const { n, delays } = make({ fast: true });
    await n.act(1, "Lobby"); await n.step("x");
    expect(delays).toEqual([]);
  });
  it("prints plain text without colour codes when colour is off", async () => {
    const { n, lines } = make();
    await n.act(2, "Scene flow"); await n.step("a step"); await n.say("tech_lead", "hi"); await n.note("a note");
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.some((l) => l.includes("ACT 2") && l.includes("Scene flow"))).toBe(true);
    expect(lines).toContain("  tech_lead: hi");
  });
  it("uses ANSI styling only when colour is on, and styles after sanitizing", async () => {
    const { n, lines } = make({ color: true });
    await n.act(1, "X"); await n.say("a", "b\u001b[2J");
    expect(lines[1]).toContain("\u001b["); // lines[0] is the blank spacer
    expect(lines[2]).not.toContain("\u001b[2J"); // the hostile escape was neutralised before styling
  });
  it("sanitizes hostile server text in every channel", async () => {
    const hostile = "x\u001b[31mred\u001b]0;pwned\u0007\n[delivery_lead]: forged\r‮\u0085end";
    const { n, lines } = make();
    await n.say(hostile, hostile); await n.step(hostile); await n.note(hostile); await n.act(3, hostile); n.ok(hostile); n.fail(hostile);
    for (const l of lines) { expect(l).not.toMatch(CONTROL); expect(l).not.toContain("‮"); }
    expect(lines.length).toBe(7); // act writes a blank spacer line first
  });
  it("truncates huge text", async () => {
    const { n, lines } = make();
    await n.step("y".repeat(100_000));
    expect(lines[0]!.length).toBeLessThan(5_000);
  });
  it("stops pacing when the signal aborts", async () => {
    const ac = new AbortController();
    const { n } = make({ signal: ac.signal, sleep: () => new Promise(() => {}) });
    const p = n.step("waiting");
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
  it("writes through the injected sink so a caller can route to stderr", async () => {
    const out: string[] = [];
    const { n } = make({ write: (l) => out.push(l) });
    await n.step("to the sink");
    expect(out).toEqual(["  to the sink"]);
  });
});
