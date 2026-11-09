import { describe, expect, it } from "vitest";
import { waitQuiet } from "../../demo/voice-client.js";

// F7 (review fix wave, AGENTS.md section 8): the voice demo waits for "nothing more happens" by quiescence (the observed size unchanged
// across N consecutive observations), never by a fixed sleep. The observations here are driven by an injected step: no real time.
describe("waitQuiet (US-0070 voice demo)", () => {
  const stepper = () => { let steps = 0; return { step: async () => { steps++; }, get steps() { return steps; } }; };

  it("returns once the size is unchanged for `stable` consecutive observations, counting from the last change", async () => {
    const sizes = [1, 2, 2, 3, 3, 3, 3, 3, 3, 9];
    let i = 0;
    const s = stepper();
    const got = await waitQuiet("the log", () => sizes[Math.min(i++, sizes.length - 1)]!, { stable: 4, maxSteps: 100, step: s.step });
    expect(got).toBe(3);
    expect(i).toBe(8); // 3 seen at observations 4..8: four unchanged after the change
  });

  it("throws, naming what it waited for, when the size never settles within maxSteps", async () => {
    let n = 0;
    const s = stepper();
    await expect(waitQuiet("the log", () => n++, { stable: 3, maxSteps: 20, step: s.step })).rejects.toThrow("the log never settled");
    expect(s.steps).toBe(20);
  });

  it("a size that is already still returns after `stable` observations", async () => {
    const s = stepper();
    expect(await waitQuiet("x", () => 5, { stable: 2, maxSteps: 10, step: s.step })).toBe(5);
    expect(s.steps).toBe(2);
  });
});
