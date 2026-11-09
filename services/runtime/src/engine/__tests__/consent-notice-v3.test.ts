import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../main.js";
import { MAX_NOTICE_CHARS, loadConsentNotice } from "../consent-notice.js";

// Owner approved the wording 2026-11-08. The first line stays until the release gate (A2 closed, legal and HR sign-off), which removes it
// and adds a SHA-256 pin; changing the notice after that needs v4, never an edit of v3.
describe("consent notice v3 (US-0070, owner-approved wording; draft marker until the release gate)", () => {
  const n = loadConsentNotice(path.join(REPO_ROOT, "consent"), "v3");

  it("loads, within the notice length limit, and is marked as a draft not for use with participants", () => {
    expect(n.version).toBe("v3");
    expect([...n.text].length).toBeLessThanOrEqual(MAX_NOTICE_CHARS);
    expect(n.text.split("\n")[0]).toBe("Draft for legal and HR review; not for use with participants until signed off.");
  });

  it("names the voice choice, the retention, who can hear the audio and how to ask for deletion", () => {
    for (const phrase of ["take part with voice", "take part by text only", "30 days", "only the facilitator", "converted to text", "recorded", "headset", "backups", "deleted"]) {
      expect(n.text, phrase).toContain(phrase);
    }
    expect(n.text).toMatch(/first time the application runs after 30 days/);
    expect(n.text).toMatch(/ask .*delet/i);
  });

  it("keeps what v2 says about AI roles and leaving", () => {
    expect(n.text).toContain("AI player");
    expect(n.text).toMatch(/\/withdraw/);
    expect(n.text).toMatch(/Once it has started, simply close the page/);
  });
});
