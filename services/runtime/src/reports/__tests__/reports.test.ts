import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  collectSecrets,
  listReleasedRoles,
  readReleasedView,
  resolveReviewDir,
} from "../index.js";
import { loadReview, supersedeReview } from "../../review/store.js";
import { writeReports } from "../../evaluator/report-write.js";
import { sampleEvaluation } from "../../evaluator/__tests__/fixtures.js";
import {
  fixedClock,
  makeDraftDir,
  makeRunner,
} from "../../review/__tests__/fixtures.js";

let root: string, dir: string, run: ReturnType<typeof makeRunner>, rel: string;
let sessionId: string;
const secrets = collectSecrets({});

async function resolveAll(d = dir, r = rel) {
  const l = await loadReview(d);
  for (const sv of l.view.subjects.values()) {
    for (const c of sv.criteria.filter((x) => x.status === "needs_review"))
      await run(["accept", r, sv.id, c.id, "--by", "kamal"]);
    const cur = (await loadReview(d)).view.subjects.get(sv.id)!;
    if (cur.summaryStale)
      await run(["accept", r, sv.id, "--summary", "--by", "kamal"]);
  }
}
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  sessionId = path.basename(dir);
  run = makeRunner(root);
  rel = path.relative(root, dir);
  await run(["open", rel, "--by", "kamal"]);
  await resolveAll();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const release = async (...subjects: string[]) =>
  expect(
    (
      await run([
        "release",
        rel,
        ...(subjects.length ? subjects : ["--all"]),
        "--by",
        "kamal",
      ])
    ).code,
  ).toBe(0);
const exportFor = (subject: string, to: string, who: string) =>
  run(["export", rel, subject, "--for", who, "--to", to, "--by", "kamal"]);
const read = (p: string) => readFile(path.join(root, p), "utf8");

