import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { RESPONSES_PER_LINK, submitResponse, type SubmitCtx } from "../index.js";
import { applyCommand, loadReview } from "../../review/store.js";
import { fixedClock } from "../../review/__tests__/fixtures.js";
import { resolveBodies } from "../../review/__tests__/fixtures.js";
import { liveReview, type Env } from "./helpers.js";

let env: Env | undefined;
afterEach(async () => {
  if (env) await rm(env.root, { recursive: true, force: true });
  env = undefined;
});
const ctx = (e: Env, credentialId = "AAAAAAAAAAA"): SubmitCtx => ({
  reportsDir: e.root,
  sessionId: e.sessionId,
  role: "alice",
  credentialId,
  now: fixedClock(1_900_000_000_000),
  secrets: [],
});
const releaseAlice = async (e: Env) => {
  await applyCommand(e.dir, fixedClock(), (l) => [
    ...resolveBodies(l.view, "alice").map((body) => ({
      actor: { kind: "facilitator", by: "kamal" } as const,
      body,
    })),
    {
      actor: { kind: "facilitator", by: "kamal" } as const,
      body: { type: "report.released", subjects: ["alice"] } as const,
    },
  ]);
};
const hideLast = async (e: Env) => {
  const rs = (await loadReview(e.dir)).view.subjects.get("alice")!.responses;
  await applyCommand(e.dir, fixedClock(), () => [
    {
      actor: { kind: "facilitator", by: "kamal" },
      body: { type: "response.hidden", response: rs.at(-1)!.seq, reason: "off topic" },
    },
  ]);
};
const say = (e: Env, text: string, credentialId?: string) =>
  submitResponse({ ...ctx(e, credentialId), text, dispute: false });
const added = async (e: Env) =>
  (await loadReview(e.dir)).events.filter((x) => x.type === "response.added").length;

describe("submitResponse after a hide", () => {
  it("the identical text is written again, not swallowed as a resend of the hidden one", async () => {
    env = await liveReview();
    await releaseAlice(env);
    expect(await say(env, "same words")).toEqual({ kind: "ok", wrote: true });
    await hideLast(env);
    const before = await added(env);
    expect(await say(env, "same words")).toEqual({ kind: "ok", wrote: true });
    expect(await added(env)).toBe(before + 1);
    // and a resend of the now-visible copy is still the no-op
    expect(await say(env, "same words")).toEqual({ kind: "ok", wrote: false });
    expect(await added(env)).toBe(before + 1);
  });

  it("a hidden response still counts toward the per-link cap", async () => {
    env = await liveReview();
    await releaseAlice(env);
    for (let i = 0; i < RESPONSES_PER_LINK; i++)
      expect((await say(env, `r${i}`)).kind).toBe("ok");
    await hideLast(env);
    expect(await say(env, "one more")).toEqual({ kind: "link_full" });
  });

  it("a hidden response still counts toward the per-role cap", async () => {
    env = await liveReview();
    await releaseAlice(env);
    // two links so the per-link cap is not what stops us: 25 + 25 = 50
    for (let i = 0; i < 25; i++) expect((await say(env, `a${i}`, "AAAAAAAAAAA")).kind).toBe("ok");
    for (let i = 0; i < 25; i++) expect((await say(env, `b${i}`, "BBBBBBBBBBA")).kind).toBe("ok");
    await hideLast(env);
    expect(await say(env, "one more", "CCCCCCCCCCA")).toEqual({ kind: "too_many" });
  });
});
