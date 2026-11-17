import { describe, expect, it } from "vitest";
import { hideResponse, parseReportSubject, reportFailureText } from "../console-api";
import { REPORT_REFUSALS } from "../messages";
import { fakeFetch, ok, refused } from "./fakes";

const SID = "abcd1234efgh5678";
const VIEW = {
  id: "alice", state: "draft",
  criteria: [{ id: "clarity", name: "Clarity", current: 3, status: "needs_review", rationale: "r", evidence: [{ quote: "q" }], flags: [] }],
  summary: { strengths: [], developments: [], actions: [] }, comments: [], versions: [],
};
const VISIBLE = { seq: 2, role: "alice", text: "hello", dispute: false };
const HIDDEN = { seq: 3, role: "alice", dispute: false, hidden: { reason: "phone", by: "priya-console", at: 1_900_000_000_000 } };
const parse = (responses: unknown[]) => parseReportSubject({ ...VIEW, responses });

describe("parseReportSubject, hidden responses", () => {
  it("accepts a hidden response without text and keeps its marker; a visible one keeps its text", () => {
    const v = parse([VISIBLE, HIDDEN]);
    expect(v?.responses).toEqual([VISIBLE, HIDDEN]);
    expect(v?.responses[1]).not.toHaveProperty("text");
  });

  it.each([
    ["a hidden response that carries text", { ...HIDDEN, text: "secret" }],
    ["a visible response without text", { seq: 2, role: "alice", dispute: false }],
    ["a hidden marker without a reason", { ...HIDDEN, hidden: { by: "p", at: 1 } }],
    ["a hidden marker without a by", { ...HIDDEN, hidden: { reason: "r", at: 1 } }],
    ["a hidden marker with a non-number at", { ...HIDDEN, hidden: { reason: "r", by: "p", at: "1" } }],
    ["a hidden marker that is not an object", { ...HIDDEN, hidden: true }],
  ])("rejects the whole view on %s", (_n, r) => {
    expect(parse([r])).toBeNull();
  });
});

describe("hideResponse", () => {
  it("posts seq, reason and by to the hide route", async () => {
    const f = fakeFetch(() => ({ status: 200, body: ok({}) }));
    const r = await hideResponse(SID, { seq: 4, reason: "Has a phone number.", by: "kamal" }, f.fetch);
    expect(r.ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(`/api/v1/console/sessions/${SID}/report/hide`);
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(f.calls[0]!.body).toEqual({ seq: 4, reason: "Has a phone number.", by: "kamal" });
  });

  it("returns the fixed refusal sentence for a superseded review", async () => {
    const f = fakeFetch(() => ({ status: 409, body: refused("superseded", "SERVER TEXT") }));
    const r = await hideResponse(SID, { seq: 4, reason: "r", by: "kamal" }, f.fetch);
    if (r.ok) throw new Error("expected a refusal");
    expect(reportFailureText(r)).toBe(REPORT_REFUSALS.superseded);
  });
});
