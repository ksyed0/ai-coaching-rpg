import { describe, expect, it } from "vitest";
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, AuthenticationError, BadRequestError, InternalServerError, NotFoundError, PermissionDeniedError, RateLimitError } from "@anthropic-ai/sdk";
import { classifyAnthropicError } from "../anthropic.js";

// The real SDK classes (no mock): proves the duck-typed classifier matches what the installed SDK throws.
const h = (retryAfter?: string) => (retryAfter ? ({ "retry-after": retryAfter } as never) : undefined);
describe("classifyAnthropicError with the installed SDK's error classes", () => {
  it.each([
    [new RateLimitError(429, { error: { message: "slow" } }, undefined, h("4")), "rate_limited", true, 4000],
    [new InternalServerError(500, undefined, "boom", undefined), "server_error", true, undefined],
    [APIError.generate(503, { error: { message: "busy" } }, undefined, undefined), "overloaded", true, undefined],
    [APIError.generate(529, { error: { message: "Overloaded" } }, undefined, undefined), "overloaded", true, undefined],
    [APIError.generate(502, undefined, "bad gateway", undefined), "server_error", true, undefined],
    [APIError.generate(504, undefined, "gw", undefined), "server_error", true, undefined],
    [new BadRequestError(400, undefined, "no", undefined), "bad_request", false, undefined],
    [new AuthenticationError(401, undefined, "no", undefined), "auth", false, undefined],
    [new PermissionDeniedError(403, undefined, "no", undefined), "auth", false, undefined],
    [new NotFoundError(404, undefined, "no", undefined), "not_found", false, undefined],
    [new APIConnectionError({ cause: new Error("ECONNRESET") }), "network", true, undefined],
    [new APIConnectionTimeoutError(), "timeout", true, undefined],
  ] as const)("%s", (err, kind, transient, retryAfterMs) => {
    const c = classifyAnthropicError(err);
    expect(c).toMatchObject({ kind, transient });
    expect(c?.retryAfterMs).toBe(retryAfterMs);
  });
  it("never classifies the SDK's abort error", () => {
    expect(classifyAnthropicError(new APIUserAbortError())).toBeNull();
  });
});
