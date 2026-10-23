import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  mkdir,
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
import { LIMITS, REVIEW_FILE, ZERO_HASH, type Entry } from "../types.js";
import * as fsp from "node:fs/promises";
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
    ).rejects.toBeInstanceOf(ReviewCorruptError);
    expect(await readFile(path.join(dir, "real.jsonl"), "utf8")).toBe("");
  });
  it("refuses a directory in place of the file", async () => {
    await mkdir(path.join(dir, REVIEW_FILE));
    await expect(readReview(dir)).rejects.toBeInstanceOf(ReviewCorruptError);
    await expect(
      writeEvents(dir, sealEntries([], ZERO_HASH, [comment("a")], clock())),
    ).rejects.toBeInstanceOf(ReviewCorruptError);
  });
  it("rejects a first line whose prev is not the zero hash", async () => {
    const [e] = sealEntries([], "f".repeat(64), [comment("a")], clock());
    await writeFile(path.join(dir, REVIEW_FILE), JSON.stringify(e) + "\n");
    await expect(readReview(dir)).rejects.toThrow(/hash chain/);
  });
  it("lets a body not override seq, ts, prev or actor", () => {
    const evil = {
      actor: fac,
      body: { ...comment("a").body, seq: 99, ts: 1, prev: "x" },
    } as unknown as Entry;
    const [e] = sealEntries([], ZERO_HASH, [evil], () => 5);
    expect([e!.seq, e!.ts, e!.prev]).toEqual([1, 5, ZERO_HASH]);
  });
  it("refuses an append that would pass the byte cap and leaves the file alone", async () => {
    await append([comment("a")]);
    const file = path.join(dir, REVIEW_FILE);
    const before = await readFile(file);
    await truncate(file, LIMITS.logBytes - 10);
    const big = await readFile(file);
    const sealed = sealEntries([], ZERO_HASH, [comment("b")], clock());
    await expect(writeEvents(dir, sealed)).rejects.toBeInstanceOf(
      ReviewRefusedError,
    );
    expect(Buffer.compare(await readFile(file), big)).toBe(0);
    expect(before.length).toBeGreaterThan(0);
  });
  it("rolls back a partial write and the log stays readable", async () => {
    await append([comment("a")]);
    const file = path.join(dir, REVIEW_FILE);
    const before = await readFile(file);
    const probe = await fsp.open(file, "r");
    const proto = Object.getPrototypeOf(probe) as {
      write: (...a: unknown[]) => Promise<unknown>;
    };
    await probe.close();
    const realWrite = proto.write;
    const spy = vi.spyOn(proto, "write").mockImplementation(async function (
      this: unknown,
      b: unknown,
    ) {
      await realWrite.call(this, b, 0, 5);
      throw Object.assign(new Error("full"), { code: "ENOSPC" });
    });
    const { events, tailHash } = await readReview(dir);
    const sealed = sealEntries(events, tailHash, [comment("b")], clock());
    await expect(writeEvents(dir, sealed)).rejects.toThrow(/nothing was added/);
    spy.mockRestore();
    expect(Buffer.compare(await readFile(file), before)).toBe(0);
    expect((await readReview(dir)).events).toHaveLength(1);
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
  it("takes carriedFrom from the entry only, never from the body", () => {
    const e = comment("a");
    const [x] = sealEntries(
      [],
      ZERO_HASH,
      [{ ...e, body: { ...e.body, carriedFrom: "evil" } as any }],
      clock(),
    );
    expect((x as any).carriedFrom).toBeUndefined();
    const [y] = sealEntries(
      [],
      ZERO_HASH,
      [{ ...e, carriedFrom: "ok" }],
      clock(),
    );
    expect(y!.carriedFrom).toBe("ok");
  });
});
