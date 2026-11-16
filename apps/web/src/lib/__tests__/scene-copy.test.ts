import { describe, expect, it } from "vitest";
import { endsWhenText, exitWhy, SCENE_COPY } from "../scene-copy";

// US-0080: the plain words a player reads about what ends a scene and why it ended.
const scene = (o: { endsWhen?: string; timeBoxMinutes?: number } = {}) => ({ id: "s1", title: "Team huddle", goal: "Agree a position", timeBoxMinutes: 10, ...o });

describe("endsWhenText", () => {
  it("test_endsWhenText_with_a_rule_names_the_rule_the_time_box_and_the_facilitator", () => {
    expect(endsWhenText(scene({ endsWhen: "the team agrees one position" }))).toBe("the team agrees one position, at 10 min, or when your facilitator moves on");
  });
  it("test_endsWhenText_without_a_rule_shows_only_the_time_box_and_the_facilitator", () => {
    expect(endsWhenText(scene())).toBe("at 10 min, or when your facilitator moves on");
    expect(endsWhenText(scene({ endsWhen: "   " }))).toBe("at 10 min, or when your facilitator moves on");
  });
  it("test_endsWhenText_a_fractional_time_box_is_shown_to_one_decimal", () => {
    expect(endsWhenText(scene({ timeBoxMinutes: 2.5 }))).toBe("at 2.5 min, or when your facilitator moves on");
    expect(endsWhenText(scene({ timeBoxMinutes: 1 / 3 }))).toBe("at 0.3 min, or when your facilitator moves on");
  });
  it("test_endsWhenText_a_rule_ending_in_a_full_stop_loses_it_inside_the_sentence", () => {
    expect(endsWhenText(scene({ endsWhen: "the team agrees." }))).toBe("the team agrees, at 10 min, or when your facilitator moves on");
  });
});

describe("exitWhy", () => {
  it("test_exitWhy_gm_detects_quotes_the_rule", () => {
    expect(exitWhy("gm_detects", scene({ endsWhen: "the team agrees one position" }))).toBe("The Game Master judged this scene's goal was met: the team agrees one position.");
    expect(exitWhy("gm_detects", scene())).toBe("The Game Master judged this scene's goal was met.");
    expect(exitWhy("gm_detects", undefined)).toBe("The Game Master judged this scene's goal was met.");
  });
  it("test_exitWhy_time_box_elapsed_names_the_minutes", () => {
    expect(exitWhy("time_box_elapsed", scene({ timeBoxMinutes: 15 }))).toBe("Time ran out (15 min).");
    expect(exitWhy("time_box_elapsed", undefined)).toBe("Time ran out.");
  });
  it("test_exitWhy_facilitator_advance_and_an_unknown_reason", () => {
    expect(exitWhy("facilitator_advance", scene())).toBe("Your facilitator moved the session on.");
    expect(exitWhy("something_new", scene())).toBe(SCENE_COPY.otherReason);
    expect(SCENE_COPY.complete).toBe("All scenes are done. The facilitator can now run the evaluation.");
  });
});
