// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ResponsesList, parseResponses } from "../ResponsesList";

afterEach(cleanup);

describe("ResponsesList", () => {
  it('responses list shows criterion, dispute marker, outcome and reason once resolved, and "n of 50 used"', () => {
    const items = parseResponses([
      { criterion: "c1", text: "I disagree here", dispute: true, resolution: { outcome: "amended", reason: "You were right" } },
      { text: "General remark", dispute: false },
      { criterion: "c1", text: "<img src=x onerror=alert(1)>", dispute: true, resolution: { outcome: "upheld", reason: "Evidence stands" } },
      { text: "Another", dispute: true, resolution: { outcome: "declined", reason: "Out of scope" } },
    ], [{ id: "c1", name: "Listening" }]);
    const { container } = render(<ResponsesList items={items} />);
    expect(screen.getByText("4 of 50 used")).toBeTruthy();
    expect(screen.getAllByText("Listening").length).toBe(2);
    expect(screen.getAllByText("Whole report")).toHaveLength(2);
    expect(screen.getAllByText("Disagreement")).toHaveLength(3);
    expect(screen.getByText(/Outcome: amended/)).toBeTruthy();
    expect(screen.getByText(/Outcome: upheld/)).toBeTruthy();
    expect(screen.getByText(/Outcome: declined/)).toBeTruthy();
    expect(screen.getByText(/You were right/)).toBeTruthy();
    expect(screen.getByText("General remark")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText(/Outcome:/)).toHaveLength(3);
  });
  it("the response text carries the class whose rule keeps line breaks and wraps long words", () => {
    const { container } = render(<ResponsesList items={parseResponses([{ text: "line one\nline two", dispute: false }], [])} />);
    const el = screen.getByText(/line one/);
    expect(el.classList.contains("report-text")).toBe(true);
    expect(el.textContent).toBe("line one\nline two");
    const css = readFileSync(join(__dirname, "../../lib/app.css"), "utf8");
    expect(css).toMatch(/(^|\n)\.report-text\s*\{[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/table\.compare td[^{]*\{[^}]*white-space:\s*pre-wrap/);
    expect(container).toBeTruthy();
  });
  it("says so when there are none", () => {
    render(<ResponsesList items={[]} />);
    expect(screen.getByText("0 of 50 used")).toBeTruthy();
  });
  it("parseResponses drops malformed entries", () => {
    expect(parseResponses("x", [])).toEqual([]);
    expect(parseResponses([null, { text: 3 }, { text: "ok", dispute: false }], [])).toHaveLength(1);
  });
});
