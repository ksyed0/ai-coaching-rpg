// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponseForm } from "../ResponseForm";

afterEach(cleanup);

const CRIT = [{ id: "c1", name: "Listening" }, { id: "c2", name: "Framing" }];
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const okBody = { success: true, error: null, data: { state: "released", view: { markdown: { own: "x", group: null } } } };
const failure = (status: number, state?: string, headers?: Record<string, string>) =>
  json(status, { success: false, data: state ? { state } : null, error: { code: "x", message: "RAW SERVER TEXT" } }, headers);

function setup(opts: { fetch?: () => Promise<Response>; used?: number } = {}) {
  const fetchFn = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) => (opts.fetch ?? (async () => json(200, okBody)))());
  const onSent = vi.fn();
  const onRefused = vi.fn();
  render(<ResponseForm criteria={CRIT} used={opts.used ?? 0} fetch={fetchFn as unknown as typeof fetch} onSent={onSent} onRefused={onRefused} />);
  return { fetchFn, onSent, onRefused };
}
const type = (t: string) => fireEvent.change(screen.getByLabelText(/Your response/), { target: { value: t } });
const send = async () => { await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Send/ })); }); };
const sent = (f: ReturnType<typeof vi.fn>) => JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body));

describe("ResponseForm", () => {
  it("the response form defaults to The whole report, counts to 1,500, sends once (button disabled), keeps text on failure", async () => {
    let release!: (r: Response) => void;
    const { fetchFn, onSent } = setup({ fetch: () => new Promise<Response>((r) => { release = r; }) });
    const sel = screen.getByLabelText("About") as HTMLSelectElement;
    expect(sel.selectedOptions[0]!.textContent).toBe("The whole report");
    expect(screen.getByText("0 / 1,500")).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    type("a".repeat(2000));
    expect((screen.getByLabelText(/Your response/) as HTMLTextAreaElement).value.length).toBe(1500);
    expect(screen.getByText("1,500 / 1,500")).toBeTruthy();
    type("Hello");
    fireEvent.change(sel, { target: { value: "c2" } });
    fireEvent.click(screen.getByLabelText("I disagree with this"));
    await send();
    await send();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const b = screen.getByRole("button", { name: "Sending…" });
    expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("/api/v1/report/responses");
    expect((init as RequestInit).method).toBe("POST");
    expect(sent(fetchFn)).toEqual({ criterion: "c2", text: "Hello", dispute: true });
    await act(async () => { release(failure(503, "busy")); });
    expect(screen.getByRole("alert").textContent).toContain("Busy, try again");
    expect(screen.getByRole("alert").textContent).not.toContain("RAW");
    expect((screen.getByLabelText(/Your response/) as HTMLTextAreaElement).value).toBe("Hello");
    expect(onSent).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
  });

  it("omits criterion for the whole report and clears the fields on success", async () => {
    const { fetchFn, onSent } = setup();
    type("Remark");
    await send();
    expect(sent(fetchFn)).toEqual({ text: "Remark", dispute: false });
    expect(onSent).toHaveBeenCalledWith(okBody.data);
    expect((screen.getByLabelText(/Your response/) as HTMLTextAreaElement).value).toBe("");
  });

  it("a duplicate-looking resend still shows success", async () => {
    const { onSent } = setup();
    for (let i = 0; i < 2; i++) { type("Same words"); await send(); }
    expect(onSent).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a saved-but-retry answer says to reload and clears the fields", async () => {
    const { onSent } = setup({ fetch: async () => json(200, { success: true, error: null, data: { saved: true, state: "retry" } }) });
    type("Remark");
    await send();
    expect(screen.getByRole("status").textContent).toBe("Sent. Reload to see it.");
    expect(onSent).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/Your response/) as HTMLTextAreaElement).value).toBe("");
  });

  it("each failure shows its fixed sentence and keeps the text", async () => {
    const cases: [Response, string][] = [
      [failure(409, "too_many"), "You have used all 50 responses."],
      [failure(409, "not_released"), "Responses are closed for this report."],
      [failure(409, "withdrawn"), "Responses are closed for this report."],
      [failure(409, "closed"), "Responses are closed for this report."],
      [failure(409, "old_schema"), "This review was opened before online ratings were available. Your facilitator can take your rating or response in the terminal."],
      [failure(413, "too_large"), "That is too large to send. Shorten what you wrote and try again."],
      [failure(429, undefined, { "Retry-After": "7" }), "Too many sends. Wait 7 seconds and try again."],
      [failure(429), "Too many sends. Wait a minute and try again."],
      [failure(400, "invalid"), "Check what you wrote and try again."],
      [failure(503, "unavailable"), "We could not send your response. Try again."],
    ];
    for (const [res, copy] of cases) {
      cleanup();
      setup({ fetch: async () => res.clone() });
      type("Keep me");
      await send();
      expect(screen.getByRole("alert").textContent).toContain(copy);
      expect((screen.getByLabelText(/Your response/) as HTMLTextAreaElement).value).toBe("Keep me");
    }
  });

  it("a refused link (404) calls onRefused", async () => {
    const { onRefused } = setup({ fetch: async () => failure(404) });
    type("x");
    await send();
    expect(onRefused).toHaveBeenCalled();
  });

  it("is disabled when 50 are used", () => {
    setup({ used: 50 });
    type("x");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("You have used all 50 responses.")).toBeTruthy();
  });
});
