import { describe, expect, it } from "vitest";
import { editSummary, reportFailureText } from "../console-api";
import { REPORT_REFUSALS } from "../messages";
import { fakeFetch, ok, refused } from "./fakes";

const SID = "abcd1234efgh5678";
const URL_ = `/api/v1/console/sessions/${SID}/report/subjects/account_manager/edit-summary`;
const input = {
  reason: "Tightened the wording.",
  strengths: ["Clear plan"],
  developments: ["Ask about budget"],
  actions: [{ lo: "LO-1", text: "Do the thing: now" }],
  by: "kamal",
};

describe("editSummary", () => {
  it("editSummary posts strengths, developments, actions as {lo, text} and the reason", async () => {
    const f = fakeFetch(() => ({ status: 200, body: ok({}) }));
    const r = await editSummary(SID, "account_manager", input, f.fetch);
    expect(r.ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(URL_);
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(f.calls[0]!.body).toEqual(input);
  });

  it("returns the parsed refusal sentence on a 4xx", async () => {
    const f = fakeFetch(() => ({ status: 400, body: refused("invalid", "SERVER TEXT about LO-9") }));
    const r = await editSummary(SID, "account_manager", input, f.fetch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(reportFailureText(r)).toBe(REPORT_REFUSALS.invalid);
    const big = await editSummary(SID, "account_manager", input, fakeFetch(() => ({ status: 413, body: refused("payload_too_large", "x") })).fetch);
    if (big.ok) throw new Error("expected a refusal");
    expect(reportFailureText(big)).toBe(REPORT_REFUSALS.payload_too_large);
  });
});
