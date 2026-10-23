import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readReview,
  sealEntries,
  withReviewLock,
  writeEvents,
} from "../review-log.js";
import { REVIEW_FILE, ZERO_HASH, type Entry } from "../types.js";
import { ReviewCorruptError, ReviewRefusedError } from "../errors.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acr-rl-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fac = { kind: "facilitator", by: "kamal" } as const;
const comment = (text: string): Entry => ({
  actor: fac,
  body: {
    type: "comment.added",
    subject: "alice",
    text,
    visibility: "internal",
  },
});
const clock = () => {
  let t = 1000;
  return () => (t += 1);
};
async function append(entries: Entry[]) {
  const { events, tailHash } = await readReview(dir);
  const sealed = sealEntries(events, tailHash, entries, clock());
  await writeEvents(dir, sealed);
  return sealed;
}

describe("review log", () => {
  it("is empty when there is no file, and chains seq and prev from the zero hash", async () => {
    expect(await readReview(dir)).toEqual({ events: [], tailHash: ZERO_HASH });
    const sealed = await append([comment("a"), comment("b")]);
    expect(sealed.map((e) => e.seq)).toEqual([1, 2]);
    expect(sealed[0]!.prev).toBe(ZERO_HASH);
    expect(sealed[1]!.prev).not.toBe(ZERO_HASH);
    await append([comment("c")]);
    const read = await readReview(dir);
    expect(read.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
  it("creates the file owner-only", async () => {
    await append([comment("a")]);
    expect((await stat(path.join(dir, REVIEW_FILE))).mode & 0o777).toBe(0o600);
  });
  it("narrows a wider existing file to owner-only on append", async () => {
    await append([comment("a")]);
    await chmod(path.join(dir, REVIEW_FILE), 0o644);
    await append([comment("b")]);
    expect((await stat(path.join(dir, REVIEW_FILE))).mode & 0o777).toBe(0o600);
  });
  it("detects an edited line, a deleted middle line, a cut-off last line and garbage", async () => {
    await append([comment("a"), comment("b"), comment("c")]);
    const file = path.join(dir, REVIEW_FILE);
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    await writeFile(
      file,
      [lines[0]!.replace('"a"', '"A"'), lines[1], lines[2]].join("\n") + "\n",
    );
    await expect(readReview(dir)).rejects.toThrow(/hash chain/);
    await writeFile(file, [lines[0], lines[2]].join("\n") + "\n");
    await expect(readReview(dir)).rejects.toThrow(/seq|chain/);
    await writeFile(file, lines.join("\n") + "\n" + '{"seq":4,"ts"');
    await expect(readReview(dir)).rejects.toThrow(/cut-off/);
    await writeFile(file, "not json\n");
    await expect(readReview(dir)).rejects.toBeInstanceOf(ReviewCorruptError);
  });
  it("does not follow a symbolic link and refuses a directory", async () => {
    await writeFile(path.join(dir, "real.jsonl"), "");
    await symlink(path.join(dir, "real.jsonl"), path.join(dir, REVIEW_FILE));
    await expect(readReview(dir)).rejects.toBeInstanceOf(ReviewCorruptError);
    await expect(
      writeEvents(dir, sealEntries([], ZERO_HASH, [comment("a")], clock())),
    ).rejects.toThrow();
  });
  it("refuses more than the event cap", async () => {
    const sealed = sealEntries(
      [],
      ZERO_HASH,
      Array.from({ length: 10_001 }, () => comment("x")),
      clock(),
    );
    await writeFile(
      path.join(dir, REVIEW_FILE),
      sealed.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await expect(readReview(dir)).rejects.toThrow(/too many events/);
  });
  it("takes one lock at a time: a second holder is refused, and the lock is released afterwards", async () => {
    let inner: Promise<unknown> | undefined;
    await withReviewLock(dir, async () => {
      inner = withReviewLock(dir, async () => 1);
      await expect(inner).rejects.toBeInstanceOf(ReviewRefusedError);
    });
    await expect(withReviewLock(dir, async () => "again")).resolves.toBe(
      "again",
    );
  });
});
