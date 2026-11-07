// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// BUG-0028 part 4: Try again must not set state after the page has gone. React 19 neither warns nor throws for that, so the test counts
// the calls to the component's state setters made after unmount.
const calls = vi.hoisted(() => ({ afterUnmount: 0, unmounted: false }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: ((init: unknown) => {
      const [value, set] = actual.useState(init);
      const wrapped = actual.useRef<((next: unknown) => void) | null>(null); // one wrapper per hook call, so the setter keeps its identity
      wrapped.current ??= (next: unknown) => { if (calls.unmounted) calls.afterUnmount += 1; (set as (n: unknown) => void)(next); };
      return [value, wrapped.current];
    }) as typeof actual.useState,
  };
});
import { ReportView } from "../ReportView";

afterEach(() => { cleanup(); vi.restoreAllMocks(); calls.afterUnmount = 0; calls.unmounted = false; });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ReportView unmount", () => {
  it("an answer to Try again that arrives after unmount sets no state", async () => {
    let release!: (r: Response) => void;
    let n = 0;
    const fetchFn = vi.fn(() => (n++ === 0 ? Promise.resolve(json(500, { success: false, data: null, error: { code: "x", message: "m" } })) : new Promise<Response>((r) => { release = r; })));
    const { unmount } = render(<ReportView fetch={fetchFn as unknown as typeof fetch} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(fetchFn).toHaveBeenCalledTimes(2); // the retry is pending
    unmount();
    calls.unmounted = true;
    await act(async () => { release(json(200, { success: true, error: null, data: { state: "not_released" } })); });
    expect(calls.afterUnmount).toBe(0);
  });
});
