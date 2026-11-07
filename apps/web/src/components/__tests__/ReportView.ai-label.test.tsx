// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportView } from "../ReportView";

// AC-0380: the "(AI player)" marker inside a group quote reaches the page, and so the print view (the same DOM, window.print()).
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });

const QUOTE = '- "a phased module costs about three person-weeks" (bob (AI player), line #6, scene 1)';
const SCRIPT_QUOTE = '- "<script>alert(1)</script>" (bob (AI player), line #6, scene 1)';
const released = (group: string) =>
  new Response(JSON.stringify({ success: true, error: null, data: { state: "released", availableUntil: "2027-02-03T10:30:00.000Z", view: { kind: "released", own: {}, group: null, markdown: { own: "Own report", group } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
const show = async (group: string) => {
  const r = render(<ReportView fetch={(async () => released(group)) as unknown as typeof fetch} />);
  await screen.findByRole("heading", { name: "Group report" });
  return r;
};

describe("ReportView with an AI player quote", () => {
  it('ReportView renders "(AI player)" in a quote as text', async () => {
    await show(QUOTE);
    const el = screen.getByText(/\(AI player\)/);
    expect(el.tagName).toBe("PRE");
    expect(el.textContent).toContain("bob (AI player), line #6");
  });

  it("the quote is not inside a .no-print element", async () => {
    const { container } = await show(QUOTE);
    const el = screen.getByText(/\(AI player\)/);
    expect(el.closest(".no-print")).toBeNull();
    const hidden = [...container.querySelectorAll(".no-print")];
    expect(hidden.length).toBeGreaterThan(0); // the Print button and the forms are hidden from print
    expect(hidden.some((h) => h.textContent?.includes("(AI player)"))).toBe(false);
  });

  it("a <script> variant of the same quote renders as literal text and creates no element", async () => {
    const { container } = await show(SCRIPT_QUOTE);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(SCRIPT_QUOTE).textContent).toContain("(AI player)");
  });
});
