import { describe, expect, it } from "vitest";
import { JoinThrottle } from "../throttle";

function make(over: Partial<ConstructorParameters<typeof JoinThrottle>[0]> = {}) {
  const clock = { t: 0 };
  const th = new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: () => clock.t, ...over });
  return { th, clock };
}
const failN = (th: JoinThrottle, n: number, ip = "1.1.1.1", role = "r") => { for (let i = 0; i < n; i++) th.fail(ip, role); };

describe("JoinThrottle", () => {
  it("JoinThrottle blocks one (address, role) and not another", () => {
    const { th } = make();
    failN(th, 6);
    expect(th.blockedForMs("1.1.1.1", "r")).toBe(60_000);
    expect(th.blockedForMs("1.1.1.1", "other")).toBe(0);
    expect(th.blockedForMs("2.2.2.2", "r")).toBe(0);
  });

  it("allows exactly max failures", () => {
    const { th } = make();
    failN(th, 5);
    expect(th.blockedForMs("1.1.1.1", "r")).toBe(0);
  });

  it("counts down and unblocks after blockMs", () => {
    const { th, clock } = make();
    failN(th, 6);
    clock.t = 45_000;
    expect(th.blockedForMs("1.1.1.1", "r")).toBe(15_000);
    clock.t = 60_000;
    expect(th.blockedForMs("1.1.1.1", "r")).toBe(0);
  });

  it("a fail recorded while blocked does not extend the block", () => {
    const { th, clock } = make();
    failN(th, 6);
    clock.t = 30_000;
    failN(th, 10);
    clock.t = 60_000;
    expect(th.blockedForMs("1.1.1.1", "r")).toBe(0);
  });

  it("failures older than the window do not add up", () => {
    const { th, clock } = make();
    failN(th, 5);
    clock.t = 60_000;
    failN(th, 5);
    expect(th.blockedForMs("1.1.1.1", "r")).toBe(0);
  });

  it("starts a fresh count after a block ends", () => {
    const { th, clock } = make();
    failN(th, 6);
    clock.t = 60_000;
    failN(th, 5);
    expect(th.blockedForMs("1.1.1.1", "r")).toBe(0);
    th.fail("1.1.1.1", "r");
    expect(th.blockedForMs("1.1.1.1", "r")).toBe(60_000);
  });

  it("bounds tracked keys: attacker-chosen roles evict the oldest, memory stays capped", () => {
    const { th } = make({ maxKeys: 50 } as never);
    for (let i = 0; i < 500; i++) th.fail("1.1.1.1", `role-${i}`);
    expect(th.size).toBeLessThanOrEqual(50);
  });

  it("caps role length so long strings share one key", () => {
    const { th } = make();
    const a = "x".repeat(200) + "A";
    const b = "x".repeat(200) + "B";
    failN(th, 3, "1.1.1.1", a);
    failN(th, 3, "1.1.1.1", b);
    expect(th.blockedForMs("1.1.1.1", a)).toBeGreaterThan(0);
  });

  it("folds unusual role shapes (control characters, separators) so they cannot forge another key", () => {
    const { th } = make();
    failN(th, 6, "1.1.1.1", "r|2.2.2.2");
    expect(th.blockedForMs("1.1.1.1", "r|2.2.2.2")).toBeGreaterThan(0);
    expect(th.blockedForMs("1.1.1.1", "r")).toBe(0);
    expect(th.blockedForMs("1.1.1.1", "r")).toBe(0);
    failN(th, 6, "1.1.1.1", "bad\u0000role");
    expect(th.blockedForMs("1.1.1.1", "bad\u0000role")).toBeGreaterThan(0);
    expect(th.blockedForMs("1.1.1.1", "bad")).toBe(0);
  });

  it("sweeps expired entries so idle keys are released", () => {
    const { th, clock } = make({ maxKeys: 10 } as never);
    for (let i = 0; i < 10; i++) th.fail("1.1.1.1", `r${i}`);
    clock.t = 120_000;
    th.fail("1.1.1.1", "fresh");
    expect(th.size).toBe(1);
  });
});
