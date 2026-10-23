import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { loadDrafts } from "../draft.js";
import { ReviewCorruptError } from "../errors.js";
import { makeDraftDir } from "./fixtures.js";

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadDrafts", () => {
  it("loads alice, bob and group from a real draft directory", async () => {
    const d = await loadDrafts(dir);
    expect([...d.subjects.keys()].sort()).toEqual(["alice", "bob", "group"]);
    expect(d.sessionId).toBe("sess1");
    expect(d.legacy).toBe(false);
    expect(Object.keys(d.files)).toEqual(
      expect.arrayContaining([
        "alice.json",
        "alice.md",
        "group.json",
        "index.md",
        "method.md",
      ]),
    );
    expect(Object.values(d.files).every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(
      true,
    );
    const alice = d.subjects.get("alice")!;
    expect(alice.kind).toBe("participant");
    expect(alice.criteria.map((c) => c.id)).toEqual([
      "discovery",
      "listening",
      "negotiation",
    ]);
    expect(alice.objectives.length).toBeGreaterThan(0);
    expect(d.subjects.get("group")!.summary).toBeNull();
    expect(alice.summary?.strengths).toEqual(["You asked about the need."]);
  });
  it("flags a directory without flag_codes as legacy", async () => {
    const f = path.join(dir, "alice.json");
    const j = JSON.parse(await readFile(f, "utf8"));
    for (const c of j.criteria) delete c.flag_codes;
    await writeFile(f, JSON.stringify(j));
    expect((await loadDrafts(dir)).legacy).toBe(true);
  });
  it("refuses a draft that is not an acr.report/1 report, a role id that is unsafe and an oversized file", async () => {
    await writeFile(
      path.join(dir, "mallory.json"),
      JSON.stringify({ schema: "other/1" }),
    );
    await expect(loadDrafts(dir)).rejects.toThrow(/mallory\.json/);
    await rm(path.join(dir, "mallory.json"));
    const f = path.join(dir, "bob.json");
    const j = JSON.parse(await readFile(f, "utf8"));
    j.participant.role = "../x";
    await writeFile(f, JSON.stringify(j));
    await expect(loadDrafts(dir)).rejects.toThrow(/bob\.json/);
    await writeFile(f, "x".repeat(5 * 1024 * 1024));
    await expect(loadDrafts(dir)).rejects.toThrow(/bob\.json/);
  });
  it("ignores files outside the allowed set", async () => {
    await writeFile(
      path.join(dir, "extra.json"),
      JSON.stringify({
        schema: "acr.report/1",
        kind: "participant",
        participant: { role: "extra" },
      }),
    );
    const only = new Set([
      "alice.json",
      "alice.md",
      "bob.json",
      "bob.md",
      "group.json",
      "group.md",
      "index.md",
      "method.md",
    ]);
    expect([...(await loadDrafts(dir, only)).subjects.keys()].sort()).toEqual([
      "alice",
      "bob",
      "group",
    ]);
  });

  const edit = async (
    file: string,
    fn: (j: Record<string, any>) => void,
  ): Promise<void> => {
    const f = path.join(dir, file);
    const j = JSON.parse(await readFile(f, "utf8"));
    fn(j);
    await writeFile(f, JSON.stringify(j));
  };
  it("validates flag_codes: unknown code, non-array and length mismatch are corrupt", async () => {
    for (const bad of [["made_up"], "quotes_dropped", ["other", "other"]]) {
      ({ root, dir } = await (async () => {
        await rm(root, { recursive: true, force: true });
        return makeDraftDir();
      })());
      await edit("alice.json", (j) => {
        j.criteria[0].flags = ["x"];
        j.criteria[0].flag_codes = bad;
      });
      const err = await loadDrafts(dir).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReviewCorruptError);
      expect((err as Error).message).toMatch(/alice\.json.*discovery/);
      expect((err as Error).message).not.toMatch(/made_up/);
    }
  });
  it("accepts matching flag_codes", async () => {
    await edit("alice.json", (j) => {
      j.criteria[0].flags = ["x"];
      j.criteria[0].flag_codes = ["other"];
    });
    expect((await loadDrafts(dir)).legacy).toBe(false);
  });
  it("refuses a participant report with the group role and a group report in another file", async () => {
    await edit("bob.json", (j) => (j.participant.role = "group"));
    await rm(path.join(dir, "group.json"));
    await rm(path.join(dir, "group.md"));
    await rename(path.join(dir, "bob.json"), path.join(dir, "group.json"));
    await expect(loadDrafts(dir)).rejects.toThrow(/group\.json/);
    ({ root, dir } = await (async () => {
      await rm(root, { recursive: true, force: true });
      return makeDraftDir();
    })());
    await rename(path.join(dir, "group.json"), path.join(dir, "zed.json"));
    await expect(loadDrafts(dir)).rejects.toThrow(/zed\.json/);
  });
  it("refuses reports that disagree on the rubric hash", async () => {
    await edit("bob.json", (j) => (j.evaluator.rubricHash = "other"));
    await expect(loadDrafts(dir)).rejects.toThrow(/different session|rubric/);
  });
  it("refuses a symbolic link and a directory named like a report", async () => {
    const target = path.join(root, "real.json");
    await writeFile(target, await readFile(path.join(dir, "bob.json")));
    await rm(path.join(dir, "bob.json"));
    await symlink(target, path.join(dir, "bob.json"));
    await expect(loadDrafts(dir)).rejects.toBeInstanceOf(ReviewCorruptError);
    await rm(path.join(dir, "bob.json"));
    await mkdir(path.join(dir, "x.json"));
    await expect(loadDrafts(dir)).rejects.toThrow(/x\.json/);
  });
});
