import { describe, expect, it } from "vitest";
import { parseReportLinks } from "../console-api";

const view = (role: Record<string, unknown>) => ({ state: "ready", roles: [{ role: "ana", credential: null, ...role }] });

describe("parseReportLinks ai flag", () => {
  it("reads ai: true", () => {
    expect(parseReportLinks(view({ ai: true }))?.roles[0]?.ai).toBe(true);
  });

  it('treats a missing or "yes" ai as false', () => {
    expect(parseReportLinks(view({}))?.roles[0]?.ai).toBe(false);
    expect(parseReportLinks(view({ ai: "yes" }))?.roles[0]?.ai).toBe(false);
    expect(parseReportLinks(view({ ai: 1 }))?.roles[0]?.ai).toBe(false);
  });
});
