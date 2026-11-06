// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ReportEnter keeps the fragment token in a module-level variable, so every test loads a fresh copy of the module.
const TOKEN = "AbCdEfGh.0123456789abcdefghij";
const envelope = (status: number, code = "x") =>
  new Response(JSON.stringify(status === 200 ? { success: true, data: {}, error: null } : { success: false, data: null, error: { code, message: "m" } }), {
    status, headers: { "Content-Type": "application/json" },
  });
const load = async () => (await import("../ReportEnter")).ReportEnter;

beforeEach(() => { vi.resetModules(); window.history.replaceState(null, "", `/report/enter#${TOKEN}`); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ReportEnter", () => {
  it("removes the fragment from the address bar before the POST resolves, and posts only the token", async () => {
    const ReportEnter = await load();
    let release!: (r: Response) => void;
    const fetchFn = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) => new Promise<Response>((r) => { release = r; }));
    const navigate = vi.fn();
    const replace = vi.spyOn(window.history, "replaceState");
    render(<ReportEnter fetch={fetchFn as unknown as typeof fetch} navigate={navigate} />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    // The address bar is cleaned before the request is made, not merely before it resolves.
    expect(replace).toHaveBeenCalledWith(null, "", "/report/enter");
    expect(replace.mock.invocationCallOrder[0]).toBeLessThan(fetchFn.mock.invocationCallOrder[0]!);
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/report/enter");
    expect(screen.getByRole("status").textContent).toBe("Opening your report…");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("/api/v1/report/enter");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ token: TOKEN });
    expect((init!.headers as Record<string, string>)["X-Requested-With"]).toBe("scenecoach");
    expect(String(url)).not.toContain(TOKEN);
    await act(async () => { release(envelope(200)); });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/report"));
  });

  it("drops the token and the finished request before it navigates", async () => {
    const ReportEnter = await load();
    const fetchFn = vi.fn(async () => envelope(200));
    const seen: { fetches: number }[] = [];
    const navigate = vi.fn(() => { seen.push({ fetches: fetchFn.mock.calls.length }); });
    const first = render(<ReportEnter fetch={fetchFn as unknown as typeof fetch} navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/report"));
    first.unmount();
    // The same module, mounted again with no fragment: the used token is gone, so nothing is posted and the link reads as dead.
    render(<ReportEnter fetch={fetchFn as unknown as typeof fetch} navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
    expect(fetchFn).toHaveBeenCalledTimes(1); // the used token was not posted again
  });

  it("a new fragment on the same document is a new attempt: the address bar is cleaned and the new token is posted", async () => {
    const ReportEnter = await load();
    const NEXT = "ZyXwVuTs.9876543210zyxwvutsrq";
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(envelope(404, "not_found"))
      .mockResolvedValueOnce(envelope(200));
    const navigate = vi.fn();
    render(<ReportEnter fetch={fetchFn as unknown as typeof fetch} navigate={navigate} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("no longer works"));
    expect(JSON.parse(fetchFn.mock.calls[0]![1].body as string)).toEqual({ token: TOKEN });
    // The user opens another link in the same tab: only the fragment changes, the page does not reload.
    await act(async () => {
      window.history.pushState(null, "", `/report/enter#${NEXT}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/report"));
    expect(JSON.parse(fetchFn.mock.calls[1]![1].body as string)).toEqual({ token: NEXT });
    expect(window.location.hash).toBe("");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("an empty fragment change is ignored", async () => {
    const ReportEnter = await load();
    const fetchFn = vi.fn(async () => envelope(404, "not_found"));
    render(<ReportEnter fetch={fetchFn as unknown as typeof fetch} navigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("no longer works"));
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("no longer works");
  });

  it("StrictMode's double mount posts once", async () => {
    const ReportEnter = await load();
    const fetchFn = vi.fn(async () => envelope(200));
    const navigate = vi.fn();
    render(<StrictMode><ReportEnter fetch={fetchFn as unknown as typeof fetch} navigate={navigate} /></StrictMode>);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ token: TOKEN });
  });

  it("a missing or empty fragment goes to /report with no request (an existing cookie decides there)", async () => {
    for (const hash of ["", "#"]) {
      vi.resetModules();
      window.history.replaceState(null, "", `/report/enter${hash}`);
      const ReportEnter = await load();
      const fetchFn = vi.fn();
      const navigate = vi.fn();
      const r = render(<ReportEnter fetch={fetchFn as unknown as typeof fetch} navigate={navigate} />);
      await waitFor(() => expect(navigate).toHaveBeenCalledWith("/report"));
      expect(fetchFn).not.toHaveBeenCalled();
      expect(screen.queryByText("This link no longer works. Ask your facilitator for a new one.")).toBeNull();
      r.unmount();
    }
  });

  it("leaves with location.replace, so /report/enter does not stay in the history", async () => {
    const { replaceWith } = await import("../ReportEnter");
    const loc = { replace: vi.fn(), assign: vi.fn() };
    replaceWith("/report", loc as unknown as Location);
    expect(loc.replace).toHaveBeenCalledWith("/report");
    expect(loc.assign).not.toHaveBeenCalled();
  });

  it("renders no status copy until it has mounted (the server HTML shows only the no-script sentence)", async () => {
    const ReportEnter = await load();
    const html = renderToStaticMarkup(<ReportEnter />);
    expect(html).not.toContain("Opening your report");
    expect(html).toContain("This link needs JavaScript to open");
  });

  it("a refused link (404) reads the refused copy and does not navigate", async () => {
    const ReportEnter = await load();
    const navigate = vi.fn();
    render(<ReportEnter fetch={(async () => envelope(404, "not_found")) as unknown as typeof fetch} navigate={navigate} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("This link no longer works. Ask your facilitator for a new one."));
    expect(navigate).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("429 reads the throttled copy and Try again re-posts the stored token", async () => {
    const ReportEnter = await load();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(envelope(429, "rate_limited"))
      .mockResolvedValueOnce(envelope(200));
    const navigate = vi.fn();
    render(<ReportEnter fetch={fetchFn as unknown as typeof fetch} navigate={navigate} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Too many attempts. Wait a minute and try again."));
    await act(async () => { screen.getByRole("button", { name: "Try again" }).click(); });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/report"));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchFn.mock.calls[1]![1].body as string)).toEqual({ token: TOKEN });
  });

  it("503 and a network failure read the retry copy with a button", async () => {
    for (const first of [() => Promise.resolve(envelope(503, "unavailable")), () => Promise.reject(new TypeError("net"))]) {
      vi.resetModules();
      window.history.replaceState(null, "", `/report/enter#${TOKEN}`);
      const ReportEnter = await load();
      const r = render(<ReportEnter fetch={vi.fn(first) as unknown as typeof fetch} navigate={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("We could not open the report. Try again."));
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
      r.unmount();
    }
  });

  it("has one h1, moves focus to it on a state change and carries the no-script sentence", async () => {
    const ReportEnter = await load();
    render(<ReportEnter fetch={(async () => envelope(404)) as unknown as typeof fetch} navigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("no longer works"));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
    // React does not mount <noscript> children on the client; the server-rendered HTML carries them.
    expect(renderToStaticMarkup(<ReportEnter />)).toContain(
      "<noscript><p class=\"banner warn\">This link needs JavaScript to open. Turn it on for this site, or ask your facilitator for help.</p></noscript>",
    );
  });
});

describe("report text styling", () => {
  it("keeps line breaks and wraps long unbroken text instead of scrolling sideways", () => {
    const css = readFileSync(join(__dirname, "..", "..", "lib", "app.css"), "utf8");
    const rule = /pre\.report-text\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/white-space:\s*pre-wrap/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("entering a link clears the draft (Review Focus 4)", async () => {
    sessionStorage.setItem("scenecoach-report-draft", JSON.stringify({ ratings: { c1: { level: 2, note: "old link" } } }));
    const ReportEnter = await load();
    const navigate = vi.fn();
    render(<ReportEnter fetch={vi.fn(async () => envelope(200)) as unknown as typeof fetch} navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/report"));
    expect(sessionStorage.getItem("scenecoach-report-draft")).toBeNull();
  });

  it("a refused link leaves a draft alone", async () => {
    sessionStorage.setItem("scenecoach-report-draft", JSON.stringify({ ratings: {} }));
    const ReportEnter = await load();
    render(<ReportEnter fetch={vi.fn(async () => envelope(404, "not_found")) as unknown as typeof fetch} navigate={vi.fn()} />);
    await screen.findByText("This link no longer works. Ask your facilitator for a new one.");
    expect(sessionStorage.getItem("scenecoach-report-draft")).not.toBeNull();
  });
});
