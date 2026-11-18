import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { loadReview } from "../store.js";
import { MODERATE_USAGE } from "../cli.js";
import { makeDraftDir, makeRunner } from "./fixtures.js";

const CANARY = "CANARY-HIDDEN-7731";
let root: string, dir: string, rel: string, run: ReturnType<typeof makeRunner>;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  run = makeRunner(root);
  rel = path.relative(root, dir);
  expect((await run(["open", rel, "--by", "kamal"])).code).toBe(0);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const release = async (s: string) => {
  for (const c of (await loadReview(dir)).view.subjects.get(s)!.criteria.filter((x) => x.status === "needs_review"))
    await run(["accept", rel, s, c.id, "--by", "kamal"]);
  if ((await loadReview(dir)).view.subjects.get(s)!.summaryStale)
    await run(["accept", rel, s, "--summary", "--by", "kamal"]);
  expect((await run(["release", rel, s, "--by", "kamal"])).code).toBe(0);
};
const respond = (text: string, extra: string[] = []) =>
  run(["respond", rel, "--role", "alice", "--text", text, "--by", "kamal", ...extra]);
const seqs = async () =>
  (await loadReview(dir)).view.subjects.get("alice")!.responses.map((r) => r.seq);

describe("pnpm moderate hide", () => {
  it("lists hide in the usage text", () => {
    expect(MODERATE_USAGE).toMatch(/hide <dir> <response-number> --reason <text> --by <name>/);
  });

  it("hides a response: exit 0, prints the number, and show carries no canary", async () => {
    await release("alice");
    await respond("fine");
    await respond(CANARY);
    const [, second] = await seqs();
    const shown = await run(["show", rel, "alice"]);
    expect(shown.out).toContain(CANARY);
    const r = await run(["hide", rel, String(second), "--reason", "off topic", "--by", "kamal"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`response #${second} hidden`);
    const after = await run(["show", rel, "alice"]);
    expect(after.code).toBe(0);
    expect(after.out).not.toContain(CANARY);
    expect(after.out).toContain("fine");
  });

  it("refuses a second hide and a missing response with exit 1 and the message", async () => {
    await release("alice");
    await respond("x");
    const [s] = await seqs();
    expect((await run(["hide", rel, String(s), "--reason", "r", "--by", "kamal"])).code).toBe(0);
    const again = await run(["hide", rel, String(s), "--reason", "r", "--by", "kamal"]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already hidden/);
    const none = await run(["hide", rel, "999", "--reason", "r", "--by", "kamal"]);
    expect(none.code).toBe(1);
    expect(none.err).toContain("there is no response with that number");
  });

  it("usage errors exit 2: bad number, missing or blank reason", async () => {
    await release("alice");
    await respond("x");
    const [s] = await seqs();
    for (const argv of [
      ["hide", rel, "abc", "--reason", "r", "--by", "kamal"],
      ["hide", rel, "0", "--reason", "r", "--by", "kamal"],
      ["hide", rel, String(s), "--by", "kamal"],
      ["hide", rel, String(s), "--reason", "   ", "--by", "kamal"],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
    }
    expect((await loadReview(dir)).events.some((e) => e.type === "response.hidden")).toBe(false);
  });

  it("resolve on a hidden dispute exits 1 with the hidden message", async () => {
    await release("alice");
    await respond("d", ["--dispute"]);
    const [s] = await seqs();
    await run(["hide", rel, String(s), "--reason", "r", "--by", "kamal"]);
    const r = await run(["resolve", rel, String(s), "--outcome", "declined", "--reason", "no", "--by", "kamal"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("that response is hidden, so there is nothing to resolve");
  });

  it("status lists every response by number with no text, marking disputes and hidden ones", async () => {
    await release("alice");
    await respond("plain " + CANARY);
    await respond("on a criterion " + CANARY, ["--criterion", "listening"]);
    await respond("disputed " + CANARY, ["--dispute"]);
    const [a, b, c] = await seqs();
    await run(["hide", rel, String(a), "--reason", "r", "--by", "kamal"]);
    const st = await run(["status", rel]);
    expect(st.out).not.toContain(CANARY);
    const lines = st.out.split("\n").filter((l) => l.startsWith("  response #"));
    expect(lines).toEqual([
      `  response #${a} by alice hidden`,
      `  response #${b} by alice on listening`,
      `  response #${c} by alice (dispute)`,
    ]);
  });

  it("hiding on a superseded review is refused with exit 1", async () => {
    await release("alice");
    await respond("x");
    const [s] = await seqs();
    const { dir: dir2 } = await (async () => {
      const { writeReports } = await import("../../evaluator/report-write.js");
      const { sampleEvaluation } = await import("../../evaluator/__tests__/fixtures.js");
      const w = await writeReports(await sampleEvaluation(), {
        outDir: root,
        evaluator: { provider: "scripted mock", scripted: true, rubricHash: "h1", variant: "v1" },
      });
      return { dir: w.dir };
    })();
    const sup = await run(["supersede", rel, path.relative(root, dir2), "--by", "kamal"]);
    expect(sup.code).toBe(0);
    expect(sup.out).toContain("open disputes stay open (a hidden one stays hidden and cannot be resolved)");
    const r = await run(["hide", rel, String(s), "--reason", "r", "--by", "kamal"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/superseded/);
  });
});
