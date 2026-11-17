import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ReviewRefusedError, ReviewUsageError } from "../../review/errors.js";
import { loadReview, supersedeReview } from "../../review/store.js";
import { REVIEW_FILE } from "../../review/types.js";
import { writeReports } from "../../evaluator/report-write.js";
import { sampleEvaluation } from "../../evaluator/__tests__/fixtures.js";
import { hideResponse, resolveDispute, toModResult } from "../index.js";
import { openedReview, releaseViaCli, type Env } from "./helpers.js";

let env: Env | undefined;
afterEach(async () => {
  if (env) await rm(env.root, { recursive: true, force: true });
  env = undefined;
});
const base = (e: Env, secrets: string[] = []) => ({
  dir: e.dir,
  by: "priya-console",
  now: e.now,
  secrets,
});
const bytes = (e: Env) => readFile(path.join(e.dir, REVIEW_FILE));
const events = async (e: Env) => (await loadReview(e.dir)).events;
const fail = (p: Promise<unknown>) => p.then(() => null).catch((x) => x);
const respond = async (e: Env, text: string, dispute = false) => {
  const r = await e.run([
    "respond", e.rel, "--role", "alice", "--text", text, "--by", "kamal",
    ...(dispute ? ["--dispute"] : []),
  ]);
  expect(r.code).toBe(0);
  return (await events(e)).at(-1)!.seq;
};
const released = async () => {
  env = await openedReview();
  await releaseViaCli(env, "alice");
  return env;
};

describe("hideResponse", () => {
  it("appends one response.hidden event by the facilitator, naming the response, with the cleaned reason", async () => {
    const e = await released();
    const seq = await respond(e, "something awful");
    const n = (await events(e)).length;
    await hideResponse({ ...base(e), seq, reason: "  off​ topic  " });
    const evs = await events(e);
    expect(evs).toHaveLength(n + 1);
    const last = evs.at(-1)!;
    expect(last).toMatchObject({
      type: "response.hidden",
      response: seq,
      reason: "off topic",
      actor: { kind: "facilitator", by: "priya-console" },
    });
    const r = (await loadReview(e.dir)).view.subjects.get("alice")!.responses[0]!;
    expect(r.hidden).toMatchObject({ reason: "off topic", by: "priya-console" });
  });

  it("scrubs a secret out of the reason", async () => {
    const e = await released();
    const seq = await respond(e, "x");
    await hideResponse({ ...base(e, ["s3cr3t-token"]), seq, reason: "has s3cr3t-token in it" });
    expect((await bytes(e)).toString()).not.toContain("s3cr3t-token");
  });

  it("refuses a response number that does not exist, and writes nothing", async () => {
    const e = await released();
    await respond(e, "x");
    const before = await bytes(e);
    const err = await fail(hideResponse({ ...base(e), seq: 999, reason: "r" }));
    expect(err).toBeInstanceOf(ReviewRefusedError);
    expect((err as Error).message).toContain("there is no response with that number");
    expect(await bytes(e)).toEqual(before);
  });

  it("refuses a second hide of the same response: exactly one hidden event in the log", async () => {
    const e = await released();
    const seq = await respond(e, "x");
    await hideResponse({ ...base(e), seq, reason: "first" });
    const before = await bytes(e);
    const err = await fail(hideResponse({ ...base(e), seq, reason: "second" }));
    expect(err).toBeInstanceOf(ReviewRefusedError);
    expect((err as Error).message).toMatch(/already hidden/);
    expect((await events(e)).filter((x) => x.type === "response.hidden")).toHaveLength(1);
    expect(await bytes(e)).toEqual(before);
  });

  it.each([0, -1, 1.5, NaN, 1_000_000_000])("a response number of %s is a usage error", async (seq) => {
    const e = await released();
    const err = await fail(hideResponse({ ...base(e), seq, reason: "r" }));
    expect(err).toBeInstanceOf(ReviewUsageError);
    expect((err as Error).message).toBe("hide needs the response number shown by status");
  });

  it.each(["", "   ", "​ \t"])("a reason of %j is a usage error and nothing is written", async (reason) => {
    const e = await released();
    const seq = await respond(e, "x");
    const before = await bytes(e);
    const err = await fail(hideResponse({ ...base(e), seq, reason }));
    expect(err).toBeInstanceOf(ReviewUsageError);
    expect(await bytes(e)).toEqual(before);
  });

  it("on a superseded review directory it is refused with code superseded", async () => {
    const e = await released();
    const seq = await respond(e, "x");
    const w = await writeReports(await sampleEvaluation(), {
      outDir: e.root,
      evaluator: { provider: "scripted mock", scripted: true, rubricHash: "h1", variant: "v1" },
    });
    await supersedeReview(e.dir, w.dir, { by: "kamal", now: e.now });
    const before = await bytes(e);
    const err = await fail(hideResponse({ ...base(e), seq, reason: "r" }));
    expect(err).toBeInstanceOf(ReviewRefusedError);
    expect((err as ReviewRefusedError).code).toBe("superseded");
    expect(await bytes(e)).toEqual(before);
  });

  it("maps to the closed codes through toModResult", async () => {
    const e = await released();
    expect(await toModResult(() => hideResponse({ ...base(e), seq: 999, reason: "r" }))).toMatchObject({ ok: false });
    expect(await toModResult(() => hideResponse({ ...base(e), seq: 0, reason: "r" }))).toEqual({ ok: false, code: "invalid" });
  });
});

describe("resolveDispute on a hidden response", () => {
  it("is a ReviewRefusedError (not an illegal-fold error) and writes nothing", async () => {
    const e = await released();
    const seq = await respond(e, "x", true);
    await hideResponse({ ...base(e), seq, reason: "r" });
    const before = await bytes(e);
    const err = await fail(resolveDispute({ ...base(e), seq, outcome: "declined", reason: "no" }));
    expect(err).toBeInstanceOf(ReviewRefusedError);
    expect((err as Error).message).toBe("that response is hidden, so there is nothing to resolve");
    expect(await bytes(e)).toEqual(before);
  });
});
