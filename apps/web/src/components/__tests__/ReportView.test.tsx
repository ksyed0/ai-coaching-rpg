// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportView } from "../ReportView";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const UNTIL = "2027-02-03T10:30:00.000Z";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const released = (own: string, group: string | null = "Group text") =>
  json(200, { success: true, error: null, data: { state: "released", availableUntil: UNTIL, view: { kind: "released", own: {}, group: null, markdown: { own, group } } } });
const fail = (status: number, code: string) => json(status, { success: false, data: null, error: { code, message: "m" } });
const view = (r: () => Promise<Response>) => {
  const fetchFn = vi.fn(r);
  render(<ReportView fetch={fetchFn as unknown as typeof fetch} />);
  return fetchFn;
};
const status = () => screen.getByRole("status").textContent;

describe("ReportView", () => {
  it("loads from GET /api/v1/report with no cache and shows a loading state first", async () => {
    let release!: (r: Response) => void;
    const fetchFn = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) => new Promise<Response>((r) => { release = r; }));
    render(<ReportView fetch={fetchFn as unknown as typeof fetch} />);
    expect(status()).toBe("Loading your report…");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("/api/v1/report");
    expect(init!.method).toBe("GET");
    await act(async () => { release(released("Hello")); });
    await screen.findByRole("heading", { name: "Your report" });
  });

  it("shows the report: heading, available-until date, two sections as plain text, a Print button", async () => {
    view(async () => released("Own line one\n\nOwn line two", "Group line"));
    await screen.findByRole("heading", { name: "Your report" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Group report" })).toBeTruthy();
    const expected = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(new Date(UNTIL));
    expect(screen.getByText(`Available until ${expected}`)).toBeTruthy();
    const own = screen.getByText(/Own line one/);
    expect(own.textContent).toBe("Own line one\n\nOwn line two");
    expect(own.tagName).toBe("PRE");
    expect(screen.getByText("Group line")).toBeTruthy();
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    screen.getByRole("button", { name: "Print" }).click();
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("omits the group section when there is no group report", async () => {
    view(async () => released("Own", null));
    await screen.findByRole("heading", { name: "Your report" });
    expect(screen.queryByRole("heading", { name: "Group report" })).toBeNull();
  });

  it("renders markup in a report as text, never as elements", async () => {
    const evil = '<img src=x onerror=alert(1)> and <script>alert(2)</script> **bold**';
    const { container } = render(<ReportView fetch={(async () => released(evil, evil)) as unknown as typeof fetch} />);
    await screen.findByRole("heading", { name: "Your report" });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getAllByText(evil)).toHaveLength(2);
  });

  it("not released, refused, retry and throttled each read their exact copy", async () => {
    const cases: [() => Promise<Response>, string][] = [
      [async () => json(200, { success: true, error: null, data: { state: "not_released", availableUntil: UNTIL } }), "Your report is not available right now. Ask your facilitator."],
      [async () => fail(404, "not_found"), "This link no longer works. Ask your facilitator for a new one."],
      [async () => fail(503, "unavailable"), "We could not load your report. Try again."],
      [() => Promise.reject(new TypeError("net")), "We could not load your report. Try again."],
      [async () => fail(429, "rate_limited"), "Too many requests. Wait a minute and try again."],
    ];
    for (const [r, copy] of cases) {
      const u = render(<ReportView fetch={vi.fn(r) as unknown as typeof fetch} />);
      await waitFor(() => expect(status()).toBe(copy));
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      u.unmount();
    }
  });

  it("throttled offers Try again too", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(fail(429, "rate_limited")).mockResolvedValueOnce(released("Back"));
    render(<ReportView fetch={fetchFn as unknown as typeof fetch} />);
    await waitFor(() => expect(status()).toBe("Too many requests. Wait a minute and try again."));
    await act(async () => { screen.getByRole("button", { name: "Try again" }).click(); });
    await screen.findByRole("heading", { name: "Your report" });
  });

  it("retry offers a button that loads again; refused does nothing else", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(fail(503, "unavailable")).mockResolvedValueOnce(released("Back"));
    render(<ReportView fetch={fetchFn as unknown as typeof fetch} />);
    await waitFor(() => expect(status()).toContain("could not load"));
    await act(async () => { screen.getByRole("button", { name: "Try again" }).click(); });
    await screen.findByRole("heading", { name: "Your report" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("moves focus to the heading when the state changes", async () => {
    view(async () => released("x"));
    await screen.findByRole("heading", { name: "Your report" });
    expect(document.activeElement).toBe(screen.getAllByRole("heading", { level: 1 })[0]);
  });
});

describe("print rules", () => {
  const css = readFileSync(join(__dirname, "..", "..", "lib", "app.css"), "utf8");
  it("pre.report-text keeps line breaks and wraps long unbroken text", () => {
    const rule = /pre\.report-text\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/white-space:\s*pre-wrap/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
  });
  it("an @media print rule hides the header, the Print button and removes backgrounds", () => {
    const block = /@media print\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/\.apphdr[^{]*\.no-print[^{]*\{\s*display:\s*none\s*!important;?\s*\}|\.no-print[^{]*\.apphdr[^{]*\{\s*display:\s*none/);
    expect(block).toMatch(/background:\s*none\s*!important/);
  });
});
