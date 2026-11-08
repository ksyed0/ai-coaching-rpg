import { describe, expect, it } from "vitest";
import { inReview, overview } from "../../components/console/report/__tests__/fixtures";
import { parseReportOverview } from "../console-api";

// US-0068 (TC-0159, TC-0161): the browser reads the optional aiRoles of the overview. Absent or malformed is an empty list and the
// overview itself still parses: a display-only row must never turn the Report panel into its "unreadable" banner.
describe("test_parseReportOverview_aiRoles", () => {
  it("absent -> an empty list (an older control, or a stage without it)", () => {
    expect(parseReportOverview(overview())?.aiRoles).toEqual([]);
    expect(parseReportOverview(inReview())?.aiRoles).toEqual([]);
  });

  it("present and well made -> kept, in order", () => {
    const v = parseReportOverview({ ...inReview(), aiRoles: ["tech_lead", "ai1"] });
    expect(v?.aiRoles).toEqual(["tech_lead", "ai1"]);
    expect(v?.subjects.map((s) => s.id)).toEqual(["account_manager", "group"]);
    const max = Array.from({ length: 64 }, (_, i) => `r${i}`);
    expect(parseReportOverview({ ...inReview(), aiRoles: max })?.aiRoles).toEqual(max);
  });

  it("malformed -> an empty list and a valid overview, never null", () => {
    const bad: unknown[] = [
      "ai1", { 0: "ai1" }, null, 3, ["ai1", 2], ["../x"], ["Tech Lead"], [""], ["ai1", "ai1"], ["x".repeat(65)],
      Array.from({ length: 65 }, (_, i) => `r${i}`),
    ];
    for (const aiRoles of bad) {
      const v = parseReportOverview({ ...inReview(), aiRoles });
      expect(v, JSON.stringify(aiRoles).slice(0, 40)).not.toBeNull();
      expect(v?.aiRoles).toEqual([]);
      expect(v?.stage).toBe("in_review");
    }
  });
});
