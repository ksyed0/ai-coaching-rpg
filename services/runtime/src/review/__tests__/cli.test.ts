import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runModerate, MODERATE_USAGE, HANDLERS } from "../cli.js";
import { loadReview } from "../store.js";
import { makeDraftDir, fixedClock } from "./fixtures.js";

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  let out = "",
    err = "";
  const r = await runModerate({
    argv,
    stdout: { write: (s) => (out += s) },
    stderr: { write: (s) => (err += s) },
    env,
    cwd: root,
    now: fixedClock(),
  });
  return { code: r.exitCode, out, err };
}
const rel = () => path.relative(root, dir);
const open = () => run(["open", rel(), "--by", "kamal"]);
const needs = async () => {
  const l = await loadReview(dir);
  return l.view.subjects
    .get("alice")!
    .criteria.filter((c) => c.status === "needs_review")
    .map((c) => c.id);
};

describe("pnpm moderate", () => {
  it("prints usage for --help and exits 2 for an unknown subcommand, a missing directory and an unknown option", async () => {
    expect((await run(["--help"])).out).toContain(
      MODERATE_USAGE.split("\n")[0],
    );
    expect((await run(["frobnicate", rel()])).code).toBe(2);
    expect((await run(["status", "nope-dir"])).code).toBe(2);
    expect((await run(["status", rel(), "--bogus"])).code).toBe(2);
  });
  it("refuses every command but open until a review is open (exit 1, says what to run)", async () => {
    const r = await run(["status", rel()]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/open/);
  });
  it("opens a review, then status lists what needs review per subject and never an absolute path", async () => {
    expect((await open()).code).toBe(0);
    const s = await run(["status", rel()]);
    expect(s.code).toBe(0);
    expect(s.out).toMatch(/alice: draft/);
    expect(s.out).toContain("needs review");
    expect(s.out).not.toContain(root);
    expect((await open()).code).toBe(1);
  });
  it("edits a score with a reason, rejects a missing or over-long reason, an unknown criterion and a bad level", async () => {
    await open();
    const cur = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.find((c) => c.id === "listening")!.current;
    const level = cur === 4 ? "3" : "4";
    expect(
      (
        await run([
          "edit",
          rel(),
          "alice",
          "listening",
          "--level",
          level,
          "--reason",
          "Heard it",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect(
      (await loadReview(dir)).view.subjects
        .get("alice")!
        .criteria.find((c) => c.id === "listening")!.status,
    ).toBe("edited");
    expect(
      (
        await run([
          "edit",
          rel(),
          "alice",
          "negotiation",
          "--level",
          "2",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await run([
          "edit",
          rel(),
          "alice",
          "negotiation",
          "--level",
          "2",
          "--reason",
          "x".repeat(501),
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await run([
          "edit",
          rel(),
          "alice",
          "nope",
          "--level",
          "2",
          "--reason",
          "r",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(1);
    expect(
      (
        await run([
          "edit",
          rel(),
          "alice",
          "negotiation",
          "--level",
          "9",
          "--reason",
          "r",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await run([
          "edit",
          rel(),
          "alice",
          "negotiation",
          "--level",
          "2",
          "--reason",
          "r",
        ])
      ).code,
    ).toBe(2);
  });
  it("--expect is a compare-and-set: a different current level exits 1 and prints the current one", async () => {
    await open();
    const r = await run([
      "edit",
      rel(),
      "alice",
      "listening",
      "--level",
      "2",
      "--expect",
      "invalid",
      "--reason",
      "r",
      "--by",
      "kamal",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/currently/);
  });
  it("edits the rationale in the same step when --rationale is given", async () => {
    await open();
    const cur = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.find((c) => c.id === "listening")!.current;
    await run([
      "edit",
      rel(),
      "alice",
      "listening",
      "--level",
      cur === 4 ? "3" : "4",
      "--rationale",
      "New words",
      "--reason",
      "clarity",
      "--by",
      "kamal",
    ]);
    expect(
      (await loadReview(dir)).view.subjects
        .get("alice")!
        .criteria.find((c) => c.id === "listening")!.rationale,
    ).toBe("New words");
  });
  it("accepts a criterion and the summary, comments, and edits the summary", async () => {
    await open();
    const id = (await needs())[0]!;
    expect(
      (await run(["accept", rel(), "alice", id, "--by", "kamal"])).code,
    ).toBe(0);
    expect(
      (await run(["accept", rel(), "alice", "--summary", "--by", "kamal"]))
        .code,
    ).toBe(0);
    expect(
      (
        await run([
          "comment",
          rel(),
          "alice",
          "--text",
          "Good scene 2",
          "--feedback",
          "--criterion",
          "listening",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await run([
          "edit-summary",
          rel(),
          "alice",
          "--strength",
          "Asked well",
          "--development",
          "Price earlier",
          "--action",
          "LO2:State two options",
          "--reason",
          "tighter",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect((await loadReview(dir)).view.subjects.get("alice")!.summary).toEqual(
      {
        strengths: ["Asked well"],
        development_points: ["Price earlier"],
        next_actions: [{ lo: "LO2", action: "State two options" }],
      },
    );
  });
  it("show prints the facilitator's rendering of the current view", async () => {
    await open();
    const r = await run(["show", rel(), "alice"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("# Feedback report: alice");
    expect(r.out).toContain("IN REVIEW");
    expect(r.out.split("\n").length).toBeGreaterThan(20);
    expect(r.out).not.toContain("⏎");
    expect((await run(["show", rel(), "carol"])).code).toBe(1);
  });
  it("scrubs a secret out of stored free text and escapes markup when shown", async () => {
    await open();
    await run(
      [
        "comment",
        rel(),
        "alice",
        "--text",
        "key sk-live-abcdef123456 <script>x</script>",
        "--by",
        "kamal",
      ],
      { OPENROUTER_API_KEY: "sk-live-abcdef123456" },
    );
    const log = await readFile(path.join(dir, "review.jsonl"), "utf8");
    expect(log).not.toContain("sk-live-abcdef123456");
    expect((await run(["show", rel(), "alice"])).out).not.toContain("<script>");
  });
  it("exits 2 on a damaged log and never repairs it", async () => {
    await open();
    const f = path.join(dir, "review.jsonl");
    await (await import("node:fs/promises")).appendFile(f, "garbage");
    expect((await run(["status", rel()])).code).toBe(2);
    expect((await readFile(f, "utf8")).endsWith("garbage")).toBe(true);
  });

  it("maps a non-Review error to a bounded message and exit 2 with no path or stack", async () => {
    await open();
    // a directory where the lock file should be: withReviewLock throws a raw SessionLockError
    await mkdir(path.join(dir, "review.lock"));
    const r = await run([
      "accept",
      rel(),
      "alice",
      "--summary",
      "--by",
      "kamal",
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("the command failed");
    expect(r.err).not.toContain(root);
    expect(r.err).not.toMatch(/SessionLockError|\n\s+at /);
    await rm(path.join(dir, "review.lock"), { recursive: true });
    const spy = vi
      .spyOn(HANDLERS, "status")
      .mockRejectedValue(new TypeError(`boom at ${root}/secret`));
    try {
      const t = await run(["status", rel()]);
      expect(t.code).toBe(2);
      expect(t.err.length).toBeLessThan(200);
      expect(t.err).not.toContain(root);
      expect(t.err).not.toContain("boom");
    } finally {
      spy.mockRestore();
    }
  });
  it("names (sanitised, bounded) the stray file that stops open", async () => {
    await writeFile(path.join(dir, "README.md"), "hello");
    const r = await run(["open", rel(), "--by", "kamal"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("README.md");
    await rm(path.join(dir, "README.md"));
    const long = `${"n".repeat(200)}\u202eEvil.md`;
    await writeFile(path.join(dir, long), "x");
    const r2 = await run(["open", rel(), "--by", "kamal"]);
    expect(r2.code).toBe(1);
    expect(r2.err).not.toContain("\u202e");
    expect(r2.err.length).toBeLessThan(300);
    await rm(path.join(dir, long));
    await writeFile(path.join(dir, "x.y.json"), "{}");
    const r3 = await run(["open", rel(), "--by", "kamal"]);
    expect(r3.code).toBe(2);
    expect(r3.err).toContain("x.y.json");
  });
  it("records a multi-line comment as one line with a visible marker, so a pasted line cannot forge a log or report line", async () => {
    await open();
    expect(
      (
        await run([
          "comment",
          rel(),
          "alice",
          "--text",
          "line one\r\nline two\nline three",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    const log = await readFile(path.join(dir, "review.jsonl"), "utf8");
    const last = JSON.parse(log.trimEnd().split("\n").at(-1)!);
    expect(last.text).toBe("line one ⏎ line two ⏎ line three");
    expect(last.text).not.toContain("\n");
  });
  it("never echoes a secret in a refusal or an error", async () => {
    await open();
    const r = await run(
      [
        "edit",
        rel(),
        "alice",
        "sk-live-abcdef123456",
        "--level",
        "2",
        "--reason",
        "r",
        "--by",
        "kamal",
      ],
      { OPENROUTER_API_KEY: "sk-live-abcdef123456" },
    );
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("sk-live-abcdef123456");
  });
});
