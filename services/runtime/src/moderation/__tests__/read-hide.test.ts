import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { applyCommand, loadReview } from "../../review/store.js";
import { moderationStatus, subjectView } from "../index.js";
import { openedReview, releaseViaCli, type Env } from "./helpers.js";

const CANARY = "CANARY-HIDDEN-7731";
let env: Env | undefined;
afterEach(async () => {
  if (env) await rm(env.root, { recursive: true, force: true });
  env = undefined;
});
const respond = (e: Env, text: string, dispute: boolean) =>
  e.run(["respond", e.rel, "--role", "alice", "--text", text, "--by", "kamal", ...(dispute ? ["--dispute"] : [])]);
const hide = async (e: Env, seq: number) =>
  applyCommand(e.dir, e.now, () => [
    {
      actor: { kind: "facilitator", by: "priya" },
      body: { type: "response.hidden", response: seq, reason: "off topic" },
    },
  ]);

describe("console reads leave a hidden response's text out", () => {
  it("the DTO gives a hidden response {reason, by, at} and no text; a visible one has no hidden key", async () => {
    env = await openedReview();
    await releaseViaCli(env, "alice");
    await respond(env, "kept", false);
    await respond(env, CANARY, true);
    const rs = (await loadReview(env.dir)).view.subjects.get("alice")!.responses;
    await hide(env, rs[1]!.seq);
    const after = (await loadReview(env.dir)).view.subjects.get("alice")!.responses;
    const dto = await subjectView(env.dir, "alice", []);
    expect(JSON.stringify(dto)).not.toContain(CANARY);
    const [kept, hidden] = dto.responses;
    expect(kept).not.toHaveProperty("hidden");
    expect(kept!.text).toBe("kept");
    expect(hidden).not.toHaveProperty("text");
    expect(hidden!.hidden).toEqual({ reason: "off topic", by: "priya", at: after[1]!.hidden!.ts });
    expect(hidden!.seq).toBe(rs[1]!.seq);
  });

  it("the hide's reason and author go through the text scrubber", async () => {
    env = await openedReview();
    await releaseViaCli(env, "alice");
    await respond(env, "x", false);
    const rs = (await loadReview(env.dir)).view.subjects.get("alice")!.responses;
    await hide(env, rs[0]!.seq);
    const dto = await subjectView(env.dir, "alice", ["off topic"]);
    expect(JSON.stringify(dto)).not.toContain("off topic");
  });

  it("openDisputes (module and CLI status) omit a hidden dispute", async () => {
    env = await openedReview();
    await releaseViaCli(env, "alice");
    await respond(env, "visible dispute", true);
    await respond(env, CANARY, true);
    const rs = (await loadReview(env.dir)).view.subjects.get("alice")!.responses;
    expect((await moderationStatus(env.dir)).subjects.find((s) => s.id === "alice")!.openDisputes).toHaveLength(2);
    await hide(env, rs[1]!.seq);
    const open = (await moderationStatus(env.dir)).subjects.find((s) => s.id === "alice")!.openDisputes;
    expect(open.map((d) => d.seq)).toEqual([rs[0]!.seq]);
    const st = await env.run(["status", env.rel]);
    expect(st.out).toContain(`open dispute: #${rs[0]!.seq}`);
    expect(st.out).not.toContain(`open dispute: #${rs[1]!.seq}`);
  });
});
