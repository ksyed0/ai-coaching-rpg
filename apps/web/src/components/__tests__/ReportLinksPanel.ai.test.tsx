// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReportLinksPanel } from "../console/ReportLinksPanel";
import { fakeFetch, ok, refused } from "../../lib/__tests__/fakes";

afterEach(cleanup);

const SID = "abcd1234efgh5678";
const BASE = `/api/v1/console/sessions/${SID}/report-links`;
const cred = { role: "x", createdAt: 1_700_000_000_000, expiresAt: 4_000_000_000_000, active: true };

function mount(roles: unknown[]) {
  const f = fakeFetch((url) => (url === BASE ? { status: 200, body: ok({ state: "ready", roles }) } : { status: 404, body: refused("not_found", "x") }));
  return render(<ReportLinksPanel sessionId={SID} fetch={f.fetch} />);
}

describe("ReportLinksPanel AI roles", () => {
  it('shows "AI player" for an ai role and offers no "Issue link" or reissue button, only revoke', async () => {
    mount([{ role: "delivery_lead", credential: cred, ai: true }]);
    expect(await screen.findByText("AI player")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Issue link/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reissue link/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Revoke link for Delivery lead" })).toBeTruthy();
  });

  it("an ai role with no live link offers no button at all", async () => {
    mount([{ role: "delivery_lead", credential: null, ai: true }]);
    expect(await screen.findByText("AI player")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /link for Delivery lead/ })).toBeNull();
  });

  it("a human role row is unchanged", async () => {
    mount([
      { role: "delivery_lead", credential: null },
      { role: "account_manager", credential: cred },
      { role: "sales_lead", credential: null, ai: "yes" },
    ]);
    await screen.findByText("Link active until", { exact: false });
    expect(screen.queryByText("AI player")).toBeNull();
    expect(screen.getByRole("button", { name: "Issue link for Delivery lead" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reissue link for Account manager" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke link for Account manager" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Issue link for Sales lead" })).toBeTruthy();
  });
});
