// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useReadiness } from "../use-readiness";
import { fakeFetch, fakeTimer, ok, readiness, refused } from "./fakes";

afterEach(cleanup);
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

function setup(answer: (n: number) => { status: number; body: unknown }) {
  let n = 0;
  const f = fakeFetch(() => answer(n++));
  const t = fakeTimer();
  const h = renderHook(() =>
    useReadiness("abc12345", { fetch: f.fetch, setTimer: t.setTimer }),
  );
  return { f, t, h };
}

describe("useReadiness", () => {
  it("polling backs off after failures and recovers", async () => {
    const up = { status: 200, body: ok(readiness()) };
    const down = { status: 502, body: refused("launcher_unavailable", "x") };
    const script = [up, down, down, down, up, up];
    const { f, t, h } = setup((n) => script[n]!);
    await flush();
    expect(h.result.current.data?.modelLabel).toBe("mock-model");
    expect(h.result.current.reconnecting).toBe(false);
    for (let i = 0; i < 5; i++) {
      act(() => t.fire());
      await flush();
    }
    // success: 2 s; then failures 2 s, 4 s, 8 s; recovery: back to 2 s
    expect(t.delays).toEqual([2000, 2000, 4000, 8000, 2000, 2000]);
    expect(f.calls).toHaveLength(6);
    expect(h.result.current.reconnecting).toBe(false);
    expect(h.result.current.data).not.toBeNull();
  });

  it("keeps the last good value and shows Reconnecting while failing; caps the wait at 30 s", async () => {
    const script = [{ status: 200, body: ok(readiness()) }];
    const { t, h } = setup((n) => script[n] ?? { status: 0, body: null });
    await flush();
    for (let i = 0; i < 8; i++) {
      act(() => t.fire());
      await flush();
    }
    expect(h.result.current.reconnecting).toBe(true);
    expect(h.result.current.data?.modelLabel).toBe("mock-model");
    expect(Math.max(...t.delays)).toBe(30_000);
    expect(t.delays.slice(0, 6)).toEqual([
      2000, 2000, 4000, 8000, 16000, 30000,
    ]);
  });

  it("schedules the next poll only after the previous one finished", async () => {
    const f = fakeFetch(() => ({ status: 200, body: ok(readiness()) }));
    f.hold();
    const t = fakeTimer();
    renderHook(() =>
      useReadiness("abc12345", { fetch: f.fetch, setTimer: t.setTimer }),
    );
    await flush();
    expect(f.calls).toHaveLength(1);
    expect(t.delays).toEqual([]);
    f.release();
    await flush();
    expect(t.delays).toEqual([2000]);
  });

  it("polling stops when the session ended and when signed out", async () => {
    const ended = setup(() => ({
      status: 200,
      body: ok(readiness({ status: "ended" })),
    }));
    await flush();
    expect(ended.t.delays).toEqual([]);
    expect(ended.f.calls).toHaveLength(1);
    cleanup();
    const gone = setup(() => ({
      status: 200,
      body: ok(readiness({ launcherStatus: "ended", status: null })),
    }));
    await flush();
    expect(gone.t.delays).toEqual([]);
    cleanup();
    const out = setup(() => ({
      status: 401,
      body: refused("unauthorized", "x"),
    }));
    await flush();
    expect(out.h.result.current.signedOut).toBe(true);
    expect(out.t.delays).toEqual([]);
    cleanup();
    const forbidden = setup(() => ({
      status: 403,
      body: refused("forbidden", "x"),
    }));
    await flush();
    expect(forbidden.h.result.current.signedOut).toBe(true);
    expect(forbidden.t.delays).toEqual([]);
  });

  it("cancels the pending timer and ignores a late answer after unmount", async () => {
    const { f, t, h } = setup(() => ({ status: 200, body: ok(readiness()) }));
    await flush();
    expect(t.pending).toBe(1);
    h.unmount();
    expect(t.pending).toBe(0);
    expect(f.calls).toHaveLength(1);
  });

  it("an answer that is not a readiness shape counts as a failure", async () => {
    const { t, h } = setup(() => ({
      status: 200,
      body: ok({ nonsense: true }),
    }));
    await flush();
    expect(h.result.current.reconnecting).toBe(true);
    expect(t.delays).toEqual([2000]);
  });

  it("refresh polls now", async () => {
    const { f, h } = setup(() => ({ status: 200, body: ok(readiness()) }));
    await flush();
    act(() => h.result.current.refresh());
    await flush();
    expect(f.calls).toHaveLength(2);
  });
});
