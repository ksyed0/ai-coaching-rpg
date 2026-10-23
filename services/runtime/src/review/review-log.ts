import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fsyncDir } from "../engine/event-log.js";
import { SessionLock, SessionLockError } from "../engine/log-files.js";
import { readRegularCapped } from "../util/read-regular.js";
import { ReviewCorruptError, ReviewRefusedError } from "./errors.js";
import { sha256 } from "./hash.js";
import {
  LIMITS,
  REVIEW_FILE,
  ZERO_HASH,
  type Entry,
  type ReviewEvent,
} from "./types.js";

export type ReviewRead = { events: ReviewEvent[]; tailHash: string };

const corrupt = (m: string) =>
  new ReviewCorruptError(
    `review.jsonl: ${m}; no command repairs it, restore it from a backup`,
  );
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isEventShape(e: unknown): e is ReviewEvent {
  if (!isObj(e)) return false;
  const a = e.actor;
  return (
    Number.isInteger(e.seq) &&
    typeof e.ts === "number" &&
    Number.isFinite(e.ts) &&
    typeof e.prev === "string" &&
    typeof e.type === "string" &&
    isObj(a) &&
    (a.kind === "facilitator" ||
      a.kind === "participant" ||
      a.kind === "system")
  );
}

/** Reads `<dir>/review.jsonl` through one handle (no symbolic link, regular file, byte cap) and checks seq and the hash chain. */
export async function readReview(dir: string): Promise<ReviewRead> {
  let text: string;
  try {
    text = await readRegularCapped(
      path.join(dir, REVIEW_FILE),
      LIMITS.logBytes,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { events: [], tailHash: ZERO_HASH };
    throw corrupt(
      "cannot be read (a symbolic link, not a regular file, or too large)",
    );
  }
  if (text === "") return { events: [], tailHash: ZERO_HASH };
  if (!text.endsWith("\n")) throw corrupt("ends in a cut-off line");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > LIMITS.events) throw corrupt("has too many events");
  const events: ReviewEvent[] = [];
  let prev = ZERO_HASH;
  for (let i = 0; i < lines.length; i++) {
    let e: unknown;
    try {
      e = JSON.parse(lines[i]!);
    } catch {
      throw corrupt(`line ${i + 1} is not JSON`);
    }
    if (!isEventShape(e)) throw corrupt(`line ${i + 1} is not a review event`);
    if (e.seq !== i + 1)
      throw corrupt(`line ${i + 1}: seq ${e.seq} breaks the sequence`);
    if (e.prev !== prev)
      throw corrupt(`line ${i + 1}: the hash chain is broken`);
    prev = sha256(lines[i]!);
    events.push(e);
  }
  return { events, tailHash: prev };
}

/** Assigns seq, ts and prev to new entries after `events`. Pure; the line that is hashed is exactly the line that is written. */
export function sealEntries(
  events: ReviewEvent[],
  tailHash: string,
  entries: Entry[],
  now: () => number,
): ReviewEvent[] {
  const sealed: ReviewEvent[] = [];
  let prev = tailHash;
  for (const [i, en] of entries.entries()) {
    const e = {
      seq: events.length + i + 1,
      ts: now(),
      prev,
      actor: en.actor,
      ...(en.carriedFrom ? { carriedFrom: en.carriedFrom } : {}),
      ...en.body,
    } as ReviewEvent;
    sealed.push(e);
    prev = sha256(JSON.stringify(e));
  }
  return sealed;
}

/** Appends sealed events in ONE write, then fdatasync and a directory fsync. The caller holds the review lock and has validated the events. */
export async function writeEvents(
  dir: string,
  sealed: ReviewEvent[],
): Promise<void> {
  if (sealed.length === 0) return;
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_APPEND |
    (fsConstants.O_NOFOLLOW ?? 0);
  let fh: FileHandle | null = null;
  try {
    fh = await open(path.join(dir, REVIEW_FILE), flags, 0o600);
    const st = await fh.stat();
    if (!st.isFile() || st.nlink > 1)
      throw new ReviewCorruptError(
        "review.jsonl is not a plain file with one link",
      );
    if ((st.mode & 0o077) !== 0) await fh.chmod(0o600);
    const buf = Buffer.from(
      sealed.map((e) => `${JSON.stringify(e)}\n`).join(""),
      "utf8",
    );
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await fh.write(buf, off, buf.length - off);
      off += bytesWritten;
    }
    await fh.datasync();
  } catch (err) {
    if (err instanceof ReviewCorruptError) throw err;
    throw new ReviewCorruptError(
      "review.jsonl could not be written; run status to check it before trying again",
    );
  } finally {
    await fh?.close().catch(() => undefined);
  }
  await fsyncDir(dir);
}

/** One writer at a time (the session lock primitive, file `review.lock`). A held lock is a refusal (exit 1), not a crash. */
export async function withReviewLock<T>(
  dir: string,
  fn: () => Promise<T>,
): Promise<T> {
  let lock: SessionLock;
  try {
    lock = SessionLock.acquire(dir, "review");
  } catch (err) {
    if (
      err instanceof SessionLockError &&
      (err.code === "locked" || err.code === "contention")
    )
      throw new ReviewRefusedError(
        "another moderate command is running on this review; try again in a moment",
      );
    throw err;
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
