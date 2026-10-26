import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runModerate, MODERATE_USAGE, HANDLERS } from "../cli.js";
import { loadReview } from "../store.js";
import { makeDraftDir, makeRunner } from "./fixtures.js";

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  run = makeRunner(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let run: ReturnType<typeof makeRunner>;
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

  const ESC = "\u001b]0;PWNED\u0007\u001b[31m";
  const tamper = async (edit: (r: any) => void) => {
    const f = path.join(dir, "alice.json");
    const r = JSON.parse(await readFile(f, "utf8"));
    edit(r);
    await writeFile(f, JSON.stringify(r));
  };
  const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

  it("refuses to open drafts whose printed fields hold terminal control sequences or non-numbers", async () => {
    for (const edit of [
      (r: any) => (r.method.name = ESC),
      (r: any) => (r.criteria[0].level_label = ESC),
      (r: any) => {
        const c = r.criteria.find((x: any) => x.evidence?.length);
        c.evidence[0].time = ESC;
      },
      (r: any) => (r.evaluator.model_calls = ESC),
      (r: any) => (r.participant.utterances = ESC),
    ]) {
      await rm(root, { recursive: true, force: true });
      ({ root, dir } = await makeDraftDir());
      await tamper(edit);
      const r = await open();
      expect(r.code).toBe(2);
      expect(r.out + r.err).not.toMatch(CTRL);
    }
  });
  it("show never emits a control character, keeps its line breaks, and redacts a secret", async () => {
    await open();
    await comment_with_esc();
    const r = await run(["show", rel(), "alice"], {
      OPENROUTER_API_KEY: "sk-live-abcdef123456",
    });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(CTRL);
    expect(r.out.split("\n").length).toBeGreaterThan(20);
  });
  async function comment_with_esc() {
    await run([
      "comment",
      rel(),
      "alice",
      "--text",
      `${ESC} hi`,
      "--feedback",
      "--by",
      "kamal",
    ]);
  }
  it("keeps the usage text multi-line on an error", async () => {
    const r = await run(["status", rel(), "--bogus"]);
    expect(r.err.split("\n").length).toBeGreaterThan(5);
  });
  it("rejects a repeated single-value option, extra positionals and accept with both a criterion and --summary (exit 2)", async () => {
    await open();
    const edit = ["edit", rel(), "alice", "listening", "--reason", "r"];
    expect(
      (await run([...edit, "--level", "2", "--level", "3", "--by", "kamal"]))
        .code,
    ).toBe(2);
    expect(
      (await run([...edit, "--level", "2", "--by", "a", "--by", "b"])).code,
    ).toBe(2);
    expect((await run(["status", rel(), "junk"])).code).toBe(2);
    expect((await run(["show", rel(), "alice", "junk"])).code).toBe(2);
    const id = (await needs())[0]!;
    expect(
      (await run(["accept", rel(), "alice", id, "--summary", "--by", "kamal"]))
        .code,
    ).toBe(2);
  });
  it("edit-summary with no items, or an action naming an unknown or unsafe objective, is refused and changes nothing", async () => {
    await open();
    const before = await readFile(path.join(dir, "review.jsonl"), "utf8");
    const base = [
      "edit-summary",
      rel(),
      "alice",
      "--reason",
      "r",
      "--by",
      "kamal",
    ];
    expect((await run(base)).code).toBe(2);
    expect((await run([...base, "--action", "NOPE9:Do it"])).code).toBe(2);
    expect((await run([...base, "--action", "bad id:Do it"])).code).toBe(2);
    expect(await readFile(path.join(dir, "review.jsonl"), "utf8")).toBe(before);
  });
  it("show emits no control character except newline and tab when a draft quote, rationale and summary item carry them", async () => {
    const file = path.join(dir, "alice.json");
    const j = JSON.parse(await readFile(file, "utf8"));
    const bad = "x\u001b[31m\u009b2J\u0007\u0000y";
    const crit = j.criteria.find(
      (c: { evidence?: unknown[] }) => (c.evidence ?? []).length > 0,
    );
    crit.evidence[0].quote = `q${bad}`;
    crit.rationale = `r${bad}`;
    j.summary.strengths[0] = `s${bad}`;
    await writeFile(file, JSON.stringify(j, null, 2));
    expect((await open()).code).toBe(0);
    const r = await run(["show", rel(), "alice"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/r\S*x\S*y/);
    expect(r.out).toMatch(/s\S*x\S*y/);
    expect(r.out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });
  it("supersede moves a re-run onto the new directory, naming carried and clean subjects", async () => {
    const { writeReports } = await import("../../evaluator/report-write.js");
    const { sampleEvaluation } =
      await import("../../evaluator/__tests__/fixtures.js");
    const w = await writeReports(await sampleEvaluation(), {
      outDir: root,
      evaluator: {
        provider: "scripted mock",
        scripted: true,
        rubricHash: "h1",
        variant: "v1",
      },
    });
    await open();
    const n = path.relative(root, w.dir);
    // no release yet: nothing blocks a second open, and supersede of an unreleased review is allowed
    const r = await run(["supersede", rel(), n, "--by", "kamal"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/carried forward: .*alice/);
    expect((await run(["supersede", rel(), n, "--by", "kamal"])).code).toBe(1);
    expect((await run(["supersede", rel(), "--by", "kamal"])).code).toBe(2);
    expect(
      (await run(["supersede", rel(), "nope", "--by", "kamal"])).code,
    ).toBe(2);
    expect((await run(["status", rel()])).out).toContain("superseded");
  });
});
