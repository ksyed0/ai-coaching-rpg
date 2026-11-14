import { describe, expect, it } from "vitest";
import { NudgeFloor } from "../../bots/nudge-floor.js";

// US-0081 (AC-0471, TC-0251): one AI player of a session nudges at a time.
describe("NudgeFloor", () => {
  const member = () => { const got: string[] = []; return { got, m: { nudged: (s: string) => { got.push(`nudged:${s}`); }, free: () => { got.push("free"); } } }; };

  it("test_nudge_floor_one_holder_at_a_time", () => {
    const f = new NudgeFloor();
    expect(f.claim("a")).toBe(true);
    expect(f.claim("a")).toBe(true);
    expect(f.claim("b")).toBe(false);
    expect(f.heldBy).toBe("a");
  });

  it("test_nudge_floor_release_frees_it_and_tells_the_others_only", () => {
    const f = new NudgeFloor();
    const a = member(); const b = member();
    f.join("a", a.m); f.join("b", b.m);
    f.claim("a");
    f.release("b"); // not the holder: nothing
    expect(f.heldBy).toBe("a");
    f.release("a");
    expect(f.heldBy).toBeNull();
    expect(a.got).toEqual([]);
    expect(b.got).toEqual(["free"]);
    expect(f.claim("b")).toBe(true);
  });

  it("test_nudge_floor_spoke_tells_every_other_member_the_scene", () => {
    const f = new NudgeFloor();
    const a = member(); const b = member(); const c = member();
    f.join("a", a.m); f.join("b", b.m); f.join("c", c.m);
    f.claim("a");
    f.spoke("a", "s1");
    expect(f.heldBy).toBeNull();
    expect(a.got).toEqual([]);
    expect(b.got).toEqual(["nudged:s1"]);
    expect(c.got).toEqual(["nudged:s1"]);
  });

  it("test_nudge_floor_leave_frees_a_held_floor_and_a_throwing_member_does_not_stop_the_others", () => {
    const f = new NudgeFloor();
    const c = member();
    const leaveA = f.join("a", { nudged: () => undefined, free: () => undefined });
    f.join("b", { nudged: () => { throw new Error("boom"); }, free: () => { throw new Error("boom"); } });
    f.join("c", c.m);
    f.claim("a");
    leaveA();
    expect(f.heldBy).toBeNull();
    expect(c.got).toEqual(["free"]);
    f.claim("c");
    f.spoke("c", "s2");
    expect(c.got).toEqual(["free"]);
  });
});
