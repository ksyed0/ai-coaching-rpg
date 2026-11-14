import { describe, expect, it } from "vitest";
import { pickNudgeTarget, roleTitle } from "../nudge.js";

// US-0081 (AC-0470, TC-0250): a nudge addresses the human seat that has spoken least in the current scene.
describe("pickNudgeTarget", () => {
  const order = ["delivery_lead", "tech_lead", "account_manager"];

  it("test_nudge_target_is_the_human_seat_that_spoke_least_in_the_scene", () => {
    expect(pickNudgeTarget({ candidates: ["delivery_lead", "account_manager"], order, sceneSpeakers: ["delivery_lead", "tech_lead", "delivery_lead", "account_manager"] })).toBe("account_manager");
  });

  it("test_nudge_target_ties_go_to_the_seat_silent_longest", () => {
    // both spoke once; account_manager spoke first, so it has been silent longest
    expect(pickNudgeTarget({ candidates: ["delivery_lead", "account_manager"], order, sceneSpeakers: ["account_manager", "tech_lead", "delivery_lead"] })).toBe("account_manager");
  });

  it("test_nudge_target_ties_of_never_spoken_seats_go_to_scenario_role_order", () => {
    expect(pickNudgeTarget({ candidates: ["account_manager", "delivery_lead"], order, sceneSpeakers: ["tech_lead"] })).toBe("delivery_lead");
  });

  it("test_nudge_target_is_null_without_a_human_seat", () => {
    expect(pickNudgeTarget({ candidates: [], order, sceneSpeakers: ["tech_lead"] })).toBeNull();
  });

  it("test_role_title_reads_a_role_id_as_a_capitalised_title", () => {
    expect(roleTitle("account_manager")).toBe("Account manager");
    expect(roleTitle("tech-lead")).toBe("Tech lead");
  });
});
