import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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

async function resolveAll(subject: string) {
  const l = await loadReview(dir);
  for (const c of l.view.subjects
    .get(subject)!
    .criteria.filter((x) => x.status === "needs_review"))
    await run(["accept", rel, subject, c.id, "--by", "kamal"]);
  const sv = (await loadReview(dir)).view.subjects.get(subject)!;
  if (sv.summaryStale)
    await run(["accept", rel, subject, "--summary", "--by", "kamal"]);
}

describe("release", () => {
  it("is refused (exit 1) while items are open, listing every unresolved item and writing nothing", async () => {
    const r = await run(["release", rel, "alice", "--by", "kamal"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/nothing was released/);
    expect(r.err).toMatch(/alice: needs review/);
    expect((await loadReview(dir)).events).toHaveLength(1);
  });
  it("releases one subject once resolved; status shows the version; a second release is refused", async () => {
    await resolveAll("alice");
    expect((await run(["release", rel, "alice", "--by", "kamal"])).code).toBe(
      0,
    );
    expect((await run(["status", rel])).out).toMatch(
      /alice: released \(version \d+\)/,
    );
    expect((await run(["release", rel, "alice", "--by", "kamal"])).code).toBe(
      1,
    );
  });
  it("--all releases every subject in one event, or none when one is unresolved", async () => {
    await resolveAll("alice");
    expect((await run(["release", rel, "--all", "--by", "kamal"])).code).toBe(
      1,
    );
    expect((await loadReview(dir)).view.subjects.get("alice")!.state).toBe(
      "draft",
    );
    await resolveAll("bob");
    await resolveAll("group");
    expect((await run(["release", rel, "--all", "--by", "kamal"])).code).toBe(
      0,
    );
    const l = await loadReview(dir);
    expect(l.events.filter((e) => e.type === "report.released")).toHaveLength(
      1,
    );
    expect(
      [...l.view.subjects.values()].every((s) => s.state === "released"),
    ).toBe(true);
  });
  it("needs --by and a subject or --all; refuses both together, an unsafe --by and an unknown subject", async () => {
    expect((await run(["release", rel, "alice"])).code).toBe(2);
    expect((await run(["release", rel, "--by", "kamal"])).code).toBe(2);
    expect(
      (await run(["release", rel, "alice", "--all", "--by", "kamal"])).code,
    ).toBe(2);
    expect((await run(["release", rel, "alice", "--by", "../x"])).code).toBe(2);
    expect(
      (await run(["release", rel, "alice", "--to", "x", "--by", "k"])).code,
    ).toBe(2);
    const r = await run(["release", rel, "zed", "--by", "kamal"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/unknown subject/);
  });
  it("two racing releases: exactly one succeeds", async () => {
    await resolveAll("alice");
    const [a, b] = await Promise.all([
      run(["release", rel, "alice", "--by", "kamal"]),
      run(["release", rel, "alice", "--by", "kamal"]),
    ]);
    expect([a.code, b.code].sort()).toEqual([0, 1]);
    expect(
      (await loadReview(dir)).view.subjects.get("alice")!.versions,
    ).toHaveLength(1);
  });
});

describe("amend and withdraw", () => {
  it("amend reopens edits and a new release makes version 2; edits are refused while released", async () => {
    await resolveAll("alice");
    await run(["release", rel, "alice", "--by", "kamal"]);
    const edit = (level: string) =>
      run([
        "edit",
        rel,
        "alice",
        "discovery",
        "--level",
        level,
        "--reason",
        "r",
        "--by",
        "kamal",
      ]);
    expect((await edit("2")).code).toBe(1);
    expect(
      (
        await run([
          "amend",
          rel,
          "alice",
          "--reason",
          "new evidence",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    const cur = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.find((c) => c.id === "discovery")!.current;
    expect((await edit(cur === 2 ? "3" : "2")).code).toBe(0);
    await resolveAll("alice");
    expect((await run(["release", rel, "alice", "--by", "kamal"])).code).toBe(
      0,
    );
    expect(
      (await loadReview(dir)).view.subjects.get("alice")!.versions,
    ).toHaveLength(2);
  });
  it("amend and withdraw need a reason and a released subject; withdrawn is terminal", async () => {
    expect(
      (await run(["amend", rel, "alice", "--reason", "r", "--by", "kamal"]))
        .code,
    ).toBe(1);
    expect((await run(["withdraw", rel, "alice", "--by", "kamal"])).code).toBe(
      2,
    );
    expect((await run(["amend", rel, "alice", "--by", "kamal"])).code).toBe(2);
    await resolveAll("alice");
    await run(["release", rel, "alice", "--by", "kamal"]);
    expect(
      (
        await run([
          "withdraw",
          rel,
          "alice",
          "--reason",
          "wrong session",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect(
      (await run(["amend", rel, "alice", "--reason", "r", "--by", "kamal"]))
        .code,
    ).toBe(1);
    expect((await run(["release", rel, "alice", "--by", "kamal"])).code).toBe(
      1,
    );
  });
  it("keeps a multi-line reason on one line, and refuses an unknown subject, an unsafe --by and extra arguments", async () => {
    await resolveAll("alice");
    await run(["release", rel, "alice", "--by", "kamal"]);
    expect(
      (
        await run([
          "amend",
          rel,
          "alice",
          "--reason",
          "line one\n\nline two",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    const ev = (await loadReview(dir)).events.find(
      (e) => e.type === "report.amended",
    ) as { reason: string };
    expect(ev.reason).not.toContain("\n");
    expect(ev.reason).toContain("line one");
    expect(ev.reason).toContain("line two");
    expect(
      (await run(["withdraw", rel, "zed", "--reason", "r", "--by", "kamal"]))
        .code,
    ).toBe(1);
    expect(
      (await run(["withdraw", rel, "alice", "--reason", "r", "--by", "a b"]))
        .code,
    ).toBe(2);
    expect(
      (
        await run([
          "withdraw",
          rel,
          "alice",
          "bob",
          "--reason",
          "r",
          "--by",
          "k",
        ])
      ).code,
    ).toBe(2);
  });
});

describe("export", () => {
  const exp = (to: string | null, extra: string[] = []) =>
    run([
      "export",
      rel,
      "alice",
      "--for",
      "facilitator",
      ...(to === null ? [] : ["--to", to]),
      "--by",
      "kamal",
      ...extra,
    ]);
  beforeEach(async () => {
    await resolveAll("alice");
    await run(["release", rel, "alice", "--by", "kamal"]);
  });
  it("writes owner-only Markdown and acr.view/1 JSON into a new directory and records report.exported with the version", async () => {
    const r = await exp("out/alice-export");
    expect(r.code).toBe(0);
    const out = path.join(root, "out/alice-export");
    expect((await readdir(out)).sort()).toEqual(["alice.json", "alice.md"]);
    expect((await stat(path.join(out, "alice.md"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(out, "alice.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(out)).mode & 0o777).toBe(0o700);
    expect(
      JSON.parse(await readFile(path.join(out, "alice.json"), "utf8")).schema,
    ).toBe("acr.view/1");
    const ex = (await loadReview(dir)).events.filter(
      (e) => e.type === "report.exported",
    );
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({
      subject: "alice",
      principal: "facilitator",
      destination: "alice-export",
    });
    expect(JSON.stringify(ex[0])).not.toContain(root);
  });
  it("refuses a draft subject, an inert principal, an existing file and a missing --to", async () => {
    expect(
      (
        await run([
          "export",
          rel,
          "bob",
          "--for",
          "facilitator",
          "--to",
          "out/b",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(1);
    expect(
      (
        await run([
          "export",
          rel,
          "alice",
          "--for",
          "line_manager",
          "--to",
          "out/p",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(1);
    expect((await exp(null)).code).toBe(2);
    expect((await exp("out/x")).code).toBe(0);
    expect((await exp("out/x")).code).not.toBe(0);
  });
  it("never overwrites: a pre-existing file in a specified directory refuses with exit 1, records nothing and leaves it intact", async () => {
    const out = path.join(root, "out/keep");
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "alice.json"), "mine");
    const r = await exp("out/keep");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/never overwritten/);
    expect(await readFile(path.join(out, "alice.json"), "utf8")).toBe("mine");
    expect(await readdir(out)).toEqual(["alice.json"]);
    expect(
      (await loadReview(dir)).events.some((e) => e.type === "report.exported"),
    ).toBe(false);
  });
  it("exports into an existing empty directory without changing it, leaving no temp files", async () => {
    const out = path.join(root, "out/empty");
    await mkdir(out, { recursive: true, mode: 0o755 });
    expect((await exp("out/empty")).code).toBe(0);
    expect((await readdir(out)).sort()).toEqual(["alice.json", "alice.md"]);
  });
  it("does not follow a symlinked destination or a symlinked file name", async () => {
    const target = path.join(root, "elsewhere");
    await mkdir(target);
    await symlink(target, path.join(root, "link"));
    const r = await exp("link");
    expect(r.code).toBe(1);
    expect(await readdir(target)).toEqual([]);
    const out = path.join(root, "out/sym");
    await mkdir(out, { recursive: true });
    await writeFile(path.join(root, "victim"), "safe");
    await symlink(path.join(root, "victim"), path.join(out, "alice.md"));
    expect((await exp("out/sym")).code).toBe(1);
    expect(await readFile(path.join(root, "victim"), "utf8")).toBe("safe");
  });
  it("when the audit event is recorded but the files cannot be written: exit 2, says so, leaves nothing behind", async () => {
    await writeFile(path.join(root, "afile"), "x");
    const r = await exp("afile/sub");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/export event was recorded/);
    expect(r.err).toMatch(/no files were produced/);
    expect(
      (await loadReview(dir)).events.filter(
        (e) => e.type === "report.exported",
      ),
    ).toHaveLength(1);
    expect(await readFile(path.join(root, "afile"), "utf8")).toBe("x");
  });
  // root ignores directory modes, so this case cannot be provoked there (the Linux container run is root)
  it.skipIf(process.getuid?.() === 0)(
    "a read-only destination fails after the audit event with exit 2 and leaves nothing behind",
    async () => {
      const out = path.join(root, "out/ro");
      await mkdir(path.join(root, "out"), { recursive: true });
      await mkdir(out, { mode: 0o500 });
      const r = await exp("out/ro");
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/nothing was left behind/);
      expect(await readdir(out)).toEqual([]);
      await rm(out, { recursive: true, force: true });
    },
  );
  it("exports the released snapshot, not the live amendment", async () => {
    const before = await readFile(path.join(dir, "alice.json"), "utf8").then(
      JSON.parse,
    );
    const disc = (j: { criteria: { id: string; score: number | null }[] }) =>
      j.criteria.find((c) => c.id === "discovery")!.score;
    await run(["amend", rel, "alice", "--reason", "r", "--by", "kamal"]);
    const cur = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.find((c) => c.id === "discovery")!.current;
    const other = cur === 4 ? "3" : "4";
    await run([
      "edit",
      rel,
      "alice",
      "discovery",
      "--level",
      other,
      "--reason",
      "r",
      "--by",
      "kamal",
    ]);
    // export is refused while amending (only a released report is exported)
    expect((await exp("out/amending")).code).toBe(1);
    await resolveAll("alice");
    await run(["release", rel, "alice", "--by", "kamal"]);
    expect((await exp("out/v2")).code).toBe(0);
    const j = JSON.parse(
      await readFile(path.join(root, "out/v2/alice.json"), "utf8"),
    );
    expect(disc(j)).toBe(Number(other));
    expect(disc(before)).not.toBeUndefined();
    const md = await readFile(path.join(root, "out/v2/alice.md"), "utf8");
    expect(md.length).toBeGreaterThan(50);
  });
  it("exports a group report from the frozen table", async () => {
    await resolveAll("group");
    await run(["release", rel, "group", "--by", "kamal"]);
    const r = await run([
      "export",
      rel,
      "group",
      "--for",
      "facilitator",
      "--to",
      "out/g",
      "--by",
      "kamal",
    ]);
    expect(r.code).toBe(0);
    const j = JSON.parse(
      await readFile(path.join(root, "out/g/group.json"), "utf8"),
    );
    expect(j.schema).toBe("acr.view/1");
    expect(j.kind).toBe("group");
  });
  it("rejects a bad --by and an extra argument", async () => {
    expect((await exp("out/z", [])).code).toBe(0);
    expect(
      (
        await run([
          "export",
          rel,
          "alice",
          "--for",
          "facilitator",
          "--to",
          "out/q",
          "--by",
          "a b",
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await run([
          "export",
          rel,
          "alice",
          "bob",
          "--for",
          "facilitator",
          "--to",
          "out/q",
          "--by",
          "k",
        ])
      ).code,
    ).toBe(2);
  });
});