describe("readReleasedView parity with export --for participant", () => {
  it("returns the same bytes and objects, and none of the peers' rows or facilitator-only fields", async () => {
    await release();
    expect((await exportFor("alice", "o/a", "participant:alice")).code).toBe(0);
    expect((await exportFor("group", "o/g", "participant:alice")).code).toBe(0);
    const r = await readReleasedView(root, sessionId, "alice", secrets);
    if (r.kind !== "released") throw new Error(r.kind);
    expect(r.markdown.own).toBe(await read("o/a/alice.md"));
    expect(r.markdown.group).toBe(await read("o/g/group.md"));
    expect(r.own).toEqual(JSON.parse(await read("o/a/alice.json")));
    expect(r.group).toEqual(JSON.parse(await read("o/g/group.json")));
    expect(r.group!.lo_coverage.players).toEqual(["alice"]);
    const text = JSON.stringify(r) + r.markdown.group;
    expect(text).not.toMatch(/"bob":\s*\{\s*"score"/);
    expect(r.markdown.group).not.toContain(
      "Talking points for the facilitator",
    );
    expect(r.markdown.own).not.toMatch(/internal/i);
  });
  it("does not write: no audit event, no lock, files unchanged", async () => {
    await release();
    const before = await read(`${rel}/review.jsonl`);
    await readReleasedView(root, sessionId, "alice", secrets);
    await listReleasedRoles(root, sessionId);
    expect(await read(`${rel}/review.jsonl`)).toBe(before);
    expect(before).not.toContain("report.exported");
    await expect(readFile(path.join(dir, "review.lock"))).rejects.toThrow();
  });
  it("group is null while the group is not released", async () => {
    await release("alice");
    const r = await readReleasedView(root, sessionId, "alice", secrets);
    expect(r.kind).toBe("released");
    if (r.kind === "released") {
      expect(r.group).toBeNull();
      expect(r.markdown.group).toBeNull();
    }
  });
});

describe("states", () => {
  it("draft gives not_released", async () => {
    expect(await readReleasedView(root, sessionId, "alice", secrets)).toEqual({
      kind: "not_released",
    });
  });
  it("withdrawn gives not_released", async () => {
    await release();
    await run(["withdraw", rel, "alice", "--reason", "wrong", "--by", "kamal"]);
    expect(await readReleasedView(root, sessionId, "alice", secrets)).toEqual({
      kind: "not_released",
    });
    expect((await readReleasedView(root, sessionId, "bob", secrets)).kind).toBe(
      "released",
    );
  });
  it("amending with a snapshot gives released", async () => {
    await release();
    await run(["amend", rel, "alice", "--reason", "r", "--by", "kamal"]);
    expect(
      (await readReleasedView(root, sessionId, "alice", secrets)).kind,
    ).toBe("released");
  });
  it("a non-subject or invalid role gives not_released", async () => {
    await release();
    for (const role of ["group", "mallory", "../x", "", "a/b"])
      expect(await readReleasedView(root, sessionId, role, secrets)).toEqual({
        kind: "not_released",
      });
  });
  it("no directory, or an invalid session id, gives missing", async () => {
    expect(await readReleasedView(root, "nope", "alice", secrets)).toEqual({
      kind: "missing",
    });
    expect(
      await readReleasedView(
        path.join(root, "absent"),
        sessionId,
        "alice",
        secrets,
      ),
    ).toEqual({ kind: "missing" });
    expect(await readReleasedView(root, "../x", "alice", secrets)).toEqual({
      kind: "missing",
    });
    expect(await listReleasedRoles(root, "nope")).toBeNull();
  });
  it("a tampered review.jsonl gives unavailable with nothing else in the result", async () => {
    await release();
    const f = path.join(dir, "review.jsonl");
    await writeFile(
      f,
      (await readFile(f, "utf8")).replace('"kamal"', '"mallory"'),
    );
    const r = await readReleasedView(root, sessionId, "alice", secrets);
    expect(r).toEqual({ kind: "unavailable" });
    expect(await listReleasedRoles(root, sessionId)).toBeNull();
  });
  it("a stray file the review never recorded is ignored; an edited or symlinked recorded file gives unavailable", async () => {
    await release();
    await writeFile(path.join(dir, "stray.json"), "x");
    expect(
      (await readReleasedView(root, sessionId, "alice", secrets)).kind,
    ).toBe("released");
    const f = path.join(dir, "bob.json");
    const orig = await readFile(f, "utf8");
    await writeFile(f, orig.replace("Clear on effort.", "Clear on effort!"));
    expect(await readReleasedView(root, sessionId, "alice", secrets)).toEqual({
      kind: "unavailable",
    });
    await rm(f);
    await writeFile(path.join(root, "bob.real"), orig);
    await symlink(path.join(root, "bob.real"), f);
    expect(await readReleasedView(root, sessionId, "alice", secrets)).toEqual({
      kind: "unavailable",
    });
  });
  it("an unreadable draft file gives unavailable", async () => {
    await release();
    await chmod(path.join(dir, "alice.json"), 0o000);
    try {
      expect(await readReleasedView(root, sessionId, "alice", secrets)).toEqual(
        { kind: "unavailable" },
      );
    } finally {
      await chmod(path.join(dir, "alice.json"), 0o600);
    }
  });
  it("a directory moved away mid-read gives unavailable or missing, never a throw", async () => {
    await release();
    const p = readReleasedView(root, sessionId, "alice", secrets);
    await rename(dir, `${dir}.gone`);
    const r = await p;
    expect(["released", "unavailable", "missing"]).toContain(r.kind);
    expect(JSON.stringify(r)).not.toContain(root);
  });
  it("a symbolic-link review folder is not followed", async () => {
    await release();
    await rename(dir, path.join(root, "elsewhere"));
    await symlink(path.join(root, "elsewhere"), dir);
    expect(
      (await readReleasedView(root, sessionId, "alice", secrets)).kind,
    ).toBe("missing");
    expect(await resolveReviewDir(root, sessionId)).toBeNull();
  });
});

describe("re-runs", () => {
  async function rerun() {
    const w = await writeReports(await sampleEvaluation(), {
      outDir: root,
      evaluator: {
        provider: "scripted mock",
        scripted: true,
        rubricHash: "h1",
        variant: "v1",
      },
    });
    return w.dir;
  }
  it("resolves the single live review: the superseded one is skipped", async () => {
    await release();
    const dir2 = await rerun();
    expect(await resolveReviewDir(root, sessionId)).toBe(dir);
    await supersedeReview(dir, dir2, { by: "kamal", now: fixedClock() });
    const rel2 = path.relative(root, dir2);
    const r2 = makeRunner(root);
    await resolveAll(dir2, rel2);
    expect((await r2(["release", rel2, "--all", "--by", "kamal"])).code).toBe(
      0,
    );
    expect(await resolveReviewDir(root, sessionId)).toBe(dir2);
    expect(path.basename(dir2)).toBe(`${sessionId}-2`);
    expect(
      (await readReleasedView(root, sessionId, "alice", secrets)).kind,
    ).toBe("released");
    expect(await listReleasedRoles(root, sessionId)).toEqual(["alice", "bob"]);
  });
  it("two live siblings give null", async () => {
    const dir2 = await rerun();
    await makeRunner(root)([
      "open",
      path.relative(root, dir2),
      "--by",
      "kamal",
    ]);
    expect(await resolveReviewDir(root, sessionId)).toBeNull();
    expect(await readReleasedView(root, sessionId, "alice", secrets)).toEqual({
      kind: "unavailable",
    });
  });
  it("a sibling of another session id or an out-of-range suffix is ignored", async () => {
    await release();
    await mkdir(path.join(root, `${sessionId}-100`));
    await mkdir(path.join(root, `${sessionId}-x`));
    await mkdir(path.join(root, `${sessionId}-02`));
    expect(await resolveReviewDir(root, sessionId)).toBe(dir);
  });
});

describe("listReleasedRoles", () => {
  it("returns only released participant roles", async () => {
    expect(await listReleasedRoles(root, sessionId)).toEqual([]);
    await release("bob");
    expect(await listReleasedRoles(root, sessionId)).toEqual(["bob"]);
    await release();
    expect(await listReleasedRoles(root, sessionId)).toEqual(["alice", "bob"]);
    await run(["withdraw", rel, "bob", "--reason", "x", "--by", "kamal"]);
    expect(await listReleasedRoles(root, sessionId)).toEqual(["alice"]);
  });
});
