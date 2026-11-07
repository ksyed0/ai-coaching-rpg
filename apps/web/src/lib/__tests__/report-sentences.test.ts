import { readFileSync } from "node:fs";
import path from "node:path";
import { REPORT_SENTENCES } from "@acr/events";
import { describe, expect, it } from "vitest";
import { KNOWN_CONFLICTS } from "../../server/report-handlers";
import { REPORT_AI_LINK_REFUSED, REPORT_NOT_READY, REPORT_UNAVAILABLE } from "../console-api";
import { MESSAGES, REPORT_REFUSALS } from "../messages";

// BUG-0027: the control service, the BFF and the console show the same fixed sentences. They are defined once in @acr/events. This test
// fails if a consumer's copy diverges (a different value) or if a consumer declares the words again as a literal.

const WORDS = {
  notReady: "No reports are ready for this session yet. Evaluate it from the Report panel of its console.",
  noReport: "There is no report to link for this role.",
  aiLinkRefused: "AI players do not get report links.",
  linkAlreadyActive: "A link is already active for this role.",
  reportsUnreadable: "The reports for this session cannot be read. Check them with moderate status.",
  reportUnavailable: "The report is unavailable. Try again.",
  linkFull: "This link has reached its limit of 25 responses. Ask your facilitator for a new link to send more.",
} as const;

const root = path.resolve(__dirname, "../../../../..");
const CONSUMERS = [
  "services/control/src/reports.ts",
  "services/control/src/report-access.ts",
  "services/control/src/moderation-routes.ts",
  "services/control/src/api.ts",
  "services/control/src/participant-writes.ts",
  "apps/web/src/server/report-handlers.ts",
  "apps/web/src/lib/console-api.ts",
  "apps/web/src/lib/messages.ts",
];

describe("the report sentences shared by control, the BFF and the console (BUG-0027)", () => {
  it("the shared sentences keep their exact words", () => {
    expect({ ...REPORT_SENTENCES }).toEqual(WORDS);
  });

  it("the BFF passes exactly the four control conflict sentences through, and nothing else", () => {
    expect([...KNOWN_CONFLICTS].sort()).toEqual(
      [REPORT_SENTENCES.notReady, REPORT_SENTENCES.noReport, REPORT_SENTENCES.aiLinkRefused, REPORT_SENTENCES.linkAlreadyActive].sort(),
    );
  });

  it("the console shows the shared sentences", () => {
    expect(REPORT_NOT_READY).toBe(REPORT_SENTENCES.notReady);
    expect(REPORT_AI_LINK_REFUSED).toBe(REPORT_SENTENCES.aiLinkRefused);
    expect(REPORT_UNAVAILABLE).toBe(REPORT_SENTENCES.reportsUnreadable);
    expect(REPORT_REFUSALS.unavailable).toBe(REPORT_SENTENCES.reportUnavailable);
  });

  it("the participant page shows the shared link-full sentence (BUG-0030)", () => {
    expect(MESSAGES.respondLinkFull).toBe(REPORT_SENTENCES.linkFull);
  });

  it("no consumer declares a shared sentence as a literal again", () => {
    for (const file of CONSUMERS) {
      const text = readFileSync(path.join(root, file), "utf8");
      for (const [name, words] of Object.entries(WORDS)) expect(text, `${file} re-declares ${name}`).not.toContain(words);
    }
  });
});
