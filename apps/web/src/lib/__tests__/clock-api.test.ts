import { describe, expect, it, vi } from "vitest";
import { formatRemaining, realClock, remainingMs } from "../clock";
import { postJson } from "../api";
import { roleLabel } from "../names";
import { fakeFetch, ok, refused } from "./fakes";

const MIN = 60_000;

describe("remainingMs", () => {
  const T = 5_000_000; // an arbitrary origin: only differences matter
  it("counts down from the time box, less the closed pauses", () => {
    expect(remainingMs({ timeBoxMinutes: 10, enteredAt: T, pausedMs: 0, paused: false, pausedSince: null }, T)).toBe(10 * MIN);
    expect(remainingMs({ timeBoxMinutes: 10, enteredAt: T, pausedMs: MIN, paused: false, pausedSince: null }, T + 3 * MIN)).toBe(8 * MIN);
  });
  it("stops at the pause start while paused", () => {
    const s = { timeBoxMinutes: 10, enteredAt: T, pausedMs: MIN, paused: true, pausedSince: T + 4 * MIN };
    expect(remainingMs(s, T + 5 * MIN)).toBe(7 * MIN);
    expect(remainingMs(s, T + 50 * MIN)).toBe(7 * MIN);
  });
  it("never goes below zero or above the time box (a clock behind the server's)", () => {
    expect(remainingMs({ timeBoxMinutes: 1, enteredAt: T, pausedMs: 0, paused: false, pausedSince: null }, T + 5 * MIN)).toBe(0);
    expect(remainingMs({ timeBoxMinutes: 1, enteredAt: T, pausedMs: 0, paused: false, pausedSince: null }, T - 5 * MIN)).toBe(MIN);
  });
  it("a paused flag without a pause start freezes nothing it cannot measure", () => {
    expect(remainingMs({ timeBoxMinutes: 2, enteredAt: T, pausedMs: 0, paused: true, pausedSince: null }, T + MIN)).toBe(MIN);
  });
});

describe("formatRemaining", () => {
  it("is mm:ss, rounding up to the next second, and h:mm:ss from an hour", () => {
    expect(formatRemaining(0)).toBe("00:00");
    expect(formatRemaining(1)).toBe("00:01");
    expect(formatRemaining(8 * MIN + 42_000)).toBe("08:42");
    expect(formatRemaining(61 * MIN + 5_000)).toBe("1:01:05");
  });
});

describe("realClock", () => {
  it("reads Date.now and runs `every` on an interval until cancelled", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const stop = realClock.every(1_000, fn);
      vi.advanceTimersByTime(3_000);
      expect(fn).toHaveBeenCalledTimes(3);
      stop();
      vi.advanceTimersByTime(3_000);
      expect(fn).toHaveBeenCalledTimes(3);
      expect(realClock.now()).toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("postJson", () => {
  it("posts JSON same-origin with the custom header and returns the data", async () => {
    const f = fakeFetch(() => ({ status: 200, body: ok({ a: 1 }) }));
    await expect(postJson("/api/v1/x", { b: 2 }, f.fetch)).resolves.toEqual({ ok: true, data: { a: 1 } });
    expect(f.calls[0]!.init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(f.calls[0]!.body).toEqual({ b: 2 });
  });
  it("sends no body when there is none", async () => {
    const f = fakeFetch();
    await postJson("/api/v1/leave", undefined, f.fetch);
    expect(f.calls[0]!.init.body).toBeUndefined();
  });
  it("returns the status, code and message of a refusal", async () => {
    const f = fakeFetch(() => ({ status: 401, body: refused("join_refused", "nope") }));
    await expect(postJson("/x", {}, f.fetch)).resolves.toEqual({ ok: false, status: 401, code: "join_refused", message: "nope" });
  });
  it("a body that is not an envelope, or a network failure, is a generic failure", async () => {
    const bad = (async () => new Response("<html>", { status: 502 })) as typeof fetch;
    await expect(postJson("/x", {}, bad)).resolves.toMatchObject({ ok: false, status: 502, code: "unknown" });
    const down = (async () => { throw new TypeError("offline"); }) as typeof fetch;
    await expect(postJson("/x", {}, down)).resolves.toMatchObject({ ok: false, status: 0, code: "network" });
    const long = fakeFetch(() => ({ status: 409, body: refused("x", "y".repeat(500)) }));
    await expect(postJson("/x", {}, long.fetch)).resolves.toMatchObject({ ok: false, message: "" });
  });
  it("uses the global fetch by default", async () => {
    const f = fakeFetch();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(f.fetch);
    try {
      await postJson("/y", {});
      expect(f.calls[0]!.url).toBe("/y");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("roleLabel", () => {
  it("turns a role id into words", () => {
    expect(roleLabel("account_manager")).toBe("Account manager");
    expect(roleLabel("tech-lead")).toBe("Tech lead");
    expect(roleLabel("")).toBe("");
  });
});
