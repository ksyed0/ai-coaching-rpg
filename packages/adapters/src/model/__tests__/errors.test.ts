import { describe, expect, it } from "vitest";
import {
  MAX_RETRY_AFTER_MS, isPermanentQuotaText, ModelProviderError, classifyHttpStatus, classifyInBandError, classifyNetworkError, isTransientModelError, parseRetryAfter,
} from "../errors.js";

describe("ModelProviderError", () => {
  it("is an Error carrying kind, transient, status and retryAfterMs", () => {
    const e = new ModelProviderError("boom", { kind: "overloaded", transient: true, status: 503, retryAfterMs: 1500 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ModelProviderError");
    expect(e).toMatchObject({ message: "boom", kind: "overloaded", transient: true, status: 503, retryAfterMs: 1500 });
    expect(e.attempts).toBeUndefined();
  });
  it("isTransientModelError is true only for a transient ModelProviderError", () => {
    expect(isTransientModelError(new ModelProviderError("x", { kind: "network", transient: true }))).toBe(true);
    expect(isTransientModelError(new ModelProviderError("x", { kind: "auth", transient: false }))).toBe(false);
    expect(isTransientModelError(new Error("overloaded"))).toBe(false);
    expect(isTransientModelError("overloaded")).toBe(false);
    expect(isTransientModelError(null)).toBe(false);
  });
});

describe("classifyHttpStatus", () => {
  it.each([
    [429, "rate_limited", true], [503, "overloaded", true], [529, "overloaded", true], [500, "server_error", true], [502, "server_error", true],
    [504, "server_error", true], [408, "timeout", true], [401, "auth", false], [403, "auth", false], [404, "not_found", false],
    [400, "bad_request", false], [422, "bad_request", false], [409, "unknown", false], [413, "unknown", false], [501, "server_error", false], [302, "unknown", false],
  ] as const)("HTTP %i -> %s (transient %s)", (status, kind, transient) => {
    expect(classifyHttpStatus(status)).toEqual({ kind, transient });
  });
});

describe("classifyInBandError", () => {
  it.each([
    [{ code: 429, message: "slow down" }, "rate_limited", true],
    [{ code: 503, message: "x" }, "overloaded", true],
    [{ code: "529", message: "x" }, "overloaded", true],
    [{ code: 500, message: "internal" }, "server_error", true],
    [{ message: "Upstream error from Nvidia: Service temporarily overloaded" }, "overloaded", true],
    [{ message: "Rate limit exceeded" }, "rate_limited", true],
    [{ message: "No capacity right now, please try again" }, "overloaded", true],
    [{ message: "model is unavailable" }, "overloaded", true],
    [{ code: "rate_limit_error", message: "x" }, "rate_limited", true],
    [{ message: "model not loaded" }, "unknown", false],
    [{ code: 400, message: "bad input" }, "bad_request", false],
    [{ code: 401, message: "no" }, "auth", false],
    [{}, "unknown", false],
    [{ code: 429, message: "You exceeded your current quota, please check your plan and billing details" }, "rate_limited", false],
    [{ code: "insufficient_quota", type: "insufficient_quota", message: "x" }, "rate_limited", false],
    [{ code: 429, type: "insufficient_quota", message: "Rate limit" }, "rate_limited", false],
  ] as const)("%j -> %s (transient %s)", (err, kind, transient) => {
    expect(classifyInBandError(err)).toMatchObject({ kind, transient });
  });
  it("accepts a bare string error and reports a numeric code as status", () => {
    expect(classifyInBandError("service overloaded")).toMatchObject({ kind: "overloaded", transient: true });
    expect(classifyInBandError({ code: 503, message: "x" }).status).toBe(503);
    expect(classifyInBandError({ message: "overloaded" }).status).toBeUndefined();
  });
});

describe("isPermanentQuotaText", () => {
  it.each(["insufficient_quota", "You exceeded your current quota", "billing_hard_limit_reached", "Insufficient credits", "quota_exceeded", "payment required"])("%s", (t) => expect(isPermanentQuotaText(t)).toBe(true));
  it.each(["Rate limit exceeded, retry later", "overloaded", ""])("%j is not a quota problem", (t) => expect(isPermanentQuotaText(t)).toBe(false));
});

describe("classifyNetworkError", () => {
  const withCode = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code }) });
  it.each(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"])("%s is a transient network failure", (code) => {
    expect(classifyNetworkError(withCode(code))).toEqual({ kind: "network", transient: true });
  });
  it("recognises 'socket hang up' and 'other side closed' by message", () => {
    expect(classifyNetworkError(new Error("socket hang up"))).toEqual({ kind: "network", transient: true });
    expect(classifyNetworkError(Object.assign(new TypeError("fetch failed"), { cause: new Error("other side closed") }))).toEqual({ kind: "network", transient: true });
  });
  it("treats DNS-not-found, redirects and other failures as permanent", () => {
    expect(classifyNetworkError(withCode("ENOTFOUND"))).toEqual({ kind: "network", transient: false });
    expect(classifyNetworkError(new TypeError("fetch failed"))).toEqual({ kind: "network", transient: false });
    expect(classifyNetworkError("weird")).toEqual({ kind: "network", transient: false });
  });
});

describe("parseRetryAfter", () => {
  const NOW = Date.parse("2026-10-01T12:00:00Z");
  it("parses delta seconds (also fractional) to milliseconds", () => {
    expect(parseRetryAfter("2", NOW)).toBe(2000);
    expect(parseRetryAfter(" 0 ", NOW)).toBe(0);
    expect(parseRetryAfter("1.5", NOW)).toBe(1500);
  });
  it("parses an HTTP date relative to now, never negative", () => {
    expect(parseRetryAfter("Thu, 01 Oct 2026 12:00:05 GMT", NOW)).toBe(5000);
    expect(parseRetryAfter("Thu, 01 Oct 2026 11:59:00 GMT", NOW)).toBe(0);
  });
  it("caps at MAX_RETRY_AFTER_MS", () => {
    expect(MAX_RETRY_AFTER_MS).toBe(10_000);
    expect(parseRetryAfter("3600", NOW)).toBe(10_000);
    expect(parseRetryAfter("Fri, 02 Oct 2026 12:00:00 GMT", NOW)).toBe(10_000);
  });
  it("returns undefined for missing or unparseable values", () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfter("", NOW)).toBeUndefined();
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
    expect(parseRetryAfter("-3", NOW)).toBeUndefined();
  });
});
