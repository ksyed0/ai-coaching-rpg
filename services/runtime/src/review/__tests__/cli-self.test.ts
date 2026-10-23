import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { loadReview } from "../store.js";
import { makeDraftDir, makeRunner } from "./fixtures.js";

let root: string, dir: string, run: ReturnType<typeof makeRunner>, rel: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  run = makeRunner(root);
  rel = path.relative(root, dir);
  await run(["open", rel, "--by", "kamal"]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const resolveAll = async (s: string) => {
  for (const c of (await loadReview(dir)).view.subjects
    .get(s)!
    .criteria.filter((x) => x.status === "needs_review"))
    await run(["accept", rel, s, c.id, "--by", "kamal"]);
};
const release = async () => {
  for (const s of ["alice", "bob", "group"]) await resolveAll(s);
  expect((await run(["release", rel, "--all", "--by", "kamal"])).code).toBe(0);
};
const exportAlice = async (to: string) => {
  await run([
    "export",
    rel,
    "alice",
    "--for",
    "participant:alice",
    "--to",
    to,
    "--by",
    "kamal",
  ]);
  return readFile(path.join(root, to, "alice.md"), "utf8");
};

describe("self-assess", () => {
  it("--list shows the criteria and the level anchors, never a score or rationale, and is unchanged by facilitator edits", async () => {
    const a = await run(["self-assess", rel, "--role", "alice", "--list"]);
    expect(a.code).toBe(0);
    const draft = JSON.parse(
      await readFile(path.join(dir, "alice.json"), "utf8"),
    );
    expect(a.out).toContain("listening");
    for (const c of draft.criteria) expect(a.out).not.toContain(c.rationale);
    const cur = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.find((c) => c.id === "listening")!.current;
    await run([
      "edit",
      rel,
      "alice",
      "listening",
      "--level",
      cur === 4 ? "3" : "4",
      "--reason",
      "r",
      "--by",
      "kamal",
    ]);
    expect(
      (await run(["self-assess", rel, "--role", "alice", "--list"])).out,
    ).toBe(a.out);
  });
  it("records ratings as the participant, attested by the facilitator; the last rating wins; bad input is refused", async () => {
    expect(
      (
        await run([
          "self-assess",
          rel,
          "--role",
          "alice",
          "--rate",
          "listening=2",
          "--rate",
          "negotiation=na",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await run([
          "self-assess",
          rel,
          "--role",
          "alice",
          "--rate",
          "listening=4",
          "--note",
          "I was patient",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    const l = await loadReview(dir);
    const ev = l.events.filter((e) => e.type === "self.rated");
    expect(ev[0]!.actor).toEqual({
      kind: "participant",
      role: "alice",
      attestedBy: "kamal",
    });
    expect(
      l.view.subjects.get("alice")!.criteria.find((c) => c.id === "listening")!
        .self,
    ).toMatchObject({ level: 4, note: "I was patient" });
    for (const argv of [
      ["--rate", "listening=9"],
      ["--rate", "listening"],
      ["--rate", "nope=3"],
      ["--role", "group", "--rate", "x=3"],
    ]) {
      expect(
        (
          await run([
            "self-assess",
            rel,
            ...(argv[0] === "--role" ? [] : ["--role", "alice"]),
            ...argv,
            "--by",
            "kamal",
          ])
        ).code,
      ).not.toBe(0);
    }
    expect(
      (
        await run([
          "self-assess",
          rel,
          "--role",
          "alice",
          "--rate",
          "listening=3",
        ])
      ).code,
    ).toBe(2); // no attestation
  });
  it("is closed once that report is released", async () => {
    await release();
    const r = await run([
      "self-assess",
      rel,
      "--role",
      "alice",
      "--rate",
      "listening=3",
      "--by",
      "kamal",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/closed|released/);
  });
  it("never changes the score", async () => {
    const before = (await loadReview(dir)).view.subjects.get(
      "alice",
    )!.objectives;
    await run([
      "self-assess",
      rel,
      "--role",
      "alice",
      "--rate",
      "listening=1",
      "--by",
      "kamal",
    ]);
    expect(
      (await loadReview(dir)).view.subjects.get("alice")!.objectives,
    ).toEqual(before);
  });
});

describe("released report: self against final, responses, disputes", () => {
  it("shows the self-rating next to the final level in the participant's report", async () => {
    await run([
      "self-assess",
      rel,
      "--role",
      "alice",
      "--rate",
      "listening=2",
      "--note",
      "SELF-NOTE-1",
      "--by",
      "kamal",
    ]);
    await release();
    const md = await exportAlice("o/a");
    expect(md).toMatch(/Self-rating/);
    expect(md).toContain("SELF-NOTE-1");
  });
  it("accepts a response only after release; a dispute is listed in status without its text; resolve closes it and shows in the report", async () => {
    expect(
      (
        await run([
          "respond",
          rel,
          "--role",
          "alice",
          "--text",
          "RESPONSE-TEXT",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(1);
    await release();
    expect(
      (
        await run([
          "respond",
          rel,
          "--role",
          "alice",
          "--criterion",
          "listening",
          "--text",
          "RESPONSE-TEXT <b>x</b>",
          "--dispute",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    const st = await run(["status", rel]);
    expect(st.out).toMatch(/open dispute: #\d+ by alice on listening/);
    expect(st.out).not.toContain("RESPONSE-TEXT");
    const seq = (await loadReview(dir)).events.find(
      (e) => e.type === "response.added",
    )!.seq;
    expect(
      (
        await run([
          "resolve",
          rel,
          String(seq),
          "--outcome",
          "declined",
          "--reason",
          "The recording supports the level",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect((await run(["status", rel])).out).not.toMatch(/open dispute/);
    const md = await exportAlice("o/a2");
    expect(md).toContain("RESPONSE-TEXT");
    expect(md).not.toContain("<b>");
    expect(md).toMatch(/declined/i);
    expect(md).toContain("The recording supports the level");
  });
  it("resolve 'amended' needs an amend first, then works", async () => {
    await release();
    await run([
      "respond",
      rel,
      "--role",
      "alice",
      "--text",
      "wrong",
      "--dispute",
      "--by",
      "kamal",
    ]);
    const seq = (await loadReview(dir)).events.find(
      (e) => e.type === "response.added",
    )!.seq;
    expect(
      (
        await run([
          "resolve",
          rel,
          String(seq),
          "--outcome",
          "amended",
          "--reason",
          "fixed",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(1);
    await run(["amend", rel, "alice", "--reason", "dispute", "--by", "kamal"]);
    expect(
      (
        await run([
          "resolve",
          rel,
          String(seq),
          "--outcome",
          "amended",
          "--reason",
          "fixed",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
  });
  it("another participant's export does not carry alice's response", async () => {
    await release();
    await run([
      "respond",
      rel,
      "--role",
      "alice",
      "--text",
      "ALICE-ONLY",
      "--by",
      "kamal",
    ]);
    await run([
      "export",
      rel,
      "bob",
      "--for",
      "participant:bob",
      "--to",
      "o/b",
      "--by",
      "kamal",
    ]);
    expect(await readFile(path.join(root, "o/b/bob.md"), "utf8")).not.toContain(
      "ALICE-ONLY",
    );
    expect(
      (
        await run([
          "export",
          rel,
          "alice",
          "--for",
          "participant:bob",
          "--to",
          "o/x",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(1);
  });
  it("scrubs secrets from a response", async () => {
    await release();
    await run(
      [
        "respond",
        rel,
        "--role",
        "alice",
        "--text",
        "my key sk-live-abcdef123456",
        "--by",
        "kamal",
      ],
      { OPENROUTER_API_KEY: "sk-live-abcdef123456" },
    );
    expect(
      await readFile(path.join(dir, "review.jsonl"), "utf8"),
    ).not.toContain("sk-live-abcdef123456");
  });
});

describe("plain refusals and bounds", () => {
  const rateOne = (extra: string[] = []) =>
    run([
      "self-assess",
      rel,
      "--role",
      "alice",
      "--rate",
      "listening=3",
      "--by",
      "kamal",
      ...extra,
    ]);
  it("explains each refusal in plain words without echoing the input", async () => {
    const hostile = "EVIL<b>\u202e\u001b[31m";
    const bad = await run([
      "self-assess",
      rel,
      "--role",
      "alice",
      "--rate",
      `${hostile}=3`,
      "--by",
      "kamal",
    ]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/not in this report/);
    expect(bad.err).not.toContain("EVIL");
    const nobody = await run([
      "respond",
      rel,
      "--role",
      `${hostile}`,
      "--text",
      "x",
      "--by",
      "kamal",
    ]);
    expect(nobody.code).toBe(1);
    expect(nobody.err).not.toContain("EVIL");
    const draft = await run([
      "respond",
      rel,
      "--role",
      "alice",
      "--text",
      "x",
      "--by",
      "kamal",
    ]);
    expect(draft.err).toMatch(/still a draft/);
    const noResp = await run([
      "resolve",
      rel,
      "999",
      "--outcome",
      "upheld",
      "--reason",
      "r",
      "--by",
      "kamal",
    ]);
    expect(noResp.code).toBe(1);
    expect(noResp.err).toMatch(/no response with that number/);
    expect(
      (
        await run([
          "resolve",
          rel,
          "x1",
          "--outcome",
          "upheld",
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
          "resolve",
          rel,
          "5",
          "--outcome",
          "maybe",
          "--reason",
          "r",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(2);
  });
  it("rejects stray options, duplicates and bad rate shapes", async () => {
    expect(
      (
        await run([
          "self-assess",
          rel,
          "--role",
          "alice",
          "--list",
          "--text",
          "x",
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await run([
          "respond",
          rel,
          "--role",
          "alice",
          "--rate",
          "a=1",
          "--text",
          "x",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await run([
          "resolve",
          rel,
          "1",
          "--role",
          "alice",
          "--outcome",
          "upheld",
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
          "self-assess",
          rel,
          "--role",
          "alice",
          "--role",
          "bob",
          "--list",
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await run([
          "self-assess",
          rel,
          "--role",
          "alice",
          "--list",
          "--rate",
          "listening=3",
        ])
      ).code,
    ).toBe(2);
    expect(
      (await run(["self-assess", rel, "--role", "alice", "--by", "kamal"]))
        .code,
    ).toBe(2);
    expect(
      (
        await rateOne(["--note", "n"]).then(() =>
          run([
            "self-assess",
            rel,
            "--role",
            "alice",
            "--rate",
            "listening=3",
            "--rate",
            "negotiation=2",
            "--note",
            "n",
            "--by",
            "kamal",
          ]),
        )
      ).code,
    ).toBe(2);
    expect(
      (
        await run([
          "self-assess",
          rel,
          "--role",
          "alice",
          "--rate",
          "listening=3",
          "--by",
          "bad name",
        ])
      ).code,
    ).toBe(2);
    expect(
      (await run(["self-assess", rel, "--role", "alice", "extra", "--list"]))
        .code,
    ).toBe(2);
    expect(
      (await run(["self-assess", rel, "--role", "nobody", "--list"])).code,
    ).toBe(1);
  });
  it("a self-rating note is cleaned like other free text and bounded", async () => {
    const r = await run(
      [
        "self-assess",
        rel,
        "--role",
        "alice",
        "--rate",
        "listening=3",
        "--note",
        "k sk-live-abcdef123456\u202e ok",
        "--by",
        "kamal",
      ],
      { OPENROUTER_API_KEY: "sk-live-abcdef123456" },
    );
    expect(r.code).toBe(0);
    const log = await readFile(path.join(dir, "review.jsonl"), "utf8");
    expect(log).not.toContain("sk-live-abcdef123456");
    expect(log).not.toContain("\u202e");
    expect(
      (
        await run([
          "self-assess",
          rel,
          "--role",
          "alice",
          "--rate",
          "listening=3",
          "--note",
          "x".repeat(1501),
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(2);
  });
  it("status shows the self-rating count", async () => {
    await rateOne();
    expect((await run(["status", rel])).out).toMatch(/1 self-rating\(s\)/);
  });
  it("accepts a response while amending, refuses after withdraw, and caps at 50 counting resolved ones", async () => {
    await release();
    await run(["amend", rel, "alice", "--reason", "r", "--by", "kamal"]);
    expect(
      (
        await run([
          "respond",
          rel,
          "--role",
          "alice",
          "--text",
          "r0",
          "--dispute",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    const seq = (await loadReview(dir)).events.find(
      (e) => e.type === "response.added",
    )!.seq;
    expect(
      (
        await run([
          "resolve",
          rel,
          String(seq),
          "--outcome",
          "upheld",
          "--reason",
          "ok",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await run([
          "resolve",
          rel,
          String(seq),
          "--outcome",
          "upheld",
          "--reason",
          "ok",
          "--by",
          "kamal",
        ])
      ).err,
    ).toMatch(/already resolved/);
    for (let i = 1; i < 50; i++)
      await run([
        "respond",
        rel,
        "--role",
        "alice",
        "--text",
        `r${i}`,
        "--by",
        "kamal",
      ]);
    const over = await run([
      "respond",
      rel,
      "--role",
      "alice",
      "--text",
      "r50",
      "--by",
      "kamal",
    ]);
    expect(over.code).toBe(1);
    expect(over.err).toMatch(/already has 50 responses/);
    await run(["withdraw", rel, "bob", "--reason", "r", "--by", "kamal"]);
    const w = await run([
      "respond",
      rel,
      "--role",
      "bob",
      "--text",
      "x",
      "--by",
      "kamal",
    ]);
    expect(w.code).toBe(1);
    expect(w.err).toMatch(/withdrawn/);
  });
  it("resolve refuses a response that is not a dispute, and only a facilitator resolves", async () => {
    await release();
    await run([
      "respond",
      rel,
      "--role",
      "alice",
      "--text",
      "plain",
      "--by",
      "kamal",
    ]);
    const seq = (await loadReview(dir)).events.find(
      (e) => e.type === "response.added",
    )!.seq;
    const r = await run([
      "resolve",
      rel,
      String(seq),
      "--outcome",
      "upheld",
      "--reason",
      "r",
      "--by",
      "kamal",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not a dispute/);
  });
});

describe("who sees what", () => {
  it("responses and self-ratings appear in the participant's own report and the facilitator view, with hostile text escaped", async () => {
    await run([
      "self-assess",
      rel,
      "--role",
      "alice",
      "--rate",
      "listening=2",
      "--note",
      "<script>S</script>",
      "--by",
      "kamal",
    ]);
    await release();
    await run([
      "respond",
      rel,
      "--role",
      "alice",
      "--text",
      "R-ALICE <img src=x onerror=1> | pipe",
      "--dispute",
      "--by",
      "kamal",
    ]);
    const md = await exportAlice("o/a");
    expect(md).toContain("R-ALICE");
    expect(md).not.toMatch(/(^|[^\\])</);
    expect(md).toContain("\\<img");
    const show = await run(["show", rel, "alice"]);
    expect(show.out).toContain("R-ALICE");
    expect(show.out).toMatch(/Self-rating/);
    const json = JSON.parse(
      await readFile(path.join(root, "o/a/alice.json"), "utf8"),
    );
    expect(json.responses).toHaveLength(1);
    expect(json.self.listening.level).toBe(2);
  });
  it("never leaks into the group report, the index, a peer's report or the peer's index", async () => {
    await run([
      "self-assess",
      rel,
      "--role",
      "alice",
      "--rate",
      "listening=2",
      "--note",
      "SELF-ALICE",
      "--by",
      "kamal",
    ]);
    await release();
    await run([
      "respond",
      rel,
      "--role",
      "alice",
      "--text",
      "R-ALICE",
      "--dispute",
      "--by",
      "kamal",
    ]);
    let n = 0;
    for (const [subject, who] of [
      ["group", "alice"],
      ["group", "bob"],
      ["bob", "bob"],
      ["index", "bob"],
      ["index", "alice"],
    ] as const) {
      const to = `o/p${n++}`;
      const r = await run([
        "export",
        rel,
        subject,
        "--for",
        `participant:${who}`,
        "--to",
        to,
        "--by",
        "kamal",
      ]);
      expect(r.code).toBe(0);
      for (const f of [`${subject}.md`, `${subject}.json`]) {
        const text = await readFile(
          path.join(
            root,
            to,
            subject === "index" && f.endsWith("json") ? "index.md" : f,
          ),
          "utf8",
        ).catch(() => "");
        expect(text).not.toContain("R-ALICE");
        expect(text).not.toContain("SELF-ALICE");
      }
    }
    // the facilitator's snapshot export of the group and of the index is not the participant's report either
    await run([
      "export",
      rel,
      "index",
      "--for",
      "facilitator",
      "--to",
      "o/fi",
      "--by",
      "kamal",
    ]);
    expect(
      await readFile(path.join(root, "o/fi/index.md"), "utf8"),
    ).not.toContain("R-ALICE");
  });
  it("a response made after release is not in the released snapshot of that version (facilitator snapshot export), but is in the participant's own report", async () => {
    await release();
    await run([
      "respond",
      rel,
      "--role",
      "alice",
      "--text",
      "LATE-RESPONSE",
      "--by",
      "kamal",
    ]);
    await run([
      "export",
      rel,
      "alice",
      "--for",
      "facilitator",
      "--to",
      "o/snap",
      "--by",
      "kamal",
    ]);
    expect(
      await readFile(path.join(root, "o/snap/alice.md"), "utf8"),
    ).not.toContain("LATE-RESPONSE");
    expect(await exportAlice("o/own")).toContain("LATE-RESPONSE");
  });
  it("the participant report keeps the frozen scores when the facilitator edits during an amendment", async () => {
    await release();
    const before = await exportAlice("o/b1");
    await run(["amend", rel, "alice", "--reason", "r", "--by", "kamal"]);
    await run([
      "respond",
      rel,
      "--role",
      "alice",
      "--text",
      "while amending",
      "--by",
      "kamal",
    ]);
    const cur = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.find((c) => c.id === "listening")!.current;
    await run([
      "edit",
      rel,
      "alice",
      "listening",
      "--level",
      cur === 4 ? "3" : "4",
      "--reason",
      "r",
      "--by",
      "kamal",
    ]);
    const after = await exportAlice("o/b2");
    expect(after.replace(/## Your responses[\s\S]*?\n\n(?=## )/, "")).toBe(
      before,
    );
    expect(after).toContain("while amending");
  });
});

describe("fix round", () => {
  it("a facilitator snapshot export does not change when a dispute is resolved later", async () => {
    await release();
    await run(["amend", rel, "alice", "--reason", "r", "--by", "kamal"]);
    await run([
      "respond",
      rel,
      "--role",
      "alice",
      "--text",
      "DURING-AMEND",
      "--dispute",
      "--by",
      "kamal",
    ]);
    await resolveAll("alice");
    expect((await run(["release", rel, "alice", "--by", "kamal"])).code).toBe(
      0,
    );
    await run([
      "export",
      rel,
      "alice",
      "--for",
      "facilitator",
      "--to",
      "o/f1",
      "--by",
      "kamal",
    ]);
    const seq = (await loadReview(dir)).events.find(
      (e) => e.type === "response.added",
    )!.seq;
    expect(
      (
        await run([
          "resolve",
          rel,
          String(seq),
          "--outcome",
          "upheld",
          "--reason",
          "LATE-REASON",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    await run([
      "export",
      rel,
      "alice",
      "--for",
      "facilitator",
      "--to",
      "o/f2",
      "--by",
      "kamal",
    ]);
    for (const f of ["alice.md", "alice.json"]) {
      const a = await readFile(path.join(root, "o/f1", f), "utf8");
      expect(await readFile(path.join(root, "o/f2", f), "utf8")).toBe(a);
      expect(a).not.toContain("LATE-REASON");
    }
  });
  it("marks the boundary under Your responses, in md and json", async () => {
    await release();
    await run([
      "respond",
      rel,
      "--role",
      "alice",
      "--text",
      "BOUNDARY",
      "--by",
      "kamal",
    ]);
    const md = await exportAlice("o/bd");
    const v = (await loadReview(dir)).view.subjects
      .get("alice")!
      .versions.at(-1)!;
    expect(md).toContain(
      `Responses are added after release and are not part of version ${v}.`,
    );
    const json = JSON.parse(
      await readFile(path.join(root, "o/bd/alice.json"), "utf8"),
    );
    expect(json.responses[0].version).toBe(v);
  });
  it("self-assess --list refuses --note", async () => {
    expect(
      (
        await run([
          "self-assess",
          rel,
          "--role",
          "alice",
          "--list",
          "--note",
          "x",
        ])
      ).code,
    ).toBe(2);
  });
});
