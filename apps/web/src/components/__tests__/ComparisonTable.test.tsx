// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ComparisonTable } from "../ComparisonTable";

afterEach(cleanup);

describe("ComparisonTable", () => {
  it("is a real table with a caption and scoped headers", () => {
    render(<ComparisonTable rows={[{ criterion: "Listening", evaluator: "Proficient", yours: "Developing", note: "n" }]} />);
    expect(screen.getByRole("table")).toBeTruthy();
    for (const h of ["Criterion", "Evaluator's level", "Your rating", "Your note"]) expect(screen.getByRole("columnheader", { name: h }).getAttribute("scope")).toBe("col");
    expect(document.querySelector("caption")).toBeTruthy();
  });
  it("table cells are text, not HTML (an <img onerror> note renders as text)", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const { container } = render(<ComparisonTable rows={[{ criterion: evil, evaluator: "E", yours: "Y", note: evil }]} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText(evil)).toHaveLength(2);
  });
  it("renders nothing for no rows", () => {
    const { container } = render(<ComparisonTable rows={[]} />);
    expect(container.querySelector("table")).toBeNull();
  });
});
