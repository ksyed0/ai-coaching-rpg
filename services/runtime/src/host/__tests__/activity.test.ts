import { describe, expect, it } from "vitest";
import { ACTIVITY_MAX_MS, ActivityBoard, activityForPlayer, type ActivityFrame } from "../activity.js";

// US-0082 (AC-0480, AC-0482): the in-memory activity board.

describe("ActivityBoard", () => {
  it("test_activity_begin_and_end_emit_once_each", () => {
    let t = 0;
    const b = new ActivityBoard(() => t);
    const seen: ActivityFrame[] = [];
    b.onChange((f) => seen.push(f));
    b.begin("npc");
    b.begin("npc"); // repeat: no second frame
    expect(b.isThinking("npc")).toBe(true);
    b.end("npc", "timed_out");
    b.end("npc"); // not thinking: no frame
    expect(seen).toEqual([{ type: "activity", roleId: "npc", state: "thinking" }, { type: "activity", roleId: "npc", state: "idle", outcome: "timed_out" }]);
    t = 1;
  });
  it("test_activity_clear_ends_everyone_and_current_drops_stale", () => {
    let t = 0;
    const b = new ActivityBoard(() => t);
    const seen: ActivityFrame[] = [];
    b.onChange((f) => seen.push(f));
    b.begin("a"); t = 10; b.begin("b");
    t = ACTIVITY_MAX_MS + 5;
    expect(b.current()).toEqual(["b"]); // a is stale (older than the expiry), b is not
    b.clear();
    expect(b.current()).toEqual([]);
    expect(seen.filter((f) => f.state === "idle").map((f) => f.roleId).sort()).toEqual(["a", "b"]);
  });
  it("test_activity_a_throwing_listener_does_not_break_others", () => {
    const b = new ActivityBoard(() => 0);
    const seen: string[] = [];
    b.onChange(() => { throw new Error("x"); });
    const off = b.onChange((f) => seen.push(f.state));
    b.begin("a"); off(); b.end("a");
    expect(seen).toEqual(["thinking"]);
  });
  it("test_activity_player_copy_never_carries_the_outcome", () => {
    const f = { type: "activity", roleId: "a", state: "idle", outcome: "failed", extra: "x" } as unknown as ActivityFrame;
    expect(activityForPlayer(f)).toEqual({ type: "activity", roleId: "a", state: "idle" });
  });
});
