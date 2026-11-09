import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { SpeechRefusedError, SpeechTimeoutError, SpeechUnavailableError, isTransientSpeechError } from "../errors.js";

// US-0070 (Task 11, AC-0402): the speech-to-text error classes. Messages are fixed sentences: no URL, no body, no transcript.
const URL_CAUSE = new Error("connect ECONNREFUSED http://127.0.0.1:9000/secret-path/inference?token=abc");

describe("speech errors (US-0070)", () => {
  it("transient is true for Unavailable and Timeout, false for Refused", () => {
    expect(new SpeechUnavailableError().transient).toBe(true);
    expect(new SpeechTimeoutError().transient).toBe(true);
    expect(new SpeechRefusedError().transient).toBe(false);
    expect(isTransientSpeechError(new SpeechUnavailableError())).toBe(true);
    expect(isTransientSpeechError(new SpeechRefusedError())).toBe(false);
    expect(isTransientSpeechError(new Error("x"))).toBe(false);
  });

  it("each has its own name and is an Error", () => {
    for (const [E, name] of [[SpeechUnavailableError, "SpeechUnavailableError"], [SpeechTimeoutError, "SpeechTimeoutError"], [SpeechRefusedError, "SpeechRefusedError"]] as const) {
      const e = new E();
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe(name);
      expect(e.message.length).toBeGreaterThan(0);
    }
  });

  it("messages contain no URL (constructed with a cause that holds one), and the cause is not kept anywhere", () => {
    for (const e of [new SpeechUnavailableError({ cause: URL_CAUSE }), new SpeechTimeoutError({ cause: URL_CAUSE }), new SpeechRefusedError({ cause: URL_CAUSE, status: 400 })]) {
      expect(e.message).not.toMatch(/http|127\.0\.0\.1|secret|token/);
      expect(inspect(e, { depth: 5 })).not.toMatch(/secret-path|token=abc/);
      expect(JSON.stringify(e)).not.toMatch(/secret-path|token=abc/);
      expect(e.stack ?? "").not.toMatch(/secret-path/);
    }
    expect(new SpeechRefusedError({ status: 400 }).status).toBe(400);
  });
});
