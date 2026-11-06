import { describe, expect, it } from "vitest";
import {
  ReviewBusyError,
  ReviewCorruptError,
  ReviewIllegalError,
  ReviewRefusedError,
  ReviewUsageError,
} from "../../review/errors.js";
import { toModResult } from "../index.js";

const fail = (e: unknown) => toModResult(() => Promise.reject(e));

describe("toModResult", () => {
  it("toModResult maps Busy→busy, Usage→invalid, coded Refused→its code, plain Refused→refused, Corrupt→unavailable, and checks Busy before Refused", async () => {
    expect(await toModResult(async () => 7)).toEqual({ ok: true, value: 7 });
    expect(await fail(new ReviewBusyError("held /tmp/x"))).toEqual({
      ok: false,
      code: "busy",
    });
    // a busy error is a refusal subclass: even with a code set, busy wins
    const coded = new ReviewBusyError("held");
    coded.code = "stale";
    expect(await fail(coded)).toEqual({ ok: false, code: "busy" });
    expect(
      await fail(new ReviewUsageError("--reason must not be empty")),
    ).toEqual({ ok: false, code: "invalid" });
    expect(
      await fail(new ReviewRefusedError("x is 2, not 3", "stale")),
    ).toEqual({ ok: false, code: "stale" });
    expect(
      await fail(
        new ReviewRefusedError("blocked", "blocked", [
          "alice",
          "../etc",
          "group",
        ]),
      ),
    ).toEqual({ ok: false, code: "blocked", detail: ["alice", "group"] });
    expect(await fail(new ReviewRefusedError("no review here"))).toEqual({
      ok: false,
      code: "refused",
    });
    expect(await fail(new ReviewCorruptError("/home/a/review.jsonl"))).toEqual({
      ok: false,
      code: "unavailable",
    });
    expect(await fail(new ReviewIllegalError("bad"))).toEqual({
      ok: false,
      code: "unavailable",
    });
    const io = Object.assign(new Error("EACCES /x"), { code: "EACCES" });
    expect(await fail(io)).toEqual({ ok: false, code: "unavailable" });
    // no message text, path or id from the review layer
    expect(
      JSON.stringify(await fail(new ReviewRefusedError("/secret/path"))),
    ).not.toContain("secret");
  });
});
