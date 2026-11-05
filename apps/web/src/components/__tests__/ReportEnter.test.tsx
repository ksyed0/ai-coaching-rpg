// @vitest-environment jsdom
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
    render(<ReportEnter fetch={fetchFn as unknown as typeof fetch} navigate={navigate} />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
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

  it("StrictMode's double mount posts once", async () => {
    const ReportEnter = await load();
    const fetchFn = vi.fn(async () => envelope(200));
    const navigate = vi.fn();
    render(<StrictMode><ReportEnter fetch={fetchFn as unknown as typeof fetch} navigate={navigate} /></StrictMode>);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ token: TOKEN });
  });

  it("a missing or empty fragment is refused without any request", async () => {
    for (const hash of ["", "#"]) {
      vi.resetModules();
      window.history.replaceState(null, "", `/report/enter${hash}`);
      const ReportEnter = await load();
      const fetchFn = vi.fn();
      const r = render(<ReportEnter fetch={fetchFn as unknown as typeof fetch} navigate={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("This link no longer works. Ask your facilitator for a new one."));
      expect(fetchFn).not.toHaveBeenCalled();
      r.unmount();
    }
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
