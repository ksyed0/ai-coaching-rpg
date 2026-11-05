import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runModerate } from "../cli.js";
import { loadDrafts } from "../draft.js";
import { makeDraftDir, fixedClock } from "./fixtures.js";

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function run(argv: string[]) {
  let out = "",
    err = "";
  const r = await runModerate({
    argv,
    stdout: { write: (s) => (out += s) },
    stderr: { write: (s) => (err += s) },
    env: {},
    cwd: root,
    now: fixedClock(),
  });
  return { code: r.exitCode, out, err };
}
const rel = () => path.relative(root, dir);
async function edit(file: string, f: (j: any) => void) {
  const p = path.join(dir, file);
  const j = JSON.parse(await readFile(p, "utf8"));
  f(j);
  await writeFile(p, JSON.stringify(j, null, 2));
}

describe("titles with legitimate invisible characters", () => {
  const titles: [string, string][] = [
    ["emoji ZWJ sequence", "Team 👩\u200d💻 call"],
    ["soft hyphen", "Dis\u00adcovery"],
    ["line separator", "One\u2028Two"],
    ["family emoji", "Huddle 👨\u200d👩\u200d👧"],
  ];
  for (const [name, title] of titles)
    it(`opens and shows a scenario title and scene title with a ${name}, without the hidden character in the output`, async () => {
      for (const f of ["alice.json", "bob.json", "group.json"])
        await edit(f, (j) => {
          j.scenario.title = title;
          j.session.scenes[0].title = title;
        });
      expect((await run(["open", rel(), "--by", "kamal"])).code).toBe(0);
      const r = await run(["show", rel(), "alice"]);
      expect(r.code).toBe(0);
      expect(r.out).not.toMatch(/[\u200d\u00ad\u2028]/);
    });
  it("still refuses a bidi override and an escape character in a title", async () => {
    await edit("alice.json", (j) => (j.scenario.title = "a\u202eb"));
    expect((await run(["open", rel(), "--by", "kamal"])).code).toBe(2);
    await edit("alice.json", (j) => (j.scenario.title = "a\u001b[31mb"));
    expect((await run(["open", rel(), "--by", "kamal"])).code).toBe(2);
    await edit("alice.json", (j) => (j.scenario.title = "a\u2067b"));
    expect((await run(["open", rel(), "--by", "kamal"])).code).toBe(2);
  });
});

describe("loadDrafts", () => {
  it("loads a role whose id is `review` (only review.jsonl and review.lock are the log's)", async () => {
    const j = JSON.parse(await readFile(path.join(dir, "alice.json"), "utf8"));
    j.participant.role = "review";
    await writeFile(path.join(dir, "review.json"), JSON.stringify(j));
    await writeFile(path.join(dir, "review.lock"), "x");
    const d = await loadDrafts(dir);
    expect(d.subjects.has("review")).toBe(true);
    expect(Object.keys(d.files)).not.toContain("review.lock");
  });
  it("rejects reports that disagree on the session start time", async () => {
    await edit(
      "bob.json",
      (j) => (j.session.date = "2030-01-01T00:00:00.000Z"),
    );
    await expect(loadDrafts(dir)).rejects.toThrow(/different session/);
  });
});

describe("edit-summary --action length", () => {
  it("accepts a 400-character action text and refuses 401", async () => {
    await run(["open", rel(), "--by", "kamal"]);
    const lo = JSON.parse(await readFile(path.join(dir, "alice.json"), "utf8"))
      .learning_objectives[0].id as string;
    const base = [
      "edit-summary",
      rel(),
      "alice",
      "--reason",
      "r",
      "--by",
      "kamal",
    ];
    expect(
      (await run([...base, "--action", `${lo}:${"a".repeat(400)}`])).code,
    ).toBe(0);
    expect(
      (await run([...base, "--action", `${lo}:${"a".repeat(401)}`])).code,
    ).toBe(2);
  });
});
